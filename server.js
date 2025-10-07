// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import twilioPkg from "twilio";

const app = express();
const server = http.createServer(app);

// --- config/env
const PORT = parseInt(process.env.PORT || "8080", 10);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const DEFAULT_VOICE = process.env.OPENAI_VOICE || "alloy";
const APP_BASE_URL = process.env.APP_BASE_URL || ""; // set by tunnel or CLI script
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const MODEL_OPTION_DESCRIPTORS = [
  { id: DEFAULT_MODEL, label: "Standard" },
  { id: "gpt-realtime-mini-2025-10-06", label: "Realtime Mini (2025-10-06)" }
];
const MODEL_OPTIONS = [];
const SEEN_MODELS = new Set();
for (const opt of MODEL_OPTION_DESCRIPTORS) {
  if (!opt?.id || SEEN_MODELS.has(opt.id)) continue;
  SEEN_MODELS.add(opt.id);
  MODEL_OPTIONS.push({ id: opt.id, label: opt.label || opt.id });
}
const MODEL_IDS = MODEL_OPTIONS.map((opt) => opt.id);

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// --- logging helper
const log = (level, ...args) => {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if (order[level] >= order[LOG_LEVEL]) {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
  }
};

if (!OPENAI_API_KEY) log("warn", "OPENAI_API_KEY is not set. Set it in .env");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- In-memory prompt store (10 min)
const prompts = new Map(); // id -> { instructions, voice, model, createdAt }
const EXPIRY_MS = 10 * 60 * 1000;

function putPrompt(instructions, voice, model) {
  const id = crypto.randomUUID();
  prompts.set(id, { instructions, voice, model, createdAt: Date.now() });
  return id;
}
function getPrompt(id) {
  const p = prompts.get(id);
  if (!p) return null;
  if (Date.now() - p.createdAt > EXPIRY_MS) {
    prompts.delete(id);
    return null;
  }
  return p;
}

// --- Base Rules always applied (then layered with user preset)
const BASE_RULES = `
You are a voice assistant on a phone call.
• Language: English only. If the caller uses another language, politely state that you currently support English only.
• Turn-taking: Do not talk over the caller. Pause and listen after each sentence. Wait ~0.6–1.0 seconds of silence before speaking.
• Brevity: Keep responses to 1–2 short sentences. Prefer concise, concrete guidance.
• Confirmation: If a question is ambiguous, ask a brief clarifying follow-up before answering.
• Empathy & tone: Friendly, calm, and professional; avoid filler words.
• If you don’t know, say so briefly and suggest a next step.
`.trim();

function composeInstructions(userInstructions) {
  const preset = String(userInstructions || "").trim();
  return `${BASE_RULES}${preset ? `\n\nCaller-specific instructions:\n${preset}` : ""}`;
}

