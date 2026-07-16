# pi-dyland: personal agent HTTP service.
#
# Four-stage image:
#   1. frontend   — builds the Next.js static export into /web/out.
#   2. deps       — installs backend production npm deps.
#   3. modelcache — downloads the ONNX embedding model (~23 MB) so the runtime
#                   is fully offline. Uses transformers.js cache dir convention.
#   4. runtime    — assembles the final image.
#
# The runtime uses Node 22 with the native TypeScript stripper
# (--experimental-strip-types) so we don't need to precompile the backend.

FROM node:22-bookworm-slim AS frontend
WORKDIR /web
COPY web-next/package.json ./
RUN npm install --ignore-scripts
COPY web-next/ ./
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Native modules (better-sqlite3, onnxruntime-node) need build tools when
# prebuilds are missing. Install once here, dropped from the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
# postinstall scripts are ALLOWED here. onnxruntime-node's prebuild download
# and better-sqlite3's node-gyp fallback both live in postinstall. See
# CLAUDE.md §15.1 exception for pi-local-rag deps.
RUN npm install --omit=dev

FROM node:22-bookworm-slim AS modelcache
WORKDIR /work
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Warm the transformers.js cache. HuggingFace pulls ~23 MB into
# ~/.cache/huggingface/. We move it to a stable location so the runtime
# stage can COPY --from=modelcache and be network-independent.
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface \
    HF_HOME=/root/.cache/huggingface
# Download the ONNX embedding model. NAS outbound is flaky so we retry up to
# 5 times with a 10s backoff. Once cached in this layer, subsequent builds
# skip the download entirely (Docker layer cache).
RUN for i in 1 2 3 4 5; do \
  node --experimental-strip-types --no-warnings -e "\
    const {pipeline} = await import('@xenova/transformers');\
    await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2');\
    console.log('embedder cached');\
  " && break || { echo "attempt $i failed, retrying in 10s..."; sleep 10; }; \
done

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Shell-skill runtime deps + libs required by native modules at runtime.
# libstdc++6 covers better-sqlite3 and onnxruntime-node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl jq python3 ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=modelcache /root/.cache/huggingface /root/.cache/huggingface
COPY package.json tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY --from=frontend /web/out ./src/web-next

RUN find ./skills -type f -name 'run.sh' -exec chmod +x {} +

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SKILLS_PATH=/app/skills \
    DATA_DIR=/data \
    TRANSFORMERS_CACHE=/root/.cache/huggingface \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_OFFLINE=1

VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
