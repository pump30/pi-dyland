# RAG + Card System Integration Spec

**Target:** `pi-dyland` (`github.com/pump30/pi-dyland`)
**Status:** Design spec — hand to a coding session to implement in one shot.
**Owner decisions locked (from planning conversation):**

1. Three ingest channels: chat attachment (≤200KB, opt-in checkbox) + `/rag/upload` (≤20MB, ≤5 files) + `$DATA_DIR/rag/inbox/` (≤500MB, background scanner)
2. Retrieval is explicit: `rag_search` skill only. No before-turn auto-injection.
3. Single global knowledge base (no per-thread / per-user isolation).
4. `postinstall` scripts allowed — Dockerfile bakes the ONNX model into the image at build time, so runtime has no network dependency.
5. Job & doc lifecycle events over a new SSE endpoint `/rag/events` (independent from `/chat`).
6. Skill calls loopback with `X-Skill-Token` shared secret.
7. Card system is generic — RAG is only the first consumer. 8 kinds: `table`, `list`, `keyvalue`, `stat`, `doc-ref`, `code`, `web-result`, `action-chips`.
8. Cards never re-enter LLM context on subsequent turns (visible only to the user; the accompanying text is what the LLM sees).

---

## 1. Dependency & Dockerfile changes

### 1.1 `package.json` — new backend deps

Add to `dependencies` (do NOT touch existing pinned versions):

```json
"pi-local-rag": "0.4.1",
"@xenova/transformers": "2.17.2",
"better-sqlite3": "12.10.0",
"sqlite-vec": "0.1.9",
"pdf-parse": "1.1.1",
"mammoth": "1.8.0",
"turndown": "7.2.4",
"ignore": "7.0.5"
```

Add to `devDependencies`:

```json
"@types/better-sqlite3": "7.6.11"
```

**Why direct pins instead of relying on pi-local-rag's transitive deps:** we want reproducible resolution and explicit control if pi-local-rag drops these later.

### 1.2 `Dockerfile` — rewritten

```dockerfile
# pi-dyland: personal agent HTTP service.
#
# Four-stage image:
#   1. frontend  — builds the Next.js static export into /web/out.
#   2. deps      — installs backend production npm deps.
#   3. modelcache — downloads the ONNX embedding model (~23 MB) so the runtime
#                   is fully offline. Uses transformers.js cache dir convention.
#   4. runtime   — assembles the final image.
#
# The runtime uses Node 22 with the native TypeScript stripper
# (--experimental-strip-types) so we don't need to precompile the backend.

FROM node:22-bookworm-slim AS frontend
WORKDIR /web
COPY web-next/package.json ./
RUN npm install --ignore-scripts
COPY web-next/ ./
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Native modules (better-sqlite3, onnxruntime-node) need build tools when
# prebuilds are missing. Install once here, dropped from the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
# postinstall scripts are ALLOWED here. onnxruntime-node's prebuild download
# and better-sqlite3's node-gyp fallback both live in postinstall. See
# CLAUDE.md §15.1 exception for pi-local-rag deps.
RUN npm install --omit=dev

FROM node:22-bookworm-slim AS modelcache
WORKDIR /work
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Warm the transformers.js cache. HuggingFace pulls ~23 MB into
# ~/.cache/huggingface/. We move it to a stable location so the runtime
# stage can COPY --from=modelcache and be network-independent.
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface \
    HF_HOME=/root/.cache/huggingface
RUN node --experimental-strip-types --no-warnings -e "\
  const {pipeline} = await import('@xenova/transformers');\
  await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2');\
  console.log('embedder cached');\
"

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Shell-skill runtime deps + libs required by native modules at runtime.
# libstdc++6 covers better-sqlite3 and onnxruntime-node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl jq python3 ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=modelcache /root/.cache/huggingface /root/.cache/huggingface
COPY package.json tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY --from=frontend /web/out ./src/web-next

RUN find ./skills -type f -name 'run.sh' -exec chmod +x {} +

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SKILLS_PATH=/app/skills \
    DATA_DIR=/data \
    TRANSFORMERS_CACHE=/root/.cache/huggingface \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_OFFLINE=1

VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
```

Key points:
- `TRANSFORMERS_OFFLINE=1` forces transformers.js to never hit HuggingFace at runtime. The model is already in the cache layer.
- `libstdc++6` is needed for both `better-sqlite3` prebuild and `onnxruntime-node` `.so` files.
- `build-essential` and `python3` (dev headers) only live in the `deps` stage — runtime image size unaffected.

---

## 2. Env vars

### 2.1 `.env.example` additions

Append at the end:

```dotenv
# -----------------------------------------------------------------------------
# RAG (retrieval-augmented generation) — knowledge base
# -----------------------------------------------------------------------------

# Shared secret used by skills (running as subprocesses) to call the loopback
# /rag/search endpoint without going through Basic Auth. Any non-empty string
# is fine; rotate if leaked.
SKILL_INTERNAL_TOKEN=

# Base URL the rag-search skill uses to reach the server internally. Almost
# always the loopback; only change if the server binds a non-default port.
SKILL_INTERNAL_URL=http://127.0.0.1:8787
```

### 2.2 `.gitignore` additions

Already covered by `data/`, but confirm these are ignored:

```
data/rag/rag.db
data/rag/rag.db-wal
data/rag/rag.db-shm
data/rag/files/
data/rag/inbox/
data/rag/inbox/.processed/
data/rag/inbox/.rejected/
```

---

## 3. New backend files

### 3.1 `src/rag.ts` — RAG facade

