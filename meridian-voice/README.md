# Meridian Voice test lab

Meridian Voice is a fictional support line used to test real call-center
behaviour on a NetSapiens core. Its domain, `meridianvoice`, has three queue agents
and an account manager with a direct line, two queues, a park, a conference bridge and one inbound number per call flow.
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
| Park rule | `sip:700@*` -> `Directed-Parktrieve` in the domain's dial plan (destination `[*]@<OwnDomain>`, source host `<OwnDomain>`): dialed from an idle phone it retrieves the call parked on 700 |
| Call recording | 2001-2003: `yes-with-transcription-and-sentiment`. 2004: `yes` (recorded, not transcribed) |

Calls come in from the `inbound-carrier` connection (`sip*@inbound-carrier`,
Inbound DID dial plan), which the build creates if it is missing.

### Agents

| Ext | Name | Role | Department | Avatar |
|---|---|---|---|---|
| 2001 | Priya Shah | **Agent A**: tier-1 support. Answers every call. | Support | ![](avatars/priya-shah.png) |
| 2002 | Marcus Reed | **Agent B**: provisioning and billing. Takes transfers, parks and consults. | Provisioning | ![](avatars/marcus-reed.png) |
| 2003 | Dana Ortiz | **Agent C**: network engineering. The last hop of `blind2`. | Network Engineering | ![](avatars/dana-ortiz.png) |
| 2004 | Owen Hale | Account manager. Not in a queue: customers call his direct number, 1 858-555-1309 (also his caller ID). Recorded without transcription. | Account Management | ![](avatars/owen-hale.png) |

2001-2003 are Call Center Agents and 2004 is a Basic User, all with emails `first.last@meridianvoice.test`.
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

