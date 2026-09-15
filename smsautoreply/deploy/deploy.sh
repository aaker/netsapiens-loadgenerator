#!/bin/bash
#
# smsautoreply - deploy from a workstation to the load-generator host.
#
# rsyncs this directory to the target and runs deploy/install.sh there.
# The remote .env is never overwritten.
#
# Usage:
#   ./deploy/deploy.sh                       # deploy to the default host
#   ./deploy/deploy.sh --dry-run             # show what rsync would transfer
#   ./deploy/deploy.sh --host other.host     # different target
#   ./deploy/deploy.sh --no-apache           # app + service, no Apache fragment
#   ./deploy/deploy.sh --restart-only        # restart the remote service, no copy
#   ./deploy/deploy.sh --status              # remote service + health status
#   ./deploy/deploy.sh --logs                # tail the remote journal
#
set -euo pipefail

HOST="${SMSAUTOREPLY_HOST:-loadgen2-phx.ca.nseng.dev}"
SSH_USER="${SMSAUTOREPLY_SSH_USER:-}"
REMOTE_DIR="${SMSAUTOREPLY_REMOTE_DIR:-/usr/local/NetSapiens/netsapiens-loadgenerator/smsautoreply}"
SERVICE_NAME="smsautoreply"
DRY_RUN=0
MODE="deploy"
INSTALL_ARGS=()

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --host)        HOST="${2:?--host needs a value}"; shift 2 ;;
        --user)        SSH_USER="${2:?--user needs a value}"; shift 2 ;;
        --remote-dir)  REMOTE_DIR="${2:?--remote-dir needs a value}"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --no-apache)   INSTALL_ARGS+=(--no-apache); shift ;;
        --no-restart)  INSTALL_ARGS+=(--no-restart); shift ;;
        --restart-only) MODE="restart"; shift ;;
        --status)      MODE="status"; shift ;;
        --logs)        MODE="logs"; shift ;;
        -h|--help)     sed -n '2,15p' "$0"; exit 0 ;;
        *)             die "unknown option: $1" ;;
    esac
done

TARGET="$HOST"
[ -n "$SSH_USER" ] && TARGET="$SSH_USER@$HOST"

SSH_OPTS=(-o ConnectTimeout=15 -o BatchMode=yes)

# sudo only when the login user is not already root.
remote_sudo() {
    ssh "${SSH_OPTS[@]}" "$TARGET" "if [ \"\$(id -u)\" -eq 0 ]; then $1; else sudo $1; fi"
}

case "$MODE" in
    status)
        log "status on $TARGET"
        remote_sudo "systemctl --no-pager --lines=10 status $SERVICE_NAME" || true
        ssh "${SSH_OPTS[@]}" "$TARGET" "curl -s -m 5 http://127.0.0.1:3010/health; echo"
        exit 0
        ;;
    logs)
        log "tailing $SERVICE_NAME journal on $TARGET (ctrl-c to stop)"
        exec ssh -t "${SSH_OPTS[@]}" "$TARGET" \
            "if [ \"\$(id -u)\" -eq 0 ]; then journalctl -u $SERVICE_NAME -f -n 100; else sudo journalctl -u $SERVICE_NAME -f -n 100; fi"
        ;;
    restart)
        log "restarting $SERVICE_NAME on $TARGET"
        remote_sudo "systemctl restart $SERVICE_NAME"
        remote_sudo "systemctl --no-pager --lines=10 status $SERVICE_NAME" || true
        exit 0
        ;;
esac

# --- preflight ---------------------------------------------------------------
command -v rsync >/dev/null 2>&1 || die "rsync is not installed locally"
log "checking ssh to $TARGET"
ssh "${SSH_OPTS[@]}" "$TARGET" true \
    || die "cannot ssh to $TARGET (key auth required; BatchMode is on)"

# --- copy --------------------------------------------------------------------
RSYNC_OPTS=(-az --delete --human-readable --itemize-changes)
[ "$DRY_RUN" -eq 1 ] && RSYNC_OPTS+=(--dry-run)

# Excluded from the delete sweep as well as the copy, so a remote .env,
# node_modules and logs survive --delete. The remote form is a single string
# because it is re-parsed by the remote shell.
EXCLUDES=(
    --exclude '.env'
    --exclude 'node_modules/'
    --exclude '.git/'
    --exclude '*.log'
    --filter 'protect .env'
    --filter 'protect node_modules/'
)
REMOTE_EXCLUDES="--exclude '.env' --exclude 'node_modules/' --exclude '.git/' --exclude '*.log' --filter 'protect .env' --filter 'protect node_modules/'"

log "syncing $LOCAL_DIR/ -> $TARGET:$REMOTE_DIR/"
remote_sudo "mkdir -p $REMOTE_DIR"
# Stage under /tmp, then move into place with sudo: the login account usually
# cannot write under /usr/local/NetSapiens directly.
STAGE="/tmp/${SERVICE_NAME}-deploy-$$"
rsync "${RSYNC_OPTS[@]}" "${EXCLUDES[@]}" \
    -e "ssh ${SSH_OPTS[*]}" \
    "$LOCAL_DIR/" "$TARGET:$STAGE/"

if [ "$DRY_RUN" -eq 1 ]; then
    ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf $STAGE" || true
    log "dry run complete; nothing was installed"
    exit 0
fi

log "moving staged files into $REMOTE_DIR"
remote_sudo "rsync -a --delete $REMOTE_EXCLUDES $STAGE/ $REMOTE_DIR/"
ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf $STAGE"

# --- install -----------------------------------------------------------------
log "running remote installer"
remote_sudo "bash $REMOTE_DIR/deploy/install.sh ${INSTALL_ARGS[*]:-}"

log "deployed to $TARGET:$REMOTE_DIR"
log "next: ssh $TARGET, edit $REMOTE_DIR/.env with the Bandwidth credentials,"
log "      then: $0 --restart-only"
