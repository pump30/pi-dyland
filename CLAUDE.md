# CLAUDE.md — pi-dyland

Project-specific development rules for `github.com/pump30/pi-dyland`. These rules override generic defaults. Follow them exactly.

---

## 1. Project overview

**pi-dyland** is a personal AI agent HTTP service running on the owner's ZSpace NAS. It embeds `@earendil-works/pi-agent-core` (pi SDK) into a Hono server, streams responses over SSE to a vanilla-JS chat UI, and routes LLM calls to `aicore-proxy` (Anthropic-compatible, backed by SAP AI Core → Claude Opus) at `http://127.0.0.1:6655` on the same NAS host.

The agent's tools are subprocesses declared as **skills** in `skills/<name>/{skill.json, run.sh}`. The skill contract is bespoke — it is **not compatible with Claude Code's SKILL.md format** and shall not be made compatible.

Deployment target: single-user, home LAN + Cloudflare Tunnel (`https://pi.superdyland.uk`). Auth: HTTP Basic Auth in front of every route except `/health`.

Non-goals: multi-tenant sessions, per-request agent instances, plugin marketplace, arbitrary binary file uploads, mobile-native UI.

---

## 2. Tech stack (fixed — do not swap)

- Runtime: **Node.js ≥ 22.19** with `--experimental-strip-types --no-warnings` (no build step, `.ts` runs directly)
- HTTP: **Hono 4.11.6** + **@hono/node-server 1.19.7**
- LLM SDK: **@earendil-works/pi-agent-core 0.80.7**, **@earendil-works/pi-ai 0.80.7**, model API `anthropic-messages`
- Schemas: **typebox 1.1.38** (must match pi packages — never bump independently)
- TS: **typescript 5.9.3** for typecheck only (no emit); **tsx 4.22.1** for `npm run dev`
- Frontend: **plain HTML + vanilla ES2020 JS**, no framework, no bundler, no CSS preprocessor
- Container: `node:22-bookworm-slim` base, `curl + jq + python3` runtime deps for skills
- Package versions are **pinned exactly** (no `^`, no `~`). If a bump is needed, verify with `npm view <pkg>@<version> version` before editing `package.json`.

---

## 3. Directory structure — authoritative

```
pi-dyland/
├── src/                    # Node backend (Hono + pi-agent-core)
│   ├── server.ts           # Hono app, routes, SSE, middleware — single entry
│   ├── agent-factory.ts    # Model<anthropic-messages> + Agent + streamFn wrapper
│   ├── skill-loader.ts     # scan skills/*/skill.json → AgentTool[]
│   ├── memory.ts           # long-term memory: profile.json / preferences.json + `remember` tool
│   └── web-next/           # BUILD OUTPUT of web-next/ (Next.js static export) — gitignored
│       ├── index.html
│       ├── 404.html
│       └── _next/static/…
├── web-next/               # Next.js + React + Tailwind + shadcn frontend source
│   ├── src/app/            # App Router (page.tsx, layout.tsx, globals.css)
│   ├── src/components/     # ChatApp, ThreadSidebar, Composer, MessageList, ToolCard, ui/*
│   ├── src/lib/            # api.ts, types.ts, utils.ts, convert-messages.ts
│   ├── next.config.ts      # output: "export", trailingSlash: true
│   ├── tailwind.config.ts
│   └── package.json        # Node 22, pnpm-optional, exact-pinned
├── skills/
│   └── <name>/             # each skill = one directory
│       ├── skill.json      # manifest
│       └── run.sh          # entry (or custom, set via manifest.entry)
├── scripts/                # NAS ops helpers (not application code)
│   ├── autodeploy.sh                  # poll origin/main, reconcile container — see §15.5
│   ├── pi-dyland-autodeploy.service   # systemd oneshot
│   └── pi-dyland-autodeploy.timer     # 60s trigger
├── Dockerfile
├── docker-compose.yml      # kept for reference; NAS uses raw `docker run`
├── .dockerignore
├── .env.example            # authoritative list of supported env vars
├── .gitignore
├── package.json            # backend deps, exact-pinned
├── tsconfig.json           # noEmit, strict
├── README.md
└── CLAUDE.md
```

Rules:
- **Do not add a `src/routes/`, `src/services/`, `src/utils/` layer.** The server has 6 routes; splitting is premature and hurts readability. Keep everything in `src/*.ts` flat.
- **Never introduce `dist/`, `build/`, or a bundler output.** Node strips TS at runtime.
- **`skills/` is the only extension point.** Do not add extension mechanisms elsewhere.
- **No `public/`, no `assets/` at repo root.** Frontend source lives under `web-next/src/`; build output lands in `src/web-next/` (gitignored) and is served relative to `import.meta.url`.
- **No `tests/`** exists yet; when tests are added they go in `test/` at repo root and use `node --test`. Do **not** introduce vitest/jest.
- **`scripts/` is for NAS ops only** — the autodeploy shell script and its two systemd units. Do not put application code, CI logic, or task runners here. Adding a fourth file needs justification: see §15.5.

---

## 4. File creation rules

Create a new file only if **all** of these hold:
1. Its concern does not fit in an existing file (`server.ts`, `agent-factory.ts`, `skill-loader.ts`).
2. It will be imported from at least one other file, or is a new skill directory.
3. It is not a wrapper around a single call site.

