import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
// pi-local-rag v0.4.1 has no setRagDirGetter; we pin storage via PI_RAG_DIR env
// (must be set BEFORE the module is loaded — see initRag) and by passing the
// explicit ragDir to openDb(). This is the fallback path called out in the
// spec's §11 risk #2.
import {
	openDb,
	hybridSearch,
	indexFiles,
	loadIndex,
} from "pi-local-rag";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type IngestSource = "chat" | "upload" | "inbox";

export interface RagDocMeta {
	sha: string;
	name: string;
	mime: string;
	size: number;
	chunks: number;
	source: IngestSource;
	addedAt: number;
}

export interface RagHit {
	file: string;
	name: string;
	snippet: string;
	lineStart: number;
	lineEnd: number;
	score: number;
	bm25: number;
	vector: number;
}

export interface RagJob {
	id: string;
	name: string;
	mime: string;
	size: number;
	source: IngestSource;
	status: "queued" | "reading" | "chunking" | "embedding" | "done" | "failed";
	pct: number;
	sha?: string;
	chunks?: number;
	error?: string;
	startedAt: number;
	finishedAt?: number;
}

export type RagEvent =
	| { type: "job_queued"; job: RagJob }
	| { type: "job_progress"; id: string; status: RagJob["status"]; pct: number }
	| { type: "job_done"; id: string; doc: RagDocMeta }
	| { type: "job_failed"; id: string; error: string }
	| { type: "doc_deleted"; sha: string };

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

export const RAG_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB per file via HTTP
export const RAG_MAX_UPLOAD_FILES = 5;
export const RAG_MAX_INBOX_BYTES = 500 * 1024 * 1024; // 500 MB per inbox file
export const RAG_ALLOWED_MIMES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"text/plain",
	"text/markdown",
	"text/html",
	"application/json",
	"text/csv",
]);
export const RAG_SEARCH_DEFAULT_LIMIT = 5;
export const RAG_SEARCH_MAX_LIMIT = 10;
export const RAG_SNIPPET_MAX_CHARS = 1500;
export const RAG_TOTAL_SNIPPET_CHARS = 12_000;

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

const ragBus = new EventEmitter();
ragBus.setMaxListeners(50);

let dataDir = "";
let ragDir = "";
let filesDir = "";
let inboxDir = "";
let db: BetterSqlite3.Database | null = null;

const jobs = new Map<string, RagJob>();
const jobQueue: RagJob[] = [];
let workerBusy = false;
const pendingBytes = new Map<string, Buffer>();

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

export async function initRag(baseDataDir: string): Promise<void> {
	dataDir = baseDataDir;
	ragDir = path.join(dataDir, "rag");
	filesDir = path.join(ragDir, "files");
	inboxDir = path.join(ragDir, "inbox");
	await mkdir(filesDir, { recursive: true });
	await mkdir(path.join(inboxDir, ".processed"), { recursive: true });
	await mkdir(path.join(inboxDir, ".rejected"), { recursive: true });

	// Pin pi-local-rag's storage. store.ts checks PI_RAG_DIR first; also pass
	// ragDir explicitly to openDb so we don't rely on cwd walk-up.
	process.env.PI_RAG_DIR = ragDir;

	db = openDb(ragDir);

	db.exec(`
		CREATE TABLE IF NOT EXISTS rag_docs (
			sha TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			mime TEXT NOT NULL,
			size INTEGER NOT NULL,
			source TEXT NOT NULL,
			file_path TEXT NOT NULL,
			added_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS rag_docs_added_at ON rag_docs(added_at DESC);
	`);

	warmupEmbedder().catch((err) => {
		console.warn("[rag] embedder warmup failed:", err);
	});

	console.log(`[rag] initialized at ${ragDir} (${countDocs()} docs)`);
}

async function warmupEmbedder(): Promise<void> {
	const { embed } = await import("pi-local-rag");
	await embed("warmup");
}

// -----------------------------------------------------------------------------
// Event bus
// -----------------------------------------------------------------------------

export function subscribeRag(fn: (ev: RagEvent) => void): () => void {
	ragBus.on("event", fn);
	return () => {
		ragBus.off("event", fn);
	};
}

function emitEvent(ev: RagEvent): void {
	ragBus.emit("event", ev);
}

