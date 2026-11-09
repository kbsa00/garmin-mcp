#!/usr/bin/env node
// Uploads the Garmin Personal API key from .env (GARMIN_API_KEY or GARMIN_APIKEY) as the
// GARMIN_API_KEY Wrangler secret, piping it via stdin. Nothing secret is printed, and the cached
// Garmin access token is cleared so the new key takes effect immediately.
//
//   node scripts/put-garmin-key.mjs

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
	const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
	if (!m) continue;
	let v = m[2];
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	env[m[1]] = v;
}
const key = env.GARMIN_API_KEY ?? env.GARMIN_APIKEY;
if (!key) {
	console.error("No GARMIN_API_KEY or GARMIN_APIKEY in .env");
	process.exit(1);
}

const put = spawnSync("npx", ["wrangler", "secret", "put", "GARMIN_API_KEY"], { input: key, stdio: ["pipe", "inherit", "inherit"] });
if (put.status !== 0) process.exit(put.status ?? 1);

// Drop the access token minted with the old key (ignore failure if it does not exist).
spawnSync("npx", ["wrangler", "kv", "key", "delete", "--binding", "APP_KV", "--remote", "garmin:access_token"], { stdio: "ignore" });
console.log("GARMIN_API_KEY secret updated and cached Garmin token cleared.");
