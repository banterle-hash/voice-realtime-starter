// scripts/preflight.js
import { spawnSync } from "child_process";
import net from "net";
import dotenv from "dotenv";

const dotenvResult = dotenv.config({ quiet: true });

const args = new Set(process.argv.slice(2));
const soft = args.has("--soft");
const checks = [];
const PROVIDER_VOICES = {
  openai: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
  xai: ["eve", "ara", "rex", "sal", "leo"]
};

function isPresent(value) {
  return Boolean(String(value || "").trim());
}

function isPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || normalized.includes("...")
    || normalized.includes("xxxxx")
    || normalized.includes("<")
    || normalized.includes("your_")
    || normalized.includes("your-");
}

function addCheck(status, label, detail, required = false) {
  checks.push({ status, label, detail, required });
}

function checkSecret(name, label, validator, failureDetail) {
  const value = process.env[name];
  if (!isPresent(value) || isPlaceholder(value)) {
    addCheck("fail", label, `missing or placeholder ${name}`, true);
    return false;
  }
  if (validator && !validator(value)) {
    addCheck("fail", label, failureDetail, true);
    return false;
  }
  addCheck("pass", label, "set", true);
  return true;
}

function run(bin, argsForBin) {
  return spawnSync(bin, argsForBin, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function maskPhone(value) {
  const phone = String(value || "").trim();
  if (phone.length <= 4) return "<set>";
  return `${phone.slice(0, 2)}...${phone.slice(-4)}`;
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve({ ok: false, error }));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve({ ok: true }));
    });
  });
}

function validateProviderDefaults() {
  const defaultProvider = (process.env.DEFAULT_PROVIDER || "openai").trim();
  if (!["openai", "xai"].includes(defaultProvider)) {
    addCheck("fail", "Default provider", `unsupported DEFAULT_PROVIDER=${defaultProvider}`, true);
  } else {
    addCheck("pass", "Default provider", defaultProvider, false);
  }

  const openaiModel = process.env.OPENAI_MODEL || "gpt-realtime";
  const openaiVoice = process.env.OPENAI_VOICE || "alloy";
  const xaiModel = process.env.XAI_MODEL || "grok-voice-latest";
  const xaiVoice = process.env.XAI_VOICE || "eve";

  if (PROVIDER_VOICES.openai.includes(openaiVoice)) {
    addCheck("pass", "OpenAI model/voice", `${openaiModel} / ${openaiVoice}`, false);
  } else {
    addCheck("warn", "OpenAI model/voice", `${openaiModel} / ${openaiVoice} is not in the app voice list; server will fall back to alloy`, false);
  }

  if (PROVIDER_VOICES.xai.includes(xaiVoice)) {
    addCheck("pass", "xAI model/voice", `${xaiModel} / ${xaiVoice}`, false);
  } else {
    addCheck("warn", "xAI model/voice", `${xaiModel} / ${xaiVoice} is not in the app voice list; server will fall back to eve`, false);
  }
}

function validateAppBaseUrl() {
  const raw = String(process.env.APP_BASE_URL || "").trim();
  if (!raw) {
    addCheck("warn", "APP_BASE_URL", "blank is OK with npm run start:ngrok; manual npm start needs a public https URL", false);
    return;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      addCheck("fail", "APP_BASE_URL", "must be https for Twilio Media Streams", true);
      return;
    }
    addCheck("pass", "APP_BASE_URL", url.origin, false);
  } catch {
    addCheck("fail", "APP_BASE_URL", "not a valid URL", true);
  }
}

function validateNgrok() {
  const bin = (process.env.NGROK_BIN_PATH || "").trim() || "ngrok";
  const version = run(bin, ["version"]);
  if (version.error || version.status !== 0) {
    addCheck("fail", "ngrok CLI", `not runnable as ${bin}`, true);
    addCheck("fail", "ngrok auth", "cannot verify auth without ngrok CLI", true);
    return;
  }

  addCheck("pass", "ngrok CLI", firstLine(version.stdout) || bin, true);

  if (!isPlaceholder(process.env.NGROK_AUTHTOKEN)) {
    addCheck("pass", "ngrok auth", "NGROK_AUTHTOKEN is set", true);
    return;
  }

  const configCheck = run(bin, ["config", "check"]);
  if (configCheck.status === 0) {
    addCheck("pass", "ngrok auth", "ngrok config check passed", true);
    return;
  }

  addCheck("fail", "ngrok auth", "set NGROK_AUTHTOKEN or run ngrok config add-authtoken <token>", true);
}

async function validatePort() {
  const raw = String(process.env.PORT || "8080").trim();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    addCheck("fail", "Local port", `invalid PORT=${raw}`, true);
    return;
  }

  const result = await isPortAvailable(port);
  if (result.ok) {
    addCheck("pass", "Local port", `${port} is available`, true);
  } else {
    addCheck("fail", "Local port", `${port} is not available (${result.error?.code || "bind failed"})`, true);
  }
}

if (dotenvResult.error) {
  addCheck("warn", ".env file", "not found; using shell environment only", false);
} else {
  addCheck("pass", ".env file", "loaded", false);
}

checkSecret("OPENAI_API_KEY", "OpenAI API key", (value) => value.startsWith("sk-"), "OPENAI_API_KEY should start with sk-");
checkSecret("XAI_API_KEY", "xAI API key", (value) => value.startsWith("xai-"), "XAI_API_KEY should start with xai-");
checkSecret("TWILIO_ACCOUNT_SID", "Twilio Account SID", (value) => value.startsWith("AC"), "TWILIO_ACCOUNT_SID should start with AC");
checkSecret("TWILIO_AUTH_TOKEN", "Twilio auth token", null, "TWILIO_AUTH_TOKEN is required");

const fromNumber = process.env.TWILIO_FROM;
if (!isPresent(fromNumber) || isPlaceholder(fromNumber)) {
  addCheck("fail", "Twilio from number", "missing or placeholder TWILIO_FROM", true);
} else if (!/^\+\d{10,15}$/.test(fromNumber.trim())) {
  addCheck("fail", "Twilio from number", "TWILIO_FROM must be E.164, for example +15551234567", true);
} else {
  addCheck("pass", "Twilio from number", maskPhone(fromNumber), true);
}

validateProviderDefaults();
validateAppBaseUrl();
validateNgrok();
await validatePort();

const labelWidth = Math.max(...checks.map((check) => check.label.length));
const failedRequired = checks.filter((check) => check.required && check.status === "fail");

console.log("Voice comparison preflight");
console.log(`Mode: ${soft ? "report only (--soft)" : "strict live OpenAI-vs-Grok phone comparison"}`);
console.log("");

for (const check of checks) {
  const status = check.status.toUpperCase().padEnd(4, " ");
  const label = check.label.padEnd(labelWidth, " ");
  console.log(`${status} ${label}  ${check.detail}`);
}

console.log("");
if (failedRequired.length) {
  console.log("Not ready for live OpenAI-vs-Grok phone comparison.");
  console.log(`Required failures: ${failedRequired.map((check) => check.label).join(", ")}`);
  console.log("No providers were contacted and no phone call was placed.");
  process.exit(soft ? 0 : 1);
}

console.log("Ready for live OpenAI-vs-Grok phone comparison.");
console.log("Start with: npm run start:ngrok");
