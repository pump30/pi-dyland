import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPersonalAgent } from "./agent-factory.ts";
import { loadSkills } from "./skill-loader.ts";
import { initMemory } from "./memory.ts";

// -----------------------------------------------------------------------------
// Config from env
// -----------------------------------------------------------------------------

const AICORE_BASE_URL = process.env.AICORE_BASE_URL ?? "https://aicore.superdyland.uk";
const AICORE_MODEL = process.env.AICORE_MODEL ?? "my-claude-opus";
const AICORE_TOKEN = process.env.AICORE_TOKEN ?? "";
const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const SKILLS_PATH = (process.env.SKILLS_PATH ?? "./skills").split(":").filter(Boolean);
const CLAUDE_SKILLS_PATH = (process.env.CLAUDE_SKILLS_PATH ?? "").split(":").filter(Boolean);
const AUTH_USER = process.env.AUTH_USER ?? "";
const AUTH_PASS = process.env.AUTH_PASS ?? "";
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");

if (!AICORE_TOKEN) {
	console.error("[server] AICORE_TOKEN is not set. The agent cannot call the LLM backend.");
	process.exit(1);
}

const authEnabled = Boolean(AUTH_USER && AUTH_PASS);
if (!authEnabled) {
	console.warn(
		"[server] WARNING: AUTH_USER/AUTH_PASS not set. HTTP server is unauthenticated. " +
			"Set both in .env to enable Basic Auth for everything except /health.",
	);
}

// -----------------------------------------------------------------------------
// Load skills; build per-thread agents lazily.
// -----------------------------------------------------------------------------

await initMemory(DATA_DIR);

const skills = await loadSkills({ roots: SKILLS_PATH, claudeSkillRoots: CLAUDE_SKILLS_PATH });
console.log(`[server] loaded ${skills.length} skill(s): ${skills.map((s) => s.manifest.name).join(", ") || "(none)"}`);

// Thread registry. Each thread owns one pi Agent with its own message history.
// Bounded by MAX_THREADS; oldest lastActiveAt evicted when full. Not persisted
// across restarts — message history is intentionally in-memory (see CLAUDE.md
// §9). Only the thread list metadata is persisted so the sidebar survives a
// browser reload; on cold start we start empty.
const MAX_THREADS = 50;
const DEFAULT_THREAD_ID = "default";

interface ThreadEntry {
	id: string;
	title: string;
	agent: Agent;
	createdAt: number;
	lastActiveAt: number;
}

const threads = new Map<string, ThreadEntry>();

function newAgent(): Agent {
	return createPersonalAgent({
		aicore: { baseUrl: AICORE_BASE_URL, modelId: AICORE_MODEL, apiKey: AICORE_TOKEN },
		tools: skills.map((s) => s.tool),
	});
}

function evictOldestIfFull(): void {
	if (threads.size < MAX_THREADS) return;
	let oldestId: string | null = null;
	let oldestTs = Number.POSITIVE_INFINITY;
	for (const [id, entry] of threads) {
		if (id === DEFAULT_THREAD_ID) continue; // never evict the fallback thread
		if (entry.lastActiveAt < oldestTs) {
			oldestTs = entry.lastActiveAt;
			oldestId = id;
		}
	}
	if (oldestId) {
		threads.delete(oldestId);
		console.log(`[server] evicted LRU thread ${oldestId}`);
	}
}

function getOrCreateThread(threadId: string, titleHint?: string): ThreadEntry {
	let entry = threads.get(threadId);
	if (!entry) {
		evictOldestIfFull();
		entry = {
			id: threadId,
			title: titleHint ?? (threadId === DEFAULT_THREAD_ID ? "Default" : "New chat"),
			agent: newAgent(),
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		};
		threads.set(threadId, entry);
	} else {
		entry.lastActiveAt = Date.now();
	}
	return entry;
}

