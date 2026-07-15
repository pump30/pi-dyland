import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

// -----------------------------------------------------------------------------
// Long-term memory: two JSON files under $DATA_DIR.
//
//   profile.json      — LLM-written facts about the user (via the `remember`
//                       tool). Shape: { [key]: { value, updatedAt } }.
//   preferences.json  — User-written preferences (not touched by the LLM).
//                       Shape: opaque JSON object.
//
// Both are optional. If DATA_DIR is unset/unwritable the memory subsystem
// degrades to a no-op (profile stays empty in-memory for the process).
//
// This is intentionally NOT a database. We only need a few dozen key-value
// pairs and read-heavy access. See pi-dyland CLAUDE.md §9.
// -----------------------------------------------------------------------------

export interface ProfileEntry {
	value: string;
	updatedAt: number;
}

export type Profile = Record<string, ProfileEntry>;
export type Preferences = Record<string, unknown>;

interface MemoryState {
	dataDir: string | null;
	profile: Profile;
	preferences: Preferences;
	profilePath: string | null;
	preferencesPath: string | null;
}

const state: MemoryState = {
	dataDir: null,
	profile: {},
	preferences: {},
	profilePath: null,
	preferencesPath: null,
};

/**
 * Initialize memory. Call once at server startup. Non-fatal on failure —
 * the server still works, memory just doesn't persist.
 */
export async function initMemory(dataDir: string): Promise<void> {
	state.dataDir = dataDir;
	state.profilePath = path.join(dataDir, "profile.json");
	state.preferencesPath = path.join(dataDir, "preferences.json");
	try {
		await mkdir(dataDir, { recursive: true });
	} catch (err) {
		console.warn(`[memory] cannot create ${dataDir}, memory disabled:`, err);
		state.dataDir = null;
		return;
	}
	state.profile = await readJson<Profile>(state.profilePath, {});
	state.preferences = await readJson<Preferences>(state.preferencesPath, {});
	const nKeys = Object.keys(state.profile).length;
	console.log(`[memory] loaded ${nKeys} profile key(s) from ${dataDir}`);
}

async function readJson<T>(p: string, fallback: T): Promise<T> {
	try {
		const buf = await readFile(p, "utf8");
		return JSON.parse(buf) as T;
	} catch {
		return fallback;
	}
}

async function writeJson(p: string, value: unknown): Promise<void> {
	// Write to a temp file then rename to make this crash-safe.
	const tmp = `${p}.tmp`;
	await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
	const { rename } = await import("node:fs/promises");
	await rename(tmp, p);
}

export function getProfile(): Profile {
	return { ...state.profile };
}

export function getPreferences(): Preferences {
	return { ...state.preferences };
}

async function saveProfile(): Promise<void> {
	if (!state.profilePath) return;
	await writeJson(state.profilePath, state.profile);
}

/**
 * Build the memory-context section that gets appended to the system prompt.
 * Empty string if there is nothing to inject.
 */
export function buildMemoryContext(): string {
	const parts: string[] = [];
	const profileKeys = Object.keys(state.profile);
	if (profileKeys.length > 0) {
		const lines = profileKeys
			.sort()
			.map((k) => `- ${k}: ${state.profile[k]?.value ?? ""}`);
		parts.push(`<user_profile>\n${lines.join("\n")}\n</user_profile>`);
	}
	const prefKeys = Object.keys(state.preferences);
	if (prefKeys.length > 0) {
		parts.push(`<user_preferences>\n${JSON.stringify(state.preferences, null, 2)}\n</user_preferences>`);
	}
	if (parts.length === 0) return "";
	return `\n\n${parts.join("\n\n")}`;
}

// -----------------------------------------------------------------------------
// Built-in `remember` tool. Registered by agent-factory alongside skills.
// -----------------------------------------------------------------------------

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VALUE_LEN = 500;

export const rememberTool: AgentTool = {
	name: "remember",
	label: "Remember",
	description:
		"Save a durable fact about the user across sessions and threads. Use sparingly, only for stable preferences or profile facts (timezone, preferred language, employer, common recipients, etc.). Never save secrets, one-off information, or anything the user did not explicitly authorize. If the user asks you to forget, call this tool with value=\"\".",
	parameters: Type.Object({
		key: Type.String({ description: "Short snake_case key, e.g. 'timezone', 'preferred_lang'." }),
		value: Type.String({ description: `The fact to remember (max ${MAX_VALUE_LEN} chars). Empty string forgets the key.` }),
	}),
	execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
		const { key, value } = params as { key: string; value: string };
		if (!KEY_RE.test(key)) {
			throw new Error(`invalid key ${JSON.stringify(key)}; must be snake_case, ≤64 chars`);
		}
		if (value.length > MAX_VALUE_LEN) {
			throw new Error(`value too long (${value.length} > ${MAX_VALUE_LEN})`);
		}
		if (value === "") {
			delete state.profile[key];
			await saveProfile();
			return { content: [{ type: "text", text: `Forgot ${key}.` }], details: { action: "forget", key } };
		}
		state.profile[key] = { value, updatedAt: Date.now() };
		await saveProfile();
		return {
			content: [{ type: "text", text: `Remembered ${key} = ${value}` }],
			details: { action: "remember", key, value },
		};
	},
};
