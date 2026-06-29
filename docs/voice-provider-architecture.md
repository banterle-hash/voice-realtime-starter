# Voice Provider Architecture

## Goal

Use real phone calls as the evaluation surface for AI voice quality. The core hypothesis is that browser demos hide important failure modes, while PSTN calls expose latency, interruption handling, codec limits, turn-taking, noise, and caller behavior under realistic stress.

## Current App

The current `vas` app is a good prototype harness:

- Twilio handles outbound calls and inbound phone-number routing.
- ngrok exposes the local development server to Twilio.
- The server receives Twilio Media Streams on `/stream`.
- The server bridges Twilio audio to OpenAI Realtime over WebSocket.
- The UI lets a tester pick a prompt, voice, model, and phone number.

This is the right basic shape for a phone-call stress test. The weak point is that OpenAI is hard-coded into `server.js`, so comparing another provider currently means forking or rewriting the bridge.

## What Should Change

Keep the phone harness stable and make the AI provider swappable.

Recommended boundary:

```text
Twilio call
  -> /twiml
  -> /stream
  -> provider adapter
       -> OpenAI Realtime
       -> xAI Grok Voice Agent
```

The Twilio side should not care which model provider is selected. It should only pass normalized call events:

- start session with `{ instructions, provider, model, voice }`
- append caller audio as base64 G.711 u-law
- receive provider audio deltas as base64 G.711 u-law
- close both sockets cleanly
- log timing and errors in a provider-neutral format

## Provider Feasibility

OpenAI: already implemented in this app through `wss://api.openai.com/v1/realtime`.

xAI/Grok: feasible. xAI documents a Voice Agent API over WebSocket at `wss://api.x.ai/v1/realtime?model=grok-voice-latest`, with server-side API key auth, voice selection, server VAD, `audio/pcmu`, and Twilio telephony examples. xAI also documents an OpenAI Realtime migration path where a raw WebSocket integration primarily changes URL, API key, model, and voice.

## xAI/Grok Differences To Handle

Configuration:

- env: `XAI_API_KEY`
- model: `grok-voice-latest` or a pinned voice model
- voices: `eve`, `ara`, `rex`, `sal`, `leo`, or custom voice IDs
- endpoint: `wss://api.x.ai/v1/realtime?model=...`

Session behavior:

- `turn_detection` can use `server_vad`
- `audio/pcmu` is supported, which matches Twilio Media Streams without transcoding
- event flow is mostly OpenAI Realtime-compatible, but some transcription event names differ
- Grok has provider-specific options such as `reasoning.effort`

## Evaluation Features To Add

Minimum useful comparison:

1. Provider selector: OpenAI vs Grok.
2. Provider-specific model and voice selector.
3. Same prompt and same phone number for both providers.
4. Per-call log rows:
   - provider
   - model
   - voice
   - Twilio call SID
   - stream start time
   - provider WebSocket connect time
   - first audio delta time
   - disconnect reason
   - errors
5. Stress-test presets:
   - noisy caller
   - fast interruptions
   - long pause before answer
   - spelling names and order IDs
   - domain jargon
   - frustrated caller

Better comparison:

- Post-call tester scorecard: latency, naturalness, interruption handling, instruction adherence, recovery, overall preference.
- Export results as CSV.
- Paired A/B calls: create a randomized provider order and call one provider at a time so the tester can score each call before dialing the next provider.

## ngrok And Webhooks

For local experiments, ngrok plus Twilio webhooks is acceptable and fast. It is not the production architecture.

Use ngrok when:

- iterating locally
- demoing quickly
- manually testing one Twilio number

Move to a deployed HTTPS service when:

- running repeated comparisons
- sharing with other testers
- keeping inbound call URLs stable
- collecting reliable metrics

Production alternatives:

- Deploy the same Express server to a stable HTTPS host.
- Use Twilio webhook URLs pointing to the deployed host.
- Optionally evaluate OpenAI SIP and xAI SIP-style/Agent Builder paths later, but keep the Twilio Media Streams bridge first because it gives provider-neutral control.

## Recommendation

Do not throw this app away. Use it as the comparison harness, but refactor the bridge now before adding more features.

Next implementation step:

1. Add a real `XAI_API_KEY` and run live Grok calls through the same Twilio number.
2. Run at least five paired OpenAI/Grok phone tests using the stress presets.
3. Export CSV results and compare first-audio timing plus human scorecard ratings.
4. If the local workflow becomes shared or repeated, deploy the Express server to stable HTTPS and move Twilio webhooks off ngrok.
5. If the bridge grows, split `connectOpenAI` and `connectXai` into provider modules.

## Current Completion State

Implemented:

- provider selector
- OpenAI and xAI/Grok realtime adapter paths
- provider-specific model and voice lists
- provider-aware TwiML parameters
- per-call in-memory run log
- timing capture for provider connect and first audio
- human scorecard
- CSV export
- randomized paired A/B flow

Still required for a real comparison:

- valid xAI key in `.env`
- live Grok phone-call verification
- live OpenAI vs Grok paired results from a real handset
