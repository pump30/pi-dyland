#!/usr/bin/env bash
# nas_calendar skill: minimal CalDAV client via curl.
# CALDAV_URL is the principal URL (containing multiple calendar collections).
# Actions: list_calendars | list | add | delete.
set -euo pipefail

INPUT="$(cat)"
ACTION="$(jq -r '.action // empty' <<<"$INPUT")"
[[ -z "$ACTION" ]] && { echo "missing field: action" >&2; exit 2; }

: "${CALDAV_URL:?CALDAV_URL not set}"
: "${CALDAV_USER:?CALDAV_USER not set}"
: "${CALDAV_PASS:?CALDAV_PASS not set}"

BASE="${CALDAV_URL%/}/"
AUTH="${CALDAV_USER}:${CALDAV_PASS}"

# Discover calendar collections under the principal URL.
# Emits TSV: <href>\t<displayname>
discover_calendars() {
  curl --fail --silent --show-error --user "$AUTH" \
    -X PROPFIND -H "Depth: 1" -H "Content-Type: application/xml; charset=utf-8" \
    --data '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>' \
    "$BASE" \
    | python3 -c '
import sys, xml.etree.ElementTree as ET, urllib.parse
NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav"}
root = ET.fromstring(sys.stdin.read())
for resp in root.findall("d:response", NS):
    href_el = resp.find("d:href", NS)
    if href_el is None or not href_el.text:
        continue
    href = urllib.parse.unquote(href_el.text)
    is_cal = False
    name = ""
    for ps in resp.findall("d:propstat", NS):
        status = ps.find("d:status", NS)
        if status is None or "200" not in (status.text or ""):
            continue
        prop = ps.find("d:prop", NS)
        if prop is None:
            continue
        if prop.find("d:resourcetype/c:calendar", NS) is not None:
            is_cal = True
        dn = prop.find("d:displayname", NS)
        if dn is not None and dn.text:
            name = dn.text
    if is_cal and name:
        print(f"{href}\t{name}")
'
}

# Resolve 'calendar' substring → single (href, name). Sets CAL_HREF, CAL_NAME.
# Exits 2 with a helpful stderr listing when 0 or >1 matches — the loader
# surfaces this to the LLM so it can re-ask the user.
resolve_calendar() {
  local needle="$1"
  local table
  table="$(discover_calendars)"
  [[ -z "$table" ]] && { echo "no calendars found under $BASE" >&2; exit 3; }

  if [[ -z "$needle" ]]; then
    echo "missing 'calendar' — ask the user which calendar to use. Available:" >&2
    while IFS=$'\t' read -r h n; do echo "  - $n" >&2; done <<<"$table"
    exit 2
  fi

  local needle_lc
  needle_lc="$(echo "$needle" | tr '[:upper:]' '[:lower:]')"
  local matches
  matches="$(awk -F'\t' -v q="$needle_lc" '{ lname=tolower($2); if (index(lname, q)) print $0 }' <<<"$table")"

  local count
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [[ "$count" -eq 0 ]]; then
    echo "no calendar matches '$needle'. Available:" >&2
    while IFS=$'\t' read -r h n; do echo "  - $n" >&2; done <<<"$table"
    exit 2
  fi
  if [[ "$count" -gt 1 ]]; then
    echo "'$needle' is ambiguous. Candidates:" >&2
    while IFS=$'\t' read -r h n; do echo "  - $n" >&2; done <<<"$matches"
    echo "Ask the user to disambiguate." >&2
    exit 2
  fi
  CAL_HREF="$(cut -f1 <<<"$matches")"
  CAL_NAME="$(cut -f2 <<<"$matches")"
}

# Radicale returns href as an absolute path (e.g. /user/xxx/). Prepend the origin.
absolute_url() {
  local href="$1"
  if [[ "$href" =~ ^https?:// ]]; then
    echo "$href"
  else
    local origin
    origin="$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(f"{p.scheme}://{p.netloc}")' "$CALDAV_URL")"
    echo "${origin}${href}"
  fi
}

fmt_ics_dt() {
  # ISO 8601 -> ICS local floating time YYYYMMDDTHHMMSS
  echo "$1" | sed -E 's/[-:]//g; s/\..*//; s/Z$//'
}

case "$ACTION" in
  list_calendars)
    discover_calendars | awk -F'\t' '{printf "- %s\n", $2}'
    ;;
  list)
    NEEDLE="$(jq -r '.calendar // empty' <<<"$INPUT")"
    resolve_calendar "$NEEDLE"
    URL="$(absolute_url "$CAL_HREF")"
    echo "Calendar: $CAL_NAME"
    curl --fail --silent --show-error --user "$AUTH" \
      -X REPORT -H "Depth: 1" -H "Content-Type: application/xml; charset=utf-8" \
      --data '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>' \
      "$URL" \
      | grep -oE '(SUMMARY|DTSTART[^:]*|DTEND[^:]*|UID):[^<]*' \
      | sed 's/&#13;//' \
      || true
    ;;
  add)
    NEEDLE="$(jq -r '.calendar // empty' <<<"$INPUT")"
    resolve_calendar "$NEEDLE"
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
    URL="$(absolute_url "${CAL_HREF%/}/")${UID}.ics"
    curl --fail --silent --show-error --user "$AUTH" \
      -X PUT -H "Content-Type: text/calendar; charset=utf-8" \
      --data-binary "$BODY" \
      "$URL" >/dev/null
    echo "created event ${UID} on '${CAL_NAME}': ${SUMMARY} @ ${START} -> ${END}"
    ;;
  delete)
    NEEDLE="$(jq -r '.calendar // empty' <<<"$INPUT")"
    resolve_calendar "$NEEDLE"
    UID="$(jq -r '.uid // empty' <<<"$INPUT")"
    [[ -z "$UID" ]] && { echo "delete requires uid" >&2; exit 2; }
    URL="$(absolute_url "${CAL_HREF%/}/")${UID}.ics"
    curl --fail --silent --show-error --user "$AUTH" \
      -X DELETE "$URL" >/dev/null
    echo "deleted event ${UID} from '${CAL_NAME}'"
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