```typescript
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
// pi-local-rag re-exports these from its index.ts; peerDependency on
// @mariozechner/pi-coding-agent is only used inside pi-local-rag's own
// extension registration, which we never import.
// eslint-disable-next-line import/no-unresolved
import {
	openDb,
	hybridSearch,
	indexFiles,
	getRagDir,
	setRagDirGetter,
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
	name: string; // pretty display name (from rag_docs table)
	snippet: string; // truncated to RAG_SNIPPET_MAX_CHARS
	lineStart: number;
	lineEnd: number;
	score: number; // 0..1 hybrid
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
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
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

let dataDir: string;
let ragDir: string;
let filesDir: string;
let inboxDir: string;
let db: ReturnType<typeof openDb> | null = null;

const jobs = new Map<string, RagJob>();
const jobQueue: RagJob[] = [];
let workerBusy = false;

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

	// Pin pi-local-rag's storage location to our data dir. Its default is
	// walk-up from cwd, which is unreliable inside the container.
	setRagDirGetter(() => ragDir);

	// Open db (loads sqlite-vec extension, runs schema init, migrates legacy).
	db = openDb();

	// Ensure our sidecar table for original filenames + source tags exists.
	// pi-local-rag has its own `files` table keyed by absolute path; we add
	// `rag_docs` keyed by sha for pretty display + source badges.
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

	// Warm the embedder so the first user query isn't paying the ~2s ONNX
	// load cost. Fire-and-forget; a failed warmup logs but doesn't crash.
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

/**
 * Enqueue a file for ingestion. Returns immediately with a job. Actual
 * processing runs in the background worker. Progress arrives via the
 * event bus.
 */
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
	// Retain the payload alongside the job. We do not store the bytes on the
	// job object itself (kept small for event serialization).
	pendingBytes.set(job.id, input.bytes);
	emitEvent({ type: "job_queued", job });
	setImmediate(runWorker);
	return job;
}

const pendingBytes = new Map<string, Buffer>();

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
	// 1. compute content sha; if already present, no-op with a synthesized done.
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

	// 2. write to $DATA_DIR/rag/files/<sha>/<safeName>
	const safeName = job.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200);
	const docDir = path.join(filesDir, sha);
	await mkdir(docDir, { recursive: true });
	const docPath = path.join(docDir, safeName);
	await writeFile(docPath, bytes);
	job.status = "reading";
	job.pct = 10;
	emitEvent({ type: "job_progress", id: job.id, status: "reading", pct: 10 });

	// 3. call pi-local-rag indexFiles with a progress hook.
	//    pi-local-rag's progress callback signature: (event) => void.
	//    We map its phases to our simplified phase tokens.
	job.status = "chunking";
	job.pct = 25;
	emitEvent({ type: "job_progress", id: job.id, status: "chunking", pct: 25 });

	let chunkCount = 0;
	await indexFiles([docPath], (ev: unknown) => {
		// Best-effort progress mapping. pi-local-rag emits events keyed by
		// phase name; we translate a subset into our own vocabulary. If the
		// shape changes upstream we still get the queued/done bookends.
		const evObj = ev as { phase?: string; done?: number; total?: number };
		if (evObj.phase === "embedding") {
			const total = evObj.total ?? 1;
			const done = evObj.done ?? 0;
			const pct = 25 + Math.floor((done / total) * 70);
			job.status = "embedding";
			job.pct = pct;
			emitEvent({ type: "job_progress", id: job.id, status: "embedding", pct });
		}
	});

	// 4. count chunks written for this file_path
	if (!db) throw new Error("rag db not initialized");
	const row = db.prepare(
		`SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?`,
	).get(docPath) as { n: number };
	chunkCount = row?.n ?? 0;

	// 5. insert into rag_docs sidecar
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

export function listDocs(): RagDocMeta[] {
	if (!db) return [];
	const rows = db.prepare(
		`SELECT sha, name, mime, size, source, added_at as addedAt,
		        (SELECT COUNT(*) FROM chunks WHERE file_path = rag_docs.file_path) AS chunks
		 FROM rag_docs
		 ORDER BY added_at DESC`,
	).all() as Array<RagDocMeta & { chunks: number }>;
	return rows.map((r) => ({ ...r, chunks: r.chunks ?? 0 }));
}

export function getDoc(sha: string): RagDocMeta | null {
	if (!db) return null;
	const row = db.prepare(
		`SELECT sha, name, mime, size, source, file_path as filePath, added_at as addedAt
		 FROM rag_docs WHERE sha = ?`,
	).get(sha) as
		| (RagDocMeta & { filePath: string })
		| undefined;
	if (!row) return null;
	const chunkRow = db.prepare(
		`SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?`,
	).get(row.filePath) as { n: number };
	return {
		sha: row.sha,
		name: row.name,
		mime: row.mime,
		size: row.size,
		source: row.source,
		addedAt: row.addedAt,
		chunks: chunkRow.n ?? 0,
	};
}

function countDocs(): number {
	if (!db) return 0;
	const row = db.prepare(`SELECT COUNT(*) AS n FROM rag_docs`).get() as {
		n: number;
	};
	return row?.n ?? 0;
}

// -----------------------------------------------------------------------------
// Deletion
// -----------------------------------------------------------------------------

export async function deleteDoc(sha: string): Promise<boolean> {
	if (!db) return false;
	const row = db.prepare(`SELECT file_path FROM rag_docs WHERE sha = ?`).get(
		sha,
	) as { file_path: string } | undefined;
	if (!row) return false;
	// Clean chunks + rag_docs row atomically.
	const filePath = row.file_path;
	db.transaction(() => {
		if (!db) return;
		// Delete matching vec rows first (fk-less; use chunks.rowid).
		const rowids = db
			.prepare(`SELECT rowid FROM chunks WHERE file_path = ?`)
			.all(filePath) as Array<{ rowid: number }>;
		for (const { rowid } of rowids) {
			db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`).run(rowid);
		}
		db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);
		db.prepare(`DELETE FROM files WHERE path = ?`).run(filePath);
		db.prepare(`DELETE FROM rag_docs WHERE sha = ?`).run(sha);
	})();
	// Remove the on-disk copy. Best effort; a leaked file is harmless.
	await rm(path.dirname(filePath), { recursive: true, force: true });
	emitEvent({ type: "doc_deleted", sha });
	return true;
}

// -----------------------------------------------------------------------------
// Query
// -----------------------------------------------------------------------------

