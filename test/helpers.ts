import type { KVLike } from "../src/garmin/client";

export class MemoryKV implements KVLike {
	store = new Map<string, string>();
	async get(key: string) {
		return this.store.get(key) ?? null;
	}
	async put(key: string, value: string) {
		this.store.set(key, value);
	}
	async delete(key: string) {
		this.store.delete(key);
	}
}

export type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fetch mock that records calls and dispatches to `route`. */
export function mockFetch(route: Route) {
	const calls: Array<{ url: URL; init?: RequestInit }> = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		calls.push({ url, init });
		return route(url, init);
	}) as typeof fetch;
	return { fn, calls };
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
