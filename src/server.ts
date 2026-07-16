import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { streamSSE } from "hono/streaming";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPersonalAgent, oneShotCompletion } from "./agent-factory.ts";
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
// Progressive skill loading: when enabled, only skill names + labels are
// baked into the base system prompt. Full per-skill descriptions are injected
// on-demand via `/skill_name` slash hints. Useful once the skill inventory
// grows past a handful; keep off by default so autonomous tool use still works
// for the current 4-skill setup.
const PROGRESSIVE_SKILLS = /^(1|true|yes)$/i.test(process.env.SKILLS_PROGRESSIVE ?? "");
// Cap on goal-driven auto-continuations per thread (DeerFlow's is 8; we're a
// single-user helper so 5 is plenty and keeps runaway loops cheap).
const GOAL_MAX_CONTINUATIONS = 5;

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
	/**
	 * True while an agent.prompt() call is running for this thread. Used to
	 * reject overlapping /chat requests (pi-agent-core would throw "already
	 * processing" anyway; we surface a cleaner error and let the client offer
	 * a Stop/Cancel path).
	 */
	inFlight: boolean;
	/**
	 * Approx cumulative token usage for the thread. We estimate from prompt
	 * text length (÷4) so we don't have to reach into pi-ai's usage plumbing.
	 * Client uses this to know when to `/compact` or start a new thread.
	 */
	tokens: { input: number; output: number };
	/** Optional session goal set via `/goal <text>` or PUT /threads/:id/goal. */
	goal: {
		text: string;
		createdAt: number;
		continuations: number;
	} | null;
}

const threads = new Map<string, ThreadEntry>();

function newAgent(): Agent {
	const toolInputs = PROGRESSIVE_SKILLS
		? skills.map((s) => ({
			...s.tool,
			// Trim to label only so the base prompt cost stays flat when the
			// skill list grows. Full description is re-injected per-turn by
			// applySlashHint for /skill_name invocations.
			description: s.manifest.label || s.manifest.name,
		}))
		: skills.map((s) => s.tool);
	return createPersonalAgent({
		aicore: { baseUrl: AICORE_BASE_URL, modelId: AICORE_MODEL, apiKey: AICORE_TOKEN },
		tools: toolInputs,
	});
}

/**
 * Replace a thread's Agent with a fresh instance and drop the old one.
 *
 * pi-agent-core does not expose a public "abort in-flight prompt" API. Once
 * `agent.prompt()` has been called, the only way to guarantee the thread can
 * accept a new prompt is to walk away from the old Agent entirely. The old
 * instance's promise continues to run to completion in the background (and
 * its outputs are discarded because we already unsubscribed), which is
 * memory-wasteful but bounded and safe.
 *
 * This mirrors DeerFlow's philosophy: rather than fixing a jammed run, delete
 * the thread state and start fresh. Here we keep the thread identity and just
 * swap the Agent underneath so the client's threadId stays valid.
 */
function rebuildAgent(entry: ThreadEntry): void {
	entry.agent = newAgent();
	entry.inFlight = false;
	entry.lastActiveAt = Date.now();
	// A rebuild is either a cancel (drop the stuck run) or a full reset. In
	// both cases we clear the token accumulator — the message history is gone
	// so the counter would just be stale.
	entry.tokens = { input: 0, output: 0 };
	// Reset continuation counter but keep the goal itself; if the user hit
	// Reset because a run got stuck, they still want the goal to apply to
	// the next attempt.
	if (entry.goal) entry.goal.continuations = 0;
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
			inFlight: false,
			tokens: { input: 0, output: 0 },
			goal: null,
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
			inFlight: t.inFlight,
			tokens: t.tokens,
			goal: t.goal,
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
	if (!entry) return c.json({ ok: true, action: "noop" });
	// Rebuild the Agent unconditionally. If a prompt was in flight, this is
	// the only way to guarantee the thread accepts new prompts — pi-agent-core
	// has no public abort API. If no prompt was running, this is equivalent to
	// agent.reset() but also clears any subscription bookkeeping.
	rebuildAgent(entry);
	return c.json({ ok: true, action: "rebuilt" });
});