export async function query(q: string, limit = RAG_SEARCH_DEFAULT_LIMIT): Promise<RagHit[]> {
	if (!db) return [];
	const cappedLimit = Math.max(1, Math.min(RAG_SEARCH_MAX_LIMIT, limit));
	const results = (await hybridSearch(q, cappedLimit)) as Array<{
		chunk: {
			file: string;
			content: string;
			lineStart: number;
			lineEnd: number;
		};
		bm25: number;
		vector: number;
		hybrid: number;
	}>;
	// Look up pretty names in a single map read.
	const pathToName = new Map<string, string>();
	if (db) {
		const rows = db
			.prepare(`SELECT file_path, name FROM rag_docs`)
			.all() as Array<{ file_path: string; name: string }>;
		for (const r of rows) pathToName.set(r.file_path, r.name);
	}
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
```

### 3.2 `src/rag-inbox.ts` — inbox directory scanner

```typescript
import { readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import mime from "node:util"; // placeholder; actual mime detection is by extension
import {
	RAG_ALLOWED_MIMES,
	RAG_MAX_INBOX_BYTES,
	enqueueIngest,
	getInboxDir,
} from "./rag.ts";

const SCAN_INTERVAL_MS = 60_000;
const MAX_PER_TICK = 3;

const EXT_TO_MIME: Record<string, string> = {
	".pdf": "application/pdf",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".html": "text/html",
	".htm": "text/html",
	".json": "application/json",
	".csv": "text/csv",
};

let timer: NodeJS.Timeout | null = null;

export function startInboxScanner(): void {
	if (timer) return;
	const tick = async () => {
		try {
			await scanOnce();
		} catch (err) {
			console.error("[rag-inbox] scan failed:", err);
		}
	};
	timer = setInterval(tick, SCAN_INTERVAL_MS);
	// Kick off one immediate scan so restarts don't wait 60s.
	setImmediate(tick);
	console.log(`[rag-inbox] scanner started, interval ${SCAN_INTERVAL_MS}ms`);
}

export function stopInboxScanner(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function scanOnce(): Promise<void> {
	const inbox = getInboxDir();
	let entries: string[];
	try {
		entries = await readdir(inbox);
	} catch {
		return;
	}
	let processed = 0;
	for (const entry of entries) {
		if (processed >= MAX_PER_TICK) break;
		if (entry.startsWith(".")) continue; // skip .processed / .rejected / dotfiles
		const src = path.join(inbox, entry);
		let st;
		try {
			st = await stat(src);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;

		const ext = path.extname(entry).toLowerCase();
		const detectedMime = EXT_TO_MIME[ext];
		if (!detectedMime || !RAG_ALLOWED_MIMES.has(detectedMime)) {
			await moveTo(src, path.join(inbox, ".rejected", entry), "unsupported extension");
			continue;
		}
		if (st.size > RAG_MAX_INBOX_BYTES) {
			await moveTo(src, path.join(inbox, ".rejected", entry), "too large");
			continue;
		}

		let bytes: Buffer;
		try {
			bytes = await readFile(src);
		} catch (err) {
			console.warn(`[rag-inbox] cannot read ${entry}:`, err);
			continue;
		}
		enqueueIngest({
			name: entry,
			mime: detectedMime,
			bytes,
			source: "inbox",
		});
		try {
			await rename(src, path.join(inbox, ".processed", entry));
		} catch (err) {
			console.warn(`[rag-inbox] cannot archive ${entry}:`, err);
		}
		processed += 1;
	}
	if (processed > 0) {
		console.log(`[rag-inbox] enqueued ${processed} file(s)`);
	}
}

async function moveTo(src: string, dest: string, reason: string): Promise<void> {
	try {
		await rename(src, dest);
		console.warn(`[rag-inbox] rejected ${src}: ${reason}`);
	} catch (err) {
		console.warn(`[rag-inbox] cannot reject ${src}:`, err);
	}
}
```

---

## 4. `src/server.ts` — additions

Do not rewrite the file. Apply these localized edits.

### 4.1 New imports (top of file, near existing imports)

```typescript
import {
	initRag,
	subscribeRag,
	enqueueIngest,
	listDocs,
	getDoc,
	deleteDoc,
	query as ragQuery,
	RAG_MAX_UPLOAD_BYTES,
	RAG_MAX_UPLOAD_FILES,
	RAG_ALLOWED_MIMES,
	RAG_SEARCH_MAX_LIMIT,
	RAG_SEARCH_DEFAULT_LIMIT,
	type RagEvent,
} from "./rag.ts";
import { startInboxScanner } from "./rag-inbox.ts";
```

### 4.2 New env

```typescript
const SKILL_INTERNAL_TOKEN = process.env.SKILL_INTERNAL_TOKEN ?? "";
```

Add a warning if `SKILL_INTERNAL_TOKEN` is empty (rag_search skill won't work):

```typescript
if (!SKILL_INTERNAL_TOKEN) {
	console.warn(
		"[server] WARNING: SKILL_INTERNAL_TOKEN not set. rag_search skill will fail.",
	);
}
```

### 4.3 Init RAG after `initMemory`

```typescript
await initMemory(DATA_DIR);
await initRag(DATA_DIR);
startInboxScanner();
```

### 4.4 Skill token bypass — modify the auth middleware

The existing middleware is:

```typescript
if (authEnabled) {
	app.use("*", async (c, next) => {
		if (c.req.path === "/health") return next();
		return basicAuth({ username: AUTH_USER, password: AUTH_PASS })(c, next);
	});
}
```

Replace with:

```typescript
if (authEnabled) {
	app.use("*", async (c, next) => {
		if (c.req.path === "/health") return next();
		// Loopback-only skill auth: /rag/search accepts X-Skill-Token from a
		// process on 127.0.0.1 (i.e. our own skills). This bypasses Basic Auth
		// so skill subprocesses don't need the human password.
		if (c.req.path === "/rag/search" && SKILL_INTERNAL_TOKEN) {
			const tok = c.req.header("x-skill-token");
			const forwarded = c.req.header("x-forwarded-for");
			const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming
				?.socket?.remoteAddress;
			const isLoopback = !forwarded && (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1");
			if (tok === SKILL_INTERNAL_TOKEN && isLoopback) return next();
		}
		return basicAuth({ username: AUTH_USER, password: AUTH_PASS })(c, next);
	});
}
```

### 4.5 New routes — insert before the `/chat` route

```typescript
// -----------------------------------------------------------------------------
// RAG — knowledge base routes
// -----------------------------------------------------------------------------

const RAG_UPLOAD_BODY_MAX = 110 * 1024 * 1024; // 110MB body cap (5×20MB × 1.33 base64 + overhead)

interface RagUploadFile {
	name?: unknown;
	mime?: unknown;
	bytesBase64?: unknown;
}
interface RagUploadBody {
	files?: unknown;
}

app.post("/rag/upload", async (c) => {
	// Body length pre-flight so a 100MB blob doesn't stall parse.
	const cl = Number(c.req.header("content-length") ?? "0");
	if (cl > RAG_UPLOAD_BODY_MAX) {
		return c.json({ error: `body too large (max ${RAG_UPLOAD_BODY_MAX} bytes)` }, 413);
	}
	const body = (await c.req.json().catch(() => ({}))) as RagUploadBody;
	if (!Array.isArray(body.files)) return c.json({ error: "files[] required" }, 400);
	if (body.files.length === 0) return c.json({ error: "no files" }, 400);
	if (body.files.length > RAG_MAX_UPLOAD_FILES) {
		return c.json({ error: `too many files (max ${RAG_MAX_UPLOAD_FILES})` }, 400);
	}
	const jobs: Array<{ id: string; name: string }> = [];
	for (const [i, raw] of body.files.entries()) {
		if (!raw || typeof raw !== "object") {
			return c.json({ error: `files[${i}] must be an object` }, 400);
		}
		const f = raw as RagUploadFile;
		if (typeof f.name !== "string" || typeof f.mime !== "string" || typeof f.bytesBase64 !== "string") {
			return c.json({ error: `files[${i}] needs {name,mime,bytesBase64}` }, 400);
		}
		if (!RAG_ALLOWED_MIMES.has(f.mime)) {
			return c.json({ error: `files[${i}] mime ${f.mime} not allowed` }, 400);
		}
		let bytes: Buffer;
		try {
			bytes = Buffer.from(f.bytesBase64, "base64");
		} catch {
			return c.json({ error: `files[${i}] invalid base64` }, 400);
		}
		if (bytes.length > RAG_MAX_UPLOAD_BYTES) {
			return c.json({ error: `files[${i}] exceeds ${RAG_MAX_UPLOAD_BYTES} bytes` }, 400);
		}
		const job = enqueueIngest({ name: f.name, mime: f.mime, bytes, source: "upload" });
		jobs.push({ id: job.id, name: job.name });
	}
	return c.json({ jobs }, 202);
});

app.get("/rag/docs", (c) => c.json({ docs: listDocs() }));

app.delete("/rag/docs/:sha", async (c) => {
	const sha = c.req.param("sha");
	const ok = await deleteDoc(sha);
	if (!ok) return c.json({ error: "not found" }, 404);
	return c.json({ ok: true });
});

interface RagSearchBody {
	query?: unknown;
	limit?: unknown;
}
app.post("/rag/search", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as RagSearchBody;
	if (typeof body.query !== "string" || !body.query.trim()) {
		return c.json({ error: "query required" }, 400);
	}
	const limit =
		typeof body.limit === "number" && Number.isFinite(body.limit)
			? Math.max(1, Math.min(RAG_SEARCH_MAX_LIMIT, Math.floor(body.limit)))
			: RAG_SEARCH_DEFAULT_LIMIT;
	const hits = await ragQuery(body.query.trim(), limit);
	return c.json({ hits });
});

// SSE stream for job & doc lifecycle. Same discipline as /chat:
//   - ": ready\n\n" upfront to defeat Cloudflare 524.
//   - 15s heartbeat.
//   - unsubscribe in finally.
app.get("/rag/events", (c) => {
	return streamSSE(c, async (stream) => {
		await stream.write(": ready\n\n").catch(() => {});
		const heartbeat = setInterval(() => {
			stream.write(`: heartbeat ${Date.now()}\n\n`).catch(() => {});
		}, HEARTBEAT_MS);
		const unsub = subscribeRag(async (ev: RagEvent) => {
			try {
				await stream.writeSSE({ data: JSON.stringify(ev) });
			} catch {
				/* stream closed */
			}
		});
		// Keep the handler open until the client disconnects. Hono's
		// streamSSE resolves the promise on close, so we await a never-
		// resolving promise gated by the abort signal.
		await new Promise<void>((resolve) => {
			stream.onAbort(() => resolve());
		});
		clearInterval(heartbeat);
		unsub();
	});
});
```

### 4.6 Chat attachment → RAG hook

Modify `parseAttachments` to accept an optional `addToLibrary` flag per file, and modify `/chat` to enqueue library ingests for flagged files.

**Type additions:**

```typescript
interface ChatFile {
	name: string;
	content: string;
	addToLibrary?: boolean; // NEW
}
```

**In `parseAttachments`**, when iterating files:

```typescript
const addFlag = (rec as { addToLibrary?: unknown }).addToLibrary;
files.push({
	name: safeName,
	content: rec.content,
	addToLibrary: addFlag === true,
});
```

**In `/chat` handler**, after `parsed.files` is validated, right before building `promptText`:

```typescript
for (const f of parsed.files) {
	if (!f.addToLibrary) continue;
	// Chat-side ingest cap is the chat file cap (200KB), enforced by
	// parseAttachments earlier. We forward the bytes as-is.
	try {
		enqueueIngest({
			name: f.name,
			mime: guessMimeFromName(f.name),
			bytes: Buffer.from(f.content, "utf8"),
			source: "chat",
		});
	} catch (err) {
		console.warn("[chat] add-to-library failed:", err);
	}
}
```

Add helper:

```typescript
function guessMimeFromName(name: string): string {
	const ext = name.toLowerCase().slice(name.lastIndexOf("."));
	if (ext === ".md" || ext === ".markdown") return "text/markdown";
	if (ext === ".json") return "application/json";
	if (ext === ".csv") return "text/csv";
	if (ext === ".html" || ext === ".htm") return "text/html";
	return "text/plain";
}
```

### 4.7 Card event forwarding — modify the `agent.subscribe` handler in `/chat`

Cards emitted by skills arrive as an extra content block in the `tool_end` `result`. Add extraction right after the `tool_end` send:

```typescript
case "tool_execution_end": {
	await send({
		type: "tool_end",
		toolCallId: event.toolCallId,
		name: event.toolName,
		result: event.result,
	});
	// Extract card blocks (if any) from the skill result and emit them as
	// separate SSE events. Cards do NOT re-enter LLM context on subsequent
	// turns — the agent state carries `text` blocks only, per skill contract.
	const content = (event.result as { content?: unknown[] })?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: string }).type === "card") {
				const card = block as { kind?: string; payload?: unknown };
				if (typeof card.kind === "string") {
					await send({
						type: "card",
						id: `card-${randomUUID()}`,
						parent: event.toolCallId,
						kind: card.kind,
						payload: card.payload ?? {},
					});
				}
			}
		}
	}
	break;
}
```

### 4.8 Health endpoint — expose RAG doc count

Modify `/health`:

```typescript
app.get("/health", (c) =>
	c.json({
		ok: true,
		aicore: { baseUrl: AICORE_BASE_URL, model: AICORE_MODEL },
		skills: skills.map((s) => ({ name: s.manifest.name, label: s.manifest.label })),
		threads: threads.size,
		rag: { docs: listDocs().length },
	}),
);
```

---

## 5. `src/skill-loader.ts` — strip card blocks from tool result content

The skill result content flows into the LLM's message history verbatim. If we let `type:"card"` blocks land there, the LLM will see raw payload JSON and get confused. Strip them out before returning:

Locate the block that parses stdout and builds `contentBlocks`. Replace with:

```typescript
try {
	const parsed = JSON.parse(text);
	if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as { content?: unknown }).content)
	) {
		const rawContent = (parsed as { content: Array<{ type?: string }> }).content;
		// LLM-visible blocks: text only. Card blocks are surfaced to the UI
		// via the server's tool_end forwarding (see server.ts §4.7); keep
		// them in the raw result for server-side extraction but do NOT let
		// them into the LLM's message stream.
		const llmBlocks = rawContent.filter(
			(b) => b && typeof b === "object" && b.type !== "card",
		);
		contentBlocks = llmBlocks as AgentToolResult<unknown>["content"];
		// details.card_blocks lets the server or a future consumer inspect
		// them without re-parsing stdout.
		const cardBlocks = rawContent.filter(
			(b) => b && typeof b === "object" && b.type === "card",
		);
		details = {
			stderr: outcome.stderr,
			...(cardBlocks.length > 0 ? { card_blocks: cardBlocks } : {}),
		};
		if ((parsed as { details?: unknown }).details !== undefined) {
			details = (parsed as { details: unknown }).details;
		}
	} else {
		contentBlocks = [{ type: "text", text }];
	}
} catch {
	contentBlocks = [{ type: "text", text }];
}
```

**But**, server.ts §4.7 currently reads cards from `event.result.content`. Since we're stripping them from `content`, the server hook needs to read them from `details.card_blocks` instead. Update server.ts §4.7:

```typescript
case "tool_execution_end": {
	await send({
		type: "tool_end",
		toolCallId: event.toolCallId,
		name: event.toolName,
		result: event.result,
	});
	const details = (event.result as { details?: { card_blocks?: unknown } })?.details;
	const cardBlocks = details?.card_blocks;
	if (Array.isArray(cardBlocks)) {
		for (const block of cardBlocks) {
			if (block && typeof block === "object") {
				const card = block as { kind?: string; payload?: unknown };
				if (typeof card.kind === "string") {
					await send({
						type: "card",
						id: `card-${randomUUID()}`,
						parent: event.toolCallId,
						kind: card.kind,
						payload: card.payload ?? {},
					});
				}
			}
		}
	}
	break;
}
```

---

## 6. `src/agent-factory.ts` — system prompt update

Append to `DEFAULT_SYSTEM_PROMPT`:

```
- If the user asks about their own files, notes, or documents (their "library" / "文件库" / "笔记" / "文档"), call rag_search with a focused query before answering. Never invent contents; only cite what rag_search returned.
- When rag_search returns hits, summarize in your own words and reference the source names in prose. The UI renders per-file cards automatically — do NOT paste the raw snippet JSON back into your reply.
```

---

## 7. `skills/rag-search/`

### 7.1 `skills/rag-search/skill.json`

```json
{
  "name": "rag_search",
  "label": "Search library",
  "description": "Search the user's personal knowledge base (uploaded documents, notes, and files they've added to their library). Use this when the user asks about the contents of their documents, notes, or files. Provide a focused natural-language query. Returns up to 10 relevant snippets with file names, line numbers, and scores. Snippets are rendered as visual cards for the user; you should summarize them in prose, not paste JSON.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural-language search query. Keep it focused — 3-15 words works best. Match the language of the user's request."
      },
      "limit": {
        "type": "integer",
        "description": "Max hits to return (1-10). Default 5."
      }
    },
    "required": ["query"]
  },
  "entry": "run.sh",
  "env": ["SKILL_INTERNAL_TOKEN", "SKILL_INTERNAL_URL"],
  "timeoutMs": 15000
}
```

### 7.2 `skills/rag-search/run.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SKILL_INTERNAL_TOKEN:?SKILL_INTERNAL_TOKEN not set}"
BASE_URL="${SKILL_INTERNAL_URL:-http://127.0.0.1:8787}"

