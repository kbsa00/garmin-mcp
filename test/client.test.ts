import { describe, expect, it } from "vitest";
import { GarminClient, GarminError, jwtExpiry, TOKEN_PATH } from "../src/garmin/client";
import { fakeJwt } from "./fixtures/garmin";
import { json, MemoryKV, mockFetch, type Route } from "./helpers";

const NOW = Date.UTC(2026, 10, 5, 6, 0);
const EXP = NOW / 1000 + 24 * 3600;

function setup(dataRoute: Route, tokenRoute?: Route) {
	let tokenCount = 0;
	const { fn, calls } = mockFetch((url, init) => {
		if (url.pathname === TOKEN_PATH) {
			tokenCount++;
			if (tokenRoute) return tokenRoute(url, init);
			return new Response(fakeJwt(EXP) + `${tokenCount}`, { headers: { "content-type": "text/plain" } });
		}
		return dataRoute(url, init);
	});
	const kv = new MemoryKV();
	const sleeps: number[] = [];
	const client = new GarminClient({
		apiKey: "test-key",
		kv,
		fetch: fn,
		now: () => NOW,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { client, kv, calls, sleeps, tokenCount: () => tokenCount };
}

const authHeader = (init?: RequestInit) => new Headers(init?.headers).get("Authorization");

describe("GarminClient", () => {
	it("exchanges the API key with the ApiKey header and caches the token in KV", async () => {
		const { client, kv, calls, tokenCount } = setup(() => json({ ok: 1 }));
		await client.get("/x");
		await client.get("/y");
		expect(tokenCount()).toBe(1);
		expect(authHeader(calls[0]!.init)).toBe("ApiKey test-key");
		expect(calls[0]!.init?.method).toBe("POST");
		expect(authHeader(calls[1]!.init)).toMatch(/^Bearer /);
		const cached = JSON.parse(kv.store.get("garmin:access_token")!);
		expect(cached.expiresAt).toBe(EXP * 1000);
	});

	it("reuses a valid token cached in KV across client instances", async () => {
		const first = setup(() => json({}));
		await first.client.getToken();
		const second = new GarminClient({
			apiKey: "k",
			kv: first.kv,
			now: () => NOW,
			fetch: (async () => {
				throw new Error("should not fetch");
			}) as typeof fetch,
		});
		const t = await second.getToken();
		expect(t.fromCache).toBe(true);
	});

	it("requests a new token when the cached one is (nearly) expired", async () => {
		const { client, kv, tokenCount } = setup(() => json({}));
		await kv.put("garmin:access_token", JSON.stringify({ token: "old", expiresAt: NOW + 60_000 }));
		const t = await client.getToken();
		expect(t.fromCache).toBe(false);
		expect(tokenCount()).toBe(1);
	});

	it("shares one token exchange between parallel requests", async () => {
		const { client, tokenCount } = setup(() => json({}));
		await Promise.all([client.get("/a"), client.get("/b"), client.get("/c"), client.get("/d")]);
		expect(tokenCount()).toBe(1);
	});

	it("on 401 fetches a new token once and retries", async () => {
		let n = 0;
		const { client, tokenCount } = setup(() => (n++ === 0 ? new Response("", { status: 401 }) : json({ v: 1 })));
		expect(await client.get("/x")).toEqual({ v: 1 });
		expect(tokenCount()).toBe(2);
	});

	it("gives up with an auth error if the retry is also 401", async () => {
		const { client, tokenCount } = setup(() => new Response("", { status: 401 }));
		await expect(client.get("/x")).rejects.toMatchObject({ kind: "auth" });
		expect(tokenCount()).toBe(2);
	});

	it("reports an expired/revoked API key clearly", async () => {
		const { client } = setup(() => json({}), () => new Response("", { status: 401 }));
		await expect(client.get("/x")).rejects.toThrow(/Personal API key/);
	});

	it("backs off on 429 and succeeds when the limit clears", async () => {
		let n = 0;
		const { client, sleeps } = setup(() =>
			n++ < 2 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : json({ v: 2 }),
		);
		expect(await client.get("/x")).toEqual({ v: 2 });
		expect(sleeps).toEqual([2000, 2000]);
	});

	it("returns a clear rate_limited error when 429 persists", async () => {
		const { client, sleeps } = setup(() => new Response("", { status: 429 }));
		const err = (await client.get("/x").catch((e) => e)) as GarminError;
		expect(err).toBeInstanceOf(GarminError);
		expect(err.kind).toBe("rate_limited");
		expect(err.message).toMatch(/rate limiting/);
		expect(sleeps).toEqual([1000, 2000]);
	});

	it("caps Retry-After so a tool call never hangs", async () => {
		const { client, sleeps } = setup(() => new Response("", { status: 429, headers: { "retry-after": "600" } }));
		await client.get("/x").catch(() => {});
		expect(Math.max(...sleeps)).toBe(5000);
	});

	it("treats 204 and empty bodies as no data", async () => {
		const a = setup(() => new Response(null, { status: 204 }));
		expect(await a.client.get("/x")).toBeNull();
		const b = setup(() => new Response("", { status: 200 }));
		expect(await b.client.get("/x")).toBeNull();
	});

	it("maps other failures to upstream / network errors", async () => {
		const a = setup(() => new Response("boom", { status: 500 }));
		await expect(a.client.get("/x?secret=1")).rejects.toMatchObject({ kind: "upstream", message: "Garmin returned HTTP 500 for /x." });
		const b = setup(() => {
			throw new TypeError("connection reset");
		});
		await expect(b.client.get("/x")).rejects.toMatchObject({ kind: "network" });
	});

	it("parses JWT exp", () => {
		expect(jwtExpiry(fakeJwt(1234))).toBe(1234000);
		expect(jwtExpiry("not-a-jwt")).toBeNull();
	});
});
