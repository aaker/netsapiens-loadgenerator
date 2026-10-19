# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NetSapiens Load Generator - a VoIP load testing tool that creates realistic multi-tenant phone system environments. It provisions domains, users, devices, call queues, and agents via the NetSapiens API v2, then uses SIPp to simulate registrations, subscriptions, and inbound calls with realistic business-day patterns across US timezones.

## Common Commands

```bash
# Install dependencies
npm install

# Generate load test data (legacy single-server)
node server.js

# Generate load test data (multi-server)
node server.js --server <server-id>

# Run all device registrations
sipp/scripts/register_all.sh                    # legacy mode
sipp/scripts/register_all.sh --server prod1     # multi-server
sipp/scripts/register_all.sh --server all       # all servers in parallel

# Run inbound calling for a timezone
sipp/scripts/inbound.sh "US_Eastern"                        # legacy, UDP
sipp/scripts/inbound.sh "US_Eastern" t1 --server prod1      # TCP, specific server

# Start Prometheus metrics server
npm run metrics                                  # or: node metrics-server.js
./scripts/start-metrics-server.sh start          # as background service
./scripts/start-metrics-server.sh status|stop|restart|logs

# Tests (Jest, in test/)
npm test                                         # run all tests
npm run test:coverage                            # with coverage report (coverage/)
npx jest test/lib/utils.test.js                  # single file

# Diagnostic tools
node test-cpu.js                                 # CPU performance benchmark for stats parsing
node test-parse-sample.js                        # Debug SIPp CSV parsing
```

## Architecture

### Configuration Modes

The system supports two configuration modes controlled by `lib/config.js`:

1. **Legacy single-server** (`.env` only) - Used when `servers.json` does not exist. Reads `TARGET_SERVER`, `APIKEY`, `SEED`, etc. from `.env`.
2. **Multi-server** (`servers.json` + `.env`) - Used when `servers.json` exists. Each server entry has its own `hostname`, `apikey`, `seed`, `maxDomains`, `peakCps`, `registrationPct`, and optional `opusPct` (overrides `OPUS_PCT` from `.env`; default 50) and optional `sasHostname` (SIP destination for inbound INVITEs only; the API and registrations still use `hostname`), and optional `ndpServerName` (overrides `NDP_SERVERNAME` from `.env`; default "core1"). Requires `--server <id>` flag. Global settings still come from `.env`.

### Core Files

| File | Purpose |
|---|---|
| `server.js` | Main entry point. Orchestrates domain/user/device/queue creation via NetSapiens API. Processes domains in parallel batches (5 concurrent). |
| `metrics-server.js` | Express server exposing Prometheus metrics at `:9090/metrics`. Monitors `sipp/stats/*.csv` files, parses SIPp statistics, tracks response times (P50/P95/P99), call rates, success/failure counts. Also writes to textfile collector path. |
| `lib/config.js` | `ConfigLoader` class - loads `servers.json` or `.env`, parses `--server` CLI arg, validates configuration. |
| `lib/nsapi.js` | `ServerApiClient` class for multi-server API calls + legacy standalone functions. All requests go to `https://<hostname>/ns-api/v2/`. Includes retry logic (3 retries, exponential backoff 1-10s) for transient errors. Handles 409 (duplicate) by calling update function. The original methods swallow errors. `apiRequest`/`apiGet`/`apiPatch`/`apiPutJson`/`apiPostJson`/`apiDelete` return `{status, data}` and throw instead, and also retry 429; `describeApiError()` formats a failure as one line. |
| `lib/utils.js` | `addToCsv()` - writes device CSVs, `addToCsvNumber()` - writes phone number CSVs, `getDomainSize()` - deterministic domain sizing from name hash, `randomIntFromInterval()`. |
| `lib/randomdata.js` | Static arrays: `timeZones` (7 US), `queueNames` (31), `departmentNames` (51), `phoneModels` (14). `buildRandomCallerData()` generates 40k random caller ID entries to `sipp/csv/random_caller_ids.csv`. |
| `lib/sipp-parser.js` | Parses SIPp `-trace_stat` CSV files. Reads only header + last line for performance. Extracts per-operation response time distributions (register, reregister, invite, subscribe), calculates percentiles, failure breakdowns. |
| `lib/prometheus-metrics.js` | Defines Prometheus gauges using `prom-client`: response time (avg/P50/P95/P99), call volume (current/total/rate), success/failure counts with reason breakdowns. Histograms disabled for performance with 300+ files. |
| `lib/stats-tracker.js` | Per-file state tracking for calculating deltas and rates between polling cycles. Aggregates stats by server/scenario/transport. Detects stale files (5min timeout). |

