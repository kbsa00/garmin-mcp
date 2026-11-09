import { describe, expect, it } from "vitest";
import { ActivityService, STATE } from "../src/activities/service";
import { addDays, dateRange } from "../src/dates";
import { Store } from "../src/db/store";
import { normalizeActivity, type SummarizedActivityDTO } from "../src/garmin/activities";
import { GarminClient, TOKEN_PATH } from "../src/garmin/client";
import { GarminRecoverySource, RecoveryService } from "../src/recovery/service";
import { backfill, dailySync, isOsloSyncHour } from "../src/sync/sync";
import { TestD1 } from "./d1";
import { runFit, strengthFit, withVo2, zip } from "./fixtures/fit";
import { bodyBatteryDay, fakeJwt, hrvDay, sleepDay, summaryDay } from "./fixtures/garmin";
import { json, MemoryKV, mockFetch } from "./helpers";

const NOW = new Date("2026-11-05T06:30:00Z");
const TODAY = "2026-11-05";
const DATA_FROM = "2026-08-01";

function activity(id: number, date: string, type: string, load: number, extra: Partial<SummarizedActivityDTO> = {}): SummarizedActivityDTO {
	return {
		activityId: id,
		activityName: `${type} ${id}`,
		startTimeLocal: `${date} 07:00:00`,
		startTimeGMT: `${date} 06:00:00`,
		activityType: { typeKey: type },
		distance: type.includes("running") ? 10000 : 0,
		duration: 3000,
		movingDuration: 3000,
		elapsedDuration: 3100,
		averageSpeed: type.includes("running") ? 3.333 : 0,
		averageHR: 150,
		maxHR: 175,
		averageRunningCadenceInStepsPerMinute: type.includes("running") ? 172 : 0,
		avgStrideLength: type.includes("running") ? 112.5 : 0,
		avgVerticalOscillation: 8.4,
		aerobicTrainingEffect: 3.1,
		anaerobicTrainingEffect: 1.2,
		trainingEffectLabel: "AEROBIC_BASE",
		activityTrainingLoad: load,
		lapCount: 3,
		...extra,
	};
}

// Activities every other day since DATA_FROM; runs on even days, strength on odd.
const ACTIVITIES_ALL = dateRange(DATA_FROM, TODAY)
	.filter((_, i) => i % 2 === 0)
	.map((d, i) => (i % 2 === 0 ? activity(1000 + i, d, "running", 80) : activity(1000 + i, d, "strength_training", 40)));
const ACTIVITIES: SummarizedActivityDTO[] = ACTIVITIES_ALL;
const RUNS = ACTIVITIES.filter((a) => a.activityType?.typeKey === "running").length;

function setup(opts: { withStore?: boolean; fitStatus?: number } = {}) {
	const counts: Record<string, number> = {};
	const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
	const inRange = (q: URLSearchParams, d: string) => d >= (q.get("startDate") ?? "0") && d <= (q.get("endDate") ?? "9");
	const { fn } = mockFetch((url) => {
		const p = url.pathname;
		const q = url.searchParams;
		if (p === TOKEN_PATH) return new Response(fakeJwt(NOW.getTime() / 1000 + 86400));
		bump(p.split("/").slice(0, 3).join("/"));
		if (p === "/activitylist-service/activities/search/activities") {
			const rows = ACTIVITIES.filter((a) => inRange(q, a.startTimeLocal!.slice(0, 10))).reverse();
			const start = Number(q.get("start") ?? 0);
			return json(rows.slice(start, start + Number(q.get("limit") ?? 100)));
		}
		if (p.startsWith("/download-service/files/activity/")) {
			if (opts.fitStatus) return new Response("", { status: opts.fitStatus });
			const id = Number(p.split("/").pop());
			const a = ACTIVITIES.find((x) => x.activityId === id);
			return new Response(zip(a?.activityType?.typeKey === "running" ? withVo2(runFit()) : strengthFit()));
		}
		if (p.startsWith("/activity-service/activity/")) {
			const id = Number(p.split("/").pop());
			const a = ACTIVITIES.find((x) => x.activityId === id);
			if (!a) return new Response("", { status: 404 });
			return json({
				activityId: id,
				activityName: a.activityName,
				activityTypeDTO: { typeKey: a.activityType!.typeKey },
				summaryDTO: { startTimeLocal: a.startTimeLocal!.replace(" ", "T") + ".0", startTimeGMT: a.startTimeGMT!.replace(" ", "T") + ".0", distance: a.distance, duration: a.duration, activityTrainingLoad: a.activityTrainingLoad, trainingEffect: 3.1 },
			});
		}
		const range = (s: string, e: string) => dateRange(s < DATA_FROM ? DATA_FROM : s, e);
		if (p === "/usersummary-service/v2/dailysummaries") return json({ data: range(q.get("startDate")!, q.get("endDate")!).map((d) => summaryDay(d, 50)) });
		if (p === "/sleep-service/sleep/dailySleepSummariesByDate") return json(range(q.get("startDate")!, q.get("endDate")!).map((d) => sleepDay(d)));
		if (p.startsWith("/hrv-service/hrv/daily/")) {
			const [, , , , from, to] = p.split("/");
			const days = range(from!, to!);
			return days.length ? json({ hrvSummaries: days.map((d) => hrvDay(d, 50)) }) : new Response(null, { status: 204 });
		}
		if (p === "/wellness-service/wellness/bodyBattery/reports/daily") return json(range(q.get("startDate")!, q.get("endDate")!).map((d) => bodyBatteryDay(d)));
		return new Response("", { status: 404 });
	});
	const client = new GarminClient({ apiKey: "k", kv: new MemoryKV(), fetch: fn, now: () => NOW.getTime(), sleep: async () => {} });
	const d1 = new TestD1();
	const store = opts.withStore === false ? null : new Store(d1);
	const recovery = new RecoveryService(new GarminRecoverySource(client), () => NOW, store ?? undefined);
	const activities = new ActivityService(client, store, recovery);
	const deps = { client, store: store!, recovery, activities, now: () => NOW, sleep: async () => {} };
	const reset = () => Object.keys(counts).forEach((k) => delete counts[k]);
	const total = () => Object.values(counts).reduce((a, b) => a + b, 0);
	return { d1, store, recovery, activities, deps, counts, reset, total };
}

