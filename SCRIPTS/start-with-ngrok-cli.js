// scripts/start-with-ngrok-cli.js
import { spawn } from "child_process";
import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 8080;
const REGION = (process.env.NGROK_REGION || "us").toLowerCase();
const NGROK_BIN = (process.env.NGROK_BIN_PATH || "").trim() || "ngrok";
const START_TIMEOUT_MS = 20000; // 20s

function startNgrok() {
  return new Promise((resolve, reject) => {
    // conservative arg set for widest CLI compatibility
    const args = [
      "http",
      String(PORT),
      `--region=${REGION}`,
      "--log=stdout",
      "--log-format=json",
    ];

    const ng = spawn(NGROK_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let resolved = false;
    let stderrBuf = "";

    const onFound = (url) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ url, proc: ng });
    };

    // bail if no URL shows up
    const timer = setTimeout(() => {
      if (resolved) return;
      reject(new Error(`ngrok did not provide a public URL within ${START_TIMEOUT_MS}ms.\nStderr:\n${stderrBuf || "(empty)"}\n`));
    }, START_TIMEOUT_MS);

    const parseLine = (line) => {
      // 1) JSON logs: look for a https URL in a top-level "url" or embedded in "msg"
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") {
          const fromUrl = obj.url && String(obj.url);
          if (fromUrl && fromUrl.startsWith("https://")) return onFound(fromUrl);
          const fromMsg = obj.msg && String(obj.msg);
          const m = fromMsg && fromMsg.match(/https:\/\/[^\s"]+/);
          if (m) return onFound(m[0]);
        }
      } catch { /* not JSON */ }

      // 2) Classic text output
      const m = line.match(/Forwarding\s+(https:\/\/[^\s]+)/i);
      if (m) return onFound(m[1]);
    };

    const rlOut = readline.createInterface({ input: ng.stdout });
    rlOut.on("line", parseLine);

    ng.stderr.on("data", (d) => {
      const s = d.toString();
      stderrBuf += s;
      s.split(/\r?\n/).forEach(parseLine);
    });

    ng.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`ngrok exited with code ${code} before providing a URL.\nStderr:\n${stderrBuf || "(empty)"}\n`));
      }
    });

    ng.on("error", (e) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

function startServer(publicUrl) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, APP_BASE_URL: publicUrl };
    const child = spawn("node", ["server.js"], { stdio: "inherit", env });
    child.on("spawn", () => resolve(child));
    child.on("error", reject);
  });
}

(async () => {
  try {
    console.log("[ngrok-cli] starting:", NGROK_BIN, "region:", REGION, "port:", PORT);
    const { url, proc: ng } = await startNgrok();
    // Some older CLIs print http first; normalize to https if present
    const httpsUrl = url.replace(/^http:/, "https:");
    console.log("\nPublic URL:", httpsUrl);
    console.log("Twilio Voice Webhook (A Call Comes In):", `${httpsUrl}/twiml`);
    console.log("\nStarting server...\n");

    const server = await startServer(httpsUrl);

    const cleanup = () => {
      try { server.kill("SIGINT"); } catch {}
      try { ng.kill("SIGINT"); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (e) {
    console.error("\n✗ ngrok CLI failed:", e?.stack || e?.message || e);
    console.error("\nTry manual once to inspect output:");
    console.error(`  ${NGROK_BIN} http ${PORT} --region=${REGION} --log=stdout --log-format=json`);
    console.error("If it shows a URL there, paste the first lines here and I’ll tune the parser.");
    process.exit(1);
  }
})();