/**
 * POST /threads/:id/cancel
 *
 * DeerFlow-equivalent of the LangGraph `runs/{run_id}/cancel` endpoint.
 * pi-agent-core cannot interrupt an in-flight prompt, so we walk away from
 * the Agent instance and hand the thread a fresh one. The client should also
 * abort its SSE fetch so the /chat handler's `finally` unsubscribes.
 */
app.post("/threads/:id/cancel", (c) => {
	const id = c.req.param("id");
	const entry = threads.get(id);
	if (!entry) return c.json({ ok: true, action: "noop" });
	const wasInFlight = entry.inFlight;
	rebuildAgent(entry);
	return c.json({ ok: true, action: "rebuilt", wasInFlight });
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
	// Include the full description when progressive skill loading is on, so
	// the LLM sees the tool's usage guidance even though the base prompt only
	// listed the label. When progressive is off, the description is already
	// in the tool definition — but repeating it costs almost nothing and
	// still nudges tool selection.
	const desc = skill.manifest.description
		? `\nTool usage guidance: ${skill.manifest.description}`
		: "";
	const hint = `${SYSTEM_HINT_OPEN}The user invoked /${skill.manifest.name}. Prefer the "${skill.manifest.name}" tool for this turn unless it clearly does not apply.${desc}${SYSTEM_HINT_CLOSE}`;
	const body = rest || `Ask me for the parameters the ${skill.manifest.name} tool needs.`;
	return { prompt: `${hint}\n\n${body}`, skill: skill.manifest.name };
}

// -----------------------------------------------------------------------------
// /compact — summarize old messages and swap them out for a summary block.
//
// pi-agent-core's Agent state is mutable; we drop everything up to the last
// N messages, then push a synthetic user+assistant pair that carries the
// LLM-produced summary. Nothing else in the pipeline (subscribe, prompt) is
// aware of this — from the model's perspective the conversation starts with
// a compact recap and continues normally.
//
// Idempotent: if the thread has fewer than KEEP_TAIL messages, no-op.
// -----------------------------------------------------------------------------

const COMPACT_KEEP_TAIL = 4;

interface RawMessageForCompact {
	role: string;
	content: Array<{ type: string; text?: string }>;
}

function stringifyMessagesForSummary(messages: RawMessageForCompact[]): string {
	// Cheap textual serialization. We only include role + text blocks so the
	// summary model doesn't have to reason about tool-use JSON shapes.
	return messages
		.map((m) => {
			if (!Array.isArray(m.content)) return "";
			const text = m.content
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n");
			if (!text.trim()) return "";
			return `${m.role.toUpperCase()}: ${text}`;
		})
		.filter(Boolean)
		.join("\n\n");
}

app.post("/compact", async (c) => {
	const id = threadIdFrom(c);
	const entry = threads.get(id);
	if (!entry) return c.json({ ok: false, error: "unknown thread" }, 404);
	if (entry.inFlight) return c.json({ ok: false, error: "thread busy" }, 409);
	const msgs = entry.agent.state.messages as unknown as RawMessageForCompact[];
	if (msgs.length <= COMPACT_KEEP_TAIL) {
		return c.json({ ok: true, action: "noop", kept: msgs.length });
	}
	const head = msgs.slice(0, msgs.length - COMPACT_KEEP_TAIL);
	const tail = msgs.slice(msgs.length - COMPACT_KEEP_TAIL);
	const transcript = stringifyMessagesForSummary(head);
	if (!transcript) return c.json({ ok: true, action: "noop", reason: "no summarizable text" });
	let summary: string;
	try {
		summary = await oneShotCompletion({
			aicore: { baseUrl: AICORE_BASE_URL, modelId: AICORE_MODEL, apiKey: AICORE_TOKEN },
			system:
				"You are a summarizer. Produce a compact recap of the given conversation for a personal assistant. Preserve concrete facts (dates, names, decisions, open questions), drop chit-chat and repeated context. Reply in the same language as the transcript. Under 300 words.",
			prompt: transcript,
			maxTokens: 800,
		});
	} catch (err) {
		console.error("[compact] summarization failed:", err);
		return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
	}
	// Rewrite messages: synthetic user (context marker) → synthetic assistant
	// (the summary) → preserved tail.
	const rewritten: RawMessageForCompact[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `${SYSTEM_HINT_OPEN}Earlier conversation compacted for context.${SYSTEM_HINT_CLOSE}`,
				},
			],
		},
		{
			role: "assistant",
			content: [{ type: "text", text: `Prior context summary:\n\n${summary}` }],
		},
		...tail,
	];
	entry.agent.state.messages = rewritten as never;
	// Reset the running token estimate since we just discarded most of the
	// history. The tail is small — reseed with a rough cost of the summary.
	entry.tokens = {
		input: Math.ceil(summary.length / 4),
		output: 0,
	};
	entry.lastActiveAt = Date.now();
	return c.json({
		ok: true,
		action: "compacted",
		dropped: head.length,
		kept: tail.length,
		summaryPreview: summary.slice(0, 200),
	});
});

