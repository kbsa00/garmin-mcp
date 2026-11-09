#!/usr/bin/env node
// Runs `wrangler dev` with secrets taken from the local .env, passed via process.env only
// (never written to another file). Accepts GARMIN_API_KEY or GARMIN_APIKEY in .env.
//
//   node scripts/dev.mjs [--hash-file FILE] [extra wrangler dev args]
// FILE holds LOGIN_PASSPHRASE_HASH=... (see scripts/new-passphrase.mjs --dev FILE).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function parseEnvFile(path) {
	const out = {};
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (!m) continue;
		let v = m[2];
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

const args = process.argv.slice(2);
const hashIdx = args.indexOf("--hash-file");
const hashFile = hashIdx >= 0 ? args.splice(hashIdx, 2)[1] : null;

const dotenv = parseEnvFile(".env");
const env = { ...process.env, GARMIN_API_KEY: dotenv.GARMIN_API_KEY ?? dotenv.GARMIN_APIKEY ?? "" };
if (hashFile) env.LOGIN_PASSPHRASE_HASH = parseEnvFile(hashFile).LOGIN_PASSPHRASE_HASH ?? "";
if (!env.GARMIN_API_KEY) console.warn("No GARMIN_API_KEY / GARMIN_APIKEY found in .env");

const child = spawn("npx", ["wrangler", "dev", "--var", "MCP_RESOURCE:http://localhost:8788/mcp", ...args], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