describe("normalizeActivity", () => {
	it("converts units and drops zero sentinels", () => {
		const a = normalizeActivity(activity(1, "2026-11-01", "running", 80))!;
		expect(a).toMatchObject({ date: "2026-11-01", start_utc: "2026-11-01T06:00:00.000Z", avg_stride_length_m: 1.125, avg_cadence_spm: 172, training_load: 80, vo2max: null });
		const s = normalizeActivity(activity(2, "2026-11-01", "strength_training", 40))!;
		expect(s.distance_m).toBeNull();
		expect(s.avg_cadence_spm).toBeNull();
		expect(normalizeActivity({ activityId: 3 })).toBeNull();
	});
});

describe("backfill and daily sync", () => {
	it("backfills recovery, activities and every FIT file, idempotently", async () => {
		const { d1, deps, store } = setup();
		const report = await backfill(deps, { delayMs: 0 });
		expect(report.recovery_from).toBe(DATA_FROM);
		expect(report.recovery_incomplete).toBe(false);
		expect(report.activities_upserted).toBe(ACTIVITIES.length);
		// FIT files are only processed for non-strength activities (laps + VO2 max).
		expect(report.fit_processed).toBe(RUNS);
		expect(report.fit_pending).toBe(0);
		expect(d1.count("activities")).toBe(ACTIVITIES.length);
		expect(d1.count("activity_laps")).toBe(Math.ceil(ACTIVITIES.length / 2) * 3);
		expect(await store!.getState(STATE.backfillCompletedAt)).toBe(NOW.toISOString());

		const rows = d1.count("daily_recovery");
		await backfill(deps, { delayMs: 0 });
		expect(d1.count("daily_recovery")).toBe(rows);
		expect(d1.count("activity_laps")).toBe(Math.ceil(ACTIVITIES.length / 2) * 3);
	});

	it("daily sync re-syncs the last 3 days and processes at most 2 FIT files", async () => {
		const { d1, deps } = setup();
		const r = await dailySync(deps);
		expect(r.recovery_days).toBe(3);
		expect(d1.count("daily_recovery")).toBe(3);
		expect(r.activities_upserted).toBe(ACTIVITIES.filter((a) => a.startTimeLocal! >= addDays(TODAY, -2)).length);
		expect(r.fit_processed).toBeLessThanOrEqual(2);
	});

	it("runs the cron only at 05:xx Oslo time", () => {
		expect(isOsloSyncHour(Date.UTC(2026, 0, 10, 4, 30))).toBe(true); // CET
		expect(isOsloSyncHour(Date.UTC(2026, 0, 10, 3, 30))).toBe(false);
		expect(isOsloSyncHour(Date.UTC(2026, 6, 10, 3, 30))).toBe(true); // CEST
		expect(isOsloSyncHour(Date.UTC(2026, 6, 10, 4, 30))).toBe(false);
	});

	it("marks FIT files failed after repeated errors", async () => {
		const { d1, deps } = setup({ fitStatus: 500 });
		await deps.store.upsertActivities([normalizeActivity(ACTIVITIES[0]!)!]);
		for (let i = 0; i < 3; i++) await deps.activities.fetchAndStoreFit(ACTIVITIES[0]!.activityId!);
		expect((d1.db.prepare("SELECT fit_status, fit_attempts FROM activities").get() as Record<string, unknown>)).toEqual({ fit_status: "error", fit_attempts: 3 });
	});
});

