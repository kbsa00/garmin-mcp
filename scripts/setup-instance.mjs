#!/usr/bin/env node
// One-time setup of this connector in YOUR Cloudflare account (the one `wrangler login` used):
//   0. pins wrangler.jsonc to your Cloudflare account id (so it can never deploy elsewhere)
//   1. creates its own KV namespaces and D1 database and writes their ids into wrangler.jsonc
//   2. applies the D1 migrations
//   3. uploads GARMIN_API_KEY from .env and a new login passphrase (-> CONNECTOR_LOGIN.txt)
//   4. deploys, then sets MCP_RESOURCE to the deployed URL and deploys again
// Re-runnable: steps that are already done are skipped. Nothing secret is printed.
//
//   node scripts/setup-instance.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG = "wrangler.jsonc";
const run = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
let cfg = readFileSync(CONFIG, "utf8");
const name = /"name":\s*"([^"]+)"/.exec(cfg)[1];
const save = () => writeFileSync(CONFIG, cfg);

// 0. The Garmin key must be in .env before anything is created.
const dotenv = {};
if (existsSync(".env")) {
	for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
}
if (!dotenv.GARMIN_API_KEY && !dotenv.GARMIN_APIKEY) {
	console.error("Put the Garmin Personal API key in .env as GARMIN_API_KEY=... first.");
	process.exit(1);
}
// Pin the account (prevents deploying into another account if wrangler's login or cache changes).
if (!/"account_id"/.test(cfg)) {
	const ids = [...new Set(strip(run(["whoami"])).match(/\b[0-9a-f]{32}\b/g) ?? [])];
	if (ids.length !== 1) {
		console.error(`Expected exactly one Cloudflare account, found ${ids.length}. Add "account_id": "<id>" to wrangler.jsonc and run again.`);
		process.exit(1);
	}
	cfg = cfg.replace(/("name":\s*"[^"]+",)/, `$1\n\t// Pinned by setup to your Cloudflare account.\n\t"account_id": "${ids[0]}",`);
	save();
}
console.log(`Setting up worker "${name}".`);

// 1. KV namespaces and D1 (titles are prefixed with the worker name so they never clash).
for (const binding of ["OAUTH_KV", "APP_KV"]) {
	const placeholder = `SET_BY_SETUP_${binding}`;
	if (!cfg.includes(placeholder)) continue;
	const out = strip(run(["kv", "namespace", "create", `${name}-${binding}`]));
	const id = /"id":\s*"([0-9a-f]{32})"/.exec(out)?.[1];
	if (!id) throw new Error(`Could not create KV namespace for ${binding}:\n${out}`);
	cfg = cfg.replace(placeholder, id);
	save();
	console.log(`Created KV ${binding}.`);
}
if (cfg.includes("SET_BY_SETUP_D1")) {
	const out = strip(run(["d1", "create", name]));
	const id = /"database_id":\s*"([0-9a-f-]{36})"/.exec(out)?.[1];
	if (!id) throw new Error(`Could not create D1 database:\n${out}`);
	cfg = cfg.replace("SET_BY_SETUP_D1", id);
	save();
	console.log("Created D1 database.");
}

// 2. Migrations.
run(["d1", "migrations", "apply", name, "--remote"]);
console.log("D1 migrations applied.");

// 3. Secrets (the first `secret put` also creates the worker).
const step = (script, args = []) => {
	const r = spawnSync("node", [script, ...args], { stdio: "inherit" });
	if (r.status !== 0) process.exit(r.status ?? 1);
};
step("scripts/put-garmin-key.mjs");
if (!existsSync("CONNECTOR_LOGIN.txt")) step("scripts/new-passphrase.mjs");
else console.log("CONNECTOR_LOGIN.txt exists; keeping the current passphrase (run `npm run rotate-passphrase` to change it).");

// 4. Resolve the workers.dev URL BEFORE deploying: the Worker refuses to start without a valid
//    MCP_RESOURCE. Registers a neutral random workers.dev subdomain if the account has none.
const accountId = /"account_id":\s*"([0-9a-f]{32})"/.exec(cfg)?.[1] ?? /([0-9a-f]{32})/.exec(strip(run(["whoami"])))?.[1];
const token = strip(run(["auth", "token"])).split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z0-9._-]{20,}$/.test(l)).pop();
const api = async (method, path, body) => {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return res.json();
};
let sub = (await api("GET", "/workers/subdomain")).result?.subdomain;
if (!sub) {
	const wanted = `mcp-${Math.random().toString(36).slice(2, 8)}`;
	const r = await api("PUT", "/workers/subdomain", { subdomain: wanted });
	if (!r.success) {
		console.error("Could not register a workers.dev subdomain. Open Workers & Pages once in the Cloudflare dashboard, then run this script again.");
		process.exit(1);
	}
	sub = r.result.subdomain;
	console.log(`Registered workers.dev subdomain "${sub}" for this account.`);
}
const url = `https://${name}.${sub}.workers.dev`;
if (!cfg.includes(`"MCP_RESOURCE": "${url}/mcp"`)) {
	cfg = cfg.replace(/"MCP_RESOURCE":\s*"[^"]*"/, `"MCP_RESOURCE": "${url}/mcp"`);
	save();
}

// 5. Deploy.
strip(run(["deploy"]));
console.log(`\nDone. Connector URL: ${url}/mcp`);
console.log("Login passphrase: CONNECTOR_LOGIN.txt");
console.log("Next: run `node scripts/backfill.mjs` to load all Garmin history, then add the URL as a custom connector in claude.ai.");
