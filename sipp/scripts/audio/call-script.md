# Load-generator call audio — simulated support call with a transfer

Three-party, ~5-minute support call used as the G.711a RTP audio for the SIPp
load scenarios. It models the platform's actual call flow: the caller reaches
tier-1 support, and at **90 seconds** the call is transferred (the UAS
scenario REFERs to a neighbouring queue at the 90s mark) to a provisioning
specialist who handles the rest of the call.

It renders to four **time-aligned** mono tracks, one per call leg, each
starting at its own t=0:

| File | Speaker | Length | Played by |
|---|---|---|---|
| `g711a-silence.pcap` | silence (A-law 0xD5)   | 90s         | UAC: pre-agent stage (AA/MOH) - RTP must flow but no agent is listening yet |
| `g711a-orig.pcap`  | Tom (caller), segment 1  | exactly 90s | UAC: first agent leg (talk_leg, `reinvite_legs` = 1) |
| `g711a-orig2.pcap` | Tom (caller), segment 2  | ~3.5 min    | UAC: legs after a transfer (`reinvite_legs` >= 2) |
| `g711a-term.pcap`  | Priya (tier-1 agent)     | exactly 90s | UAS: answers the initial call, REFERs at 90s |
| `g711a-term2.pcap` | Marcus (provisioning)    | ~3.5 min    | UAS: the leg answering the transferred call |
| `opus-term.pcap`   | Priya (OPUS PT 121)      | exactly 90s | UAS scenarios that negotiate OPUS |
| `opus-term2.pcap`  | Marcus (OPUS PT 121)     | ~3.5 min    | OPUS transferred-call leg |

Because each track is silent while the other party speaks, playing an
orig/term pair simultaneously (what a connected call leg does) reproduces the
conversation with **no talk-over**. Segment 1 is padded with silence up to
the 90s transfer point, so `orig`/`term` end exactly when the REFER fires.

Reference `call-{orig,orig2,term,term2}.wav` files (8 kHz s16, telephony
bandpassed) are written next to this doc for auditioning or `rtp_stream` use.

Generate everything with `generate-call-pcaps.sh` (requires
`DEEPGRAM_API_KEY`). Voices (Deepgram Aura, swap freely in the script):

- Caller = `aura-orion-en` (Tom, male)
- Agent 1 = `aura-asteria-en` (Priya, female)
- Agent 2 = `aura-arcas-en` (Marcus, male)

> The UAS scenarios cannot currently tell a fresh call from a transferred one
> (every answered call plays `g711a-term.pcap`). If the platform marks
> transferred INVITEs (e.g. `Diversion:` / `Referred-By:`), an `ereg` branch in
> `sipp_uas_pcap_opus_g711a_fallback.xml` could select `g711a-term2.pcap` for
> those legs.

---

## Segment 1 — caller + tier-1 (0:00 → 1:30, ends at the transfer)

**Priya (agent 1):** Thank you for calling Meridian Voice Support, this is Priya. How can I help you today?

**Tom (caller):** Hi Priya, this is Tom Becker, office manager at Lakeside Dental. We hired two new front desk coordinators this week, and I need to get them set up on our phone system.

**Priya:** I can certainly get that started, Tom. Let me verify the account first. Can you give me the main number on the account?

**Tom:** Sure, it's six one nine, five five five, zero one four four.

**Priya:** Thank you. And just to confirm, I'm showing the account under Lakeside Dental Group on Harbor Boulevard, is that right?

**Tom:** That's us. We'd also like to change how the front desk queue rings, if that's possible today.

**Priya:** Absolutely. New user setup and queue changes are handled by our provisioning team, so I'll get you over to a specialist who can do both while you're on the line.

**Tom:** Great. Will I need to repeat all my information, or do you pass that along?

**Priya:** I'm attaching my notes to the ticket right now, so they'll see everything. Your account, the two new hires, and the queue request.