// -----------------------------------------------------------------------------
// Ingest — high-level
// -----------------------------------------------------------------------------

export interface IngestFileInput {
	name: string;
	mime: string;
	bytes: Buffer;
	source: IngestSource;
}

export function enqueueIngest(input: IngestFileInput): RagJob {
	const job: RagJob = {
		id: `job-${randomUUID()}`,
		name: input.name,
		mime: input.mime,
		size: input.bytes.length,
		source: input.source,
		status: "queued",
		pct: 0,
		startedAt: Date.now(),
	};
	jobs.set(job.id, job);
	jobQueue.push(job);
	pendingBytes.set(job.id, input.bytes);
	emitEvent({ type: "job_queued", job });
	setImmediate(runWorker);
	return job;
}

async function runWorker(): Promise<void> {
	if (workerBusy) return;
	const job = jobQueue.shift();
	if (!job) return;
	workerBusy = true;
	const bytes = pendingBytes.get(job.id);
	pendingBytes.delete(job.id);
	try {
		if (!bytes) throw new Error("payload missing");
		await processIngest(job, bytes);
	} catch (err) {
		job.status = "failed";
		job.error = err instanceof Error ? err.message : String(err);
		job.finishedAt = Date.now();
		emitEvent({ type: "job_failed", id: job.id, error: job.error });
	} finally {
		workerBusy = false;
		if (jobQueue.length > 0) setImmediate(runWorker);
	}
}

async function processIngest(job: RagJob, bytes: Buffer): Promise<void> {
	const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const existing = getDoc(sha);
	if (existing) {
		job.status = "done";
		job.pct = 100;
		job.sha = sha;
		job.chunks = existing.chunks;
		job.finishedAt = Date.now();
		emitEvent({ type: "job_done", id: job.id, doc: existing });
		return;
	}

	const safeName = job.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
	const docDir = path.join(filesDir, sha);
	await mkdir(docDir, { recursive: true });
	const docPath = path.join(docDir, safeName);
	await writeFile(docPath, bytes);
	job.status = "reading";
	job.pct = 10;
	emitEvent({ type: "job_progress", id: job.id, status: "reading", pct: 10 });

	job.status = "chunking";
	job.pct = 25;
	emitEvent({ type: "job_progress", id: job.id, status: "chunking", pct: 25 });

	if (!db) throw new Error("rag db not initialized");

	// pi-local-rag's indexFiles supports ProgressCallbacks (onFile/onEmbed/…).
	// We only care about aggregate embed progress here.
	await indexFiles(
		[docPath],
		{
			onEmbed: (done, total) => {
				if (total <= 0) return;
				const pct = 25 + Math.floor((done / total) * 70);
				job.status = "embedding";
				job.pct = pct;
				emitEvent({ type: "job_progress", id: job.id, status: "embedding", pct });
			},
		},
		db,
	);

	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?`)
		.get(docPath) as { n: number } | undefined;
	const chunkCount = row?.n ?? 0;

	db.prepare(
		`INSERT OR REPLACE INTO rag_docs (sha, name, mime, size, source, file_path, added_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(sha, job.name, job.mime, bytes.length, job.source, docPath, Date.now());

	const doc: RagDocMeta = {
		sha,
		name: job.name,
		mime: job.mime,
		size: bytes.length,
		chunks: chunkCount,
		source: job.source,
		addedAt: Date.now(),
	};
	job.status = "done";
	job.pct = 100;
	job.sha = sha;
	job.chunks = chunkCount;
	job.finishedAt = Date.now();
	emitEvent({ type: "job_done", id: job.id, doc });
}

// -----------------------------------------------------------------------------
// Docs listing
// -----------------------------------------------------------------------------

interface RagDocRow {
	sha: string;
	name: string;
	mime: string;
	size: number;
	source: IngestSource;
	addedAt: number;
	filePath: string;
	chunks: number | null;
}

export function listDocs(): RagDocMeta[] {
	if (!db) return [];
	const rows = db
		.prepare(
			`SELECT sha, name, mime, size, source, added_at as addedAt, file_path as filePath,
			        (SELECT COUNT(*) FROM chunks WHERE file_path = rag_docs.file_path) AS chunks
			 FROM rag_docs
			 ORDER BY added_at DESC`,
		)
		.all() as RagDocRow[];
	return rows.map((r) => ({
		sha: r.sha,
		name: r.name,
		mime: r.mime,
		size: r.size,
		source: r.source,
		addedAt: r.addedAt,
		chunks: r.chunks ?? 0,
	}));
}

export function getDoc(sha: string): RagDocMeta | null {
	if (!db) return null;
	const row = db
		.prepare(
			`SELECT sha, name, mime, size, source, added_at as addedAt, file_path as filePath
			 FROM rag_docs WHERE sha = ?`,
		)
		.get(sha) as Omit<RagDocRow, "chunks"> | undefined;
	if (!row) return null;
	const chunkRow = db
		.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?`)
		.get(row.filePath) as { n: number } | undefined;
	return {
		sha: row.sha,
		name: row.name,
		mime: row.mime,
		size: row.size,
		source: row.source,
		addedAt: row.addedAt,
		chunks: chunkRow?.n ?? 0,
	};
}

function countDocs(): number {
	if (!db) return 0;
	const row = db.prepare(`SELECT COUNT(*) AS n FROM rag_docs`).get() as
		| { n: number }
		| undefined;
	return row?.n ?? 0;
}

// -----------------------------------------------------------------------------
// Deletion
// -----------------------------------------------------------------------------

export async function deleteDoc(sha: string): Promise<boolean> {
	if (!db) return false;
	const row = db
		.prepare(`SELECT file_path FROM rag_docs WHERE sha = ?`)
		.get(sha) as { file_path: string } | undefined;
	if (!row) return false;
	const filePath = row.file_path;
	const database = db;
	database.transaction(() => {
		const rowids = database
			.prepare(`SELECT rowid FROM chunks WHERE file_path = ?`)
			.all(filePath) as Array<{ rowid: number }>;
		for (const { rowid } of rowids) {
			database.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`).run(rowid);
		}
		database.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);
		database.prepare(`DELETE FROM files WHERE path = ?`).run(filePath);
		database.prepare(`DELETE FROM rag_docs WHERE sha = ?`).run(sha);
	})();
	await rm(path.dirname(filePath), { recursive: true, force: true });
	emitEvent({ type: "doc_deleted", sha });
	return true;
}

