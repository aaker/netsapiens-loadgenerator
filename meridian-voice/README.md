# Meridian Voice test lab

Meridian Voice is a fictional support line used to test real call-center
behaviour on a NetSapiens core. Its domain, `meridianvoice`, has three agents,
two queues, a park, a conference bridge and one inbound number per call flow.
Each flow is a scripted conversation with recorded voices: transfers, holds, a
park, a 3-way call and a 14-minute call. The same calls run once a day from
cron, and after each call the agents write a disposition and notes on its CDR.

Everything about the lab lives in [`lab.json`](lab.json). The scripts in this
folder build the domain from it, place the calls and do the wrap-up. The SIPp
side lives in `sipp/scripts/`: `manual_test.sh`, the scenarios and the audio.

## Quick start

All commands run on the load generator, from
`/usr/local/NetSapiens/netsapiens-loadgenerator`. `<server>` is an id from
`servers.json`.

```bash
# 1. Build the domain, users, devices, queues, park, bridge and DIDs
node meridian-voice/build-domain.js --server <server>

# 2. Place a call and watch it (press Enter for each call, q to quit)
sipp/scripts/manual_test.sh -s <server> --flow attended

# 3. Write the agents' dispositions and notes for calls since a time
node meridian-voice/disposition-calls.js --server <server> --flow attended --since <epoch seconds>

# 4. Run every flow once a day: set MERIDIAN_VOICE_SERVER=<server> in .env, then
cp cron/start_sipp /etc/cron.d/start_sipp
```

The build is safe to rerun. It updates anything that already exists, and it
always writes `meridian-voice/lab/devices.csv`, the device list `manual_test.sh`
registers.

## The lab domain

| Setting | Value |
|---|---|
| Domain | `meridianvoice` ("Meridian Voice") |
| Time zone | America/Phoenix |
| Area code / main number | 858 / 1 858-555-1301 |
| Dial policy | US and Canada |
| Dial plan | `meridianvoice`, chained to `<Cloud PBX Features>` so devices can dial extensions, the park and the bridge |
| Call recording | Every user: `yes-with-transcription-and-sentiment` |

Calls come in from the `inbound-carrier` connection (`sip*@inbound-carrier`,
Inbound DID dial plan), which the build creates if it is missing.

### Agents

| Ext | Name | Role | Department | Avatar |
|---|---|---|---|---|
| 2001 | Priya Shah | **Agent A**: tier-1 support. Answers every call. | Support | ![](avatars/priya-shah.png) |
| 2002 | Marcus Reed | **Agent B**: provisioning and billing. Takes transfers, parks and consults. | Provisioning | ![](avatars/marcus-reed.png) |
| 2003 | Dana Ortiz | **Agent C**: network engineering. The last hop of `blind2`. | Network Engineering | ![](avatars/dana-ortiz.png) |

All three are Call Center Agents, with emails `first.last@meridianvoice.test`.
Each has one device named after the extension (`sip:2001@meridianvoice`). Its
SIP password is derived from the server's API key, so every rebuild gives the
same one. `manual_test.sh` registers each device with that password.

The order of the users in `lab.json` decides the roles: the first is A, the
second B, the third C. In `manual_test.sh`, `--consult <ext>` picks a
different B for `attended`, `park` and `3way`.

### Queues, park and bridge

| Ext | What | Members | Used by |
|---|---|---|---|
| 4000 | Support queue (round robin) | **2001 only** | Every DID. With only Priya in it, each scripted call starts with her. |
| 4001 | Provisioning queue (round robin) | 2002 | `blind`: Priya blind-transfers to the served queue minus one (4000 → 4001) |
| 700 | Call park | | `park`: Priya parks the caller here and Marcus dials 700 to pick up |
| 800 | Conference bridge (dedicated) | | `3way`: the caller, Priya and Marcus meet here. No PIN, no name recording, no join announcements. |

The build makes the queue membership exact: it removes any agent that isn't
listed in `lab.json`.

### Inbound numbers and callers

Each flow has its own DID, routed to queue 4000. Each also has its own caller:
the caller ID number is the caller's, and the caller ID name is their company
(or their own name if a caller has no `company` in `lab.json`).