function threadIdFrom(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string {
	const q = c.req.query("thread");
	const h = c.req.header("x-thread-id");
	const id = (q ?? h ?? DEFAULT_THREAD_ID).trim();
	// keep IDs safe: only allow default or UUID-ish shapes
	if (id === DEFAULT_THREAD_ID) return id;
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return DEFAULT_THREAD_ID;
	return id;
}

// Ensure a default thread always exists so legacy single-thread callers (old
// UI, curl) keep working.
getOrCreateThread(DEFAULT_THREAD_ID);

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------

const app = new Hono();

// Simple request log so slow / failing requests leave a trace.
app.use("*", async (c, next) => {
	const started = Date.now();
	try {
		await next();
	} finally {
		const elapsed = Date.now() - started;
		// eslint-disable-next-line no-console
		console.log(`[req] ${c.req.method} ${c.req.path} -> ${c.res.status} ${elapsed}ms`);
	}
});

// -----------------------------------------------------------------------------
// Auth: HTTP Basic Auth for everything except /health.
// /health stays open so Cloudflare Tunnel and container healthchecks work
// without credentials. Set AUTH_USER + AUTH_PASS in .env to enable.
// -----------------------------------------------------------------------------

if (authEnabled) {
	app.use("*", async (c, next) => {
		if (c.req.path === "/health") return next();
		return basicAuth({ username: AUTH_USER, password: AUTH_PASS })(c, next);
	});
}

app.get("/health", (c) =>
	c.json({
		ok: true,
		aicore: { baseUrl: AICORE_BASE_URL, model: AICORE_MODEL },
		skills: skills.map((s) => ({ name: s.manifest.name, label: s.manifest.label })),
		threads: threads.size,
	}),
);

app.get("/skills", (c) =>
	c.json(
		skills.map((s) => ({
			name: s.manifest.name,
			label: s.manifest.label,
			description: s.manifest.description,
			parameters: s.manifest.parameters,
		})),
	),
);

// -----------------------------------------------------------------------------
// Threads CRUD. Each thread has its own pi Agent + message history.
// -----------------------------------------------------------------------------

app.get("/threads", (c) => {
	const list = Array.from(threads.values())
		.map((t) => ({
			id: t.id,
			title: t.title,
			createdAt: t.createdAt,
			lastActiveAt: t.lastActiveAt,
			messageCount: t.agent.state.messages.length,
		}))
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	return c.json(list);
});

app.post("/threads", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
	const rawTitle = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
	const id = randomUUID();
	const entry = getOrCreateThread(id, rawTitle || "New chat");
	return c.json({ id: entry.id, title: entry.title, createdAt: entry.createdAt, lastActiveAt: entry.lastActiveAt, messageCount: 0 });
});

