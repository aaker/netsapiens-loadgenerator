# Load-generator call audio — supervised (attended) transfer

A ~2-minute support call with a supervised transfer, used by
`manual_test.sh --flow attended` (`sipp_uac_attended.xml` and
`sipp_uas_attended.xml`). Tier-1 agent Priya talks to the caller, puts them
on hold, calls Marcus in provisioning, briefs him, and then transfers the
caller to him with a REFER carrying `Replaces`.

Each section has its own pair of **time-aligned** tracks. While one speaker
talks, the other track is silent, so playing a pair at the same time recreates
the conversation with no talk-over. Every section is padded to a fixed length,
and the scenario timers use those lengths:

| File | Speaker | Length | Played by |
|---|---|---|---|
| `g711a-att-orig.pcap`      | Tom (caller), section 1    | 44s | UAC, from the agent-connect re-INVITE |
| `g711a-att-term.pcap`      | Priya (agent A), section 1 | 44s | UAS role A, from the answer; the hold follows |
| `g711a-att-consult-a.pcap` | Priya, consult             | 24s | UAS role A, from the consult 200; the REFER follows |
| `g711a-att-consult-b.pcap` | Marcus (agent B), consult  | 24s | UAS role B, from the answer |
| `g711a-att-orig2.pcap`     | Tom, section 3             | 60s | UAC, from the merge; the caller then hangs up |
| `g711a-att-term2.pcap`     | Marcus, section 3          | 60s | UAS role B, from the merge |

The caller is silent while on hold: `att-orig` ends at the hold, and
`att-orig2` starts at the merge.

Reference `att-*.wav` files (8 kHz s16, telephony bandpassed) are written next
to this doc.

Generate everything with `generate-attended-pcaps.sh`. It needs
`DEEPGRAM_API_KEY` in the environment or in `audio/.env`. On macOS,
`TTS=say` renders placeholder audio with the built-in voices instead. The
section lengths are `HOLD_AT`, `CONSULT_LEN` and `TALK2_LEN`. If you change
them, change the matching timers in both scenarios. The generator warns when a
section's speech runs past its length.

---

## Section 1 — caller + Priya (0:00 → 0:44, ends at the hold)

**Priya:** Thank you for calling Meridian Voice Support, this is Priya. How can I help you today?

**Tom:** Hi Priya, it's Tom Becker at Lakeside Dental. Since this morning, every call to our main number goes straight to voicemail instead of ringing the front desk.

**Priya:** I'm sorry about that, Tom. Let me pull up the account. I have the main number as six one nine, five five five, zero one four four. Is that right?

**Tom:** That's the one. As far as I know, nobody here changed anything.

**Priya:** I can see the answering rules were edited early this morning. Routing changes are handled by our provisioning team, so I'd like Marcus to look at this with you. Let me place you on a brief hold while I fill him in.

**Tom:** Sure, I'll hold.

*— HOLD: Priya re-INVITEs Tom with a=sendonly and calls Marcus —*

## Section 2 — consult, Priya + Marcus (24s, Tom on hold)

**Marcus:** Provisioning, this is Marcus.

**Priya:** Hi Marcus, it's Priya. I have Tom Becker from Lakeside Dental on hold. Their main number started going straight to voicemail this morning, and the answering rules were edited at six a m.

**Marcus:** Okay, I see the edit on the account. I can take it from here.

**Priya:** Great, I'll connect him now. Thanks, Marcus.

*— MERGE: Priya sends REFER with Replaces; Tom is connected to Marcus —*

## Section 3 — caller + Marcus (60s, the caller hangs up)

**Marcus:** Hi Tom, this is Marcus in provisioning. Priya filled me in on the voicemail problem.

**Tom:** Thanks, Marcus. Our patients can't reach the front desk at all.

**Marcus:** I see what happened. Your after-hours schedule was set to stay active all day, so every call goes to voicemail. I'm switching it back to your normal business hours now.

**Tom:** Do you know who changed it?

**Marcus:** It was edited from the admin portal at six this morning. It looks like someone was setting up a holiday schedule. I'd check with whoever manages your portal login.

**Tom:** That might have been our office administrator. I'll ask them.

**Marcus:** Okay, the schedule is fixed. Can you call your main number from a cell phone so we can test it?

**Tom:** Calling now. And the front desk phones are ringing. That's working again.

**Marcus:** Perfect. I've added a note to your account, so if it happens again, anyone on our team can see the history.

**Tom:** Great. Thank you, Marcus, that was quick.

**Marcus:** Happy to help, Tom. Have a good rest of your day.

**Tom:** You too. Bye.
