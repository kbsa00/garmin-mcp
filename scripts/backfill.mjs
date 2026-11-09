#!/usr/bin/env node
// One-time (re-runnable, idempotent) backfill of all Garmin history into the production D1.
//
// Runs the Worker's backfill job in local workerd (no Free-plan CPU/subrequest limits) with the
// D1 and APP_KV bindings pointing at the real remote resources. Health data goes straight from
// Garmin into D1; nothing is written to local files and only counts are logged.
//
//   node scripts/backfill.mjs

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const PORT = 8790;
const CONFIG = ".backfill.wrangler.json";

// wrangler.jsonc -> JSON (our comments are whole-line `//` comments) with remote D1/KV bindings.
const cfg = JSON.parse(
	readFileSync("wrangler.jsonc", "utf8")
		.split("\n")
		.filter((l) => !l.trim().startsWith("//"))
		.join("\n")
		.replace(/,(\s*[}\]])/g, "$1"),
);
cfg.d1_databases = cfg.d1_databases.map((d) => ({ ...d, remote: true }));
cfg.kv_namespaces = cfg.kv_namespaces.map((k) => (k.binding === "APP_KV" ? { ...k, remote: true } : k));
delete cfg.triggers;
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

const dev = spawn("node", ["scripts/dev.mjs", "-c", CONFIG, "--port", String(PORT), "--test-scheduled"], {
	stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let done = false;
const onData = (buf) => {
	const text = buf.toString();
	output += text;
	for (const line of text.split("\n")) {
		// Only progress lines (counts) are shown.
		if (/backfill|fit processing/i.test(line)) console.log(line.trim());
		if (/backfill (done|failed)/.test(line)) done = true;
	}
};
dev.stdout.on("data", onData);
dev.stderr.on("data", onData);

const cleanup = (code) => {
	dev.kill("SIGINT");
	rmSync(CONFIG, { force: true });
	process.exit(code);
};
process.on("SIGINT", () => cleanup(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
	if (i > 120) {
		console.error("wrangler dev did not start:\n" + output.slice(-2000));
		cleanup(1);
	}
	try {
		if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
	} catch {
		// not up yet
	}
	await sleep(1000);
}
// Completion is detected from the log line or, as a fallback, from sync_state in D1.
const completedAt = () => {
	try {
		const out = execFileSync("npx", ["wrangler", "d1", "execute", cfg.d1_databases[0].database_name, "--remote", "--json", "--command", "SELECT value FROM sync_state WHERE key = 'backfill_completed_at'"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
		return JSON.parse(out)[0]?.results?.[0]?.value ?? null;
	} catch {
		return null;
	}
};
const before = completedAt();
console.log("Starting backfill (sequential requests, ~1 s apart)...");
await fetch(`http://localhost:${PORT}/__scheduled?cron=backfill`);
for (let i = 0; !done; i++) {
	await sleep(2000);
	if (i % 15 === 14) {
		const now = completedAt();
		if (now && now !== before) {
			console.log("backfill done (sync_state updated)");
			done = true;
		}
	}
}
await sleep(1000);
cleanup(/backfill failed/.test(output) ? 1 : 0);
