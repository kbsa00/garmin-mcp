// Default (non-API) handler for the OAuthProvider: the built-in single-user authorize page.

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { renderLoginPage } from "./page";
import { verifyPassphrase } from "./passphrase";
import { LoginRateLimiter } from "./ratelimit";

export const OWNER_USER_ID = "owner";
const STATE_COOKIE = "__Host-garmin_login";
const STATE_TTL_SECONDS = 600;
const stateKey = (token: string) => `login:state:${token}`;

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
	await next();
	c.header("X-Frame-Options", "DENY");
	if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", loginCsp(null));
	c.header("Referrer-Policy", "no-referrer");
	c.header("Cache-Control", "no-store");
});

app.get("/", (c) => c.text("Garmin recovery MCP connector. MCP endpoint: /mcp (OAuth required)."));

app.get("/authorize", async (c) => {
	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch (err) {
		return c.text(`Invalid authorization request: ${(err as Error).message}`, 400);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid authorization request", 400);

	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	if (!client) return c.text("Unknown client", 400);

	const token = randomToken();
	await c.env.APP_KV.put(stateKey(token), JSON.stringify(oauthReqInfo), { expirationTtl: STATE_TTL_SECONDS });

	const ip = clientIp(c.req.raw);
	const locked = await new LoginRateLimiter(c.env.APP_KV).lockedFor(ip);

	c.header("Set-Cookie", stateCookie(token, STATE_TTL_SECONDS));
	c.header("Content-Security-Policy", loginCsp(oauthReqInfo.redirectUri));
	return c.html(
		renderLoginPage({
			state: token,
			clientName: client.clientName || "An MCP client",
			redirectHost: safeHost(oauthReqInfo.redirectUri),
			locked: locked > 0,
			error: locked > 0 ? lockMessage(locked) : undefined,
		}),
	);
});

app.post("/authorize", async (c) => {
	const form = await c.req.raw.formData();
	const state = form.get("state");
	const passphrase = form.get("passphrase");
	if (typeof state !== "string" || !state || typeof passphrase !== "string") {
		return c.text("Invalid form submission", 400);
	}

	// The state must match the cookie set when this browser loaded the page (CSRF / session binding).
	if (getCookie(c, STATE_COOKIE) !== state) return c.text("Login session mismatch. Start the connection again.", 400);

	const raw = await c.env.APP_KV.get(stateKey(state));
	if (!raw) return c.text("Login session expired. Start the connection again from Claude.", 400);
	const oauthReqInfo = JSON.parse(raw) as AuthRequest;
	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	c.header("Content-Security-Policy", loginCsp(oauthReqInfo.redirectUri));
	const page = (error: string, locked = false) =>
		renderLoginPage({
			state,
			clientName: client?.clientName || "An MCP client",
			redirectHost: safeHost(oauthReqInfo.redirectUri),
			error,
			locked,
		});

	const ip = clientIp(c.req.raw);
	const limiter = new LoginRateLimiter(c.env.APP_KV);
	const lockedFor = await limiter.lockedFor(ip);
	if (lockedFor > 0) {
		c.header("Retry-After", String(lockedFor));
		return c.html(page(lockMessage(lockedFor), true), 429);
	}

	const valid = await verifyPassphrase(passphrase, c.env.LOGIN_PASSPHRASE_HASH ?? "");
	if (!valid) {
		await limiter.recordFailure(ip);
		return c.html(page("Wrong passphrase."), 401);
	}

	await Promise.all([c.env.APP_KV.delete(stateKey(state)), limiter.clear(ip)]);
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: OWNER_USER_ID,
		metadata: { label: "owner" },
		scope: oauthReqInfo.scope,
		props: { user: OWNER_USER_ID },
	});
	return new Response(null, {
		status: 302,
		headers: { Location: redirectTo, "Set-Cookie": stateCookie("", 0), "Cache-Control": "no-store" },
	});
});

app.notFound((c) => c.text("Not found", 404));

export { app as AuthHandler };

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stateCookie(value: string, maxAge: number): string {
	return namedCookie(STATE_COOKIE, value, maxAge);
}

function namedCookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clientIp(req: Request): string {
	return req.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * CSP for the login page. Browsers enforce form-action on the redirect that follows the form POST
 * as well, so the client's redirect origin (already validated against its registration by
 * parseAuthRequest) must be allowed next to 'self'.
 */
function loginCsp(redirectUri: string | null): string {
	let origin = "";
	try {
		if (redirectUri) origin = " " + new URL(redirectUri).origin;
	} catch {
		// invalid URI: keep 'self' only
	}
	return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${origin}; frame-ancestors 'none'`;
}

function safeHost(uri: string): string {
	try {
		return new URL(uri).host;
	} catch {
		return "unknown";
	}
}

function lockMessage(seconds: number): string {
	return `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`;
}