INPUT="$(cat)"
QUERY="$(echo "$INPUT" | jq -r '.query // empty')"
LIMIT="$(echo "$INPUT" | jq -r '.limit // 5')"

if [[ -z "$QUERY" ]]; then
  echo "missing: query" >&2
  exit 2
fi

# Call the loopback endpoint. jq builds the request body so quoting is safe.
BODY="$(jq -nc --arg q "$QUERY" --argjson n "$LIMIT" '{query: $q, limit: $n}')"
RESP="$(curl -sS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Skill-Token: ${SKILL_INTERNAL_TOKEN}" \
  --max-time 12 \
  -d "$BODY" \
  "${BASE_URL}/rag/search")"

# Extract hits array. If empty, tell the LLM plainly.
HITS_COUNT="$(echo "$RESP" | jq '.hits | length // 0')"

if [[ "$HITS_COUNT" == "0" ]]; then
  # No card blocks; a single text block for the LLM.
  jq -n --arg t "No results found in your library for query: $QUERY. The library may not contain relevant material — consider uploading source documents to /library." \
    '{content: [{type:"text", text:$t}]}'
  exit 0
fi

# Build a short text summary for the LLM and one doc-ref card per hit for
# the UI. `content` mixes text + card blocks; skill-loader.ts filters cards
# out of the LLM-visible content and forwards them via details.card_blocks.
SUMMARY="$(echo "$RESP" | jq -r '.hits | to_entries | map("[" + (.key+1|tostring) + "] " + .value.name + " (lines " + (.value.lineStart|tostring) + "-" + (.value.lineEnd|tostring) + ", score " + (.value.score|tostring|.[0:4]) + ")") | join("\n")')"

