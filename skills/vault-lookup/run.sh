#!/usr/bin/env bash
# vault_lookup skill: read {query} JSON on stdin, search Vaultwarden, print matches.
# Uses the local `bw` CLI when available (session token in $VAULTWARDEN_TOKEN),
# otherwise falls back to the /api/ciphers HTTP endpoint with a bearer token.
set -euo pipefail

INPUT="$(cat)"
QUERY="$(jq -r '.query // empty' <<<"$INPUT")"
[[ -z "$QUERY" ]] && { echo "missing field: query" >&2; exit 2; }

: "${VAULTWARDEN_URL:?VAULTWARDEN_URL not set}"
: "${VAULTWARDEN_TOKEN:?VAULTWARDEN_TOKEN not set}"

if command -v bw >/dev/null 2>&1; then
  # bw CLI path: assumes $VAULTWARDEN_TOKEN is a `bw unlock` session token.
  export BW_SESSION="$VAULTWARDEN_TOKEN"
  bw --raw list items --search "$QUERY" 2>/dev/null | jq -r '
    if length == 0 then "no matches for query: \(env.QUERY // "")"
    else
      map({
        name,
        username: .login.username,
        uris: (.login.uris // [] | map(.uri)),
        note: .notes
      })
      | .[]
      | "\u2022 \(.name)\n  user: \(.username // "-")\n  uri:  \(.uris | join(", "))\n  note: \(.note // "-")"
    end'
  exit 0
fi

# HTTP fallback (Vaultwarden /api/ciphers is an authenticated endpoint).
RESP=$(curl --fail --silent --show-error \
  -H "Authorization: Bearer ${VAULTWARDEN_TOKEN}" \
  "${VAULTWARDEN_URL%/}/api/ciphers")

echo "$RESP" | jq -r --arg q "$QUERY" '
  .Data
  | map(select((.Name // "") | ascii_downcase | contains($q | ascii_downcase)))
  | if length == 0 then "no matches for query: \($q)"
    else
      .[]
      | "\u2022 \(.Name)\n  user: \(.Login.Username // "-")\n  uri:  \(.Login.Uris // [] | map(.Uri) | join(", "))"
    end'
