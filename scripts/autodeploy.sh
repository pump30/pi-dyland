#!/usr/bin/env bash
# pi-dyland autodeploy — runs on NAS as a systemd oneshot every 60s.
#
# Contract (see pi-dyland/CLAUDE.md §15.5):
#   1. Fetch origin/main. Exit silently if HEAD unchanged.
#   2. Guardrail: .env in diff → refuse + alert.
#   3. Warning: .env.example in diff → alert (informational, does not block).
#   4. git reset --hard origin/main.
#   5. Decide action from changed paths:
#        - Dockerfile / package.json / any web-next/**  → rebuild
#        - src/**.ts / skills/*/skill.json              → restart
#        - only skills/*/run.sh                         → no-op (bind-mount)
#   6. Rebuild uses `pi-dyland:candidate` → swap tag; failure keeps old container.
#   7. Post-action health check on http://127.0.0.1:8787/health.
#   8. Any FATAL step sends an email via SMTP creds at $NOTIFY_ENV.
#
# Deliberately NOT handled:
#   - .env auto-sync (§11 hard rule; owner edits it manually)
#   - Untracked files under $REPO (e.g. legacy .env.bak.*, macOS ._foo) —
#     they survive `git reset --hard` and are the owner's problem to clean.
#   - Rollback to a previous image tag; keeping the running container is enough.

set -uo pipefail

REPO=/tmp/zfsv3/sata11/15869560895/data/pi-dyland
BRANCH=main
DATA=/tmp/zfsv3/sata11/15869560895/data/pi-dyland-data
LOG="$DATA/autodeploy.log"
STATUS="$DATA/autodeploy.status"
NOTIFY_ENV="$DATA/autodeploy-notify.env"
CONTAINER=pi-dyland
IMAGE=pi-dyland:local
HEALTH_URL=http://127.0.0.1:8787/health

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

send_alert() {
	local subject="$1" body="$2"
	if [[ ! -r "$NOTIFY_ENV" ]]; then
		log "no readable $NOTIFY_ENV — email skipped"
		return 0
	fi
	# Sub-shell so sourced vars don't leak.
	(
		# shellcheck disable=SC1090
		source "$NOTIFY_ENV"
		: "${SMTP_HOST:?SMTP_HOST missing}"
		: "${SMTP_USER:?SMTP_USER missing}"
		: "${SMTP_PASS:?SMTP_PASS missing}"
		local to="${SMTP_TO:-1069235479@qq.com}"
		local mail
		mail=$(printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
			"$SMTP_USER" "$to" "$subject" "$body")
		curl --silent --show-error --max-time 15 \
			--url "smtps://${SMTP_HOST}:465" --ssl-reqd \
			--mail-from "$SMTP_USER" --mail-rcpt "$to" \
			--user "$SMTP_USER:$SMTP_PASS" \
			-T - <<<"$mail" >> "$LOG" 2>&1
	) || log "send_alert curl failed (see log above)"
}

# Serialize with flock so timer overlap doesn't fight itself during a slow build.
exec 9>"$DATA/autodeploy.lock"
if ! flock -n 9; then
	# Previous run still going; skip silently.
	exit 0
fi

cd "$REPO" || { log "FATAL: cannot cd $REPO"; exit 1; }

# Fetch and compare.
if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG"; then
	log "WARN: git fetch failed; will retry next tick"
	exit 0
fi
LOCAL_SHA=$(git rev-parse "$BRANCH" 2>/dev/null || echo "")
REMOTE_SHA=$(git rev-parse "origin/$BRANCH")
if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
	exit 0
fi

log "deploy $LOCAL_SHA -> $REMOTE_SHA"
CHANGED=$(git diff --name-only "$LOCAL_SHA" "$REMOTE_SHA" 2>/dev/null || echo "")
log "changed: $(echo "$CHANGED" | tr '\n' ' ')"

# Guardrail: .env leaked into repo — refuse without touching working tree.
if echo "$CHANGED" | grep -qx '\.env'; then
	log "FATAL: .env in diff, refusing to deploy"
	send_alert "pi-dyland autodeploy REFUSED at $REMOTE_SHA" \
		".env leaked into repo. Deploy aborted, working tree untouched. Investigate immediately."
	printf '%s\n' "refused_env_leak@$REMOTE_SHA" > "$STATUS"
	exit 1
