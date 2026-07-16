#!/bin/bash
# current-time skill: returns current date/time in the requested timezone
set -euo pipefail

INPUT="$(cat)"
TZ_NAME=$(echo "$INPUT" | jq -r '.timezone // empty')
TZ_NAME="${TZ_NAME:-Asia/Shanghai}"

# date on bookworm-slim supports TZ via env
TZ="$TZ_NAME" date '+{"timezone":"%Z","iso":"%Y-%m-%dT%H:%M:%S%z","human":"%A, %B %d, %Y %H:%M:%S %Z"}'