// -----------------------------------------------------------------------------
// /suggest — end-of-turn follow-up suggestions.
// Returns 3 short prompts the user might send next. Fire-and-forget from the
// client, non-streaming, one-shot LLM call.
// -----------------------------------------------------------------------------

app.get("/suggest", async (c) => {
	const id = threadIdFrom(c);
	const entry = threads.get(id);
	if (!entry) return c.json({ suggestions: [] });
	const msgs = entry.agent.state.messages as unknown as RawMessageForCompact[];
	if (msgs.length === 0) return c.json({ suggestions: [] });
	// Only look at the tail — the summary model does not need the full log.
	const tail = msgs.slice(-6);
	const transcript = stringifyMessagesForSummary(tail);
	if (!transcript) return c.json({ suggestions: [] });
	let raw: string;
	try {
		raw = await oneShotCompletion({
			aicore: { baseUrl: AICORE_BASE_URL, modelId: AICORE_MODEL, apiKey: AICORE_TOKEN },
			system:
				"You suggest the next user turn for a personal-assistant conversation. Read the transcript and reply with exactly 3 short follow-up prompts (each under 12 words), one per line, no numbering, no quotes, no explanation. Reply in the same language as the last user turn.",
			prompt: transcript,
			maxTokens: 200,
		});
	} catch (err) {
		console.error("[suggest] failed:", err);
		return c.json({ suggestions: [] });
	}
	const suggestions = raw
		.split(/\r?\n/)
		.map((line) => line.replace(/^[\-\*\d.\s]+/, "").trim())
		.filter((line) => line.length > 0 && line.length < 200)
		.slice(0, 3);
	return c.json({ suggestions });
});

// -----------------------------------------------------------------------------
// /threads/:id/goal — set/clear a session goal.
// The goal is injected as a hidden <system_hint> into every subsequent /chat
// prompt for this thread. It also enables a lightweight continuation loop
// (see /chat's post-run evaluator).
// -----------------------------------------------------------------------------

app.get("/threads/:id/goal", (c) => {
	const id = c.req.param("id");
	const entry = threads.get(id);
	if (!entry) return c.json({ goal: null });
	return c.json({ goal: entry.goal });
});

