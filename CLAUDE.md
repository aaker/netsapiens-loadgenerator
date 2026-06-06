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

# Diagnostic/test tools
node test-cpu.js                                 # CPU performance benchmark for stats parsing
node test-parse-sample.js                        # Debug SIPp CSV parsing
```

## Architecture

### Configuration Modes

The system supports two configuration modes controlled by `lib/config.js`:

1. **Legacy single-server** (`.env` only) - Used when `servers.json` does not exist. Reads `TARGET_SERVER`, `APIKEY`, `SEED`, etc. from `.env`.
2. **Multi-server** (`servers.json` + `.env`) - Used when `servers.json` exists. Each server entry has its own `hostname`, `apikey`, `seed`, `maxDomains`, `peakCps`, `registrationPct`. Requires `--server <id>` flag. Global settings still come from `.env`.

### Core Files

| File | Purpose |
|---|---|
| `server.js` | Main entry point. Orchestrates domain/user/device/queue creation via NetSapiens API. Processes domains in parallel batches (5 concurrent). |
| `metrics-server.js` | Express server exposing Prometheus metrics at `:9090/metrics`. Monitors `sipp/stats/*.csv` files, parses SIPp statistics, tracks response times (P50/P95/P99), call rates, success/failure counts. Also writes to textfile collector path. |
| `lib/config.js` | `ConfigLoader` class - loads `servers.json` or `.env`, parses `--server` CLI arg, validates configuration. |
| `lib/nsapi.js` | `ServerApiClient` class for multi-server API calls + legacy standalone functions. All requests go to `https://<hostname>/ns-api/v2/`. Includes retry logic (3 retries, exponential backoff 1-10s) for transient errors. Handles 409 (duplicate) by calling update function. |
| `lib/utils.js` | `addToCsv()` - writes device CSVs, `addToCsvNumber()` - writes phone number CSVs, `getDomainSize()` - deterministic domain sizing from name hash, `randomIntFromInterval()`. |
| `lib/randomdata.js` | Static arrays: `timeZones` (7 US), `queueNames` (31), `departmentNames` (51), `phoneModels` (14). `buildRandomCallerData()` generates 40k random caller ID entries to `sipp/csv/random_caller_ids.csv`. |
| `lib/sipp-parser.js` | Parses SIPp `-trace_stat` CSV files. Reads only header + last line for performance. Extracts per-operation response time distributions (register, reregister, invite, subscribe), calculates percentiles, failure breakdowns. |
| `lib/prometheus-metrics.js` | Defines Prometheus gauges using `prom-client`: response time (avg/P50/P95/P99), call volume (current/total/rate), success/failure counts with reason breakdowns. Histograms disabled for performance with 300+ files. |
| `lib/stats-tracker.js` | Per-file state tracking for calculating deltas and rates between polling cycles. Aggregates stats by server/scenario/transport. Detects stale files (5min timeout). |

### Data Generation Flow

1. `server.js` loads config, seeds `fakerator` with `SEED` for reproducible data
2. Generates `MAX_DOMAIN` company domains with deterministic sizing:
   - ~1% super-large (800-2500 users), ~10% large (80-250), rest small (5-50)
3. For each domain: creates domain via API, then batches of users (25/batch), devices, MAC addresses (50%), call queues (1 per 10 users, max 8), and queue agents (10% of users per queue)
4. Writes SIPp-compatible CSV files:
   - **Devices**: `sipp/csv/[servers/<id>/]devices/<domain>.csv` (SEQUENTIAL format)
   - **Phone numbers**: `sipp/csv/[servers/<id>/]phonenumbers/<timezone>.csv` (RANDOM format)

### SIPp Integration

**Shell scripts** (`sipp/scripts/`):
- `register_all.sh` - Iterates device CSVs, allocates ports, launches `register.sh` for each with rotating transport (UDP/TCP/TLS). Only processes a subset per minute (modulo scheduling).
- `register.sh` - Launches a single SIPp registration instance. Configures TLS certs, stats tracking, media ports. Runs in background (`-bg`).
- `inbound.sh` - Launches inbound call generation for a timezone. Calculates call rate from `PEAK_CPS / 7` (one per timezone), runs ~275 seconds (5min batch).
- `port-allocator.sh` - Lock-based port allocation using `/tmp/sipp-ports/`. Manages SIP (20000-22000), control (22001-24000), and media (24001-60000) port ranges.
- `generate_tls_certs.sh` - Generates self-signed TLS certificates for SIPp.

**SIPp XML scenarios** (`sipp/scripts/`):
- `register.and.subscribe.sipp.xml` - Main registration + SUBSCRIBE scenario (used by `register.sh`)
- `register.sipp.xml` / `register_once.sipp.xml` - Simple registration scenarios
- `register_then_accept.sipp.xml` / `register_then_call.sipp.xml` - Register then handle calls
- `sipp_uac_pcap_g711a.xml` / `sipp_uac_big_sdp.xml` - UAC (caller) scenarios with PCAP audio
- `sipp_uas_pcap_*.xml` - UAS (callee) scenarios: G.711a, OPUS, OPUS with G.711 fallback

**Audio files**: `g711a-{orig,orig2,term,term2}.pcap` + `opus-{term,term2}.pcap` (PT 121) - real-speech RTP audio, one file per call leg of a support call with a transfer at 90s (orig = caller, term = agents; `2` = post-transfer segment). Regenerate with `sipp/scripts/audio/generate-call-pcaps.sh` (Deepgram TTS, see `audio/call-script.md`). Legacy: `g711a.pcap`, `opus.pcap`, `sip-rtp-opus-121.pcap` (continuous music), `2024-conversation-02-side-a/b.wav`, `mr.telephone.man.wav`

### Cron Scheduling

`cron/start_sipp` - Production cron configuration:
- Registration: runs every minute, processes a subset of domains per cycle
- Inbound: 5-minute cycles per timezone, 8-hour business day windows (UTC), rotating UDP/TCP/TLS transport on staggered minutes
- Each timezone has offset minute patterns to distribute load

`cron/start_sockettester` - Runs socket.io tester hourly 10:00-17:00

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
- `NDP_SERVERNAME` - NDP core server name (default: "core1")
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
- No test framework - `test-cpu.js` and `test-parse-sample.js` are manual diagnostic scripts
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
- `sockettester/.env`

## File Tree

```
server.js                  # Main data generation entry point
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
test-cpu.js                # CPU performance benchmark
test-parse-sample.js       # SIPp CSV parsing debugger
```
