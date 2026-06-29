# Voice Realtime Comparison — Prompted Call (Local + ngrok)

A tiny harness that lets anyone paste **custom instructions**, choose a **voice provider**, and receive a **phone call** powered by a realtime voice model. It works locally with **ngrok** and supports both **outbound** (Call me) and **inbound** (call your own Twilio number) flows. No databases, no recordings.

The current provider adapters are:

- OpenAI Realtime
- Grok Voice via xAI Voice Agent API

## Prereqs
- Node 20+
- OpenAI API key and/or xAI API key
- ngrok CLI (v3+): `brew install ngrok && ngrok config add-authtoken <TOKEN>`
- Twilio account + voice-enabled number (required for outbound and phone call-in)

## Setup
```bash
cp .env.example .env   # or: npm run setup (guided)
npm install
npm run smoke          # optional local verification, no phone call
npm run preflight      # checks live OpenAI/Grok/Twilio/ngrok readiness
npm run start:ngrok    # prints the public https URL; open it
```

## Update your local copy after someone else merges changes

Already cloned the repo and just need the latest code? Use these short steps:

1. Check that you do not have local edits you still need:
   ```bash
   git status
   ```
2. Download the newest commits from GitHub:
   ```bash
   git fetch origin
   ```
3. Move your branch forward (swap `main` for the branch you track if different):
   ```bash
   git pull origin main
   ```
4. Your `.env` file and installed packages stay local. Refresh them only if needed:
   ```bash
   npm install        # picks up any dependency changes
   cp .env.example .env  # only if you need to recreate the local secrets file
   ```

## Confirm which realtime model a call is using

When a caller connects, the server logs messages that confirm the provider and model in use:

1. `Provider connected provider=... model=... voice=...` prints once the bridge opens a websocket to the realtime API.
2. `Provider session ready provider=... model=...` appears once the provider acknowledges the session and echoes back the active model, when available.
3. `First provider audio provider=... firstAudioMs=...` gives a first-response timing signal for comparison.

You can view these logs in the terminal where you ran `npm start` or `npm run start:ngrok`. Switching the provider/model dropdowns in the web UI changes the provider and model shown in these logs.

## Architecture notes

See `docs/voice-provider-architecture.md` for the provider-comparison architecture. See `docs/live-test-playbook.md` for the operator checklist used to run paired phone-call evaluations.