Explicitly forbidden new files:
- `src/config.ts` — env vars live at the top of `server.ts`; there are ~10 of them, extraction is overhead.
- `src/logger.ts` — `console.log/error` prefixed with `[server]` / `[req]` / `[chat]` is enough; do not adopt pino/winston.
- `src/types.ts` — inline interfaces where used. Only `agent-factory.ts` exports types (`AicoreModelConfig`, `CreateAgentOptions`); nothing else needs a shared type file.
- `src/middleware/` — Hono middleware is 3–8 lines each; keep inline in `server.ts`.
- Backend files under `src/` beyond `server.ts`/`agent-factory.ts`/`skill-loader.ts`/`memory.ts` need a real justification; `src/web-next/` is a build artifact (see §10) and does not count.

Frontend (`web-next/`) follows Next.js App Router conventions: `src/app/` for routes, `src/components/` for React components, `src/lib/` for helpers. New components / hooks / types under those trees do not need explicit approval — but keep the number of components small; do not duplicate shadcn primitives.

New skill = new directory under `skills/`. Never scatter skill code elsewhere.

---

## 5. Coding rules

### 5.1 Language & syntax
- **Backend** (`src/*.ts`, excluding `src/web-next/`): TypeScript strip-only mode. **No JSX** in backend code. Erasable TS syntax only: no `enum`, no `namespace`, no parameter properties (`constructor(private x)`), no `import =`, no `export =`. Use explicit fields + constructor assignment.
- **Frontend** (`web-next/`): Next.js 15 + React 19 + TypeScript + Tailwind CSS + shadcn/ui components. JSX allowed here and here only. See §10 for the rest of the frontend contract.
- Top-level imports only in backend. **No `await import()`, no `import("x").Type`, no dynamic type imports.**
- No `any` unless the pi/Hono type surface leaves no alternative; when unavoidable, immediately narrow at the boundary with `as`.
- Prefer `unknown` for untrusted input (`c.req.json()` result), narrow with type-guards inline.
- Strings: double quotes to match existing file style. Semicolons: required (existing style).
- Async: `async/await` only, no bare `.then()` chains except for one-shot fire-and-forget on the frontend.

### 5.2 Imports
- Order within a file: node built-ins → third-party → workspace-local (`./`). Blank line between groups. Match existing ordering in `server.ts`.
- Import types with `import type { X } from ...`, never mix runtime and type imports on one line unless already colocated.
- Do **not** deep-import pi internals (e.g. `@earendil-works/pi-ai/src/api/...`). Use the package's public surface (`@earendil-works/pi-ai`, `@earendil-works/pi-ai/compat`).

### 5.3 Naming
- Files: `kebab-case.ts` (`agent-factory.ts`, `skill-loader.ts`). Web files: `kebab-case` too (`app.js`, `index.html`).
- Types & interfaces: `PascalCase` (`ChatBody`, `ValidatedAttachments`, `SkillManifest`).
- Functions & variables: `camelCase`. Constants that are compile-time immutable and used as caps in the current code (`MAX_IMAGES`, `HEARTBEAT_MS`, `DEFAULT_TIMEOUT_MS`): `SCREAMING_SNAKE_CASE`.
- Skill names in `skill.json`: `snake_case`, must match `^[a-z][a-z0-9_]*$` (enforced by `skill-loader.ts`). Skill **directory** names: `kebab-case` (e.g. `nas-calendar/` contains `"name": "nas_calendar"`). Keep this convention — do not unify.
- Env vars: `SCREAMING_SNAKE_CASE`. Group by consumer (`AICORE_*`, `AUTH_*`, `SMTP_*`, `CALDAV_*`).

### 5.4 Comments
- Write comments to explain **why**, not what. Delete comments that restate the code.
- Every non-obvious workaround **must** cite the reason. Examples that already exist and set the bar:
  - The `streamFn` wrapper in `agent-factory.ts` comments why `Model.headers` alone doesn't work.
  - The `HEARTBEAT_MS` block in `server.ts` cites Cloudflare's 100s edge timeout.
- No JSDoc `@param` / `@returns` unless the function is exported and non-obvious. Prefer good types + short leading comment.
- Do **not** add comments to code you didn't touch in the current change.

### 5.5 Error handling
- Skills report failure via **non-zero exit code + stderr**. `skill-loader.ts` converts that to `throw new Error(...)`. Do not change this contract.
- Server-side: wrap `agent.prompt()` in try/catch, `console.error("[chat] agent.prompt failed:", err)` + SSE `{type:"error", message}`. Do not swallow.
- Client-side (`app.js`): catch fetch errors, render `addMessage("error", ...)`. Never `alert()`.
- No `try/catch` for effects that can't fail (JSON stringify of known objects, `Number.parseInt` of validated strings). Trust framework guarantees.
- Do **not** add error boundaries, retry loops, or circuit breakers speculatively. Add only when a real failure is observed and cheap to reproduce.

### 5.6 No over-engineering
- No feature flags. No config objects with 20 fields. No abstract base classes.
- No wrapper functions that forward one argument.
- No "just in case" validation for internal-to-internal calls.
- One implementation per concern. If a second appears, delete the first.

