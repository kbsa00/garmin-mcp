#!/usr/bin/env node
// Generates a new connector login passphrase, writes the plaintext ONLY to CONNECTOR_LOGIN.txt
// (mode 600, gitignored) and stores its PBKDF2 hash as the LOGIN_PASSPHRASE_HASH Wrangler secret.
// Nothing secret is printed.
//
//   node scripts/new-passphrase.mjs              # rotate in production
//   node scripts/new-passphrase.mjs --dev FILE   # also write LOGIN_PASSPHRASE_HASH=... to FILE (for wrangler dev --env-file)
//   node scripts/new-passphrase.mjs --no-deploy  # only generate CONNECTOR_LOGIN.txt (+ --dev file)
//   --login-file PATH                            # write the plaintext elsewhere (e.g. a throwaway dev login)

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { fileURLToPath } from "node:url";

// Must match src/auth/passphrase.ts.
export const PBKDF2_ITERATIONS = 100_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // no 0/O/1/l/I

export function generatePassphrase(groups = 8, groupLen = 4) {
	const chars = [];
	const limit = 256 - (256 % ALPHABET.length); // rejection sampling: no modulo bias
	while (chars.length < groups * groupLen) {
		for (const b of crypto.getRandomValues(new Uint8Array(64))) {
			if (b < limit && chars.length < groups * groupLen) chars.push(ALPHABET[b % ALPHABET.length]);
		}
	}
	const out = [];
	for (let i = 0; i < groups; i++) out.push(chars.slice(i * groupLen, (i + 1) * groupLen).join(""));
	return out.join("-");
}

export async function hashPassphrase(passphrase, iterations = PBKDF2_ITERATIONS) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
	const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
	const b64 = (u) => Buffer.from(u).toString("base64");
	return `pbkdf2-sha256:${iterations}:${b64(salt)}:${b64(bits)}`;
}

async function main() {
	const args = process.argv.slice(2);
	const devIdx = args.indexOf("--dev");
	const devFile = devIdx >= 0 ? args[devIdx + 1] : null;
	const deploy = !args.includes("--no-deploy");
	const loginIdx = args.indexOf("--login-file");
	const loginFile = loginIdx >= 0 ? args[loginIdx + 1] : "CONNECTOR_LOGIN.txt";

	const passphrase = generatePassphrase();
	const hash = await hashPassphrase(passphrase);

	if (deploy) {
		const r = spawnSync("npx", ["wrangler", "secret", "put", "LOGIN_PASSPHRASE_HASH"], {
			input: hash,
			stdio: ["pipe", "inherit", "inherit"],
		});
		if (r.status !== 0) {
			console.error("wrangler secret put failed; CONNECTOR_LOGIN.txt was NOT changed.");
			process.exit(1);
		}
	}

	writeFileSync(
		loginFile,
		`Garmin MCP connector login passphrase (generated ${new Date().toISOString()}):\n\n${passphrase}\n\n` +
			"Use it once on the connector's login page when adding it in claude.ai. Keep this file private.\n",
		{ mode: 0o600 },
	);
	if (devFile) writeFileSync(devFile, `LOGIN_PASSPHRASE_HASH=${hash}\n`, { mode: 0o600 });
	console.log(`New passphrase written to ${loginFile}${deploy ? " and its hash stored as LOGIN_PASSPHRASE_HASH" : ""}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