# Emit content array: one text block + N card blocks.
echo "$RESP" | jq --arg summary "Found ${HITS_COUNT} relevant snippets in the user's library:
${SUMMARY}

The UI is rendering per-file cards. Summarize the content in prose; do not paste the snippets." '
{
  content: (
    [{type:"text", text:$summary}]
    +
    (.hits | map({
      type: "card",
      kind: "doc-ref",
      payload: {
        name: .name,
        file: .file,
        lineStart: .lineStart,
        lineEnd: .lineEnd,
        score: .score,
        snippet: .snippet
      }
    }))
  )
}'
```

Mark executable: `chmod +x skills/rag-search/run.sh`

---

## 8. Frontend (`web-next/`)

### 8.1 `web-next/src/lib/api.ts` — add helpers

Append to the existing file:

```typescript
export interface RagDoc {
	sha: string;
	name: string;
	mime: string;
	size: number;
	chunks: number;
	source: "chat" | "upload" | "inbox";
	addedAt: number;
}

export interface RagJob {
	id: string;
	name: string;
	mime: string;
	size: number;
	source: RagDoc["source"];
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
	| { type: "job_done"; id: string; doc: RagDoc }
	| { type: "job_failed"; id: string; error: string }
	| { type: "doc_deleted"; sha: string };

export async function listRagDocs(): Promise<RagDoc[]> {
	const res = await fetch("/rag/docs", { credentials: "include" });
	if (!res.ok) throw new Error(`listRagDocs ${res.status}`);
	const data = (await res.json()) as { docs: RagDoc[] };
	return data.docs;
}

export async function deleteRagDoc(sha: string): Promise<void> {
	const res = await fetch(`/rag/docs/${encodeURIComponent(sha)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) throw new Error(`deleteRagDoc ${res.status}`);
}

export async function uploadRagFiles(
	files: Array<{ name: string; mime: string; bytes: ArrayBuffer }>,
): Promise<Array<{ id: string; name: string }>> {
	const payload = {
		files: files.map((f) => ({
			name: f.name,
			mime: f.mime,
			bytesBase64: bufferToBase64(f.bytes),
		})),
	};
	const res = await fetch("/rag/upload", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`uploadRagFiles ${res.status}: ${t}`);
	}
	const data = (await res.json()) as { jobs: Array<{ id: string; name: string }> };
	return data.jobs;
}

function bufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as number[]);
	}
	return btoa(bin);
}

/**
 * Subscribe to the /rag/events SSE stream. Uses fetch + ReadableStream so
 * Basic Auth is picked up automatically by the browser (unlike EventSource
 * on cross-realm setups). Returns a stop function.
 */
export function streamRagEvents(
	onEvent: (ev: RagEvent) => void,
	onError?: (err: unknown) => void,
): () => void {
	const ctrl = new AbortController();
	(async () => {
		try {
			const res = await fetch("/rag/events", {
				credentials: "include",
				signal: ctrl.signal,
				headers: { Accept: "text/event-stream" },
			});
			if (!res.ok || !res.body) throw new Error(`streamRagEvents ${res.status}`);
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let idx;
				while ((idx = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					for (const line of frame.split("\n")) {
						if (line.startsWith("data:")) {
							const raw = line.slice(5).trim();
							if (!raw) continue;
							try {
								onEvent(JSON.parse(raw) as RagEvent);
							} catch {
								/* ignore malformed frames */
							}
						}
					}
				}
			}
		} catch (err) {
			if ((err as { name?: string }).name !== "AbortError" && onError) onError(err);
		}
	})();
	return () => ctrl.abort();
}
```

### 8.2 `web-next/src/app/library/page.tsx`

```tsx
import type { Metadata } from "next";
import { LibraryView } from "@/components/library-view";

export const metadata: Metadata = {
	title: "文件库 · pi-dyland",
};

export default function LibraryPage() {
	return <LibraryView />;
}
```

### 8.3 `web-next/src/components/library-view.tsx`

```tsx
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Inbox, Loader2, Search, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	type RagDoc,
	type RagEvent,
	type RagJob,
	deleteRagDoc,
	listRagDocs,
	streamRagEvents,
	uploadRagFiles,
} from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/utils";

const ACCEPT =
	".pdf,.docx,.txt,.md,.markdown,.html,.htm,.json,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html,application/json,text/csv";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;

const SOURCE_LABEL: Record<RagDoc["source"], string> = {
	chat: "chat",
	inbox: "inbox",
	upload: "upload",
};

export function LibraryView() {
	const [docs, setDocs] = useState<RagDoc[]>([]);
	const [jobs, setJobs] = useState<Map<string, RagJob>>(new Map());
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [dragOver, setDragOver] = useState(false);
	const [uploading, setUploading] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Initial fetch.
	useEffect(() => {
		listRagDocs()
			.then(setDocs)
			.catch((err) => setError(String(err)));
	}, []);

	// SSE subscription.
	useEffect(() => {
		const stop = streamRagEvents(
			(ev: RagEvent) => {
				setJobs((prev) => {
					const next = new Map(prev);
					if (ev.type === "job_queued") {
						next.set(ev.job.id, ev.job);
					} else if (ev.type === "job_progress") {
						const existing = next.get(ev.id);
						if (existing) {
							next.set(ev.id, { ...existing, status: ev.status, pct: ev.pct });
						}
					} else if (ev.type === "job_done") {
						next.delete(ev.id);
						setDocs((d) => {
							const filtered = d.filter((x) => x.sha !== ev.doc.sha);
							return [ev.doc, ...filtered];
						});
					} else if (ev.type === "job_failed") {
						const existing = next.get(ev.id);
						if (existing) {
							next.set(ev.id, {
								...existing,
								status: "failed",
								pct: 100,
								error: ev.error,
							});
						}
					} else if (ev.type === "doc_deleted") {
						setDocs((d) => d.filter((x) => x.sha !== ev.sha));
					}
					return next;
				});
			},
			(err) => setError(String(err)),
		);
		return stop;
	}, []);

	const totalBytes = useMemo(() => docs.reduce((n, d) => n + d.size, 0), [docs]);
	const filteredDocs = useMemo(() => {
		if (!filter.trim()) return docs;
		const q = filter.toLowerCase();
		return docs.filter((d) => d.name.toLowerCase().includes(q));
	}, [docs, filter]);

	const handleFiles = useCallback(async (fs: File[]) => {
		setError(null);
		const accepted = fs.filter((f) => f.size <= MAX_BYTES).slice(0, MAX_FILES);
		if (accepted.length !== fs.length) {
			setError(
				`部分文件被跳过（超过 ${MAX_BYTES / 1024 / 1024}MB 或超过一次 ${MAX_FILES} 个上限）。大文件请放到 NAS 的 $DATA_DIR/rag/inbox/ 目录。`,
			);
		}
		if (accepted.length === 0) return;
		setUploading(true);
		try {
			const payloads = await Promise.all(
				accepted.map(async (f) => ({
					name: f.name,
					mime: f.type || "application/octet-stream",
					bytes: await f.arrayBuffer(),
				})),
			);
			await uploadRagFiles(payloads);
		} catch (err) {
			setError(String(err));
		} finally {
			setUploading(false);
		}
	}, []);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragOver(false);
			const fs = Array.from(e.dataTransfer.files);
			void handleFiles(fs);
		},
		[handleFiles],
	);

	const onPick = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const fs = Array.from(e.target.files ?? []);
			if (fs.length > 0) void handleFiles(fs);
			if (inputRef.current) inputRef.current.value = "";
		},
		[handleFiles],
	);

	const onDelete = useCallback(async (sha: string) => {
		if (!confirm("删除这份文档？")) return;
		try {
			await deleteRagDoc(sha);
		} catch (err) {
			setError(String(err));
		}
	}, []);

	const activeJobs = Array.from(jobs.values()).filter(
		(j) => j.status !== "done" && j.status !== "failed",
	);
	const failedJobs = Array.from(jobs.values()).filter((j) => j.status === "failed");

	return (
		<div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
			<header className="flex items-center gap-3 border-b border-border/50 px-4 py-3">
				<Link href="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
					<ArrowLeft className="h-4 w-4" />
					<span className="hidden sm:inline">返回聊天</span>
				</Link>
				<h1 className="text-base font-semibold">📚 文件库</h1>
				<span className="text-xs text-muted-foreground">
					{docs.length} 篇 · {formatBytes(totalBytes)}
				</span>
			</header>

			<main className="flex-1 overflow-y-auto px-4 py-4">
				<section
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={onDrop}
					className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
						dragOver ? "border-primary bg-primary/5" : "border-border/60"
					}`}
				>
					<Upload className="mx-auto h-6 w-6 text-muted-foreground" />
					<p className="mt-2 text-sm">拖文件到这里，或</p>
					<button
						type="button"
						className="mt-1 text-sm text-primary underline underline-offset-4"
						onClick={() => inputRef.current?.click()}
					>
						点击选择文件
					</button>
					<input
						ref={inputRef}
						type="file"
						multiple
						accept={ACCEPT}
						className="hidden"
						onChange={onPick}
					/>
					<p className="mt-3 text-xs text-muted-foreground">
						PDF / DOCX / TXT / MD / HTML / JSON / CSV · 单文件 ≤ 20MB · 一次最多 5 个
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						更大的文件请放到 NAS 上的 <code>$DATA_DIR/rag/inbox/</code> 目录
					</p>
					{uploading && (
						<p className="mt-2 flex items-center justify-center gap-1 text-xs text-primary">
							<Loader2 className="h-3 w-3 animate-spin" /> 上传中…
						</p>
					)}
				</section>

				{error && (
					<div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						{error}
					</div>
				)}

				{activeJobs.length > 0 && (
					<section className="mt-6">
						<h2 className="mb-2 text-sm font-medium text-muted-foreground">
							🔄 处理中 ({activeJobs.length})
						</h2>
						<ul className="space-y-2">
							{activeJobs.map((j) => (
								<li
									key={j.id}
									className="flex items-center gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm"
								>
									<span className="flex-1 truncate">{j.name}</span>
									<span className="w-32 rounded-full bg-muted h-2 overflow-hidden">
										<span
											className="block h-full bg-primary transition-all"
											style={{ width: `${j.pct}%` }}
										/>
									</span>
									<span className="w-20 text-xs text-muted-foreground">{j.status}</span>
								</li>
							))}
						</ul>
					</section>
				)}

				{failedJobs.length > 0 && (
					<section className="mt-6">
						<h2 className="mb-2 text-sm font-medium text-destructive">
							❌ 失败 ({failedJobs.length})
						</h2>
						<ul className="space-y-1">
							{failedJobs.map((j) => (
								<li
									key={j.id}
									className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
								>
									<div className="truncate font-medium">{j.name}</div>
									<div className="text-destructive/80">{j.error ?? "unknown error"}</div>
								</li>
							))}
						</ul>
					</section>
				)}

				<section className="mt-6">
					<div className="mb-2 flex items-center justify-between gap-2">
						<h2 className="text-sm font-medium text-muted-foreground">📄 已入库文档</h2>
						<div className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1">
							<Search className="h-3 w-3 text-muted-foreground" />
							<input
								type="text"
								placeholder="按文件名过滤…"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								className="w-40 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
							/>
						</div>
					</div>
					{filteredDocs.length === 0 ? (
						<div className="rounded-md border border-border/40 bg-card/20 p-6 text-center text-sm text-muted-foreground">
							<Inbox className="mx-auto mb-2 h-6 w-6" />
							{docs.length === 0
								? "还没有任何文档。上传一份，或让文件出现在 NAS 的 inbox 目录里。"
								: "没有匹配的文档。"}
						</div>
					) : (
						<ul className="space-y-2">
							{filteredDocs.map((d) => (
								<li
									key={d.sha}
									className="flex items-center gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm"
								>
									<span className="flex-1 truncate">{d.name}</span>
									<Badge variant="secondary" className="text-xs">
										{SOURCE_LABEL[d.source]}
									</Badge>
									<span className="w-20 text-right text-xs text-muted-foreground">
										{formatBytes(d.size)}
									</span>
									<span className="w-14 text-right text-xs text-muted-foreground">
										{d.chunks} chk
									</span>
									<span className="w-20 text-right text-xs text-muted-foreground">
										{formatRelativeTime(d.addedAt)}
									</span>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => onDelete(d.sha)}
										className="h-7 w-7 p-0"
										aria-label="删除"
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</li>
							))}
						</ul>
					)}
				</section>
			</main>
		</div>
	);
}
```

### 8.4 `web-next/src/lib/utils.ts` — add helpers (append)

```typescript
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}秒前`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}小时前`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}天前`;
	return new Date(ts).toLocaleDateString();
}
```

