#!/usr/bin/env bash
set -euo pipefail

: "${SKILL_INTERNAL_TOKEN:?SKILL_INTERNAL_TOKEN not set}"
BASE_URL="${SKILL_INTERNAL_URL:-http://127.0.0.1:8787}"

INPUT="$(cat)"
QUERY="$(echo "$INPUT" | jq -r '.query // empty')"
LIMIT="$(echo "$INPUT" | jq -r '.limit // 5')"

if [[ -z "$QUERY" ]]; then
  echo "missing: query" >&2
  exit 2
fi

# Call the loopback endpoint. jq builds the request body so quoting is safe.
BODY="$(jq -nc --arg q "$QUERY" --argjson n "$LIMIT" '{query: $q, limit: $n}')"
RESP="$(curl -sS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Skill-Token: ${SKILL_INTERNAL_TOKEN}" \
  --max-time 12 \
  -d "$BODY" \
  "${BASE_URL}/rag/search")"

HITS_COUNT="$(echo "$RESP" | jq '.hits | length // 0')"

if [[ "$HITS_COUNT" == "0" ]]; then
  jq -n --arg t "No results found in your library for query: $QUERY. The library may not contain relevant material — consider uploading source documents to /library." \
    '{content: [{type:"text", text:$t}]}'
  exit 0
fi

# Build a short text summary for the LLM and one doc-ref card per hit for the UI.
# skill-loader.ts filters cards out of the LLM-visible content and forwards them
# via details.card_blocks; the server then emits them as SSE `card` events.
SUMMARY="$(echo "$RESP" | jq -r '.hits | to_entries | map("[" + (.key+1|tostring) + "] " + .value.name + " (lines " + (.value.lineStart|tostring) + "-" + (.value.lineEnd|tostring) + ", score " + (.value.score|tostring|.[0:4]) + ")") | join("\n")')"

echo "$RESP" | jq --arg summary "Found ${HITS_COUNT} relevant snippets in the user's library:
${SUMMARY}

The UI is rendering per-file cards. Summarize the content in prose; do not paste the snippets." '
{
  content: (
    [{type:"text", text:$summary}]
    +
    (.hits | map({
      type: "card",
      kind: "doc-ref",
      payload: {
        name: .name,
        file: .file,
        lineStart: .lineStart,
        lineEnd: .lineEnd,
        score: .score,
        snippet: .snippet
      }
    }))
  )
}'
