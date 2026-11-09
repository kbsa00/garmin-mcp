import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "../src/dates";
import { GarminClient, TOKEN_PATH } from "../src/garmin/client";
import { GarminRecoverySource, RecoveryService } from "../src/recovery/service";
import { bodyBatteryDay, fakeJwt, hrvDay, sleepDay, summaryDay } from "./fixtures/garmin";
import { json, MemoryKV, mockFetch } from "./helpers";

// 07:30 Oslo on 2026-11-05.
const NOW = new Date("2026-11-05T06:30:00Z");
const TODAY = "2026-11-05";

interface Overrides {
	sleepStatus?: number;
	hrvStatus?: number;
	status429?: boolean;
}

function setup(o: Overrides = {}) {
	const { fn, calls } = mockFetch((url) => {
		const p = url.pathname;
		const q = url.searchParams;
		if (p === TOKEN_PATH) return new Response(fakeJwt(NOW.getTime() / 1000 + 86400));
		if (o.status429) return new Response("", { status: 429 });
		if (p === "/usersummary-service/v2/dailysummaries") {
			return json({
				data: dateRange(q.get("startDate")!, q.get("endDate")!).map((d, i) => summaryDay(d, 50 + (i % 3), 30)),
			});
		}
		if (p === "/sleep-service/sleep/dailySleepSummariesByDate") {
			if (o.sleepStatus) return new Response("", { status: o.sleepStatus });
			return json(dateRange(q.get("startDate")!, q.get("endDate")!).map((d) => sleepDay(d)));
		}
		if (p.startsWith("/hrv-service/hrv/daily/")) {
			if (o.hrvStatus) return new Response(null, { status: o.hrvStatus });
			const [, , , , from, to] = p.split("/");
			return json({ hrvSummaries: dateRange(from!, to!).map((d, i) => hrvDay(d, 40 + i)) });
		}
		if (p === "/wellness-service/wellness/bodyBattery/reports/daily") {
			return json(dateRange(q.get("startDate")!, q.get("endDate")!).map((d) => bodyBatteryDay(d)));
		}
		return new Response("", { status: 404 });
	});
	const client = new GarminClient({ apiKey: "k", kv: new MemoryKV(), fetch: fn, now: () => NOW.getTime(), sleep: async () => {} });
	const service = new RecoveryService(new GarminRecoverySource(client), () => NOW);
	const dataCalls = () => calls.filter((c) => c.url.pathname !== TOKEN_PATH);
	return { service, calls, dataCalls };
}

describe("RecoveryService.getRecovery", () => {
	it("defaults to today in Oslo and uses 4 Garmin calls", async () => {
		const { service, dataCalls } = setup();
		const r = await service.getRecovery();
		expect(r.recovery.date).toBe(TODAY);
		expect(r.timezone).toBe("Europe/Oslo");
		expect(r.recovery.sleep.score).toBe(82);
		expect(r.recovery.hrv.last_night_avg_ms).toBe(40);
		expect(r.recovery.resting_heart_rate_bpm).toBe(51);
		expect(r.recovery.stress.previous_day_avg_level).toBe(30);
		expect(r.notes.some((n) => n.includes("today so far"))).toBe(true);
		expect(dataCalls()).toHaveLength(4);
		const ds = dataCalls().find((c) => c.url.pathname.includes("dailysummaries"))!;
		expect(ds.url.searchParams.get("startDate")).toBe("2026-11-04");
	});

	it("returns null fields (not an error) when an endpoint has no data or fails", async () => {
		const { service } = setup({ hrvStatus: 204, sleepStatus: 500 });
		const r = await service.getRecovery("2026-11-01");
		expect(r.recovery.hrv.last_night_avg_ms).toBeNull();
		expect(r.recovery.sleep.score).toBeNull();
		expect(r.recovery.missing).toContain("hrv.status");
		expect(r.recovery.missing).toContain("sleep.duration_seconds");
		expect(r.unavailable_sources).toEqual(["sleep: Garmin returned HTTP 500 for /sleep-service/sleep/dailySleepSummariesByDate."]);
		expect(r.notes.some((n) => n.includes("today so far"))).toBe(false);
	});

	it("propagates rate limiting as a clear error", async () => {
		const { service } = setup({ status429: true });
		await expect(service.getRecovery()).rejects.toThrow(/rate limiting/);
	});

	it("rejects future dates", async () => {
		const { service } = setup();
		await expect(service.getRecovery("2026-11-06")).rejects.toThrow(/future/);
	});
});

describe("RecoveryService.getTrend", () => {
	it("returns N days ending today plus 7/28-day averages with at most 6 calls for 60 days", async () => {
		const { service, dataCalls } = setup();
		const t = await service.getTrend(60);
		expect(t.days).toHaveLength(60);
		expect(t.start_date).toBe(addDays(TODAY, -59));
		expect(t.end_date).toBe(TODAY);
		expect(t.days[0]!.date).toBe(t.start_date);
		expect(t.days.at(-1)!.date).toBe(TODAY);
		expect(dataCalls()).toHaveLength(6);

		// HRV fixture: 40 + index from the first requested day (60 days -> last day = 99).
		expect(t.averages.hrv_last_night_avg_ms.last_7_days).toEqual({ value: 96, days_with_data: 7 });
		expect(t.averages.hrv_last_night_avg_ms.last_28_days).toEqual({ value: 85.5, days_with_data: 28 });
		expect(t.averages.resting_heart_rate_bpm.last_28_days.days_with_data).toBe(28);
	});

	it("still computes a 28-day average when fewer days are requested", async () => {
		const { service, dataCalls } = setup();
		const t = await service.getTrend(3);
		expect(t.days.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", TODAY]);
		expect(t.averages.hrv_last_night_avg_ms.last_28_days.days_with_data).toBe(28);
		expect(dataCalls()).toHaveLength(4);
	});

	it("validates days", async () => {
		const { service } = setup();
		await expect(service.getTrend(0)).rejects.toThrow(RangeError);
		await expect(service.getTrend(61)).rejects.toThrow(RangeError);
		await expect(service.getTrend(2.5)).rejects.toThrow(RangeError);
	});
});

describe("RecoveryService.getTrend output", () => {
	it("returns compact rows and missing counts", async () => {
		const { service } = setup({ hrvStatus: 204 });
		const t = await service.getTrend(7);
		expect(t.days[0]).toEqual({
			date: "2026-10-30",
			sleep_score: 82,
			sleep_duration_hours: 7.33,
			deep_sleep_hours: 1.33,
			rem_sleep_hours: 1.83,
			hrv_last_night_avg_ms: null,
			hrv_status: null,
			resting_heart_rate_bpm: expect.any(Number),
			body_battery_at_wake: 84,
			body_battery_highest: 85,
			stress_avg_level: 30,
		});
		expect(t.days_missing).toMatchObject({ hrv_last_night_avg_ms: 7, hrv_status: 7 });
	});

	it("fails the whole call when the API key is rejected", async () => {
		const { fn } = mockFetch((url) => (url.pathname === TOKEN_PATH ? new Response("", { status: 400 }) : json({})));
		const client = new GarminClient({ apiKey: "", kv: new MemoryKV(), fetch: fn });
		const service = new RecoveryService(new GarminRecoverySource(client), () => NOW);
		await expect(service.getRecovery()).rejects.toThrow(/Personal API key/);
	});
});