fi

# Warning: .env.example changed — owner may need to update NAS .env.
if echo "$CHANGED" | grep -qx '\.env\.example'; then
	log "WARN: .env.example changed"
	send_alert "pi-dyland autodeploy: .env.example changed at $REMOTE_SHA" \
		"The commit changes .env.example. Autodeploy is proceeding, but check whether the running NAS .env needs new keys.\n\nChanged files:\n$CHANGED"
fi

# Sync working tree.
if ! git reset --hard "origin/$BRANCH" >>"$LOG" 2>&1; then
	log "FATAL: git reset failed"
	send_alert "pi-dyland autodeploy git reset FAILED at $REMOTE_SHA" \
		"git reset --hard origin/$BRANCH failed. See $LOG."
	printf '%s\n' "reset_failed@$REMOTE_SHA" > "$STATUS"
	exit 2
fi
log "reset ok"

# Classify changes.
NEEDS_REBUILD=false
NEEDS_RESTART=false
while IFS= read -r f; do
	[[ -z "$f" ]] && continue
	case "$f" in
		Dockerfile|.dockerignore|package.json|tsconfig.json)
			NEEDS_REBUILD=true ;;
		web-next/*)
			NEEDS_REBUILD=true ;;
		src/*)
			NEEDS_RESTART=true ;;
		skills/*/skill.json)
			NEEDS_RESTART=true ;;
		skills/*/run.sh)
			: ;;  # bind-mount serves it live
		scripts/*)
			# Autodeploy script itself changed — the next timer tick picks up the new
			# version automatically because systemd re-execs on each fire.
			: ;;
		*)
			: ;;  # docs, .env.example, other non-runtime files
	esac
done <<<"$CHANGED"

if $NEEDS_REBUILD; then
	log "docker build starting"
	if ! sudo docker build -t pi-dyland:candidate "$REPO" >>"$LOG" 2>&1; then
		log "FATAL: docker build failed"
		send_alert "pi-dyland autodeploy BUILD FAILED at $REMOTE_SHA" \
			"docker build failed. Old container is still running. Last 4KB of log:\n\n$(tail -c 4000 "$LOG")"
		printf '%s\n' "build_failed@$REMOTE_SHA" > "$STATUS"
		exit 3
	fi
	log "build ok, swapping container"
	sudo docker rm -f "$CONTAINER" >>"$LOG" 2>&1 || true
	sudo docker tag pi-dyland:candidate "$IMAGE" >>"$LOG" 2>&1
	if ! sudo docker run -d --name "$CONTAINER" \
			--restart unless-stopped --network host \
			--env-file "$REPO/.env" \
			-v "$REPO/skills":/app/skills:ro \
			-v "$DATA":/data \
			"$IMAGE" >>"$LOG" 2>&1; then
		log "FATAL: docker run after successful build failed"
		send_alert "pi-dyland autodeploy RUN FAILED at $REMOTE_SHA" \
			"Build succeeded but docker run failed. Container is DOWN. Last log:\n\n$(tail -c 4000 "$LOG")"
		printf '%s\n' "run_failed@$REMOTE_SHA" > "$STATUS"
		exit 4
	fi
elif $NEEDS_RESTART; then
	log "docker restart"
	if ! sudo docker restart "$CONTAINER" >>"$LOG" 2>&1; then
		log "FATAL: docker restart failed"
		send_alert "pi-dyland autodeploy RESTART FAILED at $REMOTE_SHA" \
			"docker restart $CONTAINER failed. See $LOG."
		printf '%s\n' "restart_failed@$REMOTE_SHA" > "$STATUS"
		exit 5
	fi
else
	log "no-op (only bind-mounted or non-runtime files changed)"
fi

# Post-deploy health check.
sleep 3
if curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
	log "health ok @ $REMOTE_SHA"
	printf '%s\n' "ok@$REMOTE_SHA" > "$STATUS"
else
	log "FATAL: health check failed after deploy"
	send_alert "pi-dyland autodeploy HEALTH CHECK FAILED at $REMOTE_SHA" \
		"Deploy applied but $HEALTH_URL is not responding. Container may be crashlooping.\n\nLast log:\n$(tail -c 4000 "$LOG")"
	printf '%s\n' "unhealthy@$REMOTE_SHA" > "$STATUS"
	exit 6
fi
