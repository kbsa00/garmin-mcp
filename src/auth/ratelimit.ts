// Failed-login rate limiting in KV: per client IP and globally (single-user server, so a global
// cap is a cheap backstop against distributed guessing). KV is eventually consistent, so limits
// are approximate; the passphrase's entropy is the real defense.

import type { KVLike } from "../garmin/client";

export const LIMITS = {
	ip: { max: 5, windowSeconds: 15 * 60 },
	global: { max: 20, windowSeconds: 60 * 60 },
} as const;

interface Counter {
	count: number;
	resetAt: number; // epoch seconds
}

const ipKey = (ip: string) => `login:fail:ip:${ip}`;
const GLOBAL_KEY = "login:fail:global";

export class LoginRateLimiter {
	constructor(
		private kv: KVLike,
		private now: () => number = Date.now,
	) {}

	/** Returns seconds until login is allowed again, or 0 if not locked. */
	async lockedFor(ip: string): Promise<number> {
		const nowSec = Math.floor(this.now() / 1000);
		const [ipC, globalC] = await Promise.all([this.read(ipKey(ip), nowSec), this.read(GLOBAL_KEY, nowSec)]);
		let wait = 0;
		if (ipC && ipC.count >= LIMITS.ip.max) wait = Math.max(wait, ipC.resetAt - nowSec);
		if (globalC && globalC.count >= LIMITS.global.max) wait = Math.max(wait, globalC.resetAt - nowSec);
		return wait;
	}

	async recordFailure(ip: string): Promise<void> {
		const nowSec = Math.floor(this.now() / 1000);
		await Promise.all([
			this.bump(ipKey(ip), LIMITS.ip.windowSeconds, nowSec),
			this.bump(GLOBAL_KEY, LIMITS.global.windowSeconds, nowSec),
		]);
	}

	async clear(ip: string): Promise<void> {
		await this.kv.delete(ipKey(ip));
	}

	private async read(key: string, nowSec: number): Promise<Counter | null> {
		const raw = await this.kv.get(key);
		if (!raw) return null;
		try {
			const c = JSON.parse(raw) as Counter;
			return c.resetAt > nowSec ? c : null;
		} catch {
			return null;
		}
	}

	private async bump(key: string, windowSeconds: number, nowSec: number): Promise<void> {
		const existing = await this.read(key, nowSec);
		const next: Counter = existing
			? { count: existing.count + 1, resetAt: existing.resetAt }
			: { count: 1, resetAt: nowSec + windowSeconds };
		// KV expirations must be at least 60s in the future.
		await this.kv.put(key, JSON.stringify(next), { expiration: Math.max(next.resetAt, nowSec + 60) });
	}
}
