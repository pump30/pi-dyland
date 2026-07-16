import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { buildMemoryContext, rememberTool } from "./memory.ts";

// -----------------------------------------------------------------------------
// LLM backend: SAP AI Core proxy (aicore-proxy) on my NAS, Anthropic-compatible.
//
// aicore-proxy authenticates with `Authorization: Bearer <token>`, NOT the
// Anthropic-standard `x-api-key`. pi-ai's built-in anthropic-messages provider
// only uses `Authorization: Bearer` when the token starts with `sk-ant-oat`
// (Claude OAuth); otherwise it uses `x-api-key`. Our token is aicore-proxy's
// own static bearer, so we wrap streamSimple and inject the Authorization
// header into `options.headers`. The provider's `assertRequestAuth` accepts a
// request when an `authorization` header is present, so no apiKey is needed.
// -----------------------------------------------------------------------------

export interface AicoreModelConfig {
	baseUrl: string;
	modelId: string;
	/** aicore-proxy bearer token. Sent as `Authorization: Bearer <token>`. */
	apiKey: string;
}

/**
 * Build a pi-ai `Model` targeting the NAS aicore-proxy.
 */
export function buildAicoreModel(config: AicoreModelConfig): Model<"anthropic-messages"> {
	return {
		id: config.modelId,
		name: `Superdyland ${config.modelId}`,
		api: "anthropic-messages",
		provider: "superdyland",
		baseUrl: config.baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

/**
 * Wrap pi-ai's `streamSimple` to inject `Authorization: Bearer <token>` into
 * `options.headers` before dispatch. This bypasses pi's provider-based apiKey
 * lookup for the custom "superdyland" provider.
 */
export function buildAicoreStreamFn(apiKey: string) {
	return (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const mergedHeaders = {
			...(options?.headers ?? {}),
			Authorization: `Bearer ${apiKey}`,
		};
		return streamSimple(model, context, { ...options, headers: mergedHeaders });
	};
}

// -----------------------------------------------------------------------------
// Personal agent
// -----------------------------------------------------------------------------

export interface CreateAgentOptions {
	aicore: AicoreModelConfig;
	tools: AgentTool[];
	systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are Dyland, a personal assistant running on my home NAS.

Ground rules:
- Reply in the language the user uses. Default to Chinese with English technical terms unless asked otherwise.
- Be concise. No filler, no cheerful padding.
- Use the tools available to you when a request naturally maps to one. Prefer one focused tool call over speculating.
- If a task cannot be done with the available tools, say so plainly instead of pretending.
- When a tool errors, surface the error message and stop; do not retry blindly.
- Do not fabricate data (calendar events, credentials, files). Verify via a tool call first.
- Use the "remember" tool sparingly. Only save stable facts the user explicitly stated (timezone, preferred language, employer, common recipients). Never store secrets, credentials, or one-off information.`;

export function createPersonalAgent(options: CreateAgentOptions): Agent {
	const model = buildAicoreModel(options.aicore);
	const systemPrompt = (options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) + buildMemoryContext();
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			tools: [rememberTool, ...options.tools],
		},
		streamFn: buildAicoreStreamFn(options.aicore.apiKey),
	});
	return agent;
}

// -----------------------------------------------------------------------------
// One-shot completion. Used by /compact, /suggest, /goal continuation check.
// Bypasses pi-agent-core entirely; talks to aicore-proxy's Anthropic-compatible
// /v1/messages endpoint. Non-streaming, non-tool-using — pure text in, text out.
// Kept in this file so the bearer-token wart lives next to the streaming code
// it mirrors (see `buildAicoreStreamFn` for the auth-header quirk).
// -----------------------------------------------------------------------------

export interface OneShotOptions {
	aicore: AicoreModelConfig;
	system?: string;
	prompt: string;
	maxTokens?: number;
	/** Model override — defaults to aicore.modelId. */
	modelId?: string;
	signal?: AbortSignal;
}

interface AnthropicResponse {
	content?: Array<{ type: string; text?: string }>;
	stop_reason?: string;
}

export async function oneShotCompletion(opts: OneShotOptions): Promise<string> {
	const url = opts.aicore.baseUrl.replace(/\/$/, "") + "/v1/messages";
	const body = {
		model: opts.modelId ?? opts.aicore.modelId,
		max_tokens: opts.maxTokens ?? 1024,
		system: opts.system,
		messages: [{ role: "user", content: opts.prompt }],
	};
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			Authorization: `Bearer ${opts.aicore.apiKey}`,
		},
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new Error(`aicore /v1/messages ${res.status}: ${t.slice(0, 300)}`);
	}
	const data = (await res.json()) as AnthropicResponse;
	const text = (data.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
	return text.trim();
}