app.put("/threads/:id/goal", async (c) => {
	const id = c.req.param("id");
	const entry = threads.get(id);
	if (!entry) return c.json({ error: "not found" }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
	if (typeof body.text !== "string") return c.json({ error: "text required" }, 400);
	const text = body.text.trim().slice(0, 500);
	if (!text) {
		entry.goal = null;
		return c.json({ goal: null });
	}
	entry.goal = { text, createdAt: Date.now(), continuations: 0 };
	return c.json({ goal: entry.goal });
});

app.delete("/threads/:id/goal", (c) => {
	const id = c.req.param("id");
	const entry = threads.get(id);
	if (!entry) return c.json({ ok: true });
	entry.goal = null;
	return c.json({ ok: true });
});

// -----------------------------------------------------------------------------
// /feedback — thumbs up/down on a specific assistant turn.
// Appended to $DATA_DIR/feedback.jsonl for later offline analysis. Never
// touches the agent state; purely observational.
// -----------------------------------------------------------------------------

interface FeedbackBody {
	threadId?: unknown;
	messageId?: unknown;
	rating?: unknown; // "up" | "down"
	note?: unknown;
}

app.post("/feedback", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as FeedbackBody;
	const threadId = typeof body.threadId === "string" ? body.threadId.slice(0, 64) : "";
	const messageId = typeof body.messageId === "string" ? body.messageId.slice(0, 128) : "";
	const rating = body.rating === "up" || body.rating === "down" ? body.rating : null;
	const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";
	if (!rating) return c.json({ error: "rating must be 'up' or 'down'" }, 400);
	const record = { ts: Date.now(), threadId, messageId, rating, note };
	try {
		const target = path.join(DATA_DIR, "feedback.jsonl");
		await appendFile(target, JSON.stringify(record) + "\n", "utf8");
	} catch (err) {
		console.error("[feedback] write failed:", err);
		return c.json({ ok: false, error: "write failed" }, 500);
	}
	return c.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Goal continuation evaluator. Called after each agent.prompt turn while a
// goal is active. Returns "continue" if the run should auto-continue, "stop"
// otherwise. Any error -> "stop" (evaluated by the caller via .catch()).
// -----------------------------------------------------------------------------

async function evaluateGoalContinuation(
	entry: ThreadEntry,
	agent: Agent,
): Promise<{ action: "continue" | "stop"; reason: string }> {
	if (!entry.goal) return { action: "stop", reason: "no goal" };
	const msgs = entry.agent.state.messages as unknown as RawMessageForCompact[];
	// Peek at the last assistant message. If it ends with a question, the
	// agent is waiting on the user — don't auto-continue.
	const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
	if (!lastAssistant) return { action: "stop", reason: "no assistant reply yet" };
	const lastText = (lastAssistant.content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (!lastText) return { action: "stop", reason: "empty assistant reply" };
	// Fast local heuristic: obvious question at the end means "waiting on user".
	// Covers Chinese/English/whitespace variants; keeps the LLM call rate low.
	if (/[?？]\s*$/.test(lastText)) return { action: "stop", reason: "assistant asked a question" };
	// LLM evaluator. Kept short to stay cheap; the categories mirror
	// DeerFlow's Session-Goals evaluator.
	const tail = msgs.slice(-4);
	const transcript = stringifyMessagesForSummary(tail);
	let raw: string;
	try {
		raw = await oneShotCompletion({
			aicore: { baseUrl: AICORE_BASE_URL, modelId: AICORE_MODEL, apiKey: AICORE_TOKEN },
			system:
				`You judge whether an assistant should continue working toward a session goal or stop. Reply with exactly one word from: continue, stop. Reply "continue" only when the goal is NOT yet met AND the assistant is NOT waiting on the user AND the last turn did not fail. Otherwise reply "stop". Session goal: ${entry.goal.text}`,
			prompt: transcript,
			maxTokens: 8,
		});
	} catch {
		return { action: "stop", reason: "evaluator error" };
	}
	const verdict = raw.trim().toLowerCase().split(/\s+/)[0] ?? "stop";
	if (verdict.startsWith("continue")) return { action: "continue", reason: "evaluator continue" };
	return { action: "stop", reason: `evaluator ${verdict}` };
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
	// Reject concurrent prompts on the same thread. The client should either
	// wait for the current stream to finish or call /threads/:id/cancel first.
	// pi-agent-core would also throw "already processing" internally; catching
	// it here means we don't waste a subscription bind.
	if (entry.inFlight) {
		return c.json(
			{
				error: "thread busy",
				message:
					"Another prompt is still streaming on this thread. Wait for it to finish or POST /threads/" +
					threadId +
					"/cancel to abort.",
			},
			409,
		);
	}
	const agent = entry.agent;
	entry.inFlight = true;
	// Auto-derive title from first user prompt if still the default.
	if ((entry.title === "New chat" || entry.title === "Default") && prompt) {
		entry.title = prompt.slice(0, 40).replace(/\s+/g, " ").trim();
	}
	const slashResult = applySlashHint(prompt);
	// Handle `/goal <text>` and `/compact` as inline commands. `/goal` is
	// stateful and doesn't call the LLM here; `/compact` is a redirect hint
	// (the client should call POST /compact instead, but we short-circuit
	// gracefully if it landed here anyway).
	const goalCmd = prompt.match(/^\/goal(?:\s+([\s\S]*))?$/);
	if (goalCmd) {
		const goalText = (goalCmd[1] ?? "").trim();
		if (goalText.toLowerCase() === "clear" || goalText.toLowerCase() === "off" || !goalText) {
			entry.goal = null;
		} else {
			entry.goal = { text: goalText.slice(0, 500), createdAt: Date.now(), continuations: 0 };
		}
		entry.inFlight = false;
		return streamSSE(c, async (stream) => {
			await stream.write(": ready\n\n").catch(() => {});
			await stream.writeSSE({
				data: JSON.stringify({
					type: "goal_updated",
					goal: entry.goal,
				}),
			});
			await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
		});
	}
	const effectivePrompt = slashResult.prompt || prompt || "See attached.";
	// Inject the session goal (if any) as a hidden system_hint so the LLM
	// stays anchored across turns without polluting the visible transcript.
	// The convert-messages client strips <system_hint> before rendering.
	const goalHint = entry.goal
		? `${SYSTEM_HINT_OPEN}Session goal (active): ${entry.goal.text}${SYSTEM_HINT_CLOSE}\n\n`
		: "";
	const promptText = goalHint + buildPromptText(effectivePrompt, parsed.files);
	const images = parsed.images;
	// Rough token estimate for input: 4 chars ≈ 1 token. Cheap and good
	// enough for a "when should I compact?" indicator — precise usage would
	// require reaching into pi-ai's provider response, which we intentionally
	// keep out of scope (see CLAUDE.md §7).
	const inputEst = Math.ceil(promptText.length / 4);
	entry.tokens.input += inputEst;
	let outputChars = 0;

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
						outputChars += inner.delta.length;
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
				// Note: agent_end is intentionally NOT forwarded. We may fire
				// a second agent.prompt for goal continuation, and we only
				// want the client to see one `done` at the very end. Final
				// usage/done are emitted in the outer finally-adjacent block.
			}
		});

		try {
			await agent.prompt(promptText, images.length > 0 ? images : undefined);
			// Goal-driven continuation loop. After each successful prompt, ask
			// a small evaluator whether the session goal is met. If not (and
			// the assistant isn't waiting on the user), fire another prompt
			// with a hidden continue directive. Capped at GOAL_MAX_CONTINUATIONS
			// per goal to prevent runaway loops. This is DeerFlow's Session
			// Goals pattern applied to a single-agent setup.
			while (
				entry.goal &&
				entry.agent === agent &&
				entry.goal.continuations < GOAL_MAX_CONTINUATIONS
			) {
				const verdict = await evaluateGoalContinuation(entry, agent).catch(() => null);
				if (!verdict || verdict.action !== "continue") break;
				entry.goal.continuations += 1;
				const contHint = `${SYSTEM_HINT_OPEN}Continue working toward the session goal: ${entry.goal.text}. Take the next concrete step. If you are blocked and need user input, stop and ask; otherwise keep going.${SYSTEM_HINT_CLOSE}`;
				await agent.prompt(contHint);
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[chat] agent.prompt failed:", err);
			await send({ type: "error", message: err instanceof Error ? err.message : String(err) });
		} finally {
			// Emit final usage + done AFTER any continuation runs so the
			// client sees one clean end-of-turn signal for the whole burst.
			const outputEst = Math.ceil(outputChars / 4);
			// outputChars was accumulated inside the subscriber; entry.tokens.output
			// was NOT bumped in the subscriber anymore, so bump it here.
			entry.tokens.output += outputEst;
			try {
				await send({
					type: "usage",
					deltaInput: inputEst,
					deltaOutput: outputEst,
					totalInput: entry.tokens.input,
					totalOutput: entry.tokens.output,
				});
				await send({ type: "done" });
			} catch {
				/* stream may already be closed */
			}
			clearInterval(heartbeat);
			unsubscribe();
			// Only clear inFlight if this stream still owns the current Agent.
			// If /threads/:id/cancel or /reset rebuilt the Agent while we were
			// running, entry.agent now points to a fresh instance and its
			// inFlight was already reset by rebuildAgent().
			if (entry.agent === agent) entry.inFlight = false;
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