### 8.5 Card renderer components

Create `web-next/src/components/cards/`:

**`card-renderer.tsx`:**

```tsx
"use client";

import type { CardKind, CardPayload } from "@/lib/cards";
import { CardTable } from "./card-table";
import { CardList } from "./card-list";
import { CardKeyvalue } from "./card-keyvalue";
import { CardStat } from "./card-stat";
import { CardDocRef } from "./card-doc-ref";
import { CardCode } from "./card-code";
import { CardWebResult } from "./card-web-result";
import { CardActionChips } from "./card-action-chips";

export function CardRenderer({ kind, payload }: { kind: CardKind; payload: CardPayload }) {
	switch (kind) {
		case "table": return <CardTable payload={payload as never} />;
		case "list": return <CardList payload={payload as never} />;
		case "keyvalue": return <CardKeyvalue payload={payload as never} />;
		case "stat": return <CardStat payload={payload as never} />;
		case "doc-ref": return <CardDocRef payload={payload as never} />;
		case "code": return <CardCode payload={payload as never} />;
		case "web-result": return <CardWebResult payload={payload as never} />;
		case "action-chips": return <CardActionChips payload={payload as never} />;
		default: return null;
	}
}
```

**`web-next/src/lib/cards.ts`:**

```typescript
export type CardKind =
	| "table"
	| "list"
	| "keyvalue"
	| "stat"
	| "doc-ref"
	| "code"
	| "web-result"
	| "action-chips";

export type CardPayload = unknown;

export interface CardBlock {
	id: string;
	parent: string | null;
	kind: CardKind;
	payload: CardPayload;
}

export interface TablePayload {
	title?: string;
	columns: string[];
	rows: Array<Array<string | number | null>>;
}

export interface ListPayload {
	title?: string;
	items: Array<{ title: string; subtitle?: string; icon?: string; href?: string }>;
}

export interface KeyvaluePayload {
	title?: string;
	entries: Array<{ key: string; value: string; copyable?: boolean; secret?: boolean }>;
}

export interface StatPayload {
	label: string;
	value: string | number;
	delta?: string;
	tone?: "neutral" | "positive" | "negative";
}

export interface DocRefPayload {
	name: string;
	file: string;
	lineStart: number;
	lineEnd: number;
	score: number;
	snippet: string;
}

export interface CodePayload {
	language?: string;
	code: string;
}

export interface WebResultPayload {
	title: string;
	url: string;
	summary?: string;
	favicon?: string;
}

export interface ActionChipsPayload {
	prompts: string[];
}
```