---

## 6. HTTP route rules (`src/server.ts`)

Existing routes are the complete API. Do **not** add REST-y CRUD or "future-proofing" endpoints.

| Route | Method | Contract |
|---|---|---|
| `/health` | GET | Public. Returns `{ok, aicore:{baseUrl, model}, skills:[{name,label}], threads}`. Never require auth. Never add PII. |
| `/skills` | GET | Auth. Returns manifest array (name, label, description, parameters). Read-only. |
| `/threads` | GET | Auth. Returns `[{id, title, createdAt, lastActiveAt, messageCount, inFlight}]` sorted by `lastActiveAt` desc. |
| `/threads` | POST | Auth. Body `{title?}`. Creates a new thread (UUID id), returns the entry. |
| `/threads/:id` | PATCH | Auth. Body `{title?}`. Renames. 404 if unknown. |
| `/threads/:id` | DELETE | Auth. Deletes non-default thread; returns 400 for `default`. |
| `/threads/:id/cancel` | POST | Auth. Rebuilds the thread's Agent instance, dropping any in-flight prompt. Returns `{ok, action, wasInFlight}`. Safe no-op if the thread has no Agent yet. DeerFlow-equivalent of LangGraph's `runs/:run_id/cancel`. |
| `/messages` | GET | Auth. Full transcript of the thread selected via `?thread=<id>` or `X-Thread-Id` header. Defaults to `default`. Read-only. |
| `/reset` | POST | Auth. **Rebuilds** the thread's Agent (drops messages + any stuck run). Returns `{ok, action}`. Idempotent. |
| `/chat` | POST | Auth. Body: `{prompt?, images?, files?, threadId?}` (threadId defaults to `default`, also honors `?thread=`/`X-Thread-Id`). Response: SSE. Returns **409 "thread busy"** if the thread already has a prompt streaming — client must wait or hit `/threads/:id/cancel`. Server may auto-derive the thread title from the first user prompt. |
| `/` | GET | Auth. Serves `src/web-next/index.html` (Next.js static export). |
| `/*` | GET | Auth. Static file server rooted at `src/web-next/` for `_next/static/…` and other Next assets. Falls through to 404 for unknown paths. |

