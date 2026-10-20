# Load-generator call audio — call park

A ~2-minute support call with a call park, used by `manual_test.sh --flow park`.
Tier-1 agent Priya talks to the caller, then parks the call on 700 with a
blind REFER. After the park time (15s by default), Marcus in billing dials 700
and takes the call.

Each section has its own pair of **time-aligned** tracks. While one speaker
talks, the other track is silent. The sections are padded to the same lengths
as the attended call, so the park caller is `sipp_uac_attended.xml` with these
pcaps swapped in:

| File | Speaker | Length | Played by |
|---|---|---|---|
| `g711a-park-orig.pcap`  | Victor (caller), section 1 | 45s | UAC, from the agent-connect re-INVITE |
| `g711a-park-term.pcap`  | Priya (agent A), section 1 | 45s | `sipp_uas_park.xml`, from the answer; the park REFER follows |
| `g711a-park-orig2.pcap` | Victor, section 2             | 60s | UAC, from the pickup re-INVITE; the caller then hangs up |
| `g711a-park-term2.pcap` | Marcus (agent B), section 2 | 60s | `sipp_uac_agent_dial.xml`, from the pickup 200 |

The caller hears the core's music on hold while parked. No pcap plays for that
gap.

Reference `park-*.wav` files (8 kHz s16, telephony bandpassed) are written next
to this doc.

Generate everything with `generate-park-pcaps.sh`. It needs `DEEPGRAM_API_KEY`
in the environment or in `audio/.env`. On macOS, `TTS=say` renders placeholder
audio with the built-in voices instead. The section lengths are `PARK_AT` and
`TALK2_LEN`. If you change them, change the matching timers in the scenarios.

---

## Section 1 — caller + Priya (0:00 → 0:45, ends at the park)

**Priya:** Thank you for calling Meridian Voice Support, this is Priya. How can I help you today?

**Victor:** Hi Priya, it's Victor Chen at Chen Auto Body. Our invoice this month is about two hundred dollars higher than usual, and I can't tell why.

**Priya:** I can help with that. Can you confirm the main number on the account?

**Victor:** Sure, it's six one nine, five five five, zero one four four.

**Priya:** Let me take a look. I see the account, and there is a new charge for additional phone numbers. Billing questions go to our billing team, and Marcus can walk you through the details.

**Victor:** Okay. Do I need to call a different number?

**Priya:** No, I'll park your call, and Marcus will pick it up in just a moment. You'll hear music while you wait.

**Victor:** Sounds good, thanks.

*— PARK: Priya REFERs Victor to 700; after the park time Marcus dials 700 —*

## Section 2 — caller + Marcus (60s, the caller hangs up)

**Marcus:** Hi Victor, this is Marcus in billing. I just picked up your call from park. You have a question about this month's invoice?

**Victor:** Yes. It's about two hundred dollars higher than usual.

**Marcus:** I see it. Ten new phone numbers were added on the third, and each one has a monthly charge plus a one-time setup fee.

**Victor:** Ten numbers? We only asked for two, for our new front desk staff.

**Marcus:** You're right, the order says two. It looks like the quantity was entered incorrectly. I'm removing the eight extra numbers now, and I'll credit the charges for them.

**Victor:** Great, thank you. Will the credit show up on next month's invoice?

**Marcus:** Yes, it will appear as a separate line item. You'll also get an email confirmation in a few minutes.

**Victor:** One more thing. Can you make sure the two numbers we did order ring the front desk?

**Marcus:** They do. Both are routed to your reception queue, the same as your main number.

**Victor:** Perfect. Thanks for sorting that out, Marcus.

**Marcus:** Happy to help, Victor. Have a great day.

**Victor:** You too. Bye.
