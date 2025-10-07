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
npm install
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

When a caller connects, the server logs two messages that confirm the model in use:

1. `OpenAI WS connected (requested model: …)` prints as soon as the bridge opens a websocket to the realtime API.
2. `OpenAI session ready … model=…` appears once OpenAI acknowledges the session and echoes back the model that is actually active.

You can view these logs in the terminal where you ran `npm start` (or any other Node process that launched `server.js`). Switching the dropdown in the web UI between the standard and mini models will result in different model IDs in these log lines, letting you verify that the call is really using the selected model.
