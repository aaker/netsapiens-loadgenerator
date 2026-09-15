# smsautoreply

Receives Bandwidth.com inbound SMS/MMS callbacks and replies to the sender with
a block of generated data plus an echo of the post it received.

## Layout

| Path | Purpose |
|---|---|
| `src/index.js` | Express app: routes, JSON parsing, health check, graceful shutdown |
| `src/config.js` | Env loading + validation (`.env` in dev, `EnvironmentFile` in prod) |
| `src/auth.js` | Optional Basic-auth / shared-token check on the callback URL |
| `src/handler.js` | Normalises the callback, dedupes retries, decides to reply |
| `src/reply.js` | **Reply content lives here** - `enrich()` for new data, `buildReply()` for the text |
| `src/bandwidth.js` | Messaging API v2 client (send, retry/backoff) |
| `scripts/send-test.js` | Posts a sample inbound callback at the running service |
| `apache/smsautoreply.conf` | Apache reverse-proxy vhost |
| `apache/smsautoreply.service` | systemd unit |

## Setup

```bash
npm install
cp env.example .env     # then fill in the Bandwidth credentials
npm start
```

Config keys are documented inline in `env.example`. The service starts even
with missing credentials so `GET /health` can report what is absent (it returns
503 until the config is complete).

### Bandwidth dashboard

On the Messaging application that owns the number:

- **Inbound callback URL**: `https://sms.example.com/webhooks/bandwidth/inbound`
- **Status callback URL** (optional): same URL with `/status` appended
- If `WEBHOOK_USERNAME`/`WEBHOOK_PASSWORD` are set, enter the same values as the
  callback's Basic-auth credentials. Alternatively set `WEBHOOK_TOKEN` and
  append `?token=...` to the callback URL.

Bandwidth requires a publicly trusted HTTPS certificate on the callback URL.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `${WEBHOOK_PATH}` | Inbound message callback. Returns `200` immediately, then sends the reply. |
| `POST` | `${WEBHOOK_PATH}/status` | Delivery status callback; logs outcome only. |
| `GET` | `/health` | `200` when configured, `503` with a `problems[]` list otherwise. |

## Reply flow

1. Bandwidth `POST`s an array of events; only `message-received` is acted on.
2. The message id is checked against a 10-minute in-memory cache so a retried
   callback does not produce a second reply.
3. `buildReply()` composes: generated fields (timestamp, host, message id,
   SMS/MMS, segment count, ...) followed by the inbound `message` object as JSON,
   truncated to `REPLY_MAX_ECHO_CHARS`, with the whole body capped at 1500 chars.
4. The reply is sent from `BW_FROM_NUMBER` when set, otherwise from the number
   the inbound message was addressed to (`message.owner`). A reply is skipped
   when source and destination match, to avoid a message loop.

Set `DRY_RUN=1` to log the reply that would be sent without calling the API.

## Testing

```bash
npm start                                   # in one shell
node scripts/send-test.js                   # simulated inbound SMS
node scripts/send-test.js --mms             # with a media attachment
node scripts/send-test.js --text "hello" --from +19195551212
curl -s localhost:3010/health | jq
```

With `DRY_RUN=1` this exercises the whole path without spending messages.

## Deployment

Target host: `loadgen2-phx.ca.nseng.dev`, installed at
`/usr/local/NetSapiens/netsapiens-loadgenerator/smsautoreply`.

```bash
./deploy/deploy.sh --dry-run     # show what would transfer
./deploy/deploy.sh               # rsync + install + restart
```

`deploy/deploy.sh` runs from a workstation: it rsyncs this directory to the
host (staging in `/tmp`, then moving into place with sudo) and runs
`deploy/install.sh` there. The remote `.env`, `node_modules/` and `*.log` are
excluded from both the copy and the `--delete` sweep, so **remote credentials
are never overwritten**.

`deploy/install.sh` runs on the host and is idempotent:

1. Verifies node >= 18 and installs production dependencies
2. Creates `.env` from `env.example` on a first install (mode 600, owned by the
   service user) and warns that it needs filling in
3. Writes `/etc/systemd/system/smsautoreply.service`, rewriting the paths, node
   binary and user for the actual install location
4. Writes the Apache vhost with `ServerName` and the Let's Encrypt cert paths
   substituted, enables the required modules, runs `apachectl configtest` and
   reloads **only if the test passes**
5. Curls `/health` and prints the result

### First install

```bash
./deploy/deploy.sh --no-apache             # app + service; vhost needs a cert first
ssh loadgen2-phx.ca.nseng.dev
sudo vi /usr/local/NetSapiens/netsapiens-loadgenerator/smsautoreply/.env
```

Then, once a certificate exists for the host, re-run `./deploy/deploy.sh` to
install the vhost, or point `SSLCertificateFile` at an existing one.

### Options

| Command | Effect |
|---|---|
| `--host <fqdn>` | Deploy somewhere else (or set `SMSAUTOREPLY_HOST`) |
| `--server-name <fqdn>` | `ServerName` for the vhost; defaults to the target host |
| `--remote-dir <path>` | Install path (or `SMSAUTOREPLY_REMOTE_DIR`) |
| `--no-apache` | App and systemd unit only |
| `--no-restart` | Install files without restarting anything |
| `--restart-only` | Restart the remote service, no file copy |
| `--status` | Remote `systemctl status` plus `/health` |
| `--logs` | Tail the remote journal |

Logs: `journalctl -u smsautoreply -f` (JSON, one object per line).
