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
const XAI_API_KEY = process.env.XAI_API_KEY;
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || "openai";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const DEFAULT_OPENAI_VOICE = process.env.OPENAI_VOICE || "alloy";
const DEFAULT_XAI_MODEL = process.env.XAI_MODEL || "grok-voice-latest";
const DEFAULT_XAI_VOICE = process.env.XAI_VOICE || "eve";
const APP_BASE_URL = process.env.APP_BASE_URL || ""; // set by tunnel or CLI script
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
const XAI_VOICES = ["eve", "ara", "rex", "sal", "leo"];
const EFFECTIVE_OPENAI_VOICE = OPENAI_VOICES.includes(DEFAULT_OPENAI_VOICE) ? DEFAULT_OPENAI_VOICE : "alloy";
const EFFECTIVE_XAI_VOICE = XAI_VOICES.includes(DEFAULT_XAI_VOICE) ? DEFAULT_XAI_VOICE : "eve";

function uniqueOptions(options) {
  const seen = new Set();
  return options.filter((opt) => {
    if (!opt?.id || seen.has(opt.id)) return false;
    seen.add(opt.id);
    return true;
  });
}

const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI Realtime",
    configured: Boolean(OPENAI_API_KEY),
    defaultModel: DEFAULT_OPENAI_MODEL,
    defaultVoice: EFFECTIVE_OPENAI_VOICE,
    models: uniqueOptions([
      { id: DEFAULT_OPENAI_MODEL, label: "Standard" },
      { id: "gpt-realtime-mini-2025-10-06", label: "Realtime Mini (2025-10-06)" }
    ]),
    voices: OPENAI_VOICES
  },
  xai: {
    id: "xai",
    label: "Grok Voice (xAI)",
    configured: Boolean(XAI_API_KEY),
    defaultModel: DEFAULT_XAI_MODEL,
    defaultVoice: EFFECTIVE_XAI_VOICE,
    models: uniqueOptions([
      { id: DEFAULT_XAI_MODEL, label: "Grok Voice" },
      { id: "grok-voice-latest", label: "Grok Voice Latest" }
    ]),
    voices: XAI_VOICES
  }
};

const PROVIDER_IDS = Object.keys(PROVIDERS);
const EFFECTIVE_DEFAULT_PROVIDER = PROVIDERS[DEFAULT_PROVIDER] ? DEFAULT_PROVIDER : "openai";

const STRESS_SCENARIOS = [
  {
    id: "interruptions",
    label: "Interruptions",
    prompt: "Stress scenario: the caller will interrupt mid-answer twice. Stop speaking quickly, acknowledge the interruption, and continue with the newest request."
  },
  {
    id: "noisy_caller",
    label: "Noisy caller",
    prompt: "Stress scenario: the caller may be in a noisy place and repeat themselves. Ask short clarifying questions and confirm only critical details."
  },
  {
    id: "spelling_ids",
    label: "Spelling and IDs",
    prompt: "Stress scenario: collect a name, email, and order ID over the phone. Repeat back ambiguous letters and digits before proceeding."
  },
  {
    id: "long_pause",
    label: "Long pause",
    prompt: "Stress scenario: the caller may pause for several seconds. Do not fill silence immediately; wait calmly and ask a brief check-in only after a long pause."
  },
  {
    id: "frustrated",
    label: "Frustrated caller",
    prompt: "Stress scenario: the caller is frustrated. Stay calm, acknowledge the issue in one sentence, and move to one concrete next step."
  },
  {
    id: "domain_jargon",
    label: "Domain jargon",
    prompt: "Stress scenario: the caller uses domain-specific jargon. Ask one clarifying question when unsure and avoid pretending to know unknown terms."
  }
];
const STRESS_SCENARIOS_BY_ID = Object.fromEntries(STRESS_SCENARIOS.map((s) => [s.id, s]));

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

if (!OPENAI_API_KEY) log("warn", "OPENAI_API_KEY is not set. OpenAI calls will fail until it is set in .env");
if (!XAI_API_KEY) log("warn", "XAI_API_KEY is not set. Grok calls will fail until it is set in .env");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- In-memory prompt store (10 min)
const prompts = new Map(); // id -> { instructions, provider, voice, model, pairId, scenarioId, createdAt }
const EXPIRY_MS = 10 * 60 * 1000;

function normalizeScenarioId(scenarioId) {
  const id = String(scenarioId || "").trim();
  return STRESS_SCENARIOS_BY_ID[id] ? id : "";
}

function scenarioLabel(scenarioId) {
  return STRESS_SCENARIOS_BY_ID[scenarioId]?.label || "";
}

