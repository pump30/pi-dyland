# pi-dyland

Personal agent built on [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi-mono), served over HTTP with a minimal chat UI. LLM calls are routed to the SAP AI Core proxy (`aicore-proxy`) running on my NAS at `https://aicore.superdyland.uk` (Anthropic-compatible Messages API).

<!-- smoke-test-8 marker: README-only changes should trigger autodeploy no-op. -->

## Layout

```
pi-dyland/
├── src/
│   ├── server.ts          # Hono HTTP server: POST /chat (SSE), GET /skills, /health, /messages, /reset, static UI
│   ├── agent-factory.ts   # Builds Model<"anthropic-messages"> + Agent with getApiKey
│   ├── skill-loader.ts    # Scans skills/*/skill.json, spawns run.sh subprocesses as tools
│   └── web/               # Single-page chat UI (vanilla JS, SSE reader)
├── skills/
│   ├── send-email/        # SMTP via curl
│   ├── vault-lookup/      # Vaultwarden search (bw CLI or HTTP fallback)
│   ├── nas-calendar/      # CalDAV list/add/delete
│   └── zspace-nas/        # ZSpace NAS list/status/docker_ps
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Skill contract

Every skill is a directory under `skills/` with:

- `skill.json` — manifest with `name`, `label`, `description`, `parameters` (JSON Schema subset: `type: "object"` + `properties` + `required`), optional `entry` (default `run.sh`), optional `env` (env-var allowlist forwarded to the subprocess), optional `timeoutMs`.
- `run.sh` (or whatever `entry` names) — reads a JSON object of arguments on stdin, writes a result on stdout, exits 0 on success. Non-zero exit -> tool call is reported to the LLM as an error.

If stdout is JSON with a top-level `content` array (`[{type:"text",text:"..."}]`), that array is passed straight to the LLM; otherwise the raw stdout is wrapped as a single text block.

**This is not compatible with Claude Code's `SKILL.md` format** on purpose — pi tools need structured args and structured results, whereas Claude Code skills are natural-language instruction packs. If you want to port a Claude Code skill in `pump30/MySkill`, write a new `skill.json` + `run.sh` here that captures its behavior.

## Local usage

```bash
cd pi-dyland
npm install --ignore-scripts
cp .env.example .env
# edit .env: at minimum set AICORE_TOKEN
npm run dev      # tsx watch
# open http://localhost:8787/
```

## Deploy to NAS

```bash
# On your laptop:
rsync -avz --exclude node_modules --exclude .env . nas:/volume1/docker/pi-dyland/

# On the NAS:
ssh nas
cd /volume1/docker/pi-dyland
cp .env.example .env
# edit .env
docker compose up -d --build
docker compose logs -f
```

Then open `http://<nas-ip>:8787/` from any device on the LAN. Expose it externally through your existing reverse proxy / cloudflared if you want browser access from anywhere — same way you already expose `aicore.superdyland.uk`.

## Environment variables

| Var | Purpose |
|-----|---------|
| `AICORE_BASE_URL` | aicore-proxy base URL (default `https://aicore.superdyland.uk`) |
| `AICORE_TOKEN` | aicore-proxy API token, sent as Anthropic `x-api-key` |
| `AICORE_MODEL` | Model id exposed by aicore-proxy (default `my-claude-opus`) |
| `PORT` / `HOST` | HTTP server bind (default `0.0.0.0:8787`) |
| `SKILLS_PATH` | Colon-separated skill directories to scan (default `./skills`) |
| `SMTP_*` | send_email skill (host / port / user / pass / from) |
| `VAULTWARDEN_URL`, `VAULTWARDEN_TOKEN` | vault_lookup skill |
| `CALDAV_URL`, `CALDAV_USER`, `CALDAV_PASS` | nas_calendar skill |
| `ZSPACE_URL`, `ZSPACE_TOKEN` | zspace_nas skill |

## HTTP API

| Route | Method | Notes |
|-------|--------|-------|
| `/` | GET | chat UI |
| `/health` | GET | JSON with aicore config + skill list |
| `/skills` | GET | JSON array of loaded skills (name, label, description, parameters) |
| `/messages` | GET | full transcript held by the singleton agent |
| `/reset` | POST | clear the agent's transcript |
| `/chat` | POST | body `{prompt: string}`, response is SSE with events: `assistant_start`, `text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `error`, `done` |

## Design notes

- **Anthropic-compatible via built-in provider.** `pi-ai` already ships a full `anthropic-messages` streaming implementation. We just construct a `Model<"anthropic-messages">` with `baseUrl` pointing at aicore-proxy — no custom `streamFn`, no OAuth (aicore-proxy issues a static bearer that we send via `x-api-key`).
- **Singleton agent.** One `Agent` instance holds the transcript across `/chat` calls. This is intentional (single-user personal agent). Multi-session support would need a session id -> agent map.
- **Skill isolation is process-level only.** `run.sh` inherits `PATH`, `HOME`, `LANG` plus the explicit `env` allowlist. No cwd chroot, no user drop. Fine for a home LAN service; if you expose this to the internet, harden accordingly.
- **The four bundled skills are thin curl wrappers.** They exist to prove the contract and let you talk to your existing services. Their endpoint paths are best guesses (especially ZSpace and Vaultwarden — Vaultwarden's `/api/ciphers` requires a real bearer, and the `bw` CLI path is preferred when installed). Adjust to match your real backends before relying on them.

## Known gaps

- Not tested end-to-end yet. Next step: `npm install`, set `AICORE_TOKEN`, `npm run dev`, verify a plain chat turn and one skill call (send_email is the easiest to smoke test).
- No auth on the HTTP server. Anyone who can reach `:8787` can talk to your NAS-backed LLM and trigger skills. Front it with your reverse-proxy auth (basic auth / OIDC) before exposing beyond LAN.
- `zspace-nas` endpoint paths are guesses based on typical ZSpace firmware conventions. Verify against your actual API before use.
