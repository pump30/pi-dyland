#!/usr/bin/env bash
# zspace_nas skill: thin HTTP wrapper around the extranet ZSpace API.
# NOTE: The exact endpoint paths depend on your ZSpace firmware version. Adjust
# the paths below to match what your zspace MCP server uses.
set -euo pipefail

INPUT="$(cat)"
ACTION="$(jq -r '.action // empty' <<<"$INPUT")"
[[ -z "$ACTION" ]] && { echo "missing field: action" >&2; exit 2; }

: "${ZSPACE_URL:?ZSPACE_URL not set}"
: "${ZSPACE_TOKEN:?ZSPACE_TOKEN not set}"

BASE="${ZSPACE_URL%/}"
HEADERS=(-H "Authorization: Bearer ${ZSPACE_TOKEN}" -H "Accept: application/json")

case "$ACTION" in
  list)
    PATH_ARG="$(jq -r '.path // "/"' <<<"$INPUT")"
    curl --fail --silent --show-error "${HEADERS[@]}" \
      --data-urlencode "path=${PATH_ARG}" \
      "${BASE}/api/fs/list" \
      | jq -r '.data.items // .items // [] | .[] | "\(.type // "?") \(.name)"' 2>/dev/null \
      || echo "(empty or unrecognized response)"
    ;;
  status)
    curl --fail --silent --show-error "${HEADERS[@]}" "${BASE}/api/system/status" \
      | jq -r '. as $r | "cpu: \($r.data.cpu // $r.cpu // "?")\nmem: \($r.data.mem // $r.mem // "?")\nuptime: \($r.data.uptime // $r.uptime // "?")"'
    ;;
  docker_ps)
    curl --fail --silent --show-error "${HEADERS[@]}" "${BASE}/api/docker/containers" \
      | jq -r '.data.containers // .containers // [] | .[] | "\(.state // "?")\t\(.name // "?")\t\(.image // "?")"'
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
