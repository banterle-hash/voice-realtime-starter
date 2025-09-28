// scripts/setup.js
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";

const envPath = path.resolve(".env");

if (fs.existsSync(envPath)) {
  console.log(chalk.yellow("• .env already exists. Existing keys will be overwritten if you set new values.\n"));
}

const questions = [
  { name: "OPENAI_API_KEY", message: "OpenAI API Key (required):", validate: v => v?.startsWith("sk-") || "Enter a valid key (starts with sk-)" },
  { name: "OPENAI_MODEL", message: "OpenAI model:", default: "gpt-realtime" },
  { name: "OPENAI_VOICE", message: "OpenAI voice (alloy/ash/verse/...):", default: "alloy" },

  { type: "confirm", name: "useOutbound", message: "Enable outbound 'Call me' (requires Twilio)?", default: true },
  { name: "TWILIO_ACCOUNT_SID", message: "Twilio Account SID:", when: a => a.useOutbound, validate: v => v?.startsWith("AC") || "Should start with AC" },
  { name: "TWILIO_AUTH_TOKEN", message: "Twilio Auth Token:", when: a => a.useOutbound, validate: v => !!v || "Required" },
  { name: "TWILIO_FROM", message: "Twilio From Number (E.164, +15551234567):", when: a => a.useOutbound, validate: v => /^\+\d{10,15}$/.test(v) || "Use +countrycode number" },

  { type: "confirm", name: "useNgrok", message: "Configure ngrok authtoken (recommended)?", default: true },
  { name: "NGROK_AUTHTOKEN", message: "ngrok authtoken:", when: a => a.useNgrok }
];

const a = await inquirer.prompt(questions);

const kv = (k, v) => (v !== undefined && v !== null ? `${k}=${v}` : "");
const lines = [
  kv("OPENAI_API_KEY", a.OPENAI_API_KEY),
  kv("OPENAI_MODEL", a.OPENAI_MODEL || "gpt-realtime"),
  kv("OPENAI_VOICE", a.OPENAI_VOICE || "alloy"),

  ...(a.useOutbound ? [
    kv("TWILIO_ACCOUNT_SID", a.TWILIO_ACCOUNT_SID),
    kv("TWILIO_AUTH_TOKEN", a.TWILIO_AUTH_TOKEN),
    kv("TWILIO_FROM", a.TWILIO_FROM),
  ] : []),

  kv("NGROK_AUTHTOKEN", a.useNgrok ? a.NGROK_AUTHTOKEN : undefined),

  "PORT=8080",
  "APP_BASE_URL=",
  "LOG_LEVEL=info"
].filter(Boolean);

fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf8");

console.log(chalk.green(`\n✓ Wrote ${envPath}`));
console.log("\nNext steps:");
console.log(chalk.cyan("  1) ") + "Install deps: " + chalk.bold("npm i"));
console.log(chalk.cyan("  2) ") + "Start with ngrok: " + chalk.bold("npm run start:ngrok"));
console.log(chalk.cyan("  3) ") + "Open the printed https URL in your browser.");
console.log("\nFor inbound calls, set your Twilio number webhook to: " + chalk.bold("POST <your-ngrok-https-url>/twiml") + "\n");
