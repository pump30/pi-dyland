import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPersonalAgent } from "./agent-factory.ts";
import { loadSkills } from "./skill-loader.ts";

// -----------------------------------------------------------------------------
// Config from env
// -----------------------------------------------------------------------------

const AICORE_BASE_URL = process.env.AICORE_BASE_URL ?? "https://aicore.superdyland.uk";
const AICORE_MODEL = process.env.AICORE_MODEL ?? "my-claude-opus";
const AICORE_TOKEN = process.env.AICORE_TOKEN ?? "";
const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const SKILLS_PATH = (process.env.SKILLS_PATH ?? "./skills").split(":").filter(Boolean);

if (!AICORE_TOKEN) {
	console.error("[server] AICORE_TOKEN is not set. The agent cannot call the LLM backend.");
	process.exit(1);
}

// -----------------------------------------------------------------------------
// Load skills, build the singleton agent
// -----------------------------------------------------------------------------

const skills = await loadSkills({ roots: SKILLS_PATH });
console.log(`[server] loaded ${skills.length} skill(s): ${skills.map((s) => s.manifest.name).join(", ") || "(none)"}`);

const agent = createPersonalAgent({
	aicore: {
		baseUrl: AICORE_BASE_URL,
		modelId: AICORE_MODEL,
		apiKey: AICORE_TOKEN,
	},
	tools: skills.map((s) => s.tool),
});

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------

const app = new Hono();

app.get("/health", (c) =>
	c.json({
		ok: true,
		aicore: { baseUrl: AICORE_BASE_URL, model: AICORE_MODEL },
		skills: skills.map((s) => ({ name: s.manifest.name, label: s.manifest.label })),
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

app.get("/messages", (c) => c.json(agent.state.messages));

app.post("/reset", (c) => {
	agent.reset();
	return c.json({ ok: true });
});

// POST /chat  { prompt: string }
// Streams SSE events consumed by the browser UI.
app.post("/chat", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown };
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (!prompt) return c.json({ error: "prompt is required" }, 400);

	return streamSSE(c, async (stream) => {
		const send = async (data: Record<string, unknown>) => {
			await stream.writeSSE({ data: JSON.stringify(data) });
		};

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
			await agent.prompt(prompt);
		} catch (err) {
			await send({ type: "error", message: err instanceof Error ? err.message : String(err) });
		} finally {
			unsubscribe();
		}
	});
});

// -----------------------------------------------------------------------------
// Static chat UI
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "web");

app.get("/", async (c) => {
	const html = await readFile(path.join(webRoot, "index.html"), "utf8");
	return c.html(html);
});

app.use(
	"/web/*",
	serveStatic({
		root: path.relative(process.cwd(), webRoot) || ".",
		rewriteRequestPath: (p) => p.replace(/^\/web\//, "/"),
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