### Data Generation Flow

1. `server.js` loads config, seeds `fakerator` with `SEED` for reproducible data
2. Generates `MAX_DOMAIN` company domains with deterministic sizing:
   - ~1% super-large (800-2500 users), ~10% large (80-250), rest small (5-50)
3. For each domain: creates domain via API, then batches of users (25/batch), devices, MAC addresses (50%), call queues (1 per 10 users, min 2, effectively max 13 because of an off-by-one guard), and queue agents (15% of users + 6 per queue, picked with unseeded `Math.random()`, so membership is not reproducible between runs)
4. Writes SIPp-compatible CSV files:
   - **Devices**: `sipp/csv/[servers/<id>/]devices/<domain>.csv` (SEQUENTIAL format)
   - **Phone numbers**: `sipp/csv/[servers/<id>/]phonenumbers/<timezone>.csv` (RANDOM format)

### SIPp Integration

**Shell scripts** (`sipp/scripts/`):
- `register_all.sh` - Iterates device CSVs, allocates ports, launches `register.sh` for each with rotating transport (UDP/TCP/TLS). Only processes a subset per minute (modulo scheduling).
- `register.sh` - Launches a single SIPp registration instance. Configures TLS certs, stats tracking, media ports. Runs in background (`-bg`).
- `inbound.sh` - Launches inbound call generation for a timezone. Calculates call rate from `PEAK_CPS / 7` (one per timezone), runs ~275 seconds (5min batch). Sends to the server's `sasHostname` when set in `servers.json`, otherwise `hostname` (legacy mode: `SAS_SERVER`, falling back to `TARGET_SERVER`).
- `port-allocator.sh` - Lock-based port allocation using `/tmp/sipp-ports/`. Manages SIP (20000-22000), control (22001-24000), and media (24001-60000) port ranges.
- `generate_tls_certs.sh` - Generates self-signed TLS certificates for SIPp.
- `cps-utils.sh` - Shared `cps_multiplier [minute_offset]` business-day curve (sourced by `inbound.sh` and `domain_inbound.sh`; `register.sh` uses its own cosine curve for registration percentage).
- `domain_inbound.sh` - Per-domain inbound call boost launched by `agent-sim.js` every 5 minutes (see Agent Simulator). Takes a prebuilt weighted DID CSV (`--csv`), a peak CPS for that domain alone (not divided by 7), and a talk-time range that it templates into a copy of `sipp_uac_pcap_g711a.xml` (`sipp/scripts/.agentsim_uac_*.xml`, removed when SIPp exits). Stats file: `<server>_domainboost_<transport>_<domain>_<pid>.csv`.
- `csv-utils.sh` - Shared `normalize_device_csv` (5-column device CSV layout: displayName, extension, domain, auth, userAgent).
- `opus-utils.sh` - Shared Opus/G.711a percentage-regex helpers for UAS scenarios.
- `net-utils.sh` - Shared `resolve_ipv4 <host>`: resolves the SIP destination to an A record before handing it to SIPp, so an AAAA answer can't trigger "Network family mismatch for local/remote IP" (SIPp binds IPv4 via `-i`). IPv4 literals pass through; on resolution failure the hostname is used as-is with a warning. Sourced by `inbound.sh`, `register_all.sh`, `register.sh`, `call_all.sh`, `call.sh`, `manual_test.sh`.
- `callback_uas.sh` - Launches the long-lived answer-then-callback UAS (`sipp_uas_answer_then_callback.xml`) on a fixed SIP port (default 5050, control 5051, media base 60002 - above the port-allocator range so it never collides with pooled instances). No remote host / `servers.json` lookup: the callback goes back to the source of each inbound call, so **one instance serves all servers** (`--server` is only a stats-file label). Always advertises the host's public IP in the SDP `c=` line via `-key sdp_media_ip` (`IP_USE_PUBLIC` is ignored - the SUT reaches this fixed-port listener across NAT; `--media-ip <ip>` overrides, and a failed public-IP lookup falls back to the private IP), while `-i`/`-mi` still bind the private address. Capped at 6h via SIPp's global `-timeout`; writes `/tmp/sipp-callback-uas/callback_uas_<port>.state` (pid, start epoch, stats path).
- `callback_uas_monitor.sh` - Cron keep-alive (every minute) for the above. Restarts it when the PID is gone (normal 6h exit or crash), runtime exceeds the cap + 300s grace, the stats file goes stale (>180s), or the SIP port is not bound. Graceful `q` -> SIGTERM -> SIGKILL; `flock` prevents overlapping runs; logs to syslog under `sipp-callback`.
- `manual_test.sh` - Foreground harness for one call watched end to end, with full tracing and a tcpdump of the caller's media. It registers the devices in `sipp/csv/manual/devices.csv` (or `-f`), then places an inbound call to a DID each time you press Enter. The default `--flow blind` uses the cron scenarios; `--talk min,max` sets the caller's talk time, and `--full-call` plays the whole blind-transfer conversation once. `--flow attended` runs a supervised transfer with `sipp_uac_attended.xml` and `sipp_uas_attended.xml`. It registers each device in its own SIPp process and picks agent B with `--consult <ext>` (default: the first device). Runs only on the install path.