function putPrompt(instructions, provider, voice, model, pairId = null, scenarioId = "") {
  const id = crypto.randomUUID();
  prompts.set(id, { instructions, provider, voice, model, pairId, scenarioId: normalizeScenarioId(scenarioId), createdAt: Date.now() });
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

// --- In-memory comparison run store
const callRuns = [];
const testPairs = [];
const MAX_CALL_RUNS = 100;
const MAX_TEST_PAIRS = 50;
const SCORE_FIELDS = ["latency", "naturalness", "interruptions", "instructionAdherence", "recovery", "overall"];

function createCallRun({ direction, promptId, pairId = null, scenarioId = "", twilioCallSid = null, provider, model, voice, to = null }) {
  const now = new Date().toISOString();
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  const run = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "created",
    direction,
    promptId,
    pairId,
    scenarioId: normalizedScenarioId,
    scenarioLabel: scenarioLabel(normalizedScenarioId),
    twilioCallSid,
    streamSid: null,
    provider,
    model,
    voice,
    to,
    connectMs: null,
    streamStartMs: null,
    firstAudioMs: null,
    providerSessionId: null,
    activeModel: null,
    closeReason: null,
    error: null,
    evaluation: null
  };
  callRuns.unshift(run);
  if (callRuns.length > MAX_CALL_RUNS) callRuns.pop();
  return run;
}

function updateCallRun(id, patch) {
  if (!id) return null;
  const run = callRuns.find((r) => r.id === id);
  if (!run) return null;
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  return run;
}

function findCallRunByCallSid(callSid) {
  return callSid ? callRuns.find((r) => r.twilioCallSid === callSid) : null;
}

function serializeRun(run) {
  return {
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    direction: run.direction,
    promptId: run.promptId,
    pairId: run.pairId,
    scenarioId: run.scenarioId,
    scenarioLabel: run.scenarioLabel,
    twilioCallSid: run.twilioCallSid,
    streamSid: run.streamSid,
    provider: run.provider,
    model: run.model,
    voice: run.voice,
    to: run.to,
    connectMs: run.connectMs,
    streamStartMs: run.streamStartMs,
    firstAudioMs: run.firstAudioMs,
    providerSessionId: run.providerSessionId,
    activeModel: run.activeModel,
    closeReason: run.closeReason,
    error: run.error,
    evaluation: run.evaluation
  };
}

function parseScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function defaultProviderStep(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  return {
    provider: provider.id,
    model: provider.defaultModel,
    voice: provider.defaultVoice
  };
}

function serializePair(pair) {
  return {
    id: pair.id,
    createdAt: pair.createdAt,
    updatedAt: pair.updatedAt,
    status: pair.status,
    to: pair.to,
    scenarioId: pair.scenarioId,
    scenarioLabel: pair.scenarioLabel,
    promptPreview: pair.promptPreview,
    steps: pair.steps.map((step) => ({
      provider: step.provider,
      model: step.model,
      voice: step.voice,
      promptId: step.promptId,
      runId: step.runId,
      status: step.status,
      twilioCallSid: step.twilioCallSid
    }))
  };
}

function updatePair(pair, patch = {}) {
  Object.assign(pair, patch, { updatedAt: new Date().toISOString() });
  return pair;
}

function refreshPairStatus(pair) {
  if (pair.steps.every((step) => step.status === "called")) return updatePair(pair, { status: "complete" });
  if (pair.steps.some((step) => step.status === "called")) return updatePair(pair, { status: "in_progress" });
  return updatePair(pair, { status: "ready" });
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
    providers: PROVIDER_IDS.map((id) => {
      const p = PROVIDERS[id];
      return {
        id: p.id,
        label: p.label,
        configured: p.configured,
        defaultModel: p.defaultModel,
        defaultVoice: p.defaultVoice,
        models: p.models,
        voices: p.voices
      };
    }),
    defaultProvider: EFFECTIVE_DEFAULT_PROVIDER,
    stressScenarios: STRESS_SCENARIOS
  });
});