// --- health
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// --- tiny config endpoint for UI (host + call-in number)
app.get("/api/config", (req, res) => {
  const base = (APP_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
  res.json({
    baseUrl: base,
    twilioFrom: TWILIO_FROM || null,
    voices: ["alloy","ash","ballad","coral","echo","sage","shimmer","verse"],
    models: MODEL_OPTIONS,
    defaultModel: DEFAULT_MODEL
  });
});

// --- 1) Create a prompt
app.post("/api/prompts", (req, res) => {
  try {
    let { instructions = "", voice = DEFAULT_VOICE, model = DEFAULT_MODEL } = req.body || {};
    instructions = String(instructions || "").slice(0, 4000);
    voice = String(voice || DEFAULT_VOICE);
    model = String(model || DEFAULT_MODEL);
    if (!instructions.trim()) return res.status(400).json({ error: "instructions required" });
    if (!MODEL_IDS.includes(model)) return res.status(400).json({ error: "unsupported model" });
    const promptId = putPrompt(instructions, voice, model);
    res.json({ promptId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 2) Start an outbound call (optional "Call me")
app.post("/api/call", async (req, res) => {
  if (!twilioClient) return res.status(400).json({ error: "Twilio not configured. Set TWILIO_* in .env" });

  const { to, promptId } = req.body || {};
  if (!to || !promptId) return res.status(400).json({ error: "to and promptId required" });
  if (!/^\+\d{10,15}$/.test(String(to))) return res.status(400).json({ error: "Invalid E.164 number" });

  const p = getPrompt(promptId);
  if (!p) return res.status(404).json({ error: "promptId not found or expired" });

  const base = APP_BASE_URL || `https://${req.headers.host}`;
  const url = `${base.replace(/\/$/, "")}/twiml?promptId=${encodeURIComponent(promptId)}`;

  try {
    const r = await twilioClient.calls.create({
      to,
      from: TWILIO_FROM,
      url,
      method: "POST"
    });
    log("info", "Placed call SID:", r.sid);
    res.json({ ok: true, sid: r.sid });
  } catch (e) {
    log("error", "Twilio create call failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- 3) Twilio requests TwiML to start the media stream (POST/GET)
app.all("/twiml", (req, res) => {
  const promptId =
    (req.method === "POST" ? req.body?.promptId : req.query?.promptId) || req.query?.promptId;

  const p = getPrompt(String(promptId || ""));
  if (!p) {
    return res
      .type("text/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Prompt expired or not found. Please try again.</Say>
</Response>`
      );
  }

  const host = (APP_BASE_URL || `https://${req.headers.host}`).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const streamUrl = `wss://${host}/stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="promptId" value="${promptId}"/>
      <Parameter name="voice" value="${p.voice || DEFAULT_VOICE}"/>
      <Parameter name="model" value="${p.model || DEFAULT_MODEL}"/>
    </Stream>
  </Connect>
  <Pause length="3600"/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- 4) WS bridge: Twilio <Stream> ↔ OpenAI Realtime
const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("error", (e) => log("error", "WSS error:", e.message));

async function connectOpenAI(instructions, voice, model) {
  // Compose final instructions: Base Rules + user preset
  const finalInstructions = composeInstructions(instructions);
  const chosenModel = MODEL_IDS.includes(model) ? model : DEFAULT_MODEL;

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(chosenModel)}`;
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };

  const oa = new WebSocket(url, { headers });

  await new Promise((resolve, reject) => {
    oa.once("open", resolve);
    oa.once("error", reject);
  });

  log("info", `OpenAI WS connected (requested model: ${chosenModel})`);

  const sessionUpdate = {
    type: "session.update",
    session: {
      type: "realtime",
      model: chosenModel,
      output_modalities: ["audio"],
      instructions: finalInstructions,
      audio: {
        input: {
          // Twilio sends 8kHz PCMU μ-law
          format: { type: "audio/pcmu" },
          // Turn-taking: a bit more sensitive + longer silence before response
          turn_detection: {
            type: "server_vad",
            threshold: 0.4,
            prefix_padding_ms: 500,
            silence_duration_ms: 400
          }
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: voice || DEFAULT_VOICE,
          speed: 1.0
        }
      }
    }
  };

  oa.send(JSON.stringify(sessionUpdate));
  // Optional: Kick off a greeting if your base/preset expects it
  oa.send(JSON.stringify({ type: "response.create" }));

  return oa;
}

wss.on("connection", async (twilioWs) => {
  log("info", "Twilio connected to /stream");
  let openaiWs;
  let streamSid = null;

  const safeClose = (why) => {
    log("info", "Closing bridge:", why || "");
    try { twilioWs?.close(); } catch {}
    try { openaiWs?.close(); } catch {}
  };

  // Twilio -> Server
  twilioWs.on("message", async (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    const evt = data.event;

    if (data.streamSid && !streamSid) {
      streamSid = data.streamSid;
      log("info", "Latched streamSid:", streamSid);
    }

    if (evt === "start") {
      // Extract custom parameters (promptId, voice) placed in TwiML
      const params = data.start?.customParameters || {};
      const promptId = params.promptId;
      const modelParam = params.model;

      // Resolve instructions from in-memory store
      const p = promptId ? getPrompt(promptId) : null;
      const instructions = p?.instructions;
      const voice = p?.voice || params.voice || DEFAULT_VOICE;
      const model = p?.model || modelParam || DEFAULT_MODEL;

      try {
        openaiWs = await connectOpenAI(instructions, voice, model);
      } catch (e) {
        log("error", "OpenAI connect failed:", e.message);
        return safeClose("openai_connect_error");
      }

      // OpenAI -> Twilio
      openaiWs.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const t = msg.type;

        if (t === "session.created" || t === "session.updated") {
          const activeModel = msg?.session?.model || msg?.model;
          const sessionId = msg?.session?.id || msg?.id;
          log(
            "info",
            "OpenAI session ready",
            sessionId ? `(sessionId: ${sessionId})` : "",
            activeModel ? `model=${activeModel}` : ""
          );
          return;
        }

        // Stream model audio to Twilio
        if (t === "response.output_audio.delta" && msg.delta && streamSid) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
          return;
        }
        if (t === "response.output_audio.done" && streamSid) {
          twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `response_done_${Date.now()}` } }));
          return;
        }
        if (t === "error") {
          // Ignore benign "response_cancel_not_active" if it ever appears;
          // just log and continue instead of tearing down the bridge.
          const code = msg?.error?.code || msg?.code;
          if (code === "response_cancel_not_active") {
            log("warn", "Non-fatal:", JSON.stringify(msg));
            return;
          }
          log("error", "OpenAI error:", JSON.stringify(msg.error || msg));
          safeClose("openai_error");
        }
      });

      openaiWs.on("close", (code, reason) => { log("info", "OpenAI WS closed:", code, reason?.toString() || ""); safeClose("openai_closed"); });
      openaiWs.on("error", (e) => { log("error", "OpenAI WS error:", e.message); safeClose("openai_ws_error"); });

      return;
    }

    // Caller media (8kHz PCMU base64) -> Realtime input buffer
    if (evt === "media" && data.media?.payload) {
      try {
        openaiWs?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
      } catch {}
      return;
    }

    if (evt === "stop") {
      return safeClose("twilio_stop");
    }
  });

  twilioWs.on("close", (code, reason) => { log("info", "Twilio WS closed:", code, reason?.toString() || ""); safeClose("twilio_closed"); });
  twilioWs.on("error", (e) => { log("error", "Twilio WS error:", e.message); safeClose("twilio_ws_error"); });
});

server.listen(PORT, "0.0.0.0", () => {
  log("info", `Server listening on ${PORT}`);
  log("info", `APP_BASE_URL: ${APP_BASE_URL || "(not set; use tunnel CLI script)"}`);
});