Rules:
- Every route except `/health` is Basic-Auth-protected via one `app.use("*", ...)` middleware. **Do not add per-route auth middleware.** If a new route must be public, extend the `/health` bypass explicitly.
- The request logger middleware (`[req] METHOD PATH -> STATUS ms`) must remain first. Do not silence.
- `/chat` is the **only** SSE endpoint. Rules for it:
  - Emit `: ready\n\n` **immediately** on stream open (before touching the agent). This is the Cloudflare 524 guard — never remove.
  - Emit `: heartbeat <ts>\n\n` every `HEARTBEAT_MS` (15s) while the agent runs. Clear the interval in `finally`.
  - Unsubscribe from `agent.subscribe(...)` in `finally`. Leaked subscriptions cause "agent already processing" errors on next turn.
  - Event names emitted to the client are fixed: `assistant_start`, `text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `error`, `done`. Adding a new event type requires matching handling in `app.js`.
- Body validation: mirror `parseAttachments()` in `server.ts` — enforce limits **server-side even if the UI enforces them client-side**. Client is untrusted.
- Attachment limits are constants at the top of `server.ts`: `MAX_IMAGES=6`, `MAX_IMAGE_BYTES=5MB`, `MAX_FILES=10`, `MAX_FILE_BYTES=200KB`, `ALLOWED_IMAGE_MIMES={jpeg,png,gif,webp}`. Match the same values in `app.js`. When adjusting, update both.
- No new middleware unless there's a real request-level cross-cutting concern (request log, auth are the two we have). CORS, compression, rate limit: not needed for single-user LAN + tunnel.

---

## 7. Agent & LLM rules (`src/agent-factory.ts`)

- The agent is **per-thread**. `server.ts` maintains `Map<threadId, Agent>` (bounded by `MAX_THREADS=50`, LRU-evicted; `default` thread is never evicted). Legacy single-thread callers (old UI, curl without `?thread=`) implicitly use the `default` thread. Do NOT per-request the agent — a thread's agent lives for the lifetime of the thread. Model config, tools, and system prompt are shared across all threads.
- Thread IDs must match `^[a-zA-Z0-9_-]{1,64}$` or the literal `default`; invalid IDs are silently rewritten to `default` in `threadIdFrom()`. This is the boundary check for URL/header input.
- **Cancel / stuck-agent recovery**: pi-agent-core has no public API to interrupt an in-flight `agent.prompt()`. `POST /threads/:id/cancel` and `POST /reset` both call `rebuildAgent()`, which **swaps `entry.agent` for a fresh instance and drops the stuck one**. The abandoned Agent's promise keeps running in the background (with its subscription already unsubscribed, so nothing is emitted), and pi-agent-core garbage-collects it. This is the DeerFlow-equivalent of "start a fresh run" — do NOT try to reach into pi-agent-core internals to abort the old prompt.
- **`inFlight` semantics**: `ThreadEntry.inFlight` is set to `true` before `agent.prompt()` and cleared in `finally` — but only if `entry.agent === agent` (i.e., cancel/reset didn't swap the Agent while we were streaming). `POST /chat` rejects overlapping requests on the same thread with `409 "thread busy"` before pi-agent-core can throw its cryptic "already processing" error.
- Model configuration is fixed to `api: "anthropic-messages"`, `provider: "superdyland"`, `baseUrl` from `AICORE_BASE_URL`. `contextWindow: 200_000`, `maxTokens: 32_000`. Do not lower.
- **Bearer auth quirk (critical):** aicore-proxy uses `Authorization: Bearer <token>`, not `x-api-key`. pi-ai only auto-sends bearer when the token starts with `sk-ant-oat`. Our token is `sk-aicore-proxy-key` (aicore-proxy's own), so `buildAicoreStreamFn` wraps pi-ai's `streamSimple` and merges `Authorization` into `options.headers`. **Do not "clean up" this wrapper by moving auth to `Model.headers` — pi-ai's `assertRequestAuth` only inspects `options.headers`.**
- `getApiKey` on `Agent` is not used; auth is header-injected via the wrapper. Do not reintroduce.
- System prompt lives inline as `DEFAULT_SYSTEM_PROMPT` in `agent-factory.ts`. Keep it under 400 tokens. When editing, preserve the "Chinese with English technical terms" and "no filler" directives — they encode the owner's preference.
- Tools passed at construction time. Adding a tool = adding a skill (see §8), not editing agent-factory. The built-in `remember` tool (from `memory.ts`) is registered by `createPersonalAgent` alongside skills.

---

## 8. Skill rules (`skills/*/`)

The skill contract is stable. Every skill:

1. Lives in `skills/<kebab-case-dir>/`.
2. Has `skill.json` with these fields:
   ```json
   {
     "name": "snake_case_name",
     "label": "Human Readable",
     "description": "Explain WHEN the LLM should use this tool. Not a technical spec.",
     "parameters": {
       "type": "object",
       "properties": { "arg": { "type": "string", "description": "..." } },
       "required": ["arg"]
     },
     "entry": "run.sh",
     "env": ["ALLOWLISTED_ENV_VAR_1", "ALLOWLISTED_ENV_VAR_2"],
     "timeoutMs": 15000
   }
   ```
3. Has `run.sh` (or the file named by `entry`) that:
   - Reads a JSON object from stdin (`INPUT="$(cat)"`).
   - Uses `jq -r '.field // empty'` for extraction; validates required fields early with `[[ -z "$X" ]] && { echo "missing: X" >&2; exit 2; }`.
   - Uses `: "${ENV_VAR:?ENV_VAR not set}"` for required env — this surfaces a clean error to the LLM.
   - Writes result to stdout. Either plain text (wrapped as a single text block) or a JSON object with a top-level `content` array of `[{type:"text", text:"..."}]`.
   - Exits 0 on success, non-zero on failure. Skill loader converts non-zero → `throw new Error("skill X exited with code N: <stderr>")`.
4. Uses only tools available in the runtime image: `bash`, `curl`, `jq`, `python3`, `date`. **No** node, npm, apt, or extra binaries. If you need more, extend the Dockerfile `apt-get install` line and document why.
5. `manifest.env` is an **allowlist**. `skill-loader.ts` only forwards `PATH`, `HOME`, `LANG`, plus the listed names. Empty allowlist = subprocess has no app env. Do not "just pass all env" — this is the security boundary.

Forbidden in skills:
- Reading files from the container filesystem outside `/app/skills/<name>/`. If a skill needs data, receive it as an argument or fetch it via HTTP.
- Long-running processes (>`timeoutMs`). Skill loader `SIGKILL`s.
- Writing to `/app` at runtime (image is read-only conceptually; volume mount is `:ro`).

Do **not** port arbitrary Claude Code SKILL.md skills wholesale. Each port requires a fresh `skill.json` + `run.sh` that captures the behaviour with structured args.

**Description enrichment from Claude Code SKILL.md (Phase F):** if `CLAUDE_SKILLS_PATH` env is set (colon-separated), `skill-loader` looks for a same-named directory (snake ↔ kebab) and appends the SKILL.md frontmatter `description` to the pi skill's description under a "Claude Code companion notes:" line. This helps the LLM disambiguate tools using the richer Claude Code prose. **No SKILL.md scripts are executed**; the pi `skill.json + run.sh` remains the sole execution contract.

**Current skill inventory (do not remove without confirmation):**
- `nas-calendar` → tool `nas_calendar` (CalDAV via Radicale)
- `send-email` → tool `send_email` (Gmail SMTPS)
- `vault-lookup` → tool `vault_lookup` (kept as env-gated stub; never populate `VAULTWARDEN_TOKEN` in NAS `.env` — Vaultwarden master password never leaves the owner's Mac)
- `web-search` → tool `web_search` (Tavily HTTP API; requires `TAVILY_API_KEY`)

---

## 9. Data & state rules

- **No database.** No sqlite, no redis, no filesystem persistence for chat message history.
- The agent's `state.messages` is in-memory only. Loss on container restart is by design.
- **JSON files under `$DATA_DIR` are permitted** for durable long-term memory only: `profile.json` (LLM-written via the built-in `remember` tool) and `preferences.json` (user-written). Managed by `src/memory.ts`. Reads at startup, writes atomically via temp+rename. Do **not** extend this to store chat transcripts, session state, or arbitrary logs.
- `$DATA_DIR` defaults to `./data` locally; on NAS it must be bind-mounted from the host (`/tmp/zfsv3/sata11/15869560895/data/pi-dyland-data` → `/data`) so memory survives `docker rm -f`.
- No global mutable singletons besides the thread `Map` and the memory-module `state` in `server.ts` / `memory.ts`.
- No shared module-level caches. If caching is needed inside a skill, put it inside the skill's process (it dies with the subprocess).
- Env vars are read **once** at module load. Do not re-read `process.env` per request. **Reminder:** because Docker `--env-file` is captured at `docker run` time, changing `.env` requires `docker rm -f pi-dyland && docker run ...`. `docker restart` will NOT re-read.

---

## 10. Frontend rules (`web-next/`, built into `src/web-next/`)

- **Stack**: Next.js 15 (App Router, `output: "export"` static export), React 19, TypeScript, Tailwind CSS v3, shadcn/ui-style components (hand-rolled, not the shadcn CLI). Icons from `lucide-react`. Markdown via `react-markdown` + `remark-gfm`.
- **No Next.js server runtime in production.** The build emits static HTML/JS/CSS into `web-next/out/`; deployment copies that into `src/web-next/` and Hono `serveStatic` serves it. Anything requiring SSR/`/api` routes/middleware is not allowed.
- **API is same-origin at deploy time.** Frontend calls relative paths (`/threads`, `/chat`, `/skills`, …). In `next dev` on port 3000, set `NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787` (already the default when `window.location.port === "3000"`). Never bake absolute prod URLs into the bundle.
- **Component library rules**: shadcn-style components live under `web-next/src/components/ui/`. Hand-copy new primitives (Radix + `cva`); do **not** install a design system runtime (no Ant Design, MUI, Chakra). Keep icons in `lucide-react`.
- **Theming**: single dark theme applied via `<html class="dark">` in `layout.tsx`. CSS variables in `web-next/src/app/globals.css` under `@layer base`. Do not add a light theme unless requested.
- **Viewport**: `<body class="h-[100dvh] overflow-hidden">` + `viewport-fit: cover` + `themeColor: "#09090b"` in `layout.tsx`. `100dvh` (not `100vh`) is required so iOS Safari's dynamic address bar does not push the composer off-screen. Do not revert to `h-screen`.
- **State**: React state + refs. No Redux, no Zustand, no React Query unless a real need appears. `localStorage` OK for the active-thread pointer only.
- **SSE parsing** lives in `web-next/src/lib/api.ts` (`streamChat`) and the reducer in `web-next/src/components/chat-app.tsx` (`applySseEvent`). Event union must mirror the one emitted by `src/server.ts` in `/chat`. Adding an event type requires touching both sides in the same commit.
- **Message shape conversion** (pi Agent raw `Message[]` → client `ChatMessage[]`) lives in `web-next/src/lib/convert-messages.ts`. Handles pairing `tool_use` blocks in assistant messages with `tool_result` in the following tool message, and stripping `<system_hint>` markers.
- **Cancel / Stop wiring** (see §7 for the server contract):
  - `abortRef` holds the current `fetch` AbortController; `sendingThreadRef` remembers which thread is streaming (may differ from `activeId` if the user switched).
  - The Composer swaps Send for a destructive `Stop` button while `sending` is true; clicking it aborts the local fetch **and** fires `POST /threads/:id/cancel` so pi-agent-core's stuck instance is dropped server-side.
  - Switching threads mid-stream auto-cancels the previous one (`useEffect` on `activeId` watching `prevActiveRef`).
  - Closing the tab mid-stream fires `POST /threads/:id/cancel` via `navigator.sendBeacon` in a `beforeunload` handler.
  - `Reset` in the header calls `stopStreamLocal()` **then** `POST /reset`; both server routes now rebuild the Agent, so this is the escape hatch when a thread is jammed.
- **Responsive layout**:
  - Desktop (`≥ md`, 768px+): sidebar is inline `static`, always visible, 240px wide.
  - Mobile (`< md`): sidebar becomes a fixed drawer that slides in via `translate-x-{0,-full}` with a `backdrop-blur` overlay. Header shows a hamburger `☰` (`md:hidden`) that flips `sidebarOpen`. Picking a thread or tapping the backdrop closes the drawer.
  - The `Reset` button hides its label on `< sm` (`hidden sm:inline`) so the header stays tight on phones.
  - Do not swap this pattern for a runtime device detector; media-query classes are enough.
- **File & image attachment limits** in `web-next/src/components/composer.tsx` must match `src/server.ts` constants (`MAX_IMAGES=6`, `MAX_IMAGE_BYTES=5MB`, `MAX_FILES=10`, `MAX_FILE_BYTES=200KB`, `ALLOWED_IMAGE_MIMES`). Client-side check is for UX, not security.
- **No file upload API besides base64-in-JSON.** No multipart, no service worker, no PWA manifest, no offline mode.
- **Build & deploy**:
  1. Local: `cd web-next && npm ci && npm run build` (~5s cold).
  2. Copy output: `rm -rf src/web-next && mkdir -p src/web-next && cp -R web-next/out/. src/web-next/`.
  3. Deploy: sync `src/web-next/` to NAS along with `src/server.ts`; rebuild container.
- **Do not check in `src/web-next/`** — `.gitignore` excludes it. It is a build artifact.

---

## 11. Environment & configuration

All configuration flows through `.env` on the NAS, sourced by `docker run --env-file .env`. Rules:

1. `.env.example` in the repo is the authoritative list. Add a new var here first, with a comment describing purpose and default, before referencing it in code.
2. `AICORE_TOKEN` and `AUTH_PASS` are non-optional in production; missing `AICORE_TOKEN` causes `process.exit(1)`. Missing `AUTH_USER`/`AUTH_PASS` logs a loud warning and runs open — this is fine only for local dev.
3. Skill env vars use the skill name as prefix (`SMTP_*` for send_email, `CALDAV_*` for nas_calendar). New skills follow the same convention.
4. Never commit real values. `.env` is git-ignored; keep `.env.example` empty-valued.
5. Secrets stored in Vaultwarden by canonical name — retrieve, don't hardcode:
   - `Cloudflare API Token` — tunnel + DNS management
   - `DAV (Radicale on NAS)` — CalDAV
   - Gmail app password lives inline in the sibling `send-email` Claude Code skill (already known); when moving to pi-dyland `.env`, do not commit.
6. **Autodeploy notification credentials** live in a **separate** file on NAS: `/tmp/zfsv3/sata11/15869560895/data/pi-dyland-data/autodeploy-notify.env` (chmod 600, owned by user `15869560895`). Contains only `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, optionally `SMTP_TO`. **Physically isolated** from the app `.env` so a leak in one does not compromise the other, and so `autodeploy.sh` (running on the host, outside the container) never has to source the app's `.env`. Not committed anywhere.

---

## 12. Business iteration rules

Adding a feature:
1. Ask the user which of the three surfaces it touches: **agent behaviour** (system prompt / tool set), **skill** (new capability), **UI** (chat surface / attachment / rendering). If unsure, ask before coding.
2. Minimal viable change. A "new feature" that requires touching `server.ts` + `agent-factory.ts` + `skill-loader.ts` + `app.js` in one commit is a sign of scope creep — split it.
3. Prefer a new skill over new server code. Skills are hot-reloadable via bind mount; server changes require rebuild.
4. Before writing code: verify pi SDK support (`grep -rn` in `pi/packages/agent/src` and `pi/packages/ai/src`). Don't guess types from README.
5. UI additions must survive a page reload with no state. Do not introduce URL-based state or localStorage without confirming the user wants persistence.

Renaming / restructuring:
- Do not rename skills after creation — the LLM has been prompted with the current tool names. Renames break existing agent history.
- Do not rename `pi-dyland`, `pi.superdyland.uk`, `aicore-proxy`, or NAS container names. These are referenced from cloudflared config, memory files, and this document.

---

## 13. Bug fix rules

1. Reproduce first. If the bug is client-reported, ask for the exact prompt, timestamp, and any HTTP status code. If none available, look at `sudo docker logs pi-dyland` on NAS (see §15 for the SSH invocation).
2. Fix the root cause, not the symptom. Examples:
   - "Agent already processing" after a client abort → the leaked subscription/interval is the bug, not the error message. Fix by ensuring `finally` cleanup (already in place; regressions must preserve it).
   - Cloudflare 524 → origin didn't emit bytes within 100s. The heartbeat is the fix; do not extend CF timeout (Enterprise-only anyway).
3. When touching `agent-factory.ts` or the streamFn wrapper, re-verify the bearer auth path (§7) with a fresh container + one simple prompt.
4. Never `git reset --hard`, `git checkout .`, or `git push --force` while investigating. Root-cause and fix forward.
5. If the fix requires the container to see new env vars, always: `docker rm -f pi-dyland && docker run ...`. `docker restart` will silently keep the old env and mask the fix.
6. Regressions must land with a comment or commit-message note explaining what pattern is being defended (e.g., the `: ready` line's comment cites CF 524).

---

## 14. Git rules

- Repo: `github.com/pump30/pi-dyland` (public). Working branch during active dev: `vk/5811-init-the-persona`. `main` intentionally lags — merge only when the owner asks.
- Commit style: `<type>: <one-line summary>` where type ∈ `feat, fix, chore, docs, refactor`. Body wrapped at ~72 cols. Focus on **why**.
- Stage explicit paths (`git add src/server.ts web-next/src/components/chat-app.tsx`). **Never `git add -A` or `git add .`.**
- Never commit `.env`, `node_modules/`, `dist/`.
- Never bypass hooks (`--no-verify`), never `--amend` a pushed commit.
- Only commit when the owner explicitly asks or when a stop-hook demands it. Pushing to `origin` counts as an external action — do not push unprompted.

---

## 15. Local run & deployment rules

### 15.1 Local dev (owner's Mac)

```bash
cd pi-dyland
npm install --ignore-scripts
cp .env.example .env
# fill AICORE_TOKEN (get from aicore-proxy container: sk-aicore-proxy-key)
npm run dev          # tsx watch src/server.ts
# open http://localhost:8787/
```

- Never run `npm audit fix --force`.
- Never introduce a `postinstall` script. Lifecycle scripts require review.
- Never bump `pi-*` versions without confirming they still expose the API surface used by `agent-factory.ts` (`Agent`, `streamSimple`, `Model<"anthropic-messages">`, `ImageContent`).

### 15.2 NAS deployment (manual / recovery flow)

> **Default path is autodeploy (§15.5).** This section covers the manual flow used for feature-branch previews (not `main`), first-time provisioning, and recovery when autodeploy is disabled or stuck.

NAS access:
```bash
sshpass -p '963852ABCabc' ssh \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=accept-new \
  -o PreferredAuthentications=password \
  nas '<command>'
```
The `PreferredAuthentications=password` flag is **required** — without it password auth silently fails through the cloudflared proxy.

Deploy path on NAS: `/tmp/zfsv3/sata11/15869560895/data/pi-dyland` (owner `15869560895`). Directory must be created first via the ZSpace Dashboard (SSH user cannot mkdir in `/`), then `sudo chown -R 15869560895:15869560895 <dir>`.

Sync source to NAS — two options, pick per availability:
1. **Preferred:** `cd <target> && git fetch origin <branch> && git reset --hard FETCH_HEAD`
2. **Fallback when GitHub is unreachable from NAS (intermittent):** pipe individual files via SSH:
   ```bash
   cat src/server.ts | sshpass -p '...' ssh ... nas 'cat > /tmp/zfsv3/.../pi-dyland/src/server.ts'
   ```
   Use only when git fetch fails. Note that the NAS working tree will drift from GitHub — reconcile with a later `git fetch && git reset --hard` when connectivity returns.

Build & run on NAS:
```bash
cd /tmp/zfsv3/sata11/15869560895/data/pi-dyland
sudo docker build -t pi-dyland:local .
sudo docker rm -f pi-dyland                       # required if updating env
sudo docker run -d --name pi-dyland \
  --restart unless-stopped \
  --network host \
  --env-file .env \
  -v "$PWD/skills":/app/skills:ro \
  pi-dyland:local
```

**Hard rules for deployment:**
- **`docker restart` does NOT re-read `--env-file`.** Any `.env` change requires `docker rm -f && docker run`. Confirm with `docker inspect pi-dyland --format '{{range .Config.Env}}{{println .}}{{end}}' | grep <VAR>`.
- Always `--network host`. Do not switch to bridge; aicore-proxy is reached at `127.0.0.1:6655` and the tunnel expects the origin at `127.0.0.1:8787`.
- Skills bind-mount is `:ro`. Editing `skills/*/run.sh` on the host takes effect immediately, no rebuild needed. Editing `skill.json` requires a **container restart** (loader runs at startup).
- Rebuild in the background if the terminal will timeout: `nohup bash -c "docker build ... && docker rm -f ... && docker run ..." > /tmp/pi-dyland-build.log 2>&1 &`.
- Verify after every deploy: `curl -sS http://127.0.0.1:8787/health` on NAS, then `curl -sS https://pi.superdyland.uk/health` externally.
- Do not run `docker compose` or `docker buildx` — the NAS Docker 26.1.4 has neither.
- Do not push `pi-dyland:local` to a registry. It's local-only by design.