// --- 1) Create a prompt
app.post("/api/prompts", (req, res) => {
  try {
    let {
      instructions = "",
      provider = EFFECTIVE_DEFAULT_PROVIDER,
      voice,
      model,
      scenarioId = ""
    } = req.body || {};
    instructions = String(instructions || "").slice(0, 4000);
    provider = String(provider || EFFECTIVE_DEFAULT_PROVIDER);
    const providerConfig = PROVIDERS[provider];
    if (!providerConfig) return res.status(400).json({ error: "unsupported provider" });
    voice = String(voice || providerConfig.defaultVoice);
    model = String(model || providerConfig.defaultModel);
    if (!instructions.trim()) return res.status(400).json({ error: "instructions required" });
    if (!providerConfig.models.some((opt) => opt.id === model)) return res.status(400).json({ error: "unsupported model" });
    if (!providerConfig.voices.includes(voice)) return res.status(400).json({ error: "unsupported voice" });
    const promptId = putPrompt(instructions, provider, voice, model, null, scenarioId);
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
    const run = createCallRun({
      direction: "outbound",
      promptId,
      pairId: p.pairId || null,
      scenarioId: p.scenarioId || "",
      twilioCallSid: r.sid,
      provider: p.provider,
      model: p.model,
      voice: p.voice,
      to
    });
    log("info", "Placed call SID:", r.sid);
    res.json({ ok: true, sid: r.sid, runId: run.id });
  } catch (e) {
    log("error", "Twilio create call failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/pairs", (_req, res) => {
  res.json({ pairs: testPairs.map(serializePair) });
});

app.post("/api/pairs", (req, res) => {
  try {
    const { to, instructions = "", scenarioId = "" } = req.body || {};
    const normalizedScenarioId = normalizeScenarioId(scenarioId);
    const requestedProviders = Array.isArray(req.body?.providers) && req.body.providers.length
      ? req.body.providers
      : ["openai", "xai"];
    const providerIds = [...new Set(requestedProviders.map((p) => String(p)))];

    if (!String(instructions).trim()) return res.status(400).json({ error: "instructions required" });
    if (!to || !/^\+\d{10,15}$/.test(String(to))) return res.status(400).json({ error: "Invalid E.164 number" });
    if (providerIds.length < 2) return res.status(400).json({ error: "at least two providers required" });
    for (const providerId of providerIds) {
      if (!PROVIDERS[providerId]) return res.status(400).json({ error: `unsupported provider: ${providerId}` });
    }

    const pairId = crypto.randomUUID();
    const steps = shuffle(providerIds).map((providerId) => {
      const step = defaultProviderStep(providerId);
      const promptId = putPrompt(String(instructions).slice(0, 4000), step.provider, step.voice, step.model, pairId, normalizedScenarioId);
      return {
        ...step,
        promptId,
        runId: null,
        twilioCallSid: null,
        status: "pending"
      };
    });
    const now = new Date().toISOString();
    const pair = {
      id: pairId,
      createdAt: now,
      updatedAt: now,
      status: "ready",
      to,
      scenarioId: normalizedScenarioId,
      scenarioLabel: scenarioLabel(normalizedScenarioId),
      promptPreview: String(instructions).trim().slice(0, 140),
      steps
    };
    testPairs.unshift(pair);
    if (testPairs.length > MAX_TEST_PAIRS) testPairs.pop();
    res.json({ pair: serializePair(pair) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/pairs/:id/call-next", async (req, res) => {
  if (!twilioClient) return res.status(400).json({ error: "Twilio not configured. Set TWILIO_* in .env" });

  const pair = testPairs.find((p) => p.id === req.params.id);
  if (!pair) return res.status(404).json({ error: "pair not found" });

  const step = pair.steps.find((s) => s.status === "pending");
  if (!step) {
    refreshPairStatus(pair);
    return res.json({ ok: true, done: true, pair: serializePair(pair) });
  }

  const providerConfig = PROVIDERS[step.provider];
  if (!providerConfig?.configured) {
    step.status = "blocked";
    updatePair(pair, { status: "blocked" });
    return res.status(400).json({ error: `${providerConfig?.label || step.provider} is missing its API key`, pair: serializePair(pair) });
  }

  const base = APP_BASE_URL || `https://${req.headers.host}`;
  const url = `${base.replace(/\/$/, "")}/twiml?promptId=${encodeURIComponent(step.promptId)}`;

  try {
    const r = await twilioClient.calls.create({
      to: pair.to,
      from: TWILIO_FROM,
      url,
      method: "POST"
    });
    const run = createCallRun({
      direction: "outbound",
      promptId: step.promptId,
      pairId: pair.id,
      scenarioId: pair.scenarioId || "",
      twilioCallSid: r.sid,
      provider: step.provider,
      model: step.model,
      voice: step.voice,
      to: pair.to
    });
    step.status = "called";
    step.runId = run.id;
    step.twilioCallSid = r.sid;
    refreshPairStatus(pair);
    log("info", "Placed paired call SID:", r.sid, `pair=${pair.id}`, `provider=${step.provider}`);
    res.json({ ok: true, sid: r.sid, runId: run.id, pair: serializePair(pair) });
  } catch (e) {
    log("error", "Twilio paired call failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json({ runs: callRuns.map(serializeRun) });
});

app.post("/api/runs/:id/evaluation", (req, res) => {
  const run = callRuns.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });

  const scores = {};
  for (const field of SCORE_FIELDS) {
    const parsed = parseScore(req.body?.[field]);
    if (parsed === undefined) return res.status(400).json({ error: `${field} must be 1-5` });
    scores[field] = parsed;
  }

  const notes = String(req.body?.notes || "").slice(0, 2000);
  const evaluation = { ...scores, notes, savedAt: new Date().toISOString() };
  updateCallRun(run.id, { evaluation });
  res.json({ ok: true, run: serializeRun(run) });
});

app.get("/api/runs.csv", (_req, res) => {
  const columns = [
    "createdAt", "pairId", "scenarioId", "scenarioLabel", "provider", "model", "voice", "direction", "status", "twilioCallSid",
    "connectMs", "streamStartMs", "firstAudioMs", "latency", "naturalness",
    "interruptions", "instructionAdherence", "recovery", "overall", "notes"
  ];
  const lines = [columns.join(",")];
  for (const run of callRuns) {
    lines.push(columns.map((col) => {
      if (SCORE_FIELDS.includes(col) || col === "notes") return csvEscape(run.evaluation?.[col]);
      return csvEscape(run[col]);
    }).join(","));
  }
  res.type("text/csv").send(lines.join("\n") + "\n");
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
      <Parameter name="provider" value="${p.provider || EFFECTIVE_DEFAULT_PROVIDER}"/>
      <Parameter name="voice" value="${p.voice || PROVIDERS[p.provider || EFFECTIVE_DEFAULT_PROVIDER].defaultVoice}"/>
      <Parameter name="model" value="${p.model || PROVIDERS[p.provider || EFFECTIVE_DEFAULT_PROVIDER].defaultModel}"/>
    </Stream>
  </Connect>
  <Pause length="3600"/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- 4) WS bridge: Twilio <Stream> ↔ provider realtime API
const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("error", (e) => log("error", "WSS error:", e.message));

async function connectOpenAI(instructions, voice, model) {
  const finalInstructions = composeInstructions(instructions);
  const providerConfig = PROVIDERS.openai;
  const chosenModel = providerConfig.models.some((opt) => opt.id === model) ? model : providerConfig.defaultModel;
  const chosenVoice = providerConfig.voices.includes(voice) ? voice : providerConfig.defaultVoice;

  if (!OPENAI_API_KEY) throw new Error("OpenAI not configured. Set OPENAI_API_KEY in .env");

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
          voice: chosenVoice,
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

async function connectXai(instructions, voice, model) {
  const finalInstructions = composeInstructions(instructions);
  const providerConfig = PROVIDERS.xai;
  const chosenModel = providerConfig.models.some((opt) => opt.id === model) ? model : providerConfig.defaultModel;
  const chosenVoice = providerConfig.voices.includes(voice) ? voice : providerConfig.defaultVoice;

  if (!XAI_API_KEY) throw new Error("xAI not configured. Set XAI_API_KEY in .env");

  const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(chosenModel)}`;
  const headers = { Authorization: `Bearer ${XAI_API_KEY}` };
  const xai = new WebSocket(url, { headers });

  await new Promise((resolve, reject) => {
    xai.once("open", resolve);
    xai.once("error", reject);
  });

  log("info", `xAI WS connected (requested model: ${chosenModel})`);

  const sessionUpdate = {
    type: "session.update",
    session: {
      instructions: finalInstructions,
      voice: chosenVoice,
      turn_detection: {
        type: "server_vad",
        threshold: 0.4,
        prefix_padding_ms: 500,
        silence_duration_ms: 400
      },
      audio: {
        input: {
          format: { type: "audio/pcmu" }
        },
        output: {
          format: { type: "audio/pcmu" },
          speed: 1.0
        }
      }
    }
  };

  xai.send(JSON.stringify(sessionUpdate));
  xai.send(JSON.stringify({ type: "response.create" }));

  return xai;
}

async function connectRealtimeProvider(provider, instructions, voice, model) {
  if (provider === "xai") return connectXai(instructions, voice, model);
  return connectOpenAI(instructions, voice, model);
}

wss.on("connection", async (twilioWs) => {
  log("info", "Twilio connected to /stream");
  let providerWs;
  let streamSid = null;
  let callSid = null;
  let selectedProvider = EFFECTIVE_DEFAULT_PROVIDER;
  let selectedModel = null;
  let selectedVoice = null;
  let runId = null;
  let firstAudioLogged = false;
  const streamConnectedAt = Date.now();

  const safeClose = (why) => {
    updateCallRun(runId, { status: "closed", closeReason: why || null });
    log("info", "Closing bridge:", why || "");
    try { twilioWs?.close(); } catch {}
    try { providerWs?.close(); } catch {}
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
      const providerParam = params.provider;
      const modelParam = params.model;
      callSid = data.start?.callSid || callSid;

      // Resolve instructions from in-memory store
      const p = promptId ? getPrompt(promptId) : null;
      selectedProvider = p?.provider || providerParam || EFFECTIVE_DEFAULT_PROVIDER;
      if (!PROVIDERS[selectedProvider]) selectedProvider = EFFECTIVE_DEFAULT_PROVIDER;
      const providerConfig = PROVIDERS[selectedProvider];
      const instructions = p?.instructions;
      selectedVoice = p?.voice || params.voice || providerConfig.defaultVoice;
      selectedModel = p?.model || modelParam || providerConfig.defaultModel;
      const existingRun = findCallRunByCallSid(callSid);
      const run = existingRun || createCallRun({
        direction: "inbound",
        promptId,
        pairId: p?.pairId || null,
        scenarioId: p?.scenarioId || "",
        twilioCallSid: callSid,
        provider: selectedProvider,
        model: selectedModel,
        voice: selectedVoice
      });
      runId = run.id;
      updateCallRun(runId, {
        status: "stream_started",
        twilioCallSid: callSid || run.twilioCallSid,
        streamSid,
        provider: selectedProvider,
        model: selectedModel,
        voice: selectedVoice,
        streamStartMs: Date.now() - streamConnectedAt
      });

      try {
        const providerConnectStartedAt = Date.now();
        providerWs = await connectRealtimeProvider(selectedProvider, instructions, selectedVoice, selectedModel);
        const connectMs = Date.now() - providerConnectStartedAt;
        updateCallRun(runId, {
          status: "provider_connected",
          connectMs,
          streamStartMs: Date.now() - streamConnectedAt
        });
        log(
          "info",
          "Provider connected",
          `provider=${selectedProvider}`,
          `model=${selectedModel}`,
          `voice=${selectedVoice}`,
          callSid ? `callSid=${callSid}` : "",
          `connectMs=${connectMs}`,
          `streamStartMs=${Date.now() - streamConnectedAt}`
        );
      } catch (e) {
        updateCallRun(runId, { status: "provider_error", error: e.message });
        log("error", "Provider connect failed:", `provider=${selectedProvider}`, e.message);
        return safeClose("provider_connect_error");
      }

      // Provider -> Twilio
      providerWs.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const t = msg.type;

        if (t === "session.created" || t === "session.updated") {
          const activeModel = msg?.session?.model || msg?.model;
          const sessionId = msg?.session?.id || msg?.id;
          updateCallRun(runId, {
            status: "session_ready",
            providerSessionId: sessionId || null,
            activeModel: activeModel || null
          });
          log(
            "info",
            "Provider session ready",
            `provider=${selectedProvider}`,
            sessionId ? `(sessionId: ${sessionId})` : "",
            activeModel ? `model=${activeModel}` : ""
          );
          return;
        }

        // Stream model audio to Twilio
        if (t === "response.output_audio.delta" && msg.delta && streamSid) {
          if (!firstAudioLogged) {
            firstAudioLogged = true;
            updateCallRun(runId, {
              status: "first_audio",
              firstAudioMs: Date.now() - streamConnectedAt
            });
            log(
              "info",
              "First provider audio",
              `provider=${selectedProvider}`,
              selectedModel ? `model=${selectedModel}` : "",
              callSid ? `callSid=${callSid}` : "",
              `firstAudioMs=${Date.now() - streamConnectedAt}`
            );
          }
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
          const error = JSON.stringify(msg.error || msg);
          updateCallRun(runId, { status: "provider_error", error });
          log("error", "Provider error:", `provider=${selectedProvider}`, error);
          safeClose("provider_error");
        }
      });

      providerWs.on("close", (code, reason) => { log("info", "Provider WS closed:", `provider=${selectedProvider}`, code, reason?.toString() || ""); safeClose("provider_closed"); });
      providerWs.on("error", (e) => { log("error", "Provider WS error:", `provider=${selectedProvider}`, e.message); safeClose("provider_ws_error"); });

      return;
    }

    // Caller media (8kHz PCMU base64) -> Realtime input buffer
    if (evt === "media" && data.media?.payload) {
      try {
        providerWs?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
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
