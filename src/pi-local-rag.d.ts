// Ambient module shims for packages that ship raw TypeScript sources whose
// own strictness settings do not match ours (verbatimModuleSyntax,
// noUncheckedIndexedAccess). tsc's `skipLibCheck` only skips .d.ts files, so
// once nodenext resolution pulls in a package's `.ts` source we get all its
// internal errors. Declaring the module here shadows the source with a
// hand-written type surface — enough for our own imports to typecheck without
// dragging in upstream strictness violations.
//
// Kept minimal: only the identifiers we actually import.

declare module "pi-local-rag" {
	import type BetterSqlite3 from "better-sqlite3";

	export interface Chunk {
		id: string;
		file: string;
		content: string;
		lineStart: number;
		lineEnd: number;
		hash: string;
		indexed: string;
		tokens: number;
		vector?: number[];
	}

	export interface IndexMeta {
		chunks: Chunk[];
		files: Record<
			string,
			{ hash: string; chunks: number; indexed: string; size: number; embedded?: boolean }
		>;
		lastBuild: string;
		embeddingModel?: string;
	}

	export interface ScoredChunk {
		chunk: Chunk;
		bm25: number;
		vector: number;
		hybrid: number;
	}

	export interface ProgressCallbacks {
		onFile?: (
			current: number,
			total: number,
			filename: string,
			skipped: number,
		) => void;
		onChunk?: (
			fileChunk: number,
			totalChunks: number,
			filename: string,
		) => void;
		onEmbed?: (done: number, total: number) => void;
		onSave?: () => void;
	}

	export function openDb(ragDir?: string): BetterSqlite3.Database;
	export function loadIndex(): IndexMeta;
	export function hybridSearch(
		query: string,
		index: IndexMeta,
		limit?: number,
		alpha?: number,
		db?: BetterSqlite3.Database,
	): Promise<ScoredChunk[]>;
	export function indexFiles(
		paths: string[],
		progress?: ProgressCallbacks,
		db?: BetterSqlite3.Database,
		force?: boolean,
	): Promise<{ indexed: number; chunks: number; skipped: number; durationMs: number }>;
	export function embed(text: string): Promise<number[]>;
}

declare module "@xenova/transformers" {
	export const env: {
		cacheDir: string;
		remoteHost: string;
		localModelPath: string;
		[key: string]: unknown;
	};
	export function pipeline(task: string, model: string): Promise<unknown>;
}
