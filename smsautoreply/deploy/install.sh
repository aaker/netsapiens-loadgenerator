#!/bin/bash
#
# smsautoreply - remote installer. Runs ON the target host.
#
# Installs node dependencies, the systemd unit and the Apache vhost, then
# starts/reloads both services. Idempotent: safe to re-run on every deploy.
#
# Usage (as root, from the deployed directory):
#   ./deploy/install.sh [options]
#
# Options:
#   --server-name <fqdn>   ServerName for the Apache vhost (default: hostname -f)
#   --no-apache            Skip all Apache configuration
#   --no-systemd           Skip the systemd unit; only install dependencies
#   --no-restart           Install files but do not start/reload services
#   --user <user>          Unix user the service runs as (default: www-data)
#   -h, --help             This help
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="smsautoreply"
SERVICE_USER="www-data"
SERVER_NAME=""
DO_APACHE=1
DO_SYSTEMD=1
DO_RESTART=1

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --server-name) SERVER_NAME="${2:?--server-name needs a value}"; shift 2 ;;
        --user)        SERVICE_USER="${2:?--user needs a value}"; shift 2 ;;
        --no-apache)   DO_APACHE=0; shift ;;
        --no-systemd)  DO_SYSTEMD=0; shift ;;
        --no-restart)  DO_RESTART=0; shift ;;
        -h|--help)     sed -n '2,17p' "$0"; exit 0 ;;
        *)             die "unknown option: $1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo $0 $*)"
[ -z "$SERVER_NAME" ] && SERVER_NAME="$(hostname -f 2>/dev/null || hostname)"

log "app directory: $APP_DIR"
log "server name:   $SERVER_NAME"

# --- 1. Node -----------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is not installed"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required (found $(node -v)); the app uses global fetch"
log "node $(node -v)"

log "installing production dependencies"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
else
    npm install --omit=dev --no-audit --no-fund
fi

# --- 2. .env -----------------------------------------------------------------
if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/env.example" "$APP_DIR/.env"
    warn "created $APP_DIR/.env from env.example - fill in the Bandwidth credentials"
    warn "the service will start but /health reports 503 until it is complete"
fi
chown "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/.env" 2>/dev/null || \
    warn "could not chown .env to $SERVICE_USER"
chmod 600 "$APP_DIR/.env"

# systemd's EnvironmentFile cannot parse `export`, quotes with spaces or inline
# comments; warn rather than let the unit fail at start time.
if grep -qE '^\s*export\s' "$APP_DIR/.env"; then
    warn ".env contains 'export' lines; systemd EnvironmentFile does not support them"
fi

# --- 3. systemd --------------------------------------------------------------
if [ "$DO_SYSTEMD" -eq 1 ]; then
    UNIT_SRC="$APP_DIR/apache/${SERVICE_NAME}.service"
    UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
    [ -f "$UNIT_SRC" ] || die "missing unit file: $UNIT_SRC"

    log "installing $UNIT_DST"
    sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
        -e "s|^EnvironmentFile=.*|EnvironmentFile=$APP_DIR/.env|" \
        -e "s|^ExecStart=.*|ExecStart=$(command -v node) src/index.js|" \
        -e "s|^User=.*|User=$SERVICE_USER|" \
        -e "s|^Group=.*|Group=$SERVICE_USER|" \
        "$UNIT_SRC" > "$UNIT_DST"
    chmod 644 "$UNIT_DST"

    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null

    if [ "$DO_RESTART" -eq 1 ]; then
        log "restarting $SERVICE_NAME"
        systemctl restart "$SERVICE_NAME"
    fi
fi

# --- 4. Apache ---------------------------------------------------------------
if [ "$DO_APACHE" -eq 1 ]; then
    VHOST_SRC="$APP_DIR/apache/${SERVICE_NAME}.conf"
    [ -f "$VHOST_SRC" ] || die "missing vhost: $VHOST_SRC"

    if [ -d /etc/apache2/sites-available ]; then
        APACHE_FLAVOR="debian"
        VHOST_DST="/etc/apache2/sites-available/${SERVICE_NAME}.conf"
        APACHE_SVC="apache2"
    elif [ -d /etc/httpd/conf.d ]; then
        APACHE_FLAVOR="rhel"
        VHOST_DST="/etc/httpd/conf.d/${SERVICE_NAME}.conf"
        APACHE_SVC="httpd"
    else
        APACHE_FLAVOR=""
        warn "no Apache config directory found; skipping vhost install"
    fi

    if [ -n "$APACHE_FLAVOR" ]; then
        log "installing $VHOST_DST"
        sed -e "s|ServerName sms\.example\.com|ServerName $SERVER_NAME|g" \
            -e "s|/etc/letsencrypt/live/sms\.example\.com|/etc/letsencrypt/live/$SERVER_NAME|g" \
            "$VHOST_SRC" > "$VHOST_DST"

        # The vhost references ${APACHE_LOG_DIR}, which only Debian defines.
        if [ "$APACHE_FLAVOR" = "rhel" ]; then
            sed -i 's|\${APACHE_LOG_DIR}|/var/log/httpd|g' "$VHOST_DST"
        fi

        CERT="/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem"
        if [ ! -f "$CERT" ]; then
            warn "no certificate at $CERT"
            warn "Apache will fail to load this vhost until one exists; run certbot,"
            warn "or edit SSLCertificateFile/SSLCertificateKeyFile in $VHOST_DST"
        fi

        if [ "$APACHE_FLAVOR" = "debian" ]; then
            log "enabling modules: proxy proxy_http headers ssl rewrite setenvif"
            a2enmod proxy proxy_http headers ssl rewrite setenvif >/dev/null
            a2ensite "$SERVICE_NAME" >/dev/null
        fi

        if apachectl configtest 2>&1 | tee /tmp/${SERVICE_NAME}-configtest.log | grep -qi 'Syntax OK'; then
            log "apache configtest: Syntax OK"
            if [ "$DO_RESTART" -eq 1 ]; then
                log "reloading $APACHE_SVC"
                systemctl reload "$APACHE_SVC"
            fi
        else
            cat /tmp/${SERVICE_NAME}-configtest.log >&2
            die "apache configtest failed; vhost left in place but NOT reloaded"
        fi
    fi
fi

# --- 5. Verify ---------------------------------------------------------------
if [ "$DO_SYSTEMD" -eq 1 ] && [ "$DO_RESTART" -eq 1 ]; then
    PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
    PORT="${PORT:-3010}"
    for _ in 1 2 3 4 5; do
        sleep 1
        HEALTH="$(curl -s -m 3 "http://127.0.0.1:${PORT}/health" || true)"
        [ -n "$HEALTH" ] && break
    done
    if [ -n "$HEALTH" ]; then
        log "health: $HEALTH"
    else
        warn "no response from http://127.0.0.1:${PORT}/health"
        systemctl --no-pager --lines=20 status "$SERVICE_NAME" >&2 || true
    fi
fi

log "done"
