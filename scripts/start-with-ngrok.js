// scripts/start-with-ngrok.js
import ngrok from "ngrok";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const port = process.env.PORT || 8080;
const region = process.env.NGROK_REGION || "us";
const binPathEnv = (process.env.NGROK_BIN_PATH || "").trim(); // trim stray spaces

function validateBin(binPath) {
  if (!binPath) throw new Error("NGROK_BIN_PATH missing in .env (set to output of `which ngrok`)");
  const real = fs.existsSync(binPath) ? fs.realpathSync(binPath) : null;
  if (!real) throw new Error(`NGROK_BIN_PATH does not exist: ${binPath}`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`NGROK_BIN_PATH is not a file: ${real}`);
  // basic exec bit check on *nix
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new Error(`NGROK_BIN_PATH is not executable: ${real} (try: chmod +x "${real}")`);
  }
  return real;
}

async function main() {
  try {
    const binReal = validateBin(binPathEnv);

    if (!process.env.NGROK_AUTHTOKEN) {
      throw new Error("NGROK_AUTHTOKEN missing in .env");
    }

    // kill any stale embedded agents
    try { await ngrok.kill(); } catch {}

    await ngrok.authtoken(process.env.NGROK_AUTHTOKEN.trim());

    const url = await ngrok.connect({
      addr: `http://localhost:${port}`,
      proto: "http",
      region,
      // ngrok@^4 expects a FUNCTION returning the path
      binPath: () => binReal
    });

    const httpsUrl = url.replace(/^http:/, "https:");
    process.env.APP_BASE_URL = httpsUrl;

    console.log("\nPublic URL:", httpsUrl);
    console.log("Twilio Voice Webhook (A Call Comes In):", `${httpsUrl}/twiml`);
    console.log("\nStarting server...\n");

    const child = spawn("node", ["server.js"], {
      stdio: "inherit",
      env: { ...process.env, APP_BASE_URL: httpsUrl }
    });

    const cleanup = async () => {
      try { await ngrok.disconnect(); await ngrok.kill(); } catch {}
      try { child.kill("SIGINT"); } catch {}
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (e) {
    const pretty = typeof e === "object" ? (e.stack || e.message || JSON.stringify(e)) : String(e);
    console.error("\n✗ ngrok failed:", pretty);
    console.error("\nChecklist:");
    console.error("• NGROK_BIN_PATH must be the FULL path to the binary (e.g. /opt/homebrew/bin/ngrok), not a folder");
    console.error("• Confirm it exists & is executable: ls -l $(which ngrok)");
    console.error("• NGROK_AUTHTOKEN present in .env");
    console.error("• NGROK_REGION=us (or eu/ap) if needed");
    console.error("• Only one session (dashboard: end others) — this script runs ngrok.kill() first");
    console.error("• VPN/firewall: allow *.ngrok.com");
    process.exit(1);
  }
}

main();