**Individual card components** (`card-table.tsx`, etc.) — each is a small shadcn-style component. Compact examples:

```tsx
// card-table.tsx
import type { TablePayload } from "@/lib/cards";
export function CardTable({ payload }: { payload: TablePayload }) {
	return (
		<div className="my-2 overflow-x-auto rounded-md border border-border/50 bg-card/40">
			{payload.title && <div className="border-b border-border/50 px-3 py-2 text-xs font-medium">{payload.title}</div>}
			<table className="w-full text-xs">
				<thead className="bg-muted/40">
					<tr>{payload.columns.map((c) => <th key={c} className="px-2 py-1 text-left font-medium">{c}</th>)}</tr>
				</thead>
				<tbody>
					{payload.rows.map((row, i) => (
						<tr key={i} className="border-t border-border/30">
							{row.map((cell, j) => <td key={j} className="px-2 py-1">{cell ?? ""}</td>)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
```

```tsx
// card-doc-ref.tsx
import type { DocRefPayload } from "@/lib/cards";
import { FileText } from "lucide-react";
import { useState } from "react";
export function CardDocRef({ payload }: { payload: DocRefPayload }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="my-2 rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm">
			<div className="flex items-center gap-2">
				<FileText className="h-4 w-4 text-muted-foreground" />
				<span className="flex-1 truncate font-medium">{payload.name}</span>
				<span className="text-xs text-muted-foreground">
					L{payload.lineStart}–{payload.lineEnd} · {payload.score.toFixed(2)}
				</span>
			</div>
			<button
				type="button"
				className="mt-1 text-xs text-primary underline underline-offset-4"
				onClick={() => setOpen((v) => !v)}
			>
				{open ? "收起" : "展开片段"}
			</button>
			{open && (
				<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">
					{payload.snippet}
				</pre>
			)}
		</div>
	);
}
```

(other 6 kinds follow the same shadcn pattern — trivial once table + doc-ref are in place)

### 8.6 Wire cards into MessageList

`web-next/src/components/message-list.tsx` (or wherever assistant messages are rendered): each assistant message gains a `cards: CardBlock[]` field. In the chat reducer:

```typescript
case "card":
	// Attach to the current in-flight assistant message.
	if (state.streaming) {
		const last = state.messages[state.messages.length - 1];
		if (last?.role === "assistant") {
			last.cards = [...(last.cards ?? []), {
				id: ev.id, parent: ev.parent, kind: ev.kind, payload: ev.payload,
			}];
		}
	}
	break;
```

Render cards inside the assistant bubble, below the text:

```tsx
{message.cards?.map((c) => <CardRenderer key={c.id} kind={c.kind} payload={c.payload} />)}
```

### 8.7 Chat composer: "add to library" checkbox

In `web-next/src/components/composer.tsx`, next to the attach button add a checkbox that toggles a state `addToLibrary`. When submitting `/chat`, include `addToLibrary` on each file object in the JSON payload. If any selected file is > 200KB, disable the checkbox and show a tooltip linking to `/library`.

### 8.8 Chat header: library entry

In the chat header (`chat-app.tsx`), add:

```tsx
<Link href="/library" aria-label="文件库">
	<Button variant="ghost" size="sm"><Library className="h-4 w-4" /></Button>
</Link>
```

---

## 9. `pi-dyland/CLAUDE.md` — section-by-section diffs

### §3 Directory structure — additions

```
├── src/
│   ├── rag.ts              # RAG facade over pi-local-rag (init, ingest, query, delete)
│   ├── rag-inbox.ts        # 60s scanner for $DATA_DIR/rag/inbox
│   └── ...existing files...
├── skills/
│   ├── rag-search/         # snake→tool `rag_search`
│   └── ...existing skills...
├── web-next/src/
│   ├── app/library/        # /library page
│   ├── components/
│   │   ├── library-view.tsx
│   │   └── cards/          # generic card renderer + 8 kinds
│   └── lib/
│       └── cards.ts        # CardKind, payload types
```

### §4 File creation rules — additions

Explicitly-allowed new backend files:
- `src/rag.ts` — RAG facade. Owns event bus, ingest queue, doc metadata. All pi-local-rag interaction is confined here so §7's "no deep imports" rule stays clean.
- `src/rag-inbox.ts` — inbox scanner. Runs a 60s interval; small enough to inline but split from server.ts because it owns a timer + its own lifecycle.

Everything else about `src/config.ts` / `src/logger.ts` / `src/types.ts` remains forbidden.

### §6 HTTP routes — table additions

| Route | Method | Contract |
|---|---|---|
| `/rag/upload` | POST | Auth. Body: `{files:[{name,mime,bytesBase64}]}`. Limits: 5 files/req, 20MB/file raw, 110MB body cap. Returns 202 `{jobs:[{id,name}]}`. Async — subscribe to `/rag/events` for status. |
| `/rag/docs` | GET | Auth. Returns `{docs:[{sha,name,mime,size,chunks,source,addedAt}]}`. |
| `/rag/docs/:sha` | DELETE | Auth. 404 if unknown. |
| `/rag/search` | POST | **Loopback + X-Skill-Token only**, not for humans. Body `{query, limit?}`, returns `{hits:[{file,name,snippet,lineStart,lineEnd,score,bm25,vector}]}`. |
| `/rag/events` | GET | Auth. SSE. Events: `job_queued`, `job_progress`, `job_done`, `job_failed`, `doc_deleted`. Same `:ready` + heartbeat rules as `/chat`. |

Fixed SSE event whitelist for `/chat` gains one more: `card`. Payload: `{id, parent, kind, payload}` where `kind ∈ {table,list,keyvalue,stat,doc-ref,code,web-result,action-chips}`. Cards do **not** re-enter LLM context.

### §8 Skills — additions

