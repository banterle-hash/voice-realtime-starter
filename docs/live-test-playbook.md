# Live Voice Comparison Playbook

## Purpose

Use real phone calls to compare OpenAI Realtime against another realtime voice provider such as Grok Voice. The point is not to make a polished browser demo. The point is to expose phone-call stress: PSTN audio, G.711 u-law, turn-taking, interruptions, silence, noise, and caller impatience.

## What This App Proves

This app is the right prototype architecture when the question is: "Which voice model works better on a real phone call?"

It keeps the test harness stable:

- Twilio owns the phone call.
- ngrok exposes the local server for fast iteration.
- `/twiml` tells Twilio to stream call audio.
- `/stream` bridges Twilio Media Streams to the selected realtime provider.
- The provider selector changes only the AI side, not the telephony side.
- Runs, pair IDs, stress scenarios, timing, scores, and CSV export create comparison evidence.

This app does not prove production readiness by itself. For repeated tests with multiple users, deploy the same server to stable HTTPS and point Twilio webhooks there instead of ngrok.

## Required Keys

Required for OpenAI calls:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-realtime
OPENAI_VOICE=alloy
```

Required for Grok calls:

```env
XAI_API_KEY=xai-...
XAI_MODEL=grok-voice-latest
XAI_VOICE=eve
```

Required for outbound phone calls:

```env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1...
```

Recommended for local public URLs:

```env
NGROK_AUTHTOKEN=...
```

## Start A Local Test Session

From the configured app folder:

```bash
cd voice-realtime-starter
npm run preflight
npm run start:ngrok
```

`npm run preflight` does not contact OpenAI, xAI, Twilio, or ngrok's network. It checks whether `.env`, the provider keys, Twilio credentials, the Twilio from number, ngrok CLI/auth, and the local app port are ready for a live paired comparison. It should pass before you run OpenAI-vs-Grok phone tests.

The script prints:

- public app URL
- Twilio Voice webhook URL ending in `/twiml`

Open the public app URL in the browser for outbound tests.

For inbound tests, set the Twilio phone number voice webhook to:

```text
POST https://<ngrok-host>/twiml
```

ngrok URLs change between runs unless a reserved domain is configured. Update the Twilio webhook each time the URL changes.

## Run A Paired A/B Test

1. Pick a stress scenario in the UI.
2. Click `Use scenario` so the scenario instructions become part of the prompt.
3. Add task-specific prompt instructions.
4. Enter the tester phone number.
5. Click `Create pair`.
6. Click `Call next`.
7. Take the phone call and behave according to the selected stress scenario.
8. Score the run before calling the next provider.
9. Click `Call next` again for the other provider.
10. Score the second run.
11. Export CSV.

The pair randomizes provider order to reduce ordering bias. The CSV includes `pairId`, `scenarioId`, and `scenarioLabel` so the two calls can be compared as one test unit.

## Stress Scenarios

Use the built-in scenarios consistently:

- `interruptions`: interrupt the assistant mid-answer twice.
- `noisy_caller`: speak from a noisy environment or simulate background noise.
- `spelling_ids`: spell names, email, and order IDs over the phone.
- `long_pause`: pause long enough to test whether the assistant speaks too soon.
- `frustrated`: use impatient wording and ask for concrete next steps.
- `domain_jargon`: use jargon and check whether the assistant asks clarifying questions.

For a credible pitch, run at least five paired calls. Prefer the same tester, same phone, same physical environment, and same scenario for each pair.

## Scorecard

Score 1-5 immediately after each call:

- `latency`: how responsive the assistant felt.
- `naturalness`: how human and phone-appropriate it sounded.
- `interruptions`: whether it stopped and recovered when interrupted.
- `instructionAdherence`: whether it followed the prompt and scenario.
- `recovery`: whether it handled errors, ambiguity, and repeated information.
- `overall`: which provider you would choose for a real user.

Use notes for concrete failures. Good notes sound like:

- "Talked over caller during second interruption."
- "Repeated order ID correctly but confused B and D."
- "Waited too long after silence."
- "Recovered cleanly after correction."

## Evidence To Collect

A useful pitch should include:

- exported CSV from `/api/runs.csv`
- at least five paired runs
- same stress scenario per pair
- provider/model/voice for each run
- `firstAudioMs` and `connectMs`
- scorecard values
- concise notes with concrete observed behavior

Do not rely only on subjective preference. Use both timing and scorecard data.

## Architecture Decision

Keep this architecture for prototype evaluation if:

- tests are local or run by one operator
- ngrok URL churn is acceptable
- one Twilio number is enough
- in-memory run history is acceptable during a session

Move to a deployed service if:

- several people need to test
- Twilio webhook URLs must stay stable
- results need to persist between restarts
- you need authentication or shared exports
- you want repeatable scheduled evaluations

The current bridge is intentionally provider-neutral. Twilio remains the fixed phone harness; OpenAI and Grok are interchangeable realtime providers behind `/stream`.

## Known Current Gap

Grok calls require a valid `XAI_API_KEY`. Without it, the app will still create pairs and log a blocked/error state, but it will not complete a live Grok provider call.
