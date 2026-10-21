# Load-generator call audio — direct line (recorded, not transcribed)

A call of under a minute to an account manager's own number, used by
`manual_test.sh --flow direct`. Lena Brooks dials Owen Hale's direct line
(1 858-555-1309, routed straight to user 2004, no queue). Owen is recorded
without transcription (`recording-configuration: yes`), so this call tests
transcribing a recording after the fact. The script is short and full of
names and numbers, which makes a transcript easy to check against it.

| File | Speaker | Length | Played by |
|---|---|---|---|
| `g711a-direct-orig1.pcap` | Lena (caller) | 52s | UAC (`sipp_uac_flow.xml`, direct mode: starts on the answer) |
| `g711a-direct-term1.pcap` | Owen (2004)   | 52s | UAS `sipp_uas_direct.xml`, from the answer; then waits for the caller's BYE |

The speech is 41s; both tracks are padded to 52s, and the caller hangs up at
the end. With ringing, the whole call is under a minute.

The source is `flows/direct.json` (voices: Lena `aura-hera-en`, Owen
`aura-orpheus-en`). Regenerate the audio with
`./generate-flow-pcaps.py flows/direct.json` and the agent scenario with
`../gen-agent-scenario.py audio/flows/direct.json` (from `sipp/scripts`).

---

**Owen:** Good morning, this is Owen Hale at Meridian Voice.

**Lena:** Hi Owen, it's Lena Brooks from Sunrise Bakery. I'm calling about the extra phone we talked about last week.

**Owen:** Of course, Lena. I have the order here. One desk phone for your back office, on extension one oh four.

**Lena:** That's right. Can it ring along with the front counter when we're busy?

**Owen:** Yes. I'll add it to the counter ring group, so both phones ring together.

**Lena:** Perfect. When will it arrive?

**Owen:** It ships tomorrow and should be there Thursday. Your order number is four four seven one two.

**Lena:** Four four seven one two. Got it. Thanks, Owen.

**Owen:** You're welcome, Lena. Have a great day.

**Lena:** You too. Bye.