Each flow has its own DID, routed to queue 4000 (except `direct`, which calls Owen's direct number), and its own caller. The
caller ID number is the caller's own. The caller ID name is their `cnam` in
`lab.json`: upper case, at most 15 characters, like carrier CNAM.
`manual_test.sh` falls back to the company or name, uppercased and cut to 15.
The audio uses the caller's own name and company.

| DID | Flow | Daily at (Phoenix) | Caller ID | Caller in the audio |
|---|---|---|---|---|
| 1 858-555-1301 | `blind` | 9:00 | LAKESIDE DENTAL, 1 619-555-0144 | Tom Becker, office manager, Lakeside Dental |
| 1 858-555-1302 | `attended` | 10:00 | BRIGHT SMILE, 1 858-555-0161 | Nora Fields, Bright Smile Ortho |
| 1 858-555-1303 | `park` | 11:00 | CHEN AUTO BODY, 1 626-555-0173 | Victor Chen, Chen Auto Body |
| 1 858-555-1304 | `3way` | 12:00 | ALPINE TITLE CO, 1 720-555-0129 | Alicia Moreno, Alpine Title Co |
| 1 858-555-1305 | `blind2` | 13:00 | WALSH BUILDERS, 1 602-555-0147 | Derek Walsh, Walsh Builders |
| 1 858-555-1306 | `hold` | 14:00 | HARBOR VET, 1 415-555-0188 | Rosa Delgado, Harbor Vet Clinic |
| 1 858-555-1307 | `long` | 15:00 | PINECREST RLTY, 1 503-555-0122 | Greg Hanley, Pinecrest Realty |
| 1 858-555-1308 | `upset` | 16:00 | RUSSO PLUMBING, 1 312-555-0190 | Frank Russo, Russo Plumbing |
| 1 858-555-1309 | `direct` (Owen's direct line, to-user 2004, not the queue) | 8:00 | SUNRISE BAKERY, 1 480-555-0136 | Lena Brooks, Sunrise Bakery |

Every flow has a different caller number, so `disposition-calls.js`, which
finds a call's CDRs by caller number, can't pick up another flow's call.

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
| `park` | Priya talks 45s and parks the caller on 700. After 15s Marcus dials 700, picks up, and talks 60s. | 2001, 2002 | ~2 min |
| `3way` | Priya talks 34s, moves the caller onto bridge 800 and joins it herself. Marcus dials in 5s later, and all three talk 46s. | 2001, 2002 | ~1.5 min |
| `blind2` | Priya talks 34s and blind-transfers to Marcus. Marcus talks 30s and blind-transfers to Dana, who talks 44s. | 2001, 2002, 2003 | ~2 min |
| `hold` | No transfer. Priya and Rosa talk 32s, Priya holds her for a random 20-30s, they talk 35s, she holds again for 20-30s, then they talk 27s. | 2001 | ~2.5 min |
| `long` | Priya and Greg cover an office move, voicemail-to-email and more, with small talk and awkward silences. She holds twice (15-25s, 20-30s) and blind-transfers to Marcus, who holds twice more (20-30s each). | 2001, 2002 | ~14 min |
| `direct` | Under a minute. Lena calls Owen's direct number about a phone order; he confirms it and gives the order number. No queue, no hold, no transfer. Owen is recorded without transcription. | 2004 | ~55s |
| `upset` | Bad sentiment. Frank, an angry repeat caller, reports dropped calls for the third time. Priya holds him for 15-25s, finds nothing, can only escalate with a 1-2 day callback and can't give a credit. He threatens to switch providers and hangs up unhappy. | 2001 | ~2.5 min |

The scripts are in `sipp/scripts/audio/`: `call-script.md` (blind),
`attended-call-script.md`, `park-call-script.md`, and `flows/*.json` for
`3way`, `blind2`, `hold`, `long`, `upset` and `direct` (`direct-call-script.md` is the readable version).

### Testing transcription after the call

`direct` exists to test recording without transcription, then transcribing
the recording afterwards. Owen (2004) is the only user set to `yes`, so his
calls are recorded but not sent for transcription:

1. Place the call: `sipp/scripts/manual_test.sh -s <server> --flow direct --once`
2. Check the CDR: `call-recording-status` should show a recording, and
   `call-intelligence-job-id` should be empty (no transcription ran).
3. Request the transcription for that recording (portal, or the feature under
   test). API v2 has no endpoint to start one; it only reads a finished one
   (`GET /domains/{domain}/transcriptions?id=<job id>&date=<YYYYMM>&callid=...`).
4. Check that the CDR now has a `call-intelligence-job-id`, and read the
   transcript. It should match `sipp/scripts/audio/direct-call-script.md`.

`node meridian-voice/disposition-calls.js --server <server> --flow direct --since <epoch>`
writes Owen's disposition and prints the CDR's recording and intelligence fields.
Cron runs `direct` every day at 8:00 Phoenix time, so there is a fresh
untranscribed recording each morning.

## Placing calls

`sipp/scripts/manual_test.sh` registers the agents' devices, then calls the
flow's DID with the flow's caller ID and plays the conversation:

```bash
sipp/scripts/manual_test.sh -s <server> --flow <flow> [-t u1|t1|l1] [-w 5] [--once]
```

- **Default flow:** with no `--flow`, it runs `blind`.
- **Placing calls:** each Enter places another call, and `q` quits. `--once` places one call and exits, which is what cron uses.
- **Registrations:** the agents' devices register just before each call and stop 5 seconds after it, so nothing stays registered between calls. Each registration is also sized to the flow, about 4 minutes for `3way` up to 17 for `long`, so it ends on its own even if the script is killed. `-k` registers once for an hour and leaves the registrations running.
- **Ports:** each device registers from its own fixed ports in `lab.json` (`ports` on each user, `ports.shared` for the flows that register all three from one process): 2001 uses SIP 5110-5114, 2002 uses 5130-5134, 2003 uses 5150-5154, 2004 uses 5190-5194 (media 60700), and the shared set uses 5170-5174, with control ports +5 and media from 60300/60400/60500/60600. Each call takes the first free port in the device's set, because a stopped TCP registration holds its port for about 60s. A registration the core still holds from an earlier run therefore always points back at the same device. Before registering, the script stops any registration process an earlier run left on those ports (`-k`, or a killed run), removes the devices' old bindings (`REGISTER Contact: *`, `Expires: 0`), and refuses to start if another `manual_test.sh` run is using them. Open these ports on the box's firewall like the pool ports (20000-60000).
- **Logs:** each run prints its work directory and log paths. Full SIP traces go to `sipp/scripts/*_messages.log`.
- **Overrides:** `-f` uses another device CSV, `-n` calls another number, and `--media-ip` sets the address the caller advertises. The public IP is found automatically.
- `sipp/scripts/manual_test.sh -h` lists every option.

## Daily calls

`cron/start_sipp` runs `meridian-voice/daily-calls.sh` at the top of every hour:

1. It reads the current hour in the lab's time zone (America/Phoenix) and finds the flow scheduled for that hour. In other hours it exits quietly.
2. It runs `manual_test.sh --once` for that flow, using the transport in `lab.json` (`t1`).
3. It runs `disposition-calls.js` for the call that just finished.

The schedule runs one flow an hour from 8am to 4pm. The Phoenix clock is used
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

### Disposition and call-reason codes

The build creates the domain's call-center codes from `lab.json`
(`callcenterCodes`) with `/domains/meridianvoice/callcenter-codes`. On a
rebuild it creates any missing codes and brings existing ones back in line
with `lab.json`. Codes the domain has that aren't in `lab.json` are left
alone.

There are two lists:
- **Dispositions:** how the call ended. Each has a classification.
- **Call reasons:** why the customer called.

The API doesn't tie a reason to a disposition, so any pair is valid. The
build refuses to run if a flow writes a disposition or reason that isn't in
the lists. The wrap-up warns if the domain is missing one, because the CDR
fields accept any text and a typo would otherwise go unnoticed. Names are at
most 32 characters, the CDR fields' limit.

The code lists need call center reports enabled on the platform. If they're
off, every code request returns 404 and the build reports
`FAILED call-center codes: HTTP 404`.

| Disposition | Classification |
|---|---|
| Resolved | positive |
| Callback Scheduled | positive |
| Follow-up Required | neutral |
| Escalated | neutral |
| Transferred | neutral |
| Left Voicemail | neutral |
| Not Resolved | negative |
| Customer Hung Up | negative |
| Wrong Number | negative |
| Abandoned in Queue | negative; set by the system, inbound only |
| No Answer | negative; set by the system |
| Call Failed | negative; set by the system |

**Call reasons:** Technical Support, Network or Connectivity, Call Routing,
New User Setup, Account Changes, Number Porting, Office Move, Voicemail Issue,
Call Recording, Billing or Payment, Complaint, Cancellation Request, Sales
Inquiry, Order Status, General Information.

What each agent writes after each flow's call:

| Flow | Agent | Disposition | Call reason |
|---|---|---|---|
| `blind` | 2001 / 2002 | Transferred / Resolved | New User Setup |
| `attended` | 2001 / 2002 | Transferred / Resolved | Call Routing |
| `park` | 2001 / 2002 | Transferred / Resolved | Billing or Payment |
| `3way` | 2001 / 2002 | Escalated / Resolved | Number Porting |
| `blind2` | 2001 / 2002 / 2003 | Transferred / Transferred / Resolved | Technical Support / Network or Connectivity / Network or Connectivity |
| `hold` | 2001 | Resolved | Call Recording |
| `long` | 2001 / 2002 | Transferred / Resolved | Office Move / Account Changes |
| `upset` | 2001 | Not Resolved | Complaint |

The details of each call, such as what was fixed, extensions and ticket
numbers, go in the notes.

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
`sipp/scripts/pcaps/`; the scenarios play `pcaps/<name>.pcap`.

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
| After a park pickup, Priya's audio plays over Marcus | The core re-INVITEs the retriever at its registered contact. In `park` and `3way`, Marcus registers only from his dial-in (`DIAL: 2002 registered` in the dial-in's logs); a second registration of 2002 elsewhere would take that re-INVITE. |
| A later agent plays an earlier agent's audio, or transfers to itself | A stale binding sent the call to the wrong agent's process. Look for `rejecting an INVITE for another extension` in the agent logs, and `[register] clearing old bindings` / `unregister exited` in the run output. |
| Transfer, park or bridge step doesn't happen | Agent logs: `register.and.subscribe.sipp_<pid>_logs.log` (`ATT`, `PARK A`, `3WAY A`, `CHAIN`, `AGENT` lines) and `_errors.log` |
| Caller's sections out of step | The caller log's `FLOW caller:` lines show each re-INVITE and the section it chose |
| Agent B never dials in (park, 3way) | `pickup.log` / `join.log` in the run's work directory |
| No CDRs found | `disposition-calls.js` looks for the caller number since `--since`. Check the CDRs in the portal for that number. |
| Sentiment shows `-` | Transcription and sentiment run after the call. Rerun `disposition-calls.js` later, or check the call in the portal. |