app.patch("/threads/:id", async (c) => {
	const id = c.req.param("id");
	const entry = threads.get(id);
	if (!entry) return c.json({ error: "not found" }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
	if (typeof body.title === "string") {
		entry.title = body.title.trim().slice(0, 120) || entry.title;
	}
	return c.json({ id: entry.id, title: entry.title });
});

app.delete("/threads/:id", (c) => {
	const id = c.req.param("id");
	if (id === DEFAULT_THREAD_ID) return c.json({ error: "cannot delete default thread" }, 400);
	threads.delete(id);
	return c.json({ ok: true });
});

app.get("/messages", (c) => {
	const id = threadIdFrom(c);
	const entry = threads.get(id);
	if (!entry) return c.json([]);
	return c.json(entry.agent.state.messages);
});

app.post("/reset", (c) => {
	const id = threadIdFrom(c);
	const entry = threads.get(id);
	if (entry) entry.agent.reset();
	return c.json({ ok: true });
});

// POST /chat  { prompt: string }
// Streams SSE events consumed by the browser UI.
//
// Cloudflare edge has a 100-second timeout for the first response byte.
// LLM cold-start via aicore-proxy can exceed that (SAP AI Core cold, retries,
// throttling). To keep the connection alive we:
//   1. Emit a `:` SSE comment immediately when the handler starts.
//   2. Emit a `:heartbeat` comment every HEARTBEAT_MS while waiting for the
//      first real event. Cloudflare treats any byte as activity, so this is
//      enough to prevent 524.
const HEARTBEAT_MS = 15_000;

// Attachment limits. Keep aligned with the UI's client-side checks so the
// server rejects with a clear message instead of the LLM failing on oversized
// blobs.
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const MAX_FILES = 10;
const MAX_FILE_BYTES = 200 * 1024; // 200 KB text
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface ChatFile {
	name: string;
	content: string;
}

interface ChatBody {
	prompt?: unknown;
	images?: unknown;
	files?: unknown;
	threadId?: unknown;
}

interface ValidatedAttachments {
	images: ImageContent[];
	files: ChatFile[];
}

function parseAttachments(body: ChatBody): ValidatedAttachments | { error: string } {
	const images: ImageContent[] = [];
	const files: ChatFile[] = [];

	if (body.images !== undefined) {
		if (!Array.isArray(body.images)) return { error: "images must be an array" };
		if (body.images.length > MAX_IMAGES) return { error: `too many images (max ${MAX_IMAGES})` };
		for (const [i, raw] of body.images.entries()) {
			if (!raw || typeof raw !== "object") return { error: `images[${i}] must be an object` };
			const rec = raw as { data?: unknown; mimeType?: unknown };
			if (typeof rec.data !== "string" || typeof rec.mimeType !== "string") {
				return { error: `images[${i}] must have { data: string, mimeType: string }` };
			}
			if (!ALLOWED_IMAGE_MIMES.has(rec.mimeType)) {
				return { error: `images[${i}] mimeType ${rec.mimeType} not allowed` };
			}
			// base64 decoded size ~ length * 3/4
			const approxBytes = Math.floor((rec.data.length * 3) / 4);
			if (approxBytes > MAX_IMAGE_BYTES) {
				return { error: `images[${i}] exceeds ${MAX_IMAGE_BYTES} bytes` };
			}
			images.push({ type: "image", data: rec.data, mimeType: rec.mimeType });
		}
	}

	if (body.files !== undefined) {
		if (!Array.isArray(body.files)) return { error: "files must be an array" };
		if (body.files.length > MAX_FILES) return { error: `too many files (max ${MAX_FILES})` };
		for (const [i, raw] of body.files.entries()) {
			if (!raw || typeof raw !== "object") return { error: `files[${i}] must be an object` };
			const rec = raw as { name?: unknown; content?: unknown };
			if (typeof rec.name !== "string" || typeof rec.content !== "string") {
				return { error: `files[${i}] must have { name: string, content: string }` };
			}
			if (Buffer.byteLength(rec.content, "utf8") > MAX_FILE_BYTES) {
				return { error: `files[${i}] (${rec.name}) exceeds ${MAX_FILE_BYTES} bytes` };
			}
			// Sanitize file name: no newlines, no closing brackets to keep the wrapper unambiguous.
			const safeName = rec.name.replace(/[\r\n<>]/g, "").slice(0, 200);
			files.push({ name: safeName, content: rec.content });
		}
	}

	return { images, files };
}

function buildPromptText(prompt: string, files: ChatFile[]): string {
	if (files.length === 0) return prompt;
	const parts: string[] = [];
	for (const f of files) {
		parts.push(`<file name="${f.name}">\n${f.content}\n</file>`);
	}
	parts.push(prompt);
	return parts.join("\n\n");
}

// Slash-trigger: `/skill_name rest of prompt` prepends a soft directive so the
// LLM prefers that tool for the turn. Kebab and snake are both accepted (the
// UI shows snake_case skill names, but /send-email is Claude Code muscle
// memory). Unknown skills fall through — the raw prompt is kept.
//
// The hint is wrapped in `<system_hint>...</system_hint>` so the browser
// client can strip it before rendering user messages loaded from history.
// LLMs accept the XML-tagged directive without much confusion; keeping it
// inside the user message avoids inventing a new AgentMessage kind.
const SLASH_RE = /^\/([a-z][a-z0-9_-]*)(\s|$)([\s\S]*)$/;
const SYSTEM_HINT_OPEN = "<system_hint>";
const SYSTEM_HINT_CLOSE = "</system_hint>";

function applySlashHint(prompt: string): { prompt: string; skill: string | null } {
	const m = prompt.match(SLASH_RE);
	if (!m) return { prompt, skill: null };
	const raw = (m[1] ?? "").replace(/-/g, "_");
	const skill = skills.find((s) => s.manifest.name === raw);
	if (!skill) return { prompt, skill: null };
	const rest = (m[3] ?? "").trim();
	const hint = `${SYSTEM_HINT_OPEN}The user invoked /${skill.manifest.name}. Prefer the "${skill.manifest.name}" tool for this turn unless it clearly does not apply.${SYSTEM_HINT_CLOSE}`;
	const body = rest || `Ask me for the parameters the ${skill.manifest.name} tool needs.`;
	return { prompt: `${hint}\n\n${body}`, skill: skill.manifest.name };
}

app.post("/chat", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as ChatBody;
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	const parsed = parseAttachments(body);
	if ("error" in parsed) return c.json({ error: parsed.error }, 400);
	// prompt may be empty if the user only uploaded attachments — but we still
	// need *something* for the model to react to. Require at least one of
	// prompt / images / files.
	if (!prompt && parsed.images.length === 0 && parsed.files.length === 0) {
		return c.json({ error: "prompt or attachments required" }, 400);
	}
	// Resolve thread: body.threadId wins, else query/header, else DEFAULT.
	// Body wins because the browser client always posts JSON.
	let threadId: string = DEFAULT_THREAD_ID;
	if (typeof body.threadId === "string" && body.threadId.trim()) {
		const candidate = body.threadId.trim();
		threadId =
			candidate === DEFAULT_THREAD_ID || /^[a-zA-Z0-9_-]{1,64}$/.test(candidate)
				? candidate
				: DEFAULT_THREAD_ID;
	} else {
		threadId = threadIdFrom(c);
	}
	const entry = getOrCreateThread(threadId);
	const agent = entry.agent;
	// Auto-derive title from first user prompt if still the default.
	if ((entry.title === "New chat" || entry.title === "Default") && prompt) {
		entry.title = prompt.slice(0, 40).replace(/\s+/g, " ").trim();
	}
	const slashResult = applySlashHint(prompt);
	const effectivePrompt = slashResult.prompt || prompt || "See attached.";
	const promptText = buildPromptText(effectivePrompt, parsed.files);
	const images = parsed.images;

	return streamSSE(c, async (stream) => {
		// Fire an initial comment right away so Cloudflare sees origin bytes
		// before it starts the 100s countdown.
		await stream.write(": ready\n\n").catch(() => {});

		const heartbeat = setInterval(() => {
			stream.write(`: heartbeat ${Date.now()}\n\n`).catch(() => {});
		}, HEARTBEAT_MS);

		const send = async (data: Record<string, unknown>) => {
			await stream.writeSSE({ data: JSON.stringify(data) });
		};

		if (slashResult.skill) {
			await send({ type: "skill_hint", name: slashResult.skill });
		}

		const unsubscribe = agent.subscribe(async (event) => {
			switch (event.type) {
				case "message_start":
					if (event.message.role === "assistant") {
						await send({ type: "assistant_start" });
					}
					break;
				case "message_update": {
					const inner = event.assistantMessageEvent;
					if (inner.type === "text_delta") {
						await send({ type: "text_delta", delta: inner.delta });
					} else if (inner.type === "thinking_delta") {
						await send({ type: "thinking_delta", delta: inner.delta });
					}
					break;
				}
				case "tool_execution_start":
					await send({ type: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
					break;
				case "tool_execution_end":
					await send({
						type: "tool_end",
						toolCallId: event.toolCallId,
						name: event.toolName,
						result: event.result,
					});
					break;
				case "agent_end":
					await send({ type: "done" });
					break;
			}
		});

		try {
			await agent.prompt(promptText, images.length > 0 ? images : undefined);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[chat] agent.prompt failed:", err);
			await send({ type: "error", message: err instanceof Error ? err.message : String(err) });
		} finally {
			clearInterval(heartbeat);
			unsubscribe();
		}
	});
});

// -----------------------------------------------------------------------------
// Static UI: Next.js static export lives under src/web-next/. Build via
// `cd web-next && npm run build`, then rsync the out/ contents into
// src/web-next/. The Dockerfile copies src/web-next/ into the image.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "web-next");

app.get("/", async (c) => {
	try {
		const html = await readFile(path.join(webRoot, "index.html"), "utf8");
		return c.html(html);
	} catch {
		return c.text(
			"UI not built. Run `cd web-next && npm run build` and copy web-next/out/* into src/web-next/.",
			500,
		);
	}
});

// Serve everything under src/web-next/ at the root. Next.js static export
// emits _next/, favicon.ico, and named .html files (only / and /404 for us),
// so we mount at "/*" and let unmatched fall through to 404.
app.use(
	"/*",
	serveStatic({
		root: path.relative(process.cwd(), webRoot) || ".",
	}),
);

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
	console.log(`[server] pi-dyland listening on http://${info.address}:${info.port}`);
});

const shutdown = () => {
	console.log("[server] shutting down");
	server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