### 15.3 Cloudflare Tunnel

- Tunnel `c301eb1f-8c29-4adb-b429-4ed1979484f3` (account `a932d244b25d2adb04d8deab3c7bf743`, zone `superdyland.uk` = `8b9d0a2f9228f60290f055b36a691ced`) already routes `pi.superdyland.uk` → `http://127.0.0.1:8787`.
- Ingress config lives at Cloudflare, not on the NAS. Modify via API: `PUT /accounts/<acc>/cfd_tunnel/<t>/configurations`, insert before the catch-all `http_status:404`.
- Token scope required: `Cloudflare Tunnel:Edit` + `Zone:DNS:Edit`. Token stored in Vaultwarden as `Cloudflare API Token`.
- **No `Access:Edit`** — Cloudflare Access apps must be created manually in the Zero Trust dashboard. Do not attempt automation.
- Adding another hostname: append an ingress rule + `POST /zones/<z>/dns_records` with `CNAME` → `<tunnel_id>.cfargotunnel.com`, `proxied: true`.

### 15.4 Health & observability

- `docker logs pi-dyland` shows `[server] ...` startup, `[req] METHOD PATH -> STATUS ms` per request, `[chat] agent.prompt failed: ...` on LLM errors. This is the only log surface — keep it useful.
- If a request hangs > 30s locally on NAS but heartbeats reach the client, aicore-proxy or SAP AI Core is slow; check `docker logs aicore-proxy` for the same time window.
- If the agent gets stuck in "already processing" state (client aborted mid-stream), `docker restart pi-dyland` clears it. This is a known rough edge; do not paper over with retry logic.

