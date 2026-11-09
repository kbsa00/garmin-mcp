import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { AuthHandler } from "../src/auth/handler";
import { escapeHtml } from "../src/auth/page";
import { hashPassphrase, verifyPassphrase } from "../src/auth/passphrase";
import { LIMITS, LoginRateLimiter } from "../src/auth/ratelimit";
import { MemoryKV } from "./helpers";

const PASS = "correct-horse-battery-staple-123456";

describe("passphrase hashing", () => {
	it("verifies the right passphrase and rejects others", async () => {
		const stored = await hashPassphrase(PASS, 1000);
		expect(stored).toMatch(/^pbkdf2-sha256:1000:/);
		expect(await verifyPassphrase(PASS, stored)).toBe(true);
		expect(await verifyPassphrase(PASS + "x", stored)).toBe(false);
		expect(await verifyPassphrase(PASS, "garbage")).toBe(false);
		expect(await verifyPassphrase(PASS, "")).toBe(false);
	});
	it("uses a random salt", async () => {
		expect(await hashPassphrase(PASS, 1000)).not.toBe(await hashPassphrase(PASS, 1000));
	});
});

describe("LoginRateLimiter", () => {
	it("locks an IP after too many failures and unlocks after the window", async () => {
		let now = 1_800_000_000_000;
		const rl = new LoginRateLimiter(new MemoryKV(), () => now);
		for (let i = 0; i < LIMITS.ip.max - 1; i++) await rl.recordFailure("1.1.1.1");
		expect(await rl.lockedFor("1.1.1.1")).toBe(0);
		await rl.recordFailure("1.1.1.1");
		expect(await rl.lockedFor("1.1.1.1")).toBeGreaterThan(0);
		expect(await rl.lockedFor("2.2.2.2")).toBe(0);
		now += LIMITS.ip.windowSeconds * 1000 + 1000;
		expect(await rl.lockedFor("1.1.1.1")).toBe(0);
	});
	it("has a global cap across IPs", async () => {
		const rl = new LoginRateLimiter(new MemoryKV());
		for (let i = 0; i < LIMITS.global.max; i++) await rl.recordFailure(`10.0.0.${i}`);
		expect(await rl.lockedFor("9.9.9.9")).toBeGreaterThan(0);
	});
});

describe("escapeHtml", () => {
	it("escapes client-controlled strings", () => {
		expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
	});
});

describe("authorize page", () => {
	const authReq: AuthRequest = {
		responseType: "code",
		clientId: "client-1",
		redirectUri: "https://claude.ai/api/mcp/auth_callback",
		scope: ["garmin:read"],
		state: "s",
	} as AuthRequest;

	async function setup() {
		const kv = new MemoryKV();
		const completed: unknown[] = [];
		const env = {
			APP_KV: kv,
			LOGIN_PASSPHRASE_HASH: await hashPassphrase(PASS, 1000),
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => authReq,
				lookupClient: async () => ({ clientId: "client-1", clientName: "Claude <b>" }),
				completeAuthorization: async (opts: unknown) => {
					completed.push(opts);
					return { redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc&state=s" };
				},
			},
		} as unknown as Env;

		const open = async () => {
			const res = await AuthHandler.request("https://x.dev/authorize?client_id=client-1", {}, env);
			const html = await res.text();
			const state = /name="state" value="([0-9a-f]+)"/.exec(html)?.[1];
			const cookie = res.headers.get("set-cookie")?.split(";")[0];
			return { res, html, state, cookie };
		};
		const submit = (state: string, cookie: string | undefined, passphrase: string, ip = "1.2.3.4") => {
			const body = new URLSearchParams({ state, passphrase });
			return AuthHandler.request(
				"https://x.dev/authorize",
				{
					method: "POST",
					body,
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						"CF-Connecting-IP": ip,
						...(cookie ? { cookie } : {}),
					},
				},
				env,
			);
		};
		return { env, kv, completed, open, submit };
	}

	it("renders a login form with escaped client name and binds state to a cookie", async () => {
		const { open } = await setup();
		const { res, html, state, cookie } = await open();
		expect(res.status).toBe(200);
		expect(html).toContain("Claude &lt;b&gt;");
		expect(html).toContain("claude.ai");
		expect(state).toBeTruthy();
		expect(cookie).toBe(`__Host-garmin_login=${state}`);
		expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		// form-action must allow the post-login redirect to the client, or browsers block it.
		expect(res.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
	});

	it("completes authorization with the right passphrase", async () => {
		const { open, submit, completed, kv } = await setup();
		const { state, cookie } = await open();
		const res = await submit(state!, cookie, PASS);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("code=abc");
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({ userId: "owner", request: authReq });
		expect(kv.store.has(`login:state:${state}`)).toBe(false);
	});

	it("rejects a wrong passphrase and locks out after repeated failures", async () => {
		const { open, submit, completed } = await setup();
		const { state, cookie } = await open();
		for (let i = 0; i < LIMITS.ip.max; i++) {
			const res = await submit(state!, cookie, "wrong");
			expect(res.status).toBe(401);
		}
		const locked = await submit(state!, cookie, PASS);
		expect(locked.status).toBe(429);
		expect(locked.headers.get("retry-after")).toBeTruthy();
		expect(completed).toHaveLength(0);
	});

	it("rejects submissions without the matching state cookie (CSRF)", async () => {
		const { open, submit, completed } = await setup();
		const { state } = await open();
		expect((await submit(state!, undefined, PASS)).status).toBe(400);
		expect((await submit(state!, "__Host-garmin_login=other", PASS)).status).toBe(400);
		expect(completed).toHaveLength(0);
	});

	it("rejects unknown/expired state", async () => {
		const { submit } = await setup();
		const res = await submit("deadbeef", "__Host-garmin_login=deadbeef", PASS);
		expect(res.status).toBe(400);
	});
});

describe("scripts/new-passphrase.mjs", () => {
	it("generates strong passphrases whose hash the Worker can verify", async () => {
		// @ts-expect-error plain JS module
		const script = await import("../scripts/new-passphrase.mjs");
		const p: string = script.generatePassphrase();
		expect(p).toMatch(/^([A-Za-z2-9]{4}-){7}[A-Za-z2-9]{4}$/);
		expect(p.replace(/-/g, "").length).toBeGreaterThanOrEqual(24);
		expect(script.generatePassphrase()).not.toBe(p);
		const stored: string = await script.hashPassphrase(p, 1000);
		expect(await verifyPassphrase(p, stored)).toBe(true);
	});
});