| DID | Flow | Daily at (Phoenix) | Caller ID | Caller in the audio |
|---|---|---|---|---|
| 1 858-555-1301 | `blind` | 9:00 | Lakeside Dental, 1 619-555-0144 | Tom Becker, office manager |
| 1 858-555-1302 | `attended` | 10:00 | Lakeside Dental, 1 619-555-0144 | Tom Becker |
| 1 858-555-1303 | `park` | 11:00 | Lakeside Dental, 1 619-555-0144 | Tom Becker |
| 1 858-555-1304 | `3way` | 12:00 | Lakeside Dental, 1 619-555-0144 | Tom Becker |
| 1 858-555-1305 | `blind2` | 13:00 | Lakeside Dental, 1 619-555-0144 | Tom Becker |
| 1 858-555-1306 | `hold` | 14:00 | Harbor Vet Clinic, 1 415-555-0188 | Rosa Delgado |
| 1 858-555-1307 | `long` | 15:00 | Pinecrest Realty, 1 503-555-0122 | Greg Hanley |

A DID can only belong to one domain. If a number is already in another
domain's DID table, the build reports it as failed. Free it there, or change
the number in `lab.json`.

## The call flows

Each flow is one call with fixed audio for every party. "Talks 44s" means
that part of the conversation runs 44 seconds.

| Flow | What happens | Agents | Length |
|---|---|---|---|
| `blind` | Priya talks 90s, then blind-transfers the caller to queue 4001. Marcus takes the rest. | 2001, 2002 | ~5 min |
| `attended` | Priya talks 44s and puts the caller on hold. She calls Marcus and they talk 24s, then she transfers the caller to him (REFER with Replaces). Marcus and the caller talk 60s. | 2001, 2002 | ~2.5 min |
| `park` | Priya talks 44s and parks the caller on 700. After 15s Marcus dials 700, picks up, and talks 60s. | 2001, 2002 | ~2 min |
| `3way` | Priya talks 34s, moves the caller onto bridge 800 and joins it herself. Marcus dials in 5s later, and all three talk 46s. | 2001, 2002 | ~1.5 min |
| `blind2` | Priya talks 34s and blind-transfers to Marcus. Marcus talks 30s and blind-transfers to Dana, who talks 44s. | 2001, 2002, 2003 | ~2 min |
| `hold` | No transfer. Priya and Rosa talk 32s, Priya holds her for a random 20-30s, they talk 35s, she holds again for 20-30s, then they talk 27s. | 2001 | ~2.5 min |
| `long` | Priya and Greg cover an office move, voicemail-to-email and more, with small talk and awkward silences. She holds twice (15-25s, 20-30s) and blind-transfers to Marcus, who holds twice more (20-30s each). | 2001, 2002 | ~14 min |

The scripts are in `sipp/scripts/audio/`: `call-script.md` (blind),
`attended-call-script.md`, `park-call-script.md`, and `flows/*.json` for
`3way`, `blind2`, `hold` and `long`.

## Placing calls

`sipp/scripts/manual_test.sh` registers the agents' devices, then calls the
flow's DID with the flow's caller ID and plays the conversation:

```bash
sipp/scripts/manual_test.sh -s <server> --flow <flow> [-t u1|t1|l1] [-w 5] [--once]
```

- **Default flow:** with no `--flow`, it runs `blind`.
- **Placing calls:** each Enter places another call, and `q` quits. `--once` places one call and exits, which is what cron uses.
- **Logs:** each run prints its work directory and log paths. Full SIP traces go to `sipp/scripts/*_messages.log`.
- **Overrides:** `-f` uses another device CSV, `-n` calls another number, and `--media-ip` sets the address the caller advertises. The public IP is found automatically.
- `sipp/scripts/manual_test.sh -h` lists every option.

## Daily calls

`cron/start_sipp` runs `meridian-voice/daily-calls.sh` at the top of every hour:

1. It reads the current hour in the lab's time zone (America/Phoenix) and finds the flow scheduled for that hour. In other hours it exits quietly.
2. It runs `manual_test.sh --once` for that flow, using the transport in `lab.json` (`t1`).
3. It runs `disposition-calls.js` for the call that just finished.

The schedule runs one flow an hour from 9am to 3pm. The Phoenix clock is used
whatever the box's own time zone, and Phoenix has no daylight saving, so the
times never shift. The server comes from `MERIDIAN_VOICE_SERVER` in `.env`.

Output is appended to `/var/log/meridian-voice.log` and copied to syslog under
the tag `meridian-voice`. A lock stops two runs from overlapping. To run one
flow by hand: `meridian-voice/daily-calls.sh --flow hold`.

## After the call: dispositions and notes

`disposition-calls.js` plays the agents doing their wrap-up:

1. **Find the call:** it polls the domain's CDRs for the flow's caller number since `--since`, every 30s for up to 10 minutes (`--wait`), until every agent in the flow has an answered leg.
2. **Wrap up:** each agent "types" for a random 20-90s (`--no-delay` skips this), then writes its disposition, reason and notes from `lab.json` with `PUT /domains/meridianvoice/cdrs/{call-parent-cdr-id}`:
   - `call-disposition`
   - `call-disposition-reason`
   - `call-disposition-notes`
   - `call-disposition-submitted-datetime`
3. **Read back:** it reads each CDR and prints the disposition, the recording status, the call-intelligence job and the positive/neutral/negative sentiment. That shows whether recording, transcription and sentiment ran.

The API has no separate CDR notes field; the notes are
`call-disposition-notes`. When two agents' legs share one parent CDR, the last
agent's disposition is kept and the notes include each agent's entry, prefixed
with their name.

The API doesn't check disposition names against a code list. The ones in
`lab.json` (Transferred, Resolved, Escalated) appear in Call History as
written.

## Avatars

`avatars/*.png` are the agents' illustrated portraits (512×512, square, as
the avatar API requires). The build uploads them with
`PUT /domains/meridianvoice/users/{ext}/avatar`.

They're drawn by `avatars/make-avatars.py`, which builds an SVG for each agent
from colors and a hair style, then `avatars/render-svg.swift` rasterizes it.
To change a look, edit `AGENTS` in `make-avatars.py`, run it on macOS, and
rebuild the domain (or use `--skip-avatars` to leave the avatars as they are).

## Audio

Every flow's audio is recorded speech: Deepgram Aura voices, aligned so each
party's track is silent while the other speaks. The pcaps live in
`sipp/scripts/`, next to the scenarios.

| Flow | Generator |
|---|---|
| `blind` | `sipp/scripts/audio/generate-call-pcaps.sh` |
| `attended` | `sipp/scripts/audio/generate-attended-pcaps.sh` |
| `park` | `sipp/scripts/audio/generate-park-pcaps.sh` |
| `3way`, `blind2`, `hold`, `long` | `sipp/scripts/audio/generate-flow-pcaps.py sipp/scripts/audio/flows/<flow>.json` |

The JSON specs also define the scripted agents for `hold` and `long`. After
editing one, run `sipp/scripts/gen-agent-scenario.py` on it.

The generators read `DEEPGRAM_API_KEY` from `sipp/scripts/audio/.env`. On
macOS, `TTS=say` or `--tts say` renders placeholder voices instead. Section
lengths are timers in the scenarios: if a section's speech grows past its
length, the generator warns, and the length must change in the spec and in
`manual_test.sh`.

## Files

| Path | What |
|---|---|
| `lab.json` | The lab: domain, users, queues, park, bridge, callers, and per flow its DID, daily hour, caller and each agent's disposition |
| `build-domain.js` | Builds or updates the domain from `lab.json` and writes `lab/devices.csv` |
| `disposition-calls.js` | The agents' post-call wrap-up on the CDRs |
| `daily-calls.sh` | Cron entry point: this hour's flow, then its wrap-up |
| `lab/devices.csv` | Generated: the devices and SIP passwords `manual_test.sh` registers. Gitignored. |
| `avatars/` | Agent portraits and the scripts that draw them |

## Changing the lab

Edit `lab.json`, then rerun `build-domain.js`.

- **New DID or caller:** takes effect on the next call.
- **Different hour:** takes effect on the next cron run.
- **Adding a user:** add them to `users`. The build creates the user and device and writes the new CSV.
- **Changing a queue's agents:** the build adds the new ones and removes any that aren't listed.

The audio and agent timing are separate: they live in the specs and scenarios
under `sipp/scripts/`.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Build line says `FAILED ... HTTP 409` on a DID | The number is in another domain's DID table |
| Build line says `FAILED ... HTTP 403` | The API key's scope is too low for that object. Domains and connections need Reseller or Super User. |
| No agent answers | `manual_test.sh` banner `registered/active`. Is 2001 a logged-in member of queue 4000? |
| Transfer, park or bridge step doesn't happen | Agent logs: `register.and.subscribe.sipp_<pid>_logs.log` (`ATT`, `PARK A`, `3WAY A`, `CHAIN`, `AGENT` lines) and `_errors.log` |
| Caller's sections out of step | The caller log's `FLOW caller:` lines show each re-INVITE and the section it chose |
| Agent B never dials in (park, 3way) | `pickup.log` / `join.log` in the run's work directory |
| No CDRs found | `disposition-calls.js` looks for the caller number since `--since`. Check the CDRs in the portal for that number. |
| Sentiment shows `-` | Transcription and sentiment run after the call. Rerun `disposition-calls.js` later, or check the call in the portal. |
