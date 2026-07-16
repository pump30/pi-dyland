# pi-dyland: personal agent HTTP service.
#
# Three-stage image:
#   1. frontend — builds the Next.js static export into /web/out.
#   2. deps     — installs backend production npm deps.
#   3. runtime  — assembles the final image.
# The runtime uses Node 22 with the native TypeScript stripper
# (--experimental-strip-types) so we don't need to precompile the backend.
FROM node:22-bookworm-slim AS frontend
WORKDIR /web
# Install deps first so the layer cache survives source edits.
COPY web-next/package.json ./
RUN npm install --ignore-scripts
COPY web-next/ ./
# next.config.ts sets `output: "export"` → produces /web/out
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Shell-skill runtime deps: curl (SMTP + HTTP), jq (JSON parsing in bash),
# python3 (used by nas-calendar for date arithmetic), ca-certificates (TLS).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl jq python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY skills ./skills
# Frontend static export — server.ts serves this from /app/src/web-next.
COPY --from=frontend /web/out ./src/web-next

# Make skill scripts executable (bind-mounted skills also work at runtime).
RUN find ./skills -type f -name 'run.sh' -exec chmod +x {} +

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SKILLS_PATH=/app/skills \
    DATA_DIR=/data

# Durable JSON state (user profile, preferences) lives here. Bind-mount a host
# path over /data at `docker run` time so memory survives container recreation.
VOLUME ["/data"]

EXPOSE 8787

# Use Node's native TS support so we don't need a build step.
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
