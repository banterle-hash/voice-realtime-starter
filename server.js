// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import twilioPkg from "twilio";
import { Blob } from "buffer";

const app = express();
const server = http.createServer(app);

// --- config/env
const PORT = parseInt(process.env.PORT || "8080", 10);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const DEFAULT_VOICE = process.env.OPENAI_VOICE || "alloy";
const APP_BASE_URL = process.env.APP_BASE_URL || ""; // set by tunnel or CLI script
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const parseCsv = (value = "") =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const TRANSCRIPTION_MODEL_ALLOWLIST = new Set(
  parseCsv(process.env.OPENAI_TRANSCRIPTION_MODELS || "")
);

const modelSupportsInputAudioTranscription = (model) => {
  if (!model) return false;
  if (TRANSCRIPTION_MODEL_ALLOWLIST.size > 0) {
    return TRANSCRIPTION_MODEL_ALLOWLIST.has(model);
  }
  return /^gpt-4o-realtime-preview/.test(model);
};

const MULAW_BIAS = 0x84;
const SAMPLE_RATE_HZ = 8000;

const decodeMuLawSample = (value) => {
  const mu = ~value & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu & 0x70) >> 4;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= MULAW_BIAS;
  if (sign) sample = -sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
};

const decodeMuLawBase64ToPcm16 = (base64) => {
  if (!base64) return null;
  const muLawBuffer = Buffer.from(base64, "base64");
  const pcmBuffer = Buffer.allocUnsafe(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i += 1) {
    const sample = decodeMuLawSample(muLawBuffer[i]);
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  return pcmBuffer;
};

const createWavFromPcmChunks = (pcmChunks, sampleRate = SAMPLE_RATE_HZ) => {
  if (!pcmChunks?.length) return null;
  const data = Buffer.concat(pcmChunks);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

const transcribePostCallAudio = async (pcmChunks) => {
  if (!OPENAI_API_KEY) {
    log("warn", "Cannot transcribe call audio without OPENAI_API_KEY.");
    return null;
  }
  if (!pcmChunks?.length) return null;

  const wavBuffer = createWavFromPcmChunks(pcmChunks);
  if (!wavBuffer) return null;
  if (typeof FormData === "undefined") {
    log("error", "FormData is not available; cannot submit transcription request.");
    return null;
  }

  try {
    const formData = new FormData();
    formData.append("model", OPENAI_TRANSCRIPTION_MODEL);
    formData.append(
      "file",
      new Blob([wavBuffer], { type: "audio/wav" }),
      "call-audio.wav"
    );

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      log(
        "error",
        "Post-call transcription failed:",
        response.status,
        errText
      );
      return null;
    }

    const payload = await response.json();
    const text =
      (typeof payload.text === "string" && payload.text.trim()) ||
      "";
    return text;
  } catch (err) {
    log("error", "Post-call transcription error:", err.message);
    return null;
  }
};

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
const prompts = new Map(); // id -> { instructions, voice, createdAt }
const EXPIRY_MS = 10 * 60 * 1000;

function putPrompt(instructions, voice) {
  const id = crypto.randomUUID();
  prompts.set(id, { instructions, voice, createdAt: Date.now() });
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
    voices: ["alloy","ash","ballad","coral","echo","sage","shimmer","verse"]
  });
});

// --- 1) Create a prompt
app.post("/api/prompts", (req, res) => {
  try {
    let { instructions = "", voice = DEFAULT_VOICE } = req.body || {};
    instructions = String(instructions || "").slice(0, 4000);
    voice = String(voice || DEFAULT_VOICE);
    if (!instructions.trim()) return res.status(400).json({ error: "instructions required" });
    const promptId = putPrompt(instructions, voice);
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
    </Stream>
  </Connect>
  <Pause length="3600"/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- 4) WS bridge: Twilio <Stream> ↔ OpenAI Realtime
const twilioWss = new WebSocketServer({ noServer: true });
twilioWss.on("error", (e) => log("error", "WSS error:", e.message));

// Browser clients subscribe here for live transcripts
const transcriptClients = new Set();
const transcriptWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url || "/", "http://localhost");

  if (pathname === "/stream") {
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/transcripts") {
    transcriptWss.handleUpgrade(req, socket, head, (ws) => {
      transcriptWss.emit("connection", ws, req);
    });
    return;
  }

  socket.destroy();
});

const broadcastTranscriptStatus = (status, extra = {}) => {
  if (!status) return;
  const msg = JSON.stringify({ type: "status", status, ...extra });
  for (const client of transcriptClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(msg);
      } catch {}
    }
  }
};