**SIPp XML scenarios** (`sipp/scripts/`):
- `register.and.subscribe.sipp.xml` - Main registration + SUBSCRIBE scenario (used by `register.sh`). Registers, subscribes (MWI + presence), then re-REGISTERs every 45s for `-key reg_loops` iterations and ends. Places no outbound calls; inbound calls to the registered devices are handled by the launcher's `-oocsf` UAS scenario. Requires `-key reg_loops` from the launcher.
- `sipp_uas_answer_then_callback.xml` - Standalone UAS (PCMU/PT 0 media): answers an inbound call, plays `g711u-term.pcap`, follows in-dialog re-INVITEs (cap 8), waits for the orig BYE; then pauses 65s and calls the originating number back - callee from the inbound From URI, destination `[$peer_host]` from the inbound Contact, so it returns to whichever server called in - plays `g711u-orig.pcap`, answers an optional re-INVITE and waits for the remote BYE. Both legs share `[call_id]` (different From tags) because SIPp matches incoming messages by Call-ID. No auth on the callback leg. SDP `c=` uses the custom keyword `[sdp_media_ip]` (not SIPp's built-in `[media_ip]`, which a `-key` cannot override) so the advertised RTP address can be the public IP while the media socket binds the private one - `callback_uas.sh` must pass `-key sdp_media_ip`. Launched by `callback_uas.sh`.
- `sipp_uas_attended.xml` / `sipp_uac_attended.xml` - Supervised (attended) transfer, standard RFC 5589 flow, used only by `manual_test.sh --flow attended`. A single UAS file plays both agents. A call with `P-Served-Queue` is agent A: it talks 44s, holds the caller (re-INVITE `a=sendonly`), places an authenticated consult INVITE to agent B, talks 24s, then REFERs the caller with `Refer-To: <B?Replaces=...>`. It answers the NOTIFYs and BYEs and sends BYEs itself if they don't come. A direct call is agent B: consult audio, then the caller conversation, starting on a re-INVITE or after 25s. The consult dialog runs inside agent A's SIPp call: its Call-ID is `cx...///<original Call-ID>`, and SIPp matches everything after `///` back to the original call. An `-oocsf` scenario cannot read SIPp input files (`[fieldN]` aborts the call), so `manual_test.sh` writes a per-device copy with the `__AGENT_NAME__/EXT/DOMAIN/AUTH__` placeholders filled in (AUTH is the CSV's `[authentication ...]` field) and passes `-key consult_target` / `consult_target_alt`. The UAC answers a hold re-INVITE `recvonly`/`inactive` and starts section 3 on the sendrecv re-INVITE after it (fallback: 32s), then hangs up after 60s. Every wait is a recv with a timeout, given to every recv in the group, because SIPp arms only the first recv's timeout.
- `register.sipp.xml` / `register_once.sipp.xml` - Simple registration scenarios
- `register_then_accept.sipp.xml` / `register_then_call.sipp.xml` - Register then handle calls
- `sipp_uac_pcap_g711a.xml` / `sipp_uac_big_sdp.xml` - UAC (caller) scenarios with PCAP audio
- `sipp_uas_pcap_*.xml` - UAS (callee) scenarios: G.711a, OPUS, OPUS with G.711 fallback

**Audio files**: `g711u-{orig,orig2,term,term2}.pcap` (PCMU, PT 0 - used by `sipp_uas_answer_then_callback.xml`; regenerate from the committed reference WAVs with `sipp/scripts/audio/generate-g711u-pcaps.sh`, no TTS key needed) and `g711a-{orig,orig2,term,term2}.pcap` + `opus-{term,term2}.pcap` (PT 121) - real-speech RTP audio, one file per call leg of a support call with a transfer at 90s (orig = caller, term = agents; `2` = post-transfer segment). `g711a-silence.pcap` - 90s of A-law silence, streamed by the UAC during the pre-agent (AA/MOH) stage. Regenerate with `sipp/scripts/audio/generate-call-pcaps.sh` (Deepgram TTS, see `audio/call-script.md`). `g711a-att-{orig,term,consult-a,consult-b,orig2,term2}.pcap` - the supervised-transfer call (sections 44s / 24s / 60s); regenerate with `sipp/scripts/audio/generate-attended-pcaps.sh` (Deepgram, or `TTS=say` on macOS), see `audio/attended-call-script.md`. Legacy: `g711a.pcap`, `opus.pcap`, `sip-rtp-opus-121.pcap` (continuous music), `2024-conversation-02-side-a/b.wav`, `mr.telephone.man.wav`

### Agent Simulator (`agent-sim.js`)

A long-running daemon that makes call-queue agents behave like a real call-center workforce for selected domains. It drives shifts, login/logout, away reasons, wrap-up and dispositions through API v2. Without it, every generated agent stays logged in and Available all day. Each status change is written by the server to `agent_log`, which feeds Horizon's agentLog stats (time available, unavailable, and per reason).

- Config: `agent-sim.json` (gitignored; template `agent-sim.json.example`). There is one entry per domain, keyed by a `servers.json` id. Entries are merged over `DEFAULTS` in `lib/agent-sim/config.js`. Hostname and apikey come from `servers.json`, or from `.env` in legacy mode, where the server id is `default`.
- Commands (run from the repo root):
  - `setup`: shapes the roster. Add `--dry-run` to preview, or `--labels-only` to write only the status labels.
  - `restore`: undoes setup from the snapshot.
  - `run`: starts the daemon. `--time-scale N` and `--agent` are for testing only.
  - `status`: shows live queue and agent counts.
  - `plan`: shows the planned staffing per queue per hour, or one agent's day.
  - `report`: shows today's per-queue SL/AWT/AR/AHT and agentLog totals.
  - `codes`: lists the disposition codes; `--seed` creates the server's default set.
- State lives in `state/agent-sim/<server>/<domain>/` (gitignored):
  - `roster-snapshot.json`: the original memberships, written once and never overwritten.
  - `roster.json`: the output of setup, read by `run`.
  - `state.json`: per-agent runtime state, so a restart resumes the day.
  - `boost_numbers.csv` and `dispositions-seen.json`.
  - Also `state/agent-sim/heartbeat` and `agent-sim.pid`, used by the monitor.
- Modules in `lib/agent-sim/`:
  - `roster.js`: setup and restore.
  - `schedule.js`: seeded day plan per agent per local date.
  - `engine.js`: per-agent state machine, reconcile/drift, reactive staffing, call boost.
  - `api.js`: paced writes, at most N in flight and at least 1.5s apart per agent.
  - `dispositions.js`, `metrics.js`, `time.js`, `rng.js`.
- Queue profiles (`strong` / `normal` / `struggling`, mapped per queue in `queues`) set:
  - `staffing`: the chance a skilled agent logs into that queue today;
  - `skillDepth`: how many agents get the skill at setup;
  - `wrapUpSec`;
  - `awayMultiplier`;
  - `negativeBias`: how much negative dispositions are favoured.
- Status API facts the code relies on:
  - `PATCH .../callqueues/{q|all}/agents/{user@domain}/{login|logout|manual|onecall}`.
  - Away reasons `Break|Lunch|Meeting|Web|Other|Manual-unavail|cust1..8` are case-sensitive and require `all`.
  - Every action returns 202 before the change is applied.
  - The server drops a second agent_log write for the same agent within the same second.
  - Agents are logged in regardless of device registration. When an unregistered agent is auto-logged out after missed calls, the reconcile loop records it as drift (`logged_out_unregistered`) and logs the agent back in after `drift.relogDelaySec`.
- Custom label writes:
  - `PORTAL_CALL_QUEUE_STATUS_CUSTOM_N`, the configuration the API copies into the user's status message.
  - The domain setting `callcenter.status.custom`: 8 `[name, icon, tone]` slots, read by Horizon.
- Dispositions (`dispositions.enabled`):
  - Polls `GET /domains/{d}/cdrs` for answered calls whose `call-through-user` is a queue and whose `call-term-user` is a rostered agent.
  - After a wrap-up delay it sends `PUT /domains/{d}/cdrs/{call-parent-cdr-id}` with `call-disposition`, `call-disposition-reason`, `call-disposition-notes` and `call-disposition-submitted-datetime`.
  - Codes come from `/callcenter-codes` (feature flag `call_center_reports`), else legacy `/dispositions`, else the config fallback. The API does not validate the codes.
  - In Horizon, dispositions show up in Call History, in columns that are hidden by default.
- Metrics:
  - Written to `agent_sim.prom` in the `TEXTFILE_PATH` directory, never `sipp.prom`.
  - Metrics: `agentsim_agents{queue,state}`, `agentsim_queue_waiting`, `agentsim_queue_agents_available`, `agentsim_actions_total`, `agentsim_drift_total`, `agentsim_reactive_total`, `agentsim_dispositions_total`.

### Cron Scheduling

`cron/start_sipp` - Production cron configuration:
- Registration: runs every minute, processes a subset of domains per cycle
- Inbound: 5-minute cycles per timezone, running 24/7 (volume shaped only by `cps_multiplier`), rotating UDP/TCP/TLS transport on staggered minutes
- Each timezone has offset minute patterns to distribute load
- Callback UAS: `callback_uas_monitor.sh` every minute (keeps the single port-5050 answer-then-callback instance running for all servers; the instance itself recycles every 6 hours)

`cron/start_sockettester` - Runs socket.io tester hourly 10:00-17:00

`cron/start_agentsim` - Runs `scripts/agent_sim_monitor.sh` every minute (keeps the agent-sim daemon running; restarts it on a stale heartbeat)

### Auxiliary Components

- **`sipp-api/index.php`** - PHP API for triggering individual SIPp operations (register_once, call, accept_invite). Creates temp CSV, invokes SIPp directly.
- **`sockettester/server.js`** - Socket.io WebSocket load tester (ES module). Creates multiple concurrent clients subscribing to call/contacts/voicemail/chat/queue/agent events. Gets JWT from API, fetches domain list, randomizes subscriptions.

## Environment Variables

### Required (Legacy Mode)
- `TARGET_SERVER` - NetSapiens API hostname
- `APIKEY` - API key (should start with `nss_`)

### Load Generation
- `MAX_DOMAIN` - Number of domains to generate (1-1000, default: 10)
- `PEAK_CPS` - Peak calls per second, supports decimals like 0.5 (default: 10)
- `REGISTRATION_PCT` - Fraction of devices to register: 0-1 (default: 0.5)
- `SEED` - Random seed for reproducible data generation

### Global Settings
- `RESELLER` - Reseller name for API calls (default: "NetSapiens")
- `NDP_SERVERNAME` - NDP core server name (default: "core1"). Per-server override: `ndpServerName` in `servers.json`.
- `RECORDING_DIVISER` - Recording frequency divisor: 4 = 25% of users (default: 4)
- `SAS_SERVER` - SAS server hostname (falls back to TARGET_SERVER)
- `API_DEBUG` - Enable verbose API logging: 0/1 (default: 0)
- `IP_USE_PUBLIC` - Use public IP in SDP: 0/1 (default: 1)
- `USE_OPUS` - Enable OPUS codec for UAS tests: 0/1 (default: 1)

### Metrics Server
- `METRICS_PORT` - Prometheus endpoint port (default: 9090)
- `STATS_DIR` - SIPp statistics directory (default: ./sipp/stats)
- `UPDATE_INTERVAL` - Polling interval in seconds (default: 10)
- `FILE_CLEANUP_AGE` - Delete stats files older than N seconds (default: 600)
- `ENABLE_METRICS` - Set to 'false' to disable processing
- `USE_FILE_WATCHER` - Use chokidar file watcher: 'true' to enable (default: polling only)
- `TEXTFILE_PATH` - Path for Node Exporter textfile collector (default: /usr/local/NetSapiens/agent/textfile_collector/sipp.prom)

## Key Conventions

### Code Style
- Uses `var` for legacy modules, `const`/`let` in newer code - match the style of the file you're editing
- Node.js CommonJS modules (`require`/`module.exports`) throughout, except `sockettester/` which uses ES modules
- Tests use Jest, plus `supertest` for the `metrics-server.js` endpoints. They live in `test/`, mirroring the source layout (`test/lib/<module>.test.js`).
  - Covered: the core `lib/` modules and `metrics-server.js`. Not covered: agent-sim, `server.js` and the shell scripts.
  - `test/lib/config.test.js` deletes `TARGET_SERVER`, `APIKEY`, `MAX_DOMAIN` etc. and then re-requires `lib/config.js`. That module calls `dotenv.config()` on load, so a local `.env` puts the values straight back.
  - With a populated `.env` in the repo root, 3 config tests fail: "throws when TARGET_SERVER missing", "throws when APIKEY missing" and "applies defaults for optional fields". Without one, all tests pass. Run the suite from a checkout without `.env` (e.g. a `git worktree`) or move `.env` aside.
- `test-cpu.js` and `test-parse-sample.js` are manual diagnostic scripts, not part of the Jest suite
- No linter or formatter configured

### API Pattern
- All API calls go through `ServerApiClient` (multi-server) or legacy standalone functions in `lib/nsapi.js`
- API endpoint pattern: `https://<hostname>/ns-api/v2/<path>`
- POST for creation, PUT for updates. 409 responses trigger the duplicate/update callback
- `apiCreateSync` waits for response; `apiCreate` fires and forgets

### CSV File Format
- Device CSVs: `SEQUENTIAL\r\n` header, fields: `displayName;device;domain;[authentication ...]`
- Phone number CSVs: `RANDOM\r\n` header, fields: `phonenumber;domain;description`
- Random caller IDs: `RANDOM\r\n` header, fields: `callerName;number;`

### Deployment
- Production install path: `/usr/local/NetSapiens/netsapiens-loadgenerator`
- Cron files go in `/etc/cron.d/` (copy from `cron/`)
- Requires SIPp installed system-wide (`/usr/bin/sipp`)
- TLS certs at `sipp/tls/sipp.crt` and `sipp/tls/sipp.key`
- Multi-server mode requires `jq` for bash scripts to parse `servers.json`
- Port locks stored in `/tmp/sipp-ports/`

### .gitignore
- `node_modules/`, `package-lock.json`, `deploy.sh`
- `sipp/csv/devices/`, `sipp/csv/phonenumbers/` (generated data)
- `agent-sim.json`, `state/` (agent-sim config and runtime state), `sipp/scripts/.agentsim_uac_*.xml`
- `sockettester/.env`
- `coverage/` (Jest coverage output)

## File Tree

```
server.js                  # Main data generation entry point
agent-sim.js               # Call-center agent behaviour simulator (daemon + setup/restore/status/report)
agent-sim.json.example     # agent-sim per-domain configuration template
metrics-server.js          # Prometheus metrics server
package.json               # Dependencies: axios, express, fakerator, seedrandom, prom-client, etc.
.env.example               # Environment variable template
servers.json.example       # Multi-server configuration template
lib/
  config.js                # Configuration loader (multi/single server)
  nsapi.js                 # NetSapiens API v2 client (ServerApiClient class + legacy)
  utils.js                 # CSV generation, domain sizing
  randomdata.js            # Static data arrays, caller ID generation
  sipp-parser.js           # SIPp statistics CSV parser
  prometheus-metrics.js    # Prometheus metric definitions
  stats-tracker.js         # Per-file state tracking, aggregation
  agent-sim/               # agent-sim modules (config, roster, schedule, engine, api, dispositions, metrics)
sipp/
  scripts/                 # SIPp XML scenarios + bash orchestration
  csv/                     # Generated CSV files (devices/, phonenumbers/, random_*)
  stats/                   # SIPp runtime statistics (monitored by metrics-server)
cron/
  start_sipp               # Cron config for registration + inbound calling
  start_sockettester        # Cron config for socket.io testing
scripts/
  start-metrics-server.sh  # Service management for metrics server
sipp-api/
  index.php                # PHP API for single SIPp operations
sockettester/
  server.js                # Socket.io WebSocket load tester (ES module)
test/                      # Jest tests (lib/*.test.js, metrics-server.test.js)
jest.config.js             # Jest configuration
test-cpu.js                # CPU performance benchmark
test-parse-sample.js       # SIPp CSV parsing debugger
```
