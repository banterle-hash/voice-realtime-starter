# Realtime Voice — Prompted Call (Local + ngrok)

A tiny starter that lets anyone paste **custom instructions**, choose a **voice**, and receive a **phone call** powered by **OpenAI Realtime**. It works locally with **ngrok** and supports both **outbound** (Call me) and **inbound** (call your own Twilio number) flows. No databases, no recordings—pure demo.

### Transcription flow
- During the call the UI shows connection status updates.
- When the call ends, the server assembles the caller's μ-law audio stream, converts it to linear PCM, and sends it to the OpenAI transcription endpoint.
- Once the transcription is returned, the complete post-call transcript appears in the dashboard (instead of incremental realtime captions).
- Configure the transcription model with `OPENAI_TRANSCRIPTION_MODEL` if you prefer something other than the default `gpt-4o-mini-transcribe`.

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
