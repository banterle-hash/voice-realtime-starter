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