// -----------------------------------------------------------------------------
// Query
// -----------------------------------------------------------------------------

export async function query(
	q: string,
	limit = RAG_SEARCH_DEFAULT_LIMIT,
): Promise<RagHit[]> {
	if (!db) return [];
	const cappedLimit = Math.max(1, Math.min(RAG_SEARCH_MAX_LIMIT, limit));
	// hybridSearch expects an IndexMeta; a stub is enough — the DB is the
	// source of truth for scoring. loadIndex() returns the correctly shaped
	// meta without an expensive scan.
	const indexMeta = loadIndex();
	const results = await hybridSearch(q, indexMeta, cappedLimit, 0.4, db);

	const pathToName = new Map<string, string>();
	const rows = db
		.prepare(`SELECT file_path, name FROM rag_docs`)
		.all() as Array<{ file_path: string; name: string }>;
	for (const r of rows) pathToName.set(r.file_path, r.name);

	let totalChars = 0;
	const hits: RagHit[] = [];
	for (const r of results) {
		let snippet = r.chunk.content;
		if (snippet.length > RAG_SNIPPET_MAX_CHARS) {
			snippet = snippet.slice(0, RAG_SNIPPET_MAX_CHARS) + "…";
		}
		if (totalChars + snippet.length > RAG_TOTAL_SNIPPET_CHARS) break;
		totalChars += snippet.length;
		hits.push({
			file: r.chunk.file,
			name: pathToName.get(r.chunk.file) ?? path.basename(r.chunk.file),
			snippet,
			lineStart: r.chunk.lineStart,
			lineEnd: r.chunk.lineEnd,
			score: r.hybrid,
			bm25: r.bm25,
			vector: r.vector,
		});
	}
	return hits;
}

// -----------------------------------------------------------------------------
// Helpers exposed for the inbox scanner
// -----------------------------------------------------------------------------

export function getInboxDir(): string {
	return inboxDir;
}

export function getRagDirPath(): string {
	return ragDir;
}