Skill stdout may now include `{type:"card", kind, payload}` blocks alongside `{type:"text"}` in the top-level `content` array. `skill-loader.ts` strips card blocks from LLM-visible content and forwards them via `details.card_blocks`. Constraints:
- Every card payload ≤ 32KB serialized.
- Tables ≤ 100 rows × 10 columns; skill must truncate.
- Card kinds are a closed set; unknown `kind` values are silently dropped by the UI.

Current skill inventory adds:
- `rag-search` → tool `rag_search` (hybrid FTS+vector, loopback HTTP to `/rag/search`).

### §9 Data & state — additions

Additional durable paths permitted under `$DATA_DIR`:
- `$DATA_DIR/rag/rag.db` (+ `-wal`, `-shm`) — SQLite index managed by pi-local-rag.
- `$DATA_DIR/rag/files/<sha>/<name>` — original uploaded documents (kept so we can regenerate the index if needed).
- `$DATA_DIR/rag/inbox/` — user-facing drop directory; `.processed/` and `.rejected/` are lifecycle subdirs.

Everything else about "no chat history persistence" remains.

### §10 Frontend — additions

- New route: `/library` (Next.js App Router, static export). Uses `fetch` + ReadableStream to consume `/rag/events` for the same reason `streamChat` does (Basic Auth interop).
- Card renderers live under `web-next/src/components/cards/` — one file per kind. Payloads typed in `web-next/src/lib/cards.ts` (mirror the server's skill contract). Unknown kinds render nothing.
- Cards attach to assistant messages under `cards[]` but are **never** replayed on `/messages` reload — they are transient UI artifacts; history reload shows text-only assistant messages. This mirrors §9's "no chat history persistence" spirit.
- Chat composer gains an "add to library" checkbox. Disabled + tooltip when any selected file > 200KB. The 200KB / 20MB / 500MB three-tier ceiling is fixed; do not add a bulk uploader.

### §15.1 — postinstall exception

Amend the "no postinstall" rule with an exception:

> Exception: `pi-local-rag` and its transitive deps (`@xenova/transformers`, `better-sqlite3`, `onnxruntime-node`) require `postinstall` for prebuild download / native compile fallback. This is explicitly allowed **only in the `deps` Docker stage**. The runtime image copies compiled `node_modules` in — no postinstall runs at runtime. Local dev on macOS must also allow these; do not `--ignore-scripts` after this change.

### §16 Out of scope — remove RAG from the implicit "no persistence" scope

Add:

> **In scope (via §3/§6/§8/§9/§10 rules above):** RAG knowledge base — file ingest (3 channels), hybrid search skill, `/library` UI. This is user-facing personal-notes storage, not chat history.

---

## 10. NAS deployment checklist

1. **Local build & sync:**
   ```bash
   cd pi-dyland/web-next && npm ci && npm run build && cd ..
   rm -rf src/web-next && mkdir -p src/web-next && cp -R web-next/out/. src/web-next/
   git add -A && git commit -m "feat: rag + card system"
   git push origin vk/7c97-rag
   ```

2. **On NAS (via `sshpass` + `nas` alias per CLAUDE.md §15.2):**
   ```bash
   cd /tmp/zfsv3/sata11/15869560895/data/pi-dyland
   git fetch origin vk/7c97-rag && git checkout vk/7c97-rag && git reset --hard FETCH_HEAD
   ```

3. **Add new env var to `.env`:**
   ```bash
   echo "SKILL_INTERNAL_TOKEN=$(openssl rand -hex 32)" >> .env
   ```

4. **Rebuild image (background because ONNX warmup + native compile takes 3–5 min):**
   ```bash
   nohup bash -c "
     sudo docker build -t pi-dyland:local . &&
     sudo docker rm -f pi-dyland &&
     sudo docker run -d --name pi-dyland --restart unless-stopped \
       --network host --env-file .env \
       -v \"$PWD/skills\":/app/skills:ro \
       -v /tmp/zfsv3/sata11/15869560895/data/pi-dyland-data:/data \
       pi-dyland:local
   " > /tmp/pi-dyland-build.log 2>&1 &
   ```

5. **Verify:**
   ```bash
   curl -sS http://127.0.0.1:8787/health | jq '.rag'
   # Expect: {"docs":0}

   # Upload a small test doc
   B64=$(base64 -w0 < some.pdf)
   curl -sS -u user:pass -H 'Content-Type: application/json' \
     -d "{\"files\":[{\"name\":\"test.pdf\",\"mime\":\"application/pdf\",\"bytesBase64\":\"$B64\"}]}" \
     http://127.0.0.1:8787/rag/upload
   # Expect: 202 with jobs[]

   # After ~10s, check docs
   curl -sS -u user:pass http://127.0.0.1:8787/rag/docs | jq
   ```

6. **Cloudflare tunnel** — no config change needed. `pi.superdyland.uk` already points at `127.0.0.1:8787`; new routes ride the existing ingress.

7. **Test inbox path:**
   ```bash
   cp somebook.pdf /tmp/zfsv3/sata11/15869560895/data/pi-dyland-data/rag/inbox/
   # Watch: docker logs pi-dyland | grep rag-inbox
   # After ≤60s + processing time, appears in /rag/docs with source:"inbox"
   ```

8. **Rollback:**
   ```bash
   git checkout main && sudo docker build -t pi-dyland:local . && sudo docker rm -f pi-dyland && sudo docker run ...
   ```

---

## 11. Known risks / open items

1. **pi-local-rag's `indexFiles` progress callback shape** — I inferred `{phase, done, total}` from the research report but haven't verified. If it emits differently, the `/rag/events` `job_progress` events won't fire mid-embedding; the job will just jump from `chunking` to `done`. Non-fatal; UX degrades to "spinner then done".

2. **`setRagDirGetter` presence** — the research confirmed it's exported. If a future pi-local-rag version drops it, fall back to setting `PI_RAG_DIR=/data/rag` env var before `initRag()`.

3. **Native binary rebuild on NAS** — `better-sqlite3` and `onnxruntime-node` prebuilds might not have `linux-x64` for the NAS's specific glibc. If `npm install` in the `deps` stage falls back to source compile, first build takes 5–10 min. Subsequent rebuilds cached.

4. **HuggingFace 23MB in build cache** — image size grows by ~30MB. Acceptable.

5. **Concurrent access to `rag.db` from inbox scanner + upload handler** — `better-sqlite3` is synchronous and single-threaded per connection. Both paths currently share `db` and serialize naturally through the JS event loop. **Do not** open a second connection for the inbox scanner.

6. **Large PDFs with OCR** — the research showed pi-local-rag has optional `pdftoppm`+`tesseract` OCR. We are NOT installing those in the runtime image. Scanned PDFs will silently produce empty or very short text. If needed later, add `apt install poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim` to the runtime stage (~200MB size hit).

7. **`libraryLibrary` UI does not currently show download link for the original file.** Deferred; add `/rag/docs/:sha/download` later if the owner asks.

---

## 12. What this spec does NOT include (deferred)

- Streaming ingest (multipart, chunked) — the base64-in-JSON channel is the only supported HTTP upload, per CLAUDE.md §10.
- Search UI inside `/library` (users searching their own docs via UI, not via LLM). RAG search is LLM-mediated only in v1.
- Per-doc preview / render (viewing a PDF/DOCX in-browser).
- OCR for scanned PDFs.
- Multi-user knowledge base separation.
- Card kinds beyond the eight listed.
- Markdown-fence card triggering from LLM output (option A path from the design discussion — implement later if needed).
- Progress cancellation from the UI (kill an in-flight ingest job).

Each is a follow-up PR when a real need appears.
