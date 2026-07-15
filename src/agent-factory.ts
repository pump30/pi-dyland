import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai/compat";

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
- Do not fabricate data (calendar events, credentials, files). Verify via a tool call first.`;

export function createPersonalAgent(options: CreateAgentOptions): Agent {
	const model = buildAicoreModel(options.aicore);
	const agent = new Agent({
		initialState: {
			systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			model,
			tools: options.tools,
		},
		streamFn: buildAicoreStreamFn(options.aicore.apiKey),
	});
	return agent;
}
