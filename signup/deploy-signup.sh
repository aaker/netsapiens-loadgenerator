#!/usr/bin/env bash
#
# Deploy the signup app to the v46lab core servers.
#
# Builds the React/Vite client locally and ships the built dist, so the servers
# need no dev dependencies. Only signup/ is deployed. Server-specific files
# (.env and the data/ runtime log) are excluded and never overwritten.
#
# On each host it restarts, it also renders and installs the systemd unit
# (deploy/signup.service.template -> $SYSTEMD_DIR/$SERVICE.service) and the
# Apache reverse-proxy conf (deploy/signup.apache.conf.template ->
# $APACHE_CONF_DIR/$SERVICE.conf), enables the proxy modules, and reloads Apache.
#
# NOTE: the signup server keeps its reseller-claim race protection in-process
# only (see signup/README.md). Running the service on more than one box at once
# defeats that guard. This script restarts the service on BOTH hosts — if core2
# is meant to be a standby, set RESTART_HOSTS below to core1 only.
#
# Usage:
#   ./deploy-signup.sh                     # deploy to both, restart signup unit
#   SERVICE=mysignup ./deploy-signup.sh    # override the systemd unit name
#   SSH_USER=ec2-user ./deploy-signup.sh   # override the ssh user
set -euo pipefail

SERVERS=(
  core1-phx.v46lab.ucaas.tech
  core2-phx.v46lab.ucaas.tech
)

# Hosts whose systemd service gets restarted after deploy. Default: all of them.
# To keep core2 as a code-only standby, set: RESTART_HOSTS=(core1-phx.v46lab.ucaas.tech)
RESTART_HOSTS=("${SERVERS[@]}")

SSH_USER="${SSH_USER:-root}"
SERVICE="${SERVICE:-signup}"        # systemd unit name (override with SERVICE=...)
REMOTE_BASE="/usr/local/NetSapiens/netsapiens-loadgenerator/signup"

# Base path the UI is served under (must match client/vite.config.js `base`) and
# the port the Node server listens on (SIGNUP_PORT in signup/.env, default 3100).
BASE_PATH="${BASE_PATH:-/signup}"
SIGNUP_PORT="${SIGNUP_PORT:-3100}"

# Where the rendered configs are installed on the servers (Debian/Ubuntu layout).
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
APACHE_CONF_DIR="${APACHE_CONF_DIR:-/etc/apache2/conf-enabled}"
APACHE_SERVICE="${APACHE_SERVICE:-apache2}"

# node/npm on the servers live under the NetSapiens nodejs-library, not on PATH.
# Prepend this dir so remote `npm` (and the node it spawns) resolve there.
NODE_BIN="${NODE_BIN:-/usr/local/NetSapiens/nodejs-library/node}"
NODE_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="${NPM_BIN:-$NODE_DIR/npm}"

# No sudo needed when we ssh in as root; otherwise prefix privileged commands.
if [ "$SSH_USER" = "root" ]; then SUDO=""; else SUDO="sudo"; fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this is signup/
LOCAL_SIGNUP="$REPO_DIR"

contains() { local n="$1"; shift; for h in "$@"; do [ "$h" = "$n" ] && return 0; done; return 1; }

# Render a *.template from signup/deploy/ with the deploy paths substituted.
render() {
  sed -e "s|__REMOTE_BASE__|$REMOTE_BASE|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__BASE_PATH__|$BASE_PATH|g" \
      -e "s|__PORT__|$SIGNUP_PORT|g" \
      "$1"
}

echo "==> Building client locally"
npm --prefix "$LOCAL_SIGNUP/client" install --no-audit --no-fund
npm --prefix "$LOCAL_SIGNUP/client" run build

if [ ! -f "$LOCAL_SIGNUP/client/dist/index.html" ]; then
  echo "ERROR: client build produced no client/dist/index.html — aborting." >&2
  exit 1
fi

# Excludes are also protected from --delete, so .env and data/ on the servers
# are never removed or overwritten.
RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='client/node_modules'
  --exclude='.env'
  --exclude='data'
  --exclude='deploy-signup.sh'
)

for host in "${SERVERS[@]}"; do
  echo
  echo "==> Deploying to $host"
  ssh "$SSH_USER@$host" "mkdir -p '$REMOTE_BASE'"
  rsync -av --delete -e ssh "${RSYNC_EXCLUDES[@]}" \
    "$LOCAL_SIGNUP/" "$SSH_USER@$host:$REMOTE_BASE/"

  echo "==> Installing production deps on $host (node: $NODE_BIN)"
  # --ignore-scripts skips the postinstall client build (we shipped dist already).
  ssh "$SSH_USER@$host" \
    "export PATH='$NODE_DIR':\"\$PATH\"; cd '$REMOTE_BASE' && '$NPM_BIN' install --omit=dev --ignore-scripts --no-audit --no-fund"

  if contains "$host" "${RESTART_HOSTS[@]}"; then
    echo "==> Installing systemd unit ($SERVICE.service) on $host"
    render "$LOCAL_SIGNUP/deploy/signup.service.template" \
      | ssh "$SSH_USER@$host" "$SUDO tee '$SYSTEMD_DIR/$SERVICE.service' >/dev/null"
    ssh "$SSH_USER@$host" "$SUDO systemctl daemon-reload && $SUDO systemctl enable '$SERVICE'"

    echo "==> Installing Apache proxy conf ($SERVICE.conf) on $host"
    render "$LOCAL_SIGNUP/deploy/signup.apache.conf.template" \
      | ssh "$SSH_USER@$host" "$SUDO tee '$APACHE_CONF_DIR/$SERVICE.conf' >/dev/null"
    ssh "$SSH_USER@$host" \
      "$SUDO a2enmod proxy proxy_http headers >/dev/null && $SUDO apachectl -t && $SUDO systemctl reload '$APACHE_SERVICE'"

    echo "==> Restarting $SERVICE on $host"
    ssh "$SSH_USER@$host" \
      "$SUDO systemctl restart '$SERVICE' && $SUDO systemctl --no-pager --lines=5 status '$SERVICE' || true"
  else
    echo "==> Skipping service + web config on $host (code-only)"
  fi
done

echo
echo "==> Done."
