// scripts/smoke-test.js
import { spawn } from "child_process";
import { WebSocket } from "ws";

const PORT = process.env.SMOKE_PORT || "18080";
const BASE = `http://127.0.0.1:${PORT}`;

function fail(message) {
  throw new Error(message);
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}

async function waitForServer(child) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) fail(`server exited early with code ${child.exitCode}`);
    try {
      const { res } = await request("/healthz");
      if (res.ok) return;
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fail(`server did not become ready: ${lastError}`);
}

async function simulateTwilioStart(promptId) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream`);
    const timer = setTimeout(() => reject(new Error("timed out waiting for simulated Twilio stream to close")), 3000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        event: "start",
        streamSid: "MZ_SMOKE_STREAM",
        start: {
          callSid: "CA_SMOKE_XAI",
          customParameters: {
            promptId,
            provider: "xai",
            voice: "eve",
            model: "grok-voice-latest"
          }
        }
      }));
    });
    ws.on("close", () => { clearTimeout(timer); resolve(); });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const server = spawn("node", ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT,
    LOG_LEVEL: "error",
    OPENAI_API_KEY: "sk-smoke-test",
    OPENAI_MODEL: "gpt-realtime",
    OPENAI_VOICE: "alloy",
    XAI_API_KEY: "",
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    TWILIO_FROM: "+15551234567",
    APP_BASE_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });

try {
  await waitForServer(server);

  const config = await request("/api/config");
  if (!config.res.ok) fail("/api/config failed");
  if (!config.body.providers?.some((p) => p.id === "openai" && p.configured)) fail("OpenAI provider not configured in smoke config");
  if (!config.body.providers?.some((p) => p.id === "xai" && !p.configured)) fail("xAI provider should be unconfigured in smoke config");
  if ((config.body.stressScenarios || []).length < 6) fail("expected stress scenarios in config");

  const pair = await request("/api/pairs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: "+15551234567",
      instructions: "Smoke-test paired comparison.",
      scenarioId: "interruptions",
      providers: ["openai", "xai"]
    })
  });
  if (!pair.res.ok || !pair.body.pair?.id) fail("pair creation failed");
  if (pair.body.pair.scenarioId !== "interruptions") fail("pair scenario was not preserved");
  if (pair.body.pair.steps.length !== 2) fail("pair should contain two provider steps");

  const prompt = await request("/api/prompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instructions: "Smoke-test direct prompt.",
      provider: "xai",
      voice: "eve",
      model: "grok-voice-latest",
      scenarioId: "spelling_ids"
    })
  });
  if (!prompt.res.ok || !prompt.body.promptId) fail("xAI prompt creation failed");

  const twiml = await request(`/twiml?promptId=${encodeURIComponent(prompt.body.promptId)}`);
  if (!twiml.res.ok || !String(twiml.body).includes('name="provider" value="xai"')) fail("TwiML did not include xAI provider parameter");

  await simulateTwilioStart(prompt.body.promptId);

  const runs = await request("/api/runs");
  const run = runs.body.runs?.find((r) => r.twilioCallSid === "CA_SMOKE_XAI");
  if (!run) fail("simulated Twilio run was not recorded");
  if (run.scenarioId !== "spelling_ids") fail("run scenario was not preserved");
  if (!String(run.error || "").includes("XAI_API_KEY")) fail("expected missing xAI key error in run log");

  const evaluation = await request(`/api/runs/${encodeURIComponent(run.id)}/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      latency: 3,
      naturalness: 3,
      interruptions: 2,
      instructionAdherence: 4,
      recovery: 3,
      overall: 3,
      notes: "smoke score"
    })
  });
  if (!evaluation.res.ok || evaluation.body.run?.evaluation?.overall !== 3) fail("evaluation save failed");

  const csv = await request("/api/runs.csv");
  const csvText = String(csv.body || "");
  if (!csvText.includes("scenarioId") || !csvText.includes("spelling_ids") || !csvText.includes("smoke score")) fail("CSV export missing expected run data");

  console.log("smoke ok");
} finally {
  server.kill("SIGINT");
  await new Promise((resolve) => server.once("exit", resolve));
  if (stderr && process.env.SMOKE_DEBUG) console.error(stderr);
}
