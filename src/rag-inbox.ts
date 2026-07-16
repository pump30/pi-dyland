import { readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
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
	if (!inbox) return;
	let entries: string[];
	try {
		entries = await readdir(inbox);
	} catch {
		return;
	}
	let processed = 0;
	for (const entry of entries) {
		if (processed >= MAX_PER_TICK) break;
		if (entry.startsWith(".")) continue;
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
