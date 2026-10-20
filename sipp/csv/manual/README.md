# Manual test lab

This is the platform setup that `sipp/scripts/manual_test.sh` expects. Each
`--flow` plays one scripted call, and its agents and audio assume the users,
queues and extensions below. Everything is on the domain **`netsapiens`**.

The devices and DIDs live next to this file:

- `devices.csv`: the three agent devices, with their SIP credentials.
- `phonenumbers.csv`: one DID per flow. The third field is the flow name, and
  `manual_test.sh` picks the DID that matches `--flow`.

## Users

| Extension | Name | Role | Device |
|---|---|---|---|
| 2001 | Priya Shah | **Agent A**, tier-1 support. Answers every queue call. | `2001` |
| 2002 | Marcus Reed | **Agent B**, provisioning and billing. The second agent in every flow. | `2002` |
| 2003 | Dana Ortiz | **Agent C**, network engineering. The third agent in `blind2`. | `2003` |

The names match the voices in the call audio. Each user needs one device with
the extension as its name and the password from `devices.csv`.

The caller is not a user. Calls arrive from the `inbound-carrier` connection
with a random caller ID from `sipp/csv/random_caller_ids.csv`. In the audio,
the caller is Tom Becker from Lakeside Dental.

The roles come from the order of `devices.csv`: the first device is agent A,
the second is B, and the third is C. `--consult <ext>` picks a different agent
B for `attended`, `park` and `3way`.

## Queues

| Queue | Name | Members | Used by |
|---|---|---|---|
| 4000 | Support | **2001 only** | Every DID below |
| 4001 | Provisioning | 2002 | `blind`: agent A blind-transfers the caller here |

Queue 4000 must ring only agent A. Each agent scenario plays a fixed part of
the conversation, so the call has to reach agent A first.

The `blind` flow transfers to the served queue minus one, and 4000 goes to
4001. That rule lives in `sipp_uas_pcap_opus_g711a_fallback.xml`, which is
shared with the cron load.

## Park and conference extensions

| Extension | What | Used by |
|---|---|---|
| 700 | Call park orbit | `park`: agent A REFERs the caller to 700, and agent B dials 700 to pick up. `--park-ext` changes it. |
| 800 | Conference bridge | `3way`: agent A REFERs the caller to 800, then A and B dial 800. `--conf-ext` changes it. |

The bridge must let callers straight in. It can't ask for a PIN, a name
recording or any other prompt, because SIPp can't answer them.

## DIDs

All five DIDs route to queue 4000. Use a DID table entry that sends the call
to `sip:start@call-queuing` with the To rewritten to `4000@netsapiens`, the
same as the existing "DID for Testing".

| DID | Flow | Command |
|---|---|---|
| 1 858-555-1234 | `blind` | `manual_test.sh -s <server>` |
| 1 858-555-1235 | `attended` | `manual_test.sh -s <server> --flow attended` |
| 1 858-555-1236 | `park` | `manual_test.sh -s <server> --flow park` |
| 1 858-555-1237 | `3way` | `manual_test.sh -s <server> --flow 3way` |
| 1 858-555-1238 | `blind2` | `manual_test.sh -s <server> --flow blind2` |

`-n <number>` calls any other DID.

## The flows

| Flow | What happens | Agents | Length | Script |
|---|---|---|---|---|
| `blind` | Priya talks 90s, then blind-transfers the caller to queue 4001. Marcus takes the rest of the call. | 2001, then 2002 via queue 4001 | ~5 min | `audio/call-script.md` |
| `attended` | Priya talks 44s, puts the caller on hold and calls Marcus. They talk 24s, then Priya transfers the caller to him (REFER with Replaces). The caller and Marcus talk 60s. | 2001, 2002 | ~2.5 min | `audio/attended-call-script.md` |
| `park` | Priya talks 44s and parks the caller on 700. 15s later, Marcus dials 700 and talks with the caller for 60s. | 2001, 2002 | ~2 min | `audio/park-call-script.md` |
| `3way` | Priya talks 34s, then moves the caller onto bridge 800 and joins. Marcus dials in 5s later, and all three talk for 46s. | 2001, 2002 | ~1.5 min | `audio/flows/3way.json` |
| `blind2` | Priya talks 34s and blind-transfers the caller to Marcus (2002). Marcus talks 30s and blind-transfers them to Dana (2003). Dana talks 44s. | 2001, 2002, 2003 | ~2 min | `audio/flows/blind2.json` |

The script paths are under `sipp/scripts/`. The two JSON files are the specs
for `audio/generate-flow-pcaps.py`, and they hold the script itself in their
`turns`.

## Setup checklist

1. Create users 2001, 2002 and 2003 with the names above. Give each one a
   device named after its extension, using the password from `devices.csv`.
2. Create queue 4000 (Support) with only 2001 as a member, and queue 4001
   (Provisioning) with 2002.
3. Set up call park so 700 parks a call and dialing 700 picks it up.
4. Create conference bridge 800 with no PIN and no entry prompts.
5. Add the five DIDs to the DID table, all routed to queue 4000.
6. Run each flow once. The banner shows the DID, the agents and the
   extensions it is using.