describe("tools read D1 first and fall back to the API", () => {
	it("get_recovery and get_recovery_trend use stored final days and only fetch today", async () => {
		const s = setup();
		await backfill(s.deps, { delayMs: 0 });
		s.reset();
		const past = await s.recovery.getRecovery("2026-11-01");
		expect(past.data_source).toBe("d1");
		expect(s.total()).toBe(0);
		const trend = await s.recovery.getTrend(60);
		expect(trend.days).toHaveLength(60);
		expect(trend.data_source).toBe("d1+garmin_api");
		expect(s.total()).toBe(4); // today only
	});

	it("works without D1 (API only)", async () => {
		const s = setup({ withStore: false });
		const r = await s.recovery.getRecovery("2026-11-01");
		expect(r.data_source).toBe("garmin_api");
		expect(r.recovery.sleep.score).toBe(82);
		const acts = await s.activities.getActivities("2026-10-01", "2026-10-31", "running");
		expect(acts.data_source).toBe("garmin_api");
		expect(acts.activities.every((a) => a.type === "running")).toBe(true);
		expect(acts.activities[0]!.avg_pace).toBe("5:00/km");
	});

	it("get_activities: D1 plus a fresh API call from the last sync date", async () => {
		const s = setup();
		await backfill(s.deps, { delayMs: 0 });
		s.reset();
		const old = await s.activities.getActivities("2026-09-01", "2026-09-30");
		expect(old.data_source).toBe("d1");
		expect(s.total()).toBe(0);
		const recent = await s.activities.getActivities("2026-10-01", TODAY);
		expect(recent.data_source).toBe("d1+garmin_api");
		expect(s.counts["/activitylist-service/activities"]).toBe(1);
		expect(recent.totals_by_type.running!.count).toBeGreaterThan(0);
	});

	it("get_activity_detail returns laps from D1 without downloading again", async () => {
		const s = setup();
		await backfill(s.deps, { delayMs: 0 });
		s.reset();
		const run = await s.activities.getActivityDetail(ACTIVITIES[0]!.activityId!);
		expect(run.data_source).toBe("d1");
		expect(run.laps).toHaveLength(3);
		expect(run.laps[0]).toMatchObject({ pace: "5:00/km", avg_cadence: 171, avg_step_length_m: 0.98, avg_ground_contact_ms: 245 });
		expect(run).not.toHaveProperty("strength");
		expect(s.total()).toBe(0);
	});

	it("strength activities are listed (with Garmin load) but their FIT is not downloaded", async () => {
		const s = setup();
		await backfill(s.deps, { delayMs: 0 });
		expect(s.counts["/download-service/files"]).toBe(RUNS);
		const list = await s.activities.getActivities("2026-10-01", "2026-10-31", "strength");
		expect(list.count).toBeGreaterThan(0);
		expect(list.activities.every((a) => a.training_load === 40)).toBe(true);
	});

	it("get_activity_detail downloads and parses the FIT when not yet stored", async () => {
		const s = setup({ withStore: false });
		const d = await s.activities.getActivityDetail(ACTIVITIES[0]!.activityId!);
		expect(d.data_source).toBe("garmin_api");
		expect(d.laps).toHaveLength(3);
		await expect(s.activities.getActivityDetail(42)).rejects.toThrow(/No activity/);
	});

	it("training load, readiness and recovery-after work on stored history", async () => {
		const s = setup();
		await backfill(s.deps, { delayMs: 0 });
		const load = await s.activities.getTrainingLoad(14);
		expect(load.days).toHaveLength(14);
		// Steady pattern: acute ≈ chronic -> maintaining/productive.
		expect(["maintaining", "productive"]).toContain(load.current.status);
		const r1 = await s.activities.getReadiness("2026-11-01");
		const r2 = await s.activities.getReadiness("2026-11-01");
		expect(r1.score).toBe(r2.score);
		expect(r1.score).not.toBeNull();
		const rec = await s.activities.getRecoveryAfter("2026-10-20");
		expect(rec.activities_on_date.length).toBeGreaterThanOrEqual(0);
		expect(rec.daily.length).toBe(15);
	});

	it("VO2 max: null with explanation when Garmin has none", async () => {
		const s = setup();
		const v = await s.activities.getVo2maxTrend(90);
		expect(v.available).toBe(false);
		expect(v.latest_vo2max).toBeNull();
		expect(v.explanation).toMatch(/FIT file .*No value is estimated/);
	});


	it("VO2 max from FIT files survives later syncs and feeds get_vo2max_trend", async () => {
		const s = setup();
		await backfill(s.deps, { delayMs: 0 });
		expect(s.d1.db.prepare("SELECT COUNT(*) AS n FROM activities WHERE vo2max = 45.7 AND vo2max_source = 'fit_file'").get()).toEqual({ n: Math.ceil(ACTIVITIES.length / 2) });
		await dailySync(s.deps); // the search endpoint returns no VO2 max: must not wipe it
		const v = await s.activities.getVo2maxTrend(60);
		expect(v.available).toBe(true);
		expect(v.latest_vo2max).toBe(45.7);
		expect(v.latest_vo2max_rounded_like_watch).toBe(46);
		expect(v.points!.every((p) => p.type === "running")).toBe(true);
		const recent = await s.activities.getActivities(addDays(TODAY, -3), TODAY, "running");
		expect(recent.activities.every((a) => a.vo2max === 45.7)).toBe(true);
	});
});
