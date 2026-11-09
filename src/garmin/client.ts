// Garmin Connect Personal API client: token exchange + cached bearer token + resilient GET.

export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

const TOKEN_CACHE_KEY = "garmin:access_token";
/** Refresh this long before the JWT's own expiry. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const MAX_429_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 5000;
const REQUEST_TIMEOUT_MS = 20000;

/** "token" = the API-key exchange itself failed (nothing else can work until it is fixed). */
export type GarminErrorKind = "auth" | "token" | "rate_limited" | "upstream" | "network" | "bad_request" | "not_found";

export class GarminError extends Error {
	constructor(
		public kind: GarminErrorKind,
		message: string,
		public status?: number,
	) {
		super(message);
		this.name = "GarminError";
	}
}

/** Subset of KVNamespace used here, so tests can pass a Map-backed fake. */
export interface KVLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface GarminClientOptions {
	apiKey: string;
	kv: KVLike;
	fetch?: typeof fetch;
	baseUrl?: string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** 429 handling; the defaults keep interactive tool calls short. Backfill uses longer waits. */
	max429Retries?: number;
	maxRetryAfterMs?: number;
}

interface CachedToken {
	token: string;
	expiresAt: number; // epoch ms
}

export interface TokenInfo {
	expiresAt: number;
	fromCache: boolean;
}

export class GarminClient {
	private readonly apiKey: string;
	private readonly kv: KVLike;
	private readonly fetchFn: typeof fetch;
	private readonly baseUrl: string;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private memo: CachedToken | null = null;
	private inflight: Promise<CachedToken> | null = null;
	private readonly max429Retries: number;
	private readonly maxRetryAfterMs: number;

	constructor(opts: GarminClientOptions) {
		this.apiKey = opts.apiKey;
		this.kv = opts.kv;
		this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
		this.baseUrl = opts.baseUrl ?? GARMIN_BASE_URL;
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.now = opts.now ?? Date.now;
		this.max429Retries = opts.max429Retries ?? MAX_429_RETRIES;
		this.maxRetryAfterMs = opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
	}