### 15.5 Autodeploy (main → NAS)

**Default deployment path.** A systemd oneshot service on the NAS polls `origin/main` every 60s. When the local `main` diverges from `origin/main` it reconciles the running container automatically.

**Files** (all live in `scripts/`, checked into the repo):
- `autodeploy.sh` — the polling reconciler.
- `pi-dyland-autodeploy.service` — systemd unit (`Type=oneshot`).
- `pi-dyland-autodeploy.timer` — 60s recurrence.

**Runtime footprint on NAS** (installed once, see "Provisioning" below):
- The two systemd unit files are copied to `/etc/systemd/system/`.
- SMTP notification credentials live at `/tmp/zfsv3/sata11/15869560895/data/pi-dyland-data/autodeploy-notify.env` (§11.6).
- Log: `/tmp/zfsv3/sata11/15869560895/data/pi-dyland-data/autodeploy.log`.
- Status: `/tmp/zfsv3/sata11/15869560895/data/pi-dyland-data/autodeploy.status` (one line: `ok@<sha>` / `build_failed@<sha>` / `unhealthy@<sha>` / etc). **Known limitation:** the status file is only rewritten on ticks that actually restart or rebuild the container — a series of no-op ticks (e.g. only `skills/*/run.sh` or docs changed) leaves the file pinned to the last mutating deploy's SHA. `autodeploy.log` is the source of truth for "is autodeploy currently running?"; treat `autodeploy.status` as "last mutating outcome".
- Lock: `.../pi-dyland-data/autodeploy.lock` — `flock` prevents overlapping ticks during a slow build.

