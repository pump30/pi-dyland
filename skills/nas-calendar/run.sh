#!/usr/bin/env bash
# nas_calendar skill: minimal CalDAV client via curl. Supports action=list|add|delete.
set -euo pipefail

INPUT="$(cat)"
ACTION="$(jq -r '.action // empty' <<<"$INPUT")"
[[ -z "$ACTION" ]] && { echo "missing field: action" >&2; exit 2; }

: "${CALDAV_URL:?CALDAV_URL not set}"
: "${CALDAV_USER:?CALDAV_USER not set}"
: "${CALDAV_PASS:?CALDAV_PASS not set}"

BASE="${CALDAV_URL%/}"
AUTH="${CALDAV_USER}:${CALDAV_PASS}"

fmt_ics_dt() {
  # ISO 8601 -> ICS local floating time YYYYMMDDTHHMMSS
  local input="$1"
  echo "$input" | sed -E 's/[-:]//g; s/\..*//; s/Z$//'
}

case "$ACTION" in
  list)
    curl --fail --silent --show-error --user "$AUTH" \
      -X REPORT -H "Depth: 1" -H "Content-Type: application/xml; charset=utf-8" \
      --data '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>' \
      "$BASE/" \
      | grep -oE '(SUMMARY|DTSTART[^:]*|DTEND[^:]*|UID):[^<]*' \
      | sed 's/&#13;//' \
      || true
    ;;
  add)
    SUMMARY="$(jq -r '.summary // empty' <<<"$INPUT")"
    START="$(jq -r '.start // empty' <<<"$INPUT")"
    END="$(jq -r '.end // empty' <<<"$INPUT")"
    [[ -z "$SUMMARY" || -z "$START" ]] && { echo "add requires summary and start" >&2; exit 2; }
    if [[ -z "$END" ]]; then
      END=$(python3 -c "import sys,datetime;s=datetime.datetime.fromisoformat(sys.argv[1]);print((s+datetime.timedelta(hours=1)).isoformat())" "$START")
    fi
    UID="pi-dyland-$(date +%s)-$RANDOM@dyland"
    ICS_START="$(fmt_ics_dt "$START")"
    ICS_END="$(fmt_ics_dt "$END")"
    NOW="$(date -u +%Y%m%dT%H%M%SZ)"
    BODY="BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//pi-dyland//nas-calendar//EN
BEGIN:VEVENT
UID:${UID}
DTSTAMP:${NOW}
DTSTART:${ICS_START}
DTEND:${ICS_END}
SUMMARY:${SUMMARY}
END:VEVENT
END:VCALENDAR"
    curl --fail --silent --show-error --user "$AUTH" \
      -X PUT -H "Content-Type: text/calendar; charset=utf-8" \
      --data-binary "$BODY" \
      "$BASE/${UID}.ics" >/dev/null
    echo "created event ${UID}: ${SUMMARY} @ ${START} -> ${END}"
    ;;
  delete)
    UID="$(jq -r '.uid // empty' <<<"$INPUT")"
    [[ -z "$UID" ]] && { echo "delete requires uid" >&2; exit 2; }
    curl --fail --silent --show-error --user "$AUTH" \
      -X DELETE "$BASE/${UID}.ics" >/dev/null
    echo "deleted event ${UID}"
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