**Tom:** Perfect, thank you.

**Priya:** You're welcome, Tom. Stay on the line for just a moment while I transfer you to Marcus in provisioning. He'll take great care of you.

**Tom:** Sounds good, thanks Priya.

*— TRANSFER at 1:30 (silence pads the remainder of both segment-1 tracks) —*

## Segment 2 — caller + provisioning (own t=0, ~3.5 min)

**Marcus (agent 2):** Hi, this is Marcus with provisioning. Am I speaking with Tom from Lakeside Dental?

**Tom:** That's me. Hopefully Priya sent over the details?

**Marcus:** She did, I have the ticket right here. Two new front desk coordinators to set up, and some changes to your reception queue. Let's start with the new users. Can you give me their names?

**Tom:** The first is Maria Delgado, that's D E L G A D O. The second is James Whitfield, W H I T F I E L D.

**Marcus:** Got it. I see extensions one oh six and one oh seven are free, so I'll put Maria on one oh six and James on one oh seven.

**Tom:** That works. They each have a desk phone already. We pulled two spares out of the storage closet, same model as everyone else's.

**Marcus:** Even easier. Once I finish, just plug each phone into the network and power it on. It will pull its configuration automatically, and the extension number will show on the screen when it's ready.

**Tom:** Okay, that's simpler than I expected. What do they do for voicemail?

**Marcus:** I'm setting a temporary PIN for each of them now, and they'll be prompted to change it the first time they dial in. Do you want their voicemails delivered to email as well, like the rest of your staff?

**Tom:** Yes please. Use m delgado at lakeside dental dot com, and j whitfield at the same domain.

**Marcus:** Both are in. Now, the queue. I'm opening your reception queue, and right now it rings extensions one oh one and one oh two together, then overflows to your line after twenty seconds.

**Tom:** Right, and that's the problem. We want all four front desk extensions in there, but when every phone rings at once it gets chaotic up front.

**Marcus:** Understood. I can switch the queue from ring-all to round robin. It rings whoever has been idle the longest first, then moves to the next agent if there's no answer after fifteen seconds.

**Tom:** Round robin sounds much better. Fifteen seconds per agent is fine.

**Marcus:** Done. All four front desk extensions are in the rotation, round robin, fifteen second timeout, and the overflow to your line stays as the final step.

**Tom:** Great. One more thing, while you're in there. Our after-hours greeting is out of date, it still has our old Saturday hours.

**Marcus:** I see it, that recording is from last year. I'll flag it for a re-recording on this same ticket so it doesn't get lost.

**Tom:** Appreciate it. Our Saturday hours changed back in March, so I'll record a new greeting this week.

**Marcus:** Sounds good. Alright, everything is provisioned. Can you plug in one of the new phones now so we can do a quick live test?

**Tom:** Give me a second. Okay, Maria's phone is booting, it says updating configuration. There we go, extension one oh six is on the screen.

**Marcus:** I can see it registered on my end too. I'm sending a test call into the queue now. It should ring the longest idle phone first.

**Tom:** It's ringing on Maria's phone right now. I'll let it time out. And there it goes, it just rolled over to the next desk. That's exactly what we wanted.

**Marcus:** Perfect, round robin is doing its job. You'll get a summary email with the new extensions, the voicemail settings, and the greeting reminder.

**Tom:** One last thing. If James's phone gives us any trouble tomorrow, do I call this same number?

**Marcus:** Yes, same number, and reference ticket four seven two one five. Anyone on my team can pick it right up from the notes.

**Tom:** Ticket four seven two one five, got it. You've both made this really painless today. Thanks, Marcus.

**Marcus:** My pleasure, Tom. Welcome aboard to Maria and James, and thanks for calling Meridian Voice. Have a great day.

---

The authoritative copy of these lines lives in `generate-call-pcaps.sh` (the
`turns` array) — edit there so the audio stays in sync with this doc.
