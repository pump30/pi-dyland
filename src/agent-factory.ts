import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

// -----------------------------------------------------------------------------
// LLM backend: SAP AI Core proxy (aicore-proxy) on my NAS, Anthropic-compatible.
// pi-ai already ships a full `anthropic-messages` streaming implementation; we
// only need to describe the model. pi's default provider dispatch will pick
// the right stream function based on `model.api`.
// -----------------------------------------------------------------------------

export interface AicoreModelConfig {
	baseUrl: string;
	modelId: string;
	/** aicore-proxy issues an Anthropic-shaped `x-api-key`. */
	apiKey: string;
}

/**
 * Build a pi-ai `Model` targeting the NAS aicore-proxy.
 *
 * The context window / maxTokens numbers are conservative defaults that match
 * what aicore-proxy passes through to SAP AI Core's Claude Opus deployment. If
 * the real limits differ, we can lift them without breaking anything since
 * pi-ai clamps against them internally.
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
		// Anthropic-compatible auth: aicore-proxy expects the token as x-api-key.
		// pi-ai passes `options.apiKey` through to the Anthropic SDK client.
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
		// aicore-proxy authentication: forward the token as apiKey to the
		// underlying Anthropic SDK client.
		getApiKey: async () => options.aicore.apiKey,
	});
	return agent;
}