**Action classification** (must stay in sync with `autodeploy.sh`'s case block):

| Files touched by the commit | Action |
|---|---|
| `Dockerfile`, `.dockerignore`, `package.json`, `tsconfig.json`, or any `web-next/**` | `docker build -t pi-dyland:candidate` → on success `docker rm -f && docker tag → :local && docker run`. On failure, old container keeps running and an alert email fires. |
| Any `src/**` or any `skills/*/skill.json` | `docker restart pi-dyland`. |
| Only `skills/*/run.sh` | **No-op.** `skills/` is bind-mounted `:ro` and the shell reads `run.sh` at each invocation. |
| Only `scripts/**` | **No-op.** systemd re-execs the script on each tick, so the new version takes effect one cycle later without any explicit reload. |
| Only docs, README, `.env.example` warnings, etc. | **No-op.** |

**Hard rules — do not "relax" without amending this section:**
- **Autodeploy never touches `.env`.** If `.env` shows up in `git diff` between `LOCAL_SHA` and `REMOTE_SHA`, the script refuses to deploy, alerts, and exits non-zero. This defends §11.4 (`.env` is git-ignored) against future mistakes.
- **`.env.example` changes are non-blocking** but always send an alert email so the owner can decide whether to sync the NAS `.env` manually. Autodeploy never edits `.env`.
- **Build failures preserve the running container.** The candidate tag pattern (`pi-dyland:candidate` first, swap to `:local` only after `docker build` returns 0) means a broken commit does not take the service down. The email alert is the operator's job to notice; there is no automatic rollback of git state — the working tree still lands on the broken commit so the next fix can be a follow-up commit, not a revert dance.
- **Health check is the source of truth for "deployed OK".** `curl -sSf http://127.0.0.1:8787/health` within 5s after the action. If it fails, status file is `unhealthy@<sha>` and an alert fires. The container is not automatically rolled back — the operator investigates.
- **No cross-branch support.** Only `origin/main` is watched. Feature branches use §15.2 manual flow.

**Pause / resume:**
```bash
sudo systemctl stop pi-dyland-autodeploy.timer      # pause
sudo systemctl start pi-dyland-autodeploy.timer     # resume
sudo systemctl disable pi-dyland-autodeploy.timer   # pause + survive reboot
```
When paused, the NAS behaves exactly like pre-autodeploy: §15.2 is the operator's path.

**Debugging:**
```bash
journalctl -u pi-dyland-autodeploy --since '10 min ago'          # systemd view
tail -f /tmp/zfsv3/.../pi-dyland-data/autodeploy.log             # script view
cat /tmp/zfsv3/.../pi-dyland-data/autodeploy.status              # last outcome
```

**Provisioning** (one-time, after PR that adds §15.5 files is merged to main and pulled onto NAS):
```bash
sudo cp /tmp/zfsv3/.../pi-dyland/scripts/pi-dyland-autodeploy.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-dyland-autodeploy.timer
# then write the SMTP creds file (§11.6):
umask 077 && cat > /tmp/zfsv3/.../pi-dyland-data/autodeploy-notify.env <<'EOF'
SMTP_HOST=smtp.gmail.com
SMTP_USER=<gmail user>
SMTP_PASS=<gmail app password>
EOF
```

---

## 16. What is out of scope (do not build unprompted)

- Multi-user sessions, login accounts, RBAC.
- Chat history persistence, transcript export.
- Alternate LLM backends (OpenAI, Gemini). The pi SDK supports them; the agent doesn't need them.
- Voice input, audio output, image generation.
- Streaming file uploads, chunked file processing, PDF/Office parsing.
- Docker Compose migration, Kubernetes, ECS.
- Webhook-triggered redeploys, GitHub Actions, self-hosted runners, or any push-based CI. **Polling-based autodeploy is scoped in §15.5 and is the only automation surface.**
- Rate limiting, CSRF tokens, CORS — the service is single-user behind Basic Auth on a private hostname.

If any of the above is requested, revisit this file and add the new rule set explicitly.
