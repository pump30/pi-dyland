# pi-dyland: personal agent HTTP service.
#
# Two-stage image: install deps once, then copy source. The image includes
# curl+jq+bash for the shell-based skills. Runtime uses Node 22 with the
# native TypeScript stripper (--experimental-strip-types) so we don't need
# to precompile.
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

# Make skill scripts executable (bind-mounted skills also work at runtime).
RUN find ./skills -type f -name 'run.sh' -exec chmod +x {} +

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SKILLS_PATH=/app/skills

EXPOSE 8787

# Use Node's native TS support so we don't need a build step.
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
