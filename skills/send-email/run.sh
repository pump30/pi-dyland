#!/usr/bin/env bash
# send_email skill: read {to,subject,body} JSON on stdin, send via SMTP with curl.
set -euo pipefail

INPUT="$(cat)"
require() { jq -e "$1" >/dev/null 2>&1 <<<"$INPUT" || { echo "missing field: $1" >&2; exit 2; }; }

require '.subject'
require '.body'

: "${SMTP_HOST:?SMTP_HOST not set}"
: "${SMTP_USER:?SMTP_USER not set}"
: "${SMTP_PASS:?SMTP_PASS not set}"
SMTP_PORT="${SMTP_PORT:-465}"
SMTP_FROM="${SMTP_FROM:-$SMTP_USER}"

TO="$(jq -r '.to // empty' <<<"$INPUT")"
[[ -z "$TO" ]] && TO="$SMTP_USER"
SUBJECT="$(jq -r '.subject' <<<"$INPUT")"
BODY="$(jq -r '.body' <<<"$INPUT")"

BOUNDARY="pi-dyland-$(date +%s)-$RANDOM"
MAIL_FILE="$(mktemp)"
trap 'rm -f "$MAIL_FILE"' EXIT

{
  echo "From: $SMTP_FROM"
  echo "To: $TO"
  echo "Subject: $SUBJECT"
  echo "MIME-Version: 1.0"
  echo "Content-Type: text/plain; charset=utf-8"
  echo
  echo "$BODY"
} > "$MAIL_FILE"

curl --fail --silent --show-error --ssl-reqd \
  --url "smtps://${SMTP_HOST}:${SMTP_PORT}" \
  --user "${SMTP_USER}:${SMTP_PASS}" \
  --mail-from "${SMTP_FROM}" \
  --mail-rcpt "${TO}" \
  --upload-file "$MAIL_FILE" >/dev/null

echo "Email sent to ${TO} (subject: ${SUBJECT})"
