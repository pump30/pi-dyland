import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

// -----------------------------------------------------------------------------
// Skill manifest schema
// -----------------------------------------------------------------------------

/**
 * Manifest declared by each skill in `skill.json`.
 *
 * The manifest is intentionally minimal: we do not try to be compatible with
 * Claude Code's SKILL.md YAML frontmatter. A pi tool is a structured call
 * (validated args in, structured result out), which is a different contract.
 */
export interface SkillManifest {
	/** Unique tool name exposed to the LLM. Must match `^[a-z][a-z0-9_]*$`. */
	name: string;
	/** Short human-readable label used by chat UI. */
	label: string;
	/** Description shown to the LLM. Explain when and how to use the tool. */
	description: string;
	/**
	 * JSON Schema describing the tool arguments. Only a small subset is
	 * supported: `type: "object"`, `properties`, `required`.
	 */
	parameters: {
		type: "object";
		properties: Record<string, JsonSchemaProperty>;
		required?: string[];
	};
	/** Entry filename relative to the skill directory. Defaults to `run.sh`. */
	entry?: string;
	/**
	 * Environment variable names to forward from the server process to the
	 * skill subprocess. Nothing else is forwarded, to keep the blast radius
	 * small.
	 */
	env?: string[];
	/** Optional per-skill timeout in milliseconds. Defaults to 60_000. */
	timeoutMs?: number;
}

interface JsonSchemaProperty {
	type: "string" | "number" | "integer" | "boolean";
	description?: string;
	enum?: string[];
	default?: unknown;
}

// -----------------------------------------------------------------------------
// Manifest -> TypeBox schema
// -----------------------------------------------------------------------------

function propToSchema(prop: JsonSchemaProperty): TSchema {
	const opts: Record<string, unknown> = {};
	if (prop.description) opts.description = prop.description;
	if (prop.default !== undefined) opts.default = prop.default;
	switch (prop.type) {
		case "string":
			if (prop.enum) {
				return Type.Union(
					prop.enum.map((v) => Type.Literal(v)),
					opts,
				);
			}
			return Type.String(opts);
		case "number":
			return Type.Number(opts);
		case "integer":
			return Type.Integer(opts);
		case "boolean":
			return Type.Boolean(opts);
	}
}

function manifestToParameters(manifest: SkillManifest): TSchema {
	const props: Record<string, TSchema> = {};
	for (const [key, prop] of Object.entries(manifest.parameters.properties)) {
		props[key] = propToSchema(prop);
	}
	const required = new Set(manifest.parameters.required ?? []);
	const shaped: Record<string, TSchema> = {};
	for (const [key, schema] of Object.entries(props)) {
		shaped[key] = required.has(key) ? schema : Type.Optional(schema);
	}
	return Type.Object(shaped);
}

// -----------------------------------------------------------------------------
// Subprocess runner
// -----------------------------------------------------------------------------

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 60_000;

interface RunOutcome {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

function runSkill(
	execPath: string,
	args: unknown,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<RunOutcome> {
	return new Promise((resolve, reject) => {
		const child = spawn(execPath, [], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (buf: Buffer) => {
			stdout += buf.toString("utf8");
		});
		child.stderr.on("data", (buf: Buffer) => {
			stderr += buf.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, code, timedOut });
		});
		child.stdin.end(JSON.stringify(args ?? {}));
	});
}

// -----------------------------------------------------------------------------
// Public API: load skills into AgentTool[]
// -----------------------------------------------------------------------------

export interface LoadedSkill {
	manifest: SkillManifest;
	dir: string;
	tool: AgentTool;
}

export interface LoadSkillsOptions {
	/** Colon-separated list of directories to scan. */
	roots: string[];
}

export async function loadSkills(options: LoadSkillsOptions): Promise<LoadedSkill[]> {
	const loaded: LoadedSkill[] = [];
	const seen = new Set<string>();
	for (const root of options.roots) {
		const absRoot = path.resolve(root);
		let entries: string[];
		try {
			entries = await readdir(absRoot);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const dir = path.join(absRoot, entry);
			try {
				const s = await stat(dir);
				if (!s.isDirectory()) continue;
			} catch {
				continue;
			}
			const manifestPath = path.join(dir, "skill.json");
			let manifest: SkillManifest;
			try {
				manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SkillManifest;
			} catch {
				continue;
			}
			if (!NAME_RE.test(manifest.name)) {
				console.warn(`[skill-loader] skipping ${dir}: invalid name ${JSON.stringify(manifest.name)}`);
				continue;
			}
			if (seen.has(manifest.name)) {
				console.warn(`[skill-loader] duplicate skill name ${manifest.name} at ${dir}; keeping first`);
				continue;
			}
			seen.add(manifest.name);
			const entryName = manifest.entry ?? "run.sh";
			const execPath = path.join(dir, entryName);
			const parameters = manifestToParameters(manifest);
			const timeoutMs = manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const envAllow = new Set(manifest.env ?? []);
			const tool: AgentTool = {
				name: manifest.name,
				label: manifest.label,
				description: manifest.description,
				parameters,
				execute: async (_toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
					const childEnv: NodeJS.ProcessEnv = {
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						LANG: process.env.LANG,
					};
					for (const key of envAllow) {
						const v = process.env[key];
						if (v !== undefined) childEnv[key] = v;
					}
					const outcome = await runSkill(execPath, params, childEnv, timeoutMs, signal);
					if (outcome.timedOut) {
						throw new Error(`skill ${manifest.name} timed out after ${timeoutMs}ms`);
					}
					if (outcome.code !== 0) {
						const stderr = outcome.stderr.trim().slice(0, 4000);
						throw new Error(
							`skill ${manifest.name} exited with code ${outcome.code}${stderr ? `: ${stderr}` : ""}`,
						);
					}
					// Convention: run.sh writes plain text to stdout. If it writes JSON with
					// a top-level "content" array of {type:"text",text:string}, we use that.
					const text = outcome.stdout;
					let details: unknown = { stderr: outcome.stderr };
					let contentBlocks: AgentToolResult<unknown>["content"];
					try {
						const parsed = JSON.parse(text);
						if (
							parsed &&
							typeof parsed === "object" &&
							Array.isArray((parsed as { content?: unknown }).content)
						) {
							contentBlocks = (parsed as { content: AgentToolResult<unknown>["content"] }).content;
							if ((parsed as { details?: unknown }).details !== undefined) {
								details = (parsed as { details: unknown }).details;
							}
						} else {
							contentBlocks = [{ type: "text", text }];
						}
					} catch {
						contentBlocks = [{ type: "text", text }];
					}
					return { content: contentBlocks, details };
				},
			};
			loaded.push({ manifest, dir, tool });
		}
	}
	return loaded;
}
