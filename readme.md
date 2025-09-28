# Realtime Voice — Prompted Call (Local + ngrok)

A tiny starter that lets anyone paste **custom instructions**, choose a **voice**, and receive a **phone call** powered by **OpenAI Realtime**. It works locally with **ngrok** and supports both **outbound** (Call me) and **inbound** (call your own Twilio number) flows. No databases, no recordings—pure demo.

## Prereqs
- Node 20+
- OpenAI API key
- ngrok CLI (v3+): `brew install ngrok && ngrok config add-authtoken <TOKEN>`
- Twilio account + voice-enabled number (required for outbound and phone call-in)

## Setup
```bash
cp .env.example .env   # or: npm run setup (guided)
npm i
npm run start:ngrok    # prints the public https URL; open it
```

## Optional model feature allowlists

Some realtime capabilities are only available on certain models. To avoid
unexpected errors you can opt-in model IDs via environment variables (comma
separated):

| Variable | Purpose |
| --- | --- |
| `OPENAI_TRANSCRIPTION_MODELS` | Enables `input_audio_transcription` when the selected realtime model is included. Leave empty to fall back to the default detection for `gpt-4o-realtime-preview*`. |
| `OPENAI_NOISE_SUPPRESSION_MODELS` | Enables `session.audio.input.noise_suppression` for the listed realtime models. Leave empty to allow the default `gpt-4o-realtime-preview*` detection. |

Define these in your `.env` (see `.env.example`) when using compatible models to
activate the corresponding features.