transcriptWss.on("connection", (client) => {
  transcriptClients.add(client);
  try {
    client.send(JSON.stringify({ type: "status", status: "connected" }));
  } catch {}

  client.on("close", () => transcriptClients.delete(client));
  client.on("error", () => transcriptClients.delete(client));
});

transcriptWss.on("error", (e) => log("error", "Transcript WSS error:", e.message));

const broadcastTranscript = (payload) => {
  const msg = JSON.stringify({ type: "transcript", ...payload });
  for (const client of transcriptClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch {}
    }
  }
};

async function connectOpenAI(instructions, voice) {
  // Compose final instructions: Base Rules + user preset
  const finalInstructions = composeInstructions(instructions);

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };

  const oa = new WebSocket(url, { headers });

  await new Promise((resolve, reject) => {
    oa.once("open", resolve);
    oa.once("error", reject);
  });

  const sessionUpdate = {
    type: "session.update",
    session: {
      type: "realtime",
      model: OPENAI_MODEL,
      output_modalities: ["audio"],
      instructions: finalInstructions,
      audio: {
        input: {
          // Twilio sends 8kHz PCMU μ-law
          format: { type: "audio/pcmu" },
          noise_suppression: { amount: "default" },
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

  if (modelSupportsInputAudioTranscription(OPENAI_MODEL)) {
    sessionUpdate.session.input_audio_transcription = {
      model: OPENAI_TRANSCRIPTION_MODEL
    };
  } else {
    log(
      "debug",
      `Model ${OPENAI_MODEL} does not support input_audio_transcription; skipping.`
    );
  }

  oa.send(JSON.stringify(sessionUpdate));
  // Optional: Kick off a greeting if your base/preset expects it
  oa.send(JSON.stringify({ type: "response.create" }));

  return oa;
}

twilioWss.on("connection", async (twilioWs) => {
  log("info", "Twilio connected to /stream");
  let openaiWs;
  let streamSid = null;
  let callActive = false;
  const userTranscriptionPartials = new Map();
  const inboundAudioPcmChunks = [];
  let postCallTranscriptionStarted = false;

  const textFrom = (value) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => textFrom(v)).join("");
    if (typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (typeof value.transcript === "string") return value.transcript;
      if (typeof value.delta === "string") return value.delta;
      if (typeof value.content === "string") return value.content;
      if (typeof value.value === "string") return value.value;
    }
    return "";
  };

  const userKeyFor = (itemId, contentIndex = 0) =>
    `${itemId || "user"}:${contentIndex ?? 0}`;

  const pushUserTranscriptDelta = ({ itemId, fallbackId, contentIndex = 0, chunk }) => {
    if (!chunk) return;
    const key = userKeyFor(itemId || fallbackId, contentIndex);
    const existing = userTranscriptionPartials.get(key);
    const id = existing?.id || itemId || fallbackId || key;
    const text = (existing?.text || "") + chunk;
    userTranscriptionPartials.set(key, { id, text });
    broadcastTranscript({ role: "user", id, text: chunk, append: true });
  };

  const finalizeUserTranscript = ({
    itemId,
    fallbackId,
    contentIndex = 0,
    finalText
  }) => {
    const key = userKeyFor(itemId || fallbackId, contentIndex);
    const existing = userTranscriptionPartials.get(key);
    const id = existing?.id || itemId || fallbackId || key;
    const text = finalText || existing?.text || "";
    userTranscriptionPartials.delete(key);
    const payload = { role: "user", id, final: true };
    if (text) {
      payload.text = text;
      payload.append = false;
    }
    broadcastTranscript(payload);
  };

  const safeClose = (why) => {
    log("info", "Closing bridge:", why || "");
    try { twilioWs?.close(); } catch {}
    try { openaiWs?.close(); } catch {}
    userTranscriptionPartials.clear();
    if (callActive) {
      callActive = false;
    }
    if (!postCallTranscriptionStarted) {
      postCallTranscriptionStarted = true;
      (async () => {
        try {
          if (inboundAudioPcmChunks.length > 0) {
            broadcastTranscriptStatus("post_call_processing", { streamSid });
            const transcriptText = await transcribePostCallAudio(
              inboundAudioPcmChunks
            );
            inboundAudioPcmChunks.length = 0;
            if (transcriptText) {
              broadcastTranscript({
                role: "user",
                id: "post-call-user",
                text: transcriptText,
                append: false,
                final: true
              });
              broadcastTranscriptStatus("post_call_transcript_ready", {
                streamSid
              });
            } else {
              broadcastTranscriptStatus("post_call_transcription_failed", {
                streamSid
              });
            }
          } else {
            broadcastTranscriptStatus("post_call_transcription_failed", {
              streamSid
            });
          }
        } catch (err) {
          log("error", "Failed post-call transcription:", err.message);
          broadcastTranscriptStatus("post_call_transcription_failed", {
            streamSid
          });
        } finally {
          inboundAudioPcmChunks.length = 0;
          broadcastTranscriptStatus("call_finished", { streamSid });
        }
      })();
    }
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
      const voice = params.voice || DEFAULT_VOICE;

      // Resolve instructions from in-memory store
      const p = promptId ? getPrompt(promptId) : null;
      const instructions = p?.instructions;

      try {
        openaiWs = await connectOpenAI(instructions, voice);
      } catch (e) {
        log("error", "OpenAI connect failed:", e.message);
        return safeClose("openai_connect_error");
      }

      callActive = true;
      broadcastTranscriptStatus("call_started", { streamSid });

      // OpenAI -> Twilio
      openaiWs.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const t = msg.type;

        // Stream model audio to Twilio
        if (t === "response.output_audio.delta" && msg.delta && streamSid) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
          return;
        }
        if (t === "response.output_audio.done" && streamSid) {
          twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `response_done_${Date.now()}` } }));
          return;
        }

        // Live transcription events for the browser UI
        if (t === "response.output_text.delta" && msg.delta) {
          broadcastTranscript({
            role: "agent",
            id: msg.response?.id || msg.response_id || msg.id,
            text: msg.delta,
            append: true
          });
          return;
        }
        if (t === "response.output_text.done") {
          broadcastTranscript({
            role: "agent",
            id: msg.response?.id || msg.response_id || msg.id,
            final: true
          });
          return;
        }
        if (
          t === "conversation.item.input_audio_transcription.delta"
        ) {
          const itemId = msg.item_id || msg.itemId;
          const contentIndex = msg.content_index ?? msg.contentIndex ?? 0;
          const chunk =
            textFrom(msg.delta) ||
            textFrom(msg.transcript) ||
            textFrom(msg.text);
          const fallbackId =
            msg.response?.id ||
            msg.response_id ||
            msg.id;
          pushUserTranscriptDelta({
            itemId,
            contentIndex,
            chunk,
            fallbackId
          });
          return;
        }
        if (
          t === "conversation.item.input_audio_transcription.completed"
        ) {
          const itemId = msg.item_id || msg.itemId;
          const contentIndex = msg.content_index ?? msg.contentIndex ?? 0;
          const finalText =
            textFrom(msg.transcript) ||
            textFrom(msg.text) ||
            textFrom(msg.delta);
          const fallbackId =
            msg.response?.id ||
            msg.response_id ||
            msg.id;
          finalizeUserTranscript({
            itemId,
            contentIndex,
            finalText,
            fallbackId
          });
          return;
        }
        if (
          (t === "response.input_audio_transcription.delta" ||
            t === "input_audio_buffer.transcription.delta") &&
          (msg.delta || msg.transcript)
        ) {
          const chunk =
            textFrom(msg.delta) ||
            textFrom(msg.transcript) ||
            textFrom(msg.text);
          const fallbackId =
            msg.response?.id ||
            msg.response_id ||
            msg.item_id ||
            msg.id;
          pushUserTranscriptDelta({
            itemId: msg.item_id,
            contentIndex: msg.content_index ?? msg.contentIndex ?? 0,
            chunk,
            fallbackId
          });
          return;
        }
        if (
          t === "response.input_audio_transcription.completed" ||
          t === "input_audio_buffer.transcription.completed"
        ) {
          const fallbackId =
            msg.response?.id ||
            msg.response_id ||
            msg.item_id ||
            msg.id;
          const text =
            msg.transcription?.text ||
            msg.response?.input_audio_transcription?.text ||
            textFrom(msg.transcript) ||
            textFrom(msg.text) ||
            textFrom(msg.delta);
          finalizeUserTranscript({
            itemId: msg.item_id,
            contentIndex: msg.content_index ?? msg.contentIndex ?? 0,
            finalText: text,
            fallbackId
          });
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
      const track = data.media.track || "inbound";
      if (track === "inbound") {
        const pcmChunk = decodeMuLawBase64ToPcm16(data.media.payload);
        if (pcmChunk) inboundAudioPcmChunks.push(pcmChunk);
      }
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
