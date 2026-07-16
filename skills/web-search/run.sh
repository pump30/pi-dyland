#!/usr/bin/env bash
set -euo pipefail

# Smoke test #2 marker — verifies autodeploy no-op path for run.sh-only changes.
: "${TAVILY_API_KEY:?TAVILY_API_KEY not set on server (add to .env)}"

INPUT="$(cat)"
QUERY="$(echo "$INPUT" | jq -r '.query // empty')"
MAX="$(echo "$INPUT" | jq -r '.max_results // 5')"
DEPTH="$(echo "$INPUT" | jq -r '.search_depth // "basic"')"

[[ -z "$QUERY" ]] && { echo "missing: query" >&2; exit 2; }

# Clamp max_results to [1, 10]
if ! [[ "$MAX" =~ ^[0-9]+$ ]] || (( MAX < 1 )); then MAX=5; fi
if (( MAX > 10 )); then MAX=10; fi

# Only "basic" or "advanced"; anything else -> basic.
case "$DEPTH" in
  basic|advanced) ;;
  *) DEPTH=basic ;;
esac

REQ="$(jq -n \
  --arg k "$TAVILY_API_KEY" \
  --arg q "$QUERY" \
  --argjson n "$MAX" \
  --arg d "$DEPTH" \
  '{api_key:$k, query:$q, max_results:$n, search_depth:$d, include_answer:true}')"

RESP="$(curl -sS --max-time 15 https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d "$REQ")"

# Check for API errors (Tavily returns {error:"..."} or {detail:"..."} on failure).
ERR="$(echo "$RESP" | jq -r '.error // .detail // empty')"
if [[ -n "$ERR" ]]; then
  echo "Tavily API error: $ERR" >&2
  exit 3
fi

echo "$RESP" | jq -r '
  ((.answer // "") | if . != "" then "**AI answer:** \(.)\n\n" else "" end) +
  "**Top results:**\n" +
  ([.results[] | "- [\(.title)](\(.url))\n  \((.content // "")[0:220])..."] | join("\n"))
'
