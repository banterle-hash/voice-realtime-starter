# Realtime Voice — Prompted Call (Local + ngrok)

A tiny starter that lets anyone paste **custom instructions**, choose a **voice**, and receive a **phone call** powered by **OpenAI Realtime**. It works locally with **ngrok** and supports both **outbound** (Call me) and **inbound** (call your own Twilio number) flows. No databases, no recordings—pure demo.

## Prereqs
- Node 20+
- An OpenAI API key
- ngrok account (recommended)
- Twilio account + a voice-enabled number (only if you want outbound calls)

## Setup
```bash
cp .env.example .env   # or run the interactive setup
npm run setup          # guided prompts for OpenAI/Twilio/ngrok
npm i
npm run start:ngrok