	/** Returns a valid access token, exchanging the API key when none is cached or `force` is set. */
	async getToken(force = false): Promise<{ token: string } & TokenInfo> {
		if (!force) {
			const cached = this.memo ?? (await this.readCache());
			if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
				this.memo = cached;
				return { token: cached.token, expiresAt: cached.expiresAt, fromCache: true };
			}
		}
		// Parallel callers share one exchange instead of each requesting a token.
		this.inflight ??= this.refresh().finally(() => {
			this.inflight = null;
		});
		const fresh = await this.inflight;
		return { token: fresh.token, expiresAt: fresh.expiresAt, fromCache: false };
	}

	private async refresh(): Promise<CachedToken> {
		const fresh = await this.exchangeKey();
		this.memo = fresh;
		const ttlSeconds = Math.floor((fresh.expiresAt - this.now()) / 1000);
		// KV requires expirationTtl >= 60.
		if (ttlSeconds >= 60) {
			await this.kv.put(TOKEN_CACHE_KEY, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
		}
		return fresh;
	}

	/**
	 * GET a JSON endpoint. 401 → one forced token refresh and retry. 429 → backoff, then
	 * GarminError("rate_limited"). 204 / empty body → null.
	 */
	async get<T>(path: string): Promise<T | null> {
		const res = await this.send(path, "application/json");
		if (!res) return null;
		const text = await res.text();
		if (!text.trim()) return null;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new GarminError("upstream", `Garmin returned non-JSON data for ${stripQuery(path)}.`);
		}
	}

	/** GET a binary endpoint (e.g. a FIT download). Same retry rules as get(). */
	async getBytes(path: string): Promise<Uint8Array | null> {
		const res = await this.send(path, "*/*");
		if (!res) return null;
		const bytes = new Uint8Array(await res.arrayBuffer());
		return bytes.length ? bytes : null;
	}

	/** Returns the successful response, or null for 204. */
	private async send(path: string, accept: string): Promise<Response | null> {
		let { token } = await this.getToken();
		let refreshed = false;
		let rateLimitRetries = 0;

		for (;;) {
			const res = await this.request(path, token, accept);

			if (res.status === 401 || res.status === 403) {
				if (!refreshed) {
					refreshed = true;
					// Reuse a token another parallel request already refreshed.
					({ token } = this.memo && this.memo.token !== token ? this.memo : await this.getToken(true));
					continue;
				}
				throw new GarminError("auth", `Garmin rejected the access token (HTTP ${res.status}) even after refreshing it.`, res.status);
			}

			if (res.status === 429) {
				if (rateLimitRetries < this.max429Retries) {
					rateLimitRetries++;
					await this.sleep(retryDelayMs(res.headers.get("retry-after"), rateLimitRetries, this.maxRetryAfterMs));
					continue;
				}
				throw new GarminError(
					"rate_limited",
					"Garmin is rate limiting requests (HTTP 429). Wait a few minutes and try again.",
					429,
				);
			}

			if (res.status === 204) return null;
			if (res.status === 400) {
				throw new GarminError("bad_request", `Garmin rejected the request parameters (HTTP 400) for ${stripQuery(path)}.`, 400);
			}
			if (res.status === 404) {
				throw new GarminError("not_found", `Garmin has no resource at ${stripQuery(path)} (HTTP 404).`, 404);
			}
			if (!res.ok) {
				throw new GarminError("upstream", `Garmin returned HTTP ${res.status} for ${stripQuery(path)}.`, res.status);
			}
			return res;
		}
	}

	private async request(path: string, token: string, accept: string): Promise<Response> {
		try {
			return await this.fetchFn(this.baseUrl + path, {
				headers: { Accept: accept, Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			throw new GarminError("network", `Could not reach Garmin: ${(err as Error).message}`);
		}
	}

	private async exchangeKey(): Promise<CachedToken> {
		let res: Response;
		try {
			res = await this.fetchFn(this.baseUrl + TOKEN_PATH, {
				method: "POST",
				headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			throw new GarminError("token", `Could not reach the Garmin token endpoint: ${(err as Error).message}`);
		}
		if (res.status === 400 || res.status === 401 || res.status === 403) {
			throw new GarminError(
				"auth",
				`Garmin rejected the Personal API key (HTTP ${res.status}). It is probably missing, expired or revoked; create a new key and update the GARMIN_API_KEY secret.`,
				res.status,
			);
		}
		if (res.status === 429) {
			throw new GarminError("rate_limited", "Garmin is rate limiting token requests (HTTP 429). Wait a few minutes and try again.", 429);
		}
		if (!res.ok) {
			throw new GarminError("token", `Garmin token endpoint returned HTTP ${res.status}. Try again later.`, res.status);
		}
		const token = (await res.text()).trim();
		const exp = jwtExpiry(token);
		// Fall back to the documented 24h lifetime if the token is not a readable JWT.
		return { token, expiresAt: exp ?? this.now() + 24 * 3600 * 1000 };
	}

	private async readCache(): Promise<CachedToken | null> {
		const raw = await this.kv.get(TOKEN_CACHE_KEY);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as CachedToken;
			return typeof parsed.token === "string" && typeof parsed.expiresAt === "number" ? parsed : null;
		} catch {
			return null;
		}
	}
}

/** Reads the `exp` claim (seconds) of a JWT without verifying it; returns epoch ms. */
export function jwtExpiry(token: string): number | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4);
		const exp = JSON.parse(atob(b64)).exp;
		return typeof exp === "number" ? exp * 1000 : null;
	} catch {
		return null;
	}
}

function retryDelayMs(retryAfter: string | null, attempt: number, cap: number): number {
	const seconds = retryAfter ? Number(retryAfter) : NaN;
	const ms = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** (attempt - 1);
	return Math.min(Math.max(ms, 0), cap);
}

function stripQuery(path: string): string {
	return path.split("?")[0]!;
}
