import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "../src/dates";
import { computeLoad, loadStatus } from "../src/metrics/load";
import { computeReadiness, loadComponentScore } from "../src/metrics/readiness";
import { computeRecoveryAfter } from "../src/metrics/recovery-after";
import { baseline } from "../src/metrics/stats";
import { formatDuration, formatPace } from "../src/format";
import { type DayRecovery, normalizeDay } from "../src/recovery/normalize";

function day(date: string, hrv: number | null, rhr: number | null, sleepScore: number | null = 80, sleepH: number | null = 8): DayRecovery {
	const d = normalizeDay({ date });
	d.hrv.last_night_avg_ms = hrv;
	d.hrv.baseline_balanced_low_ms = 42;
	d.hrv.baseline_balanced_high_ms = 58;
	d.resting_heart_rate_bpm = rhr;
	d.sleep.score = sleepScore;
	d.sleep.duration_seconds = sleepH == null ? null : sleepH * 3600;
	return d;
}

describe("training load / ACWR", () => {
	it("computes acute/chronic averages and ACWR", () => {
		const loads = new Map<string, number>();
		for (const d of dateRange("2026-10-01", "2026-10-28")) loads.set(d, 50);
		for (const d of dateRange("2026-10-22", "2026-10-28")) loads.set(d, 100);
		const [last] = computeLoad(loads, "2026-10-28", "2026-10-28", "2026-10-01");
		// acute = 100; chronic = (21*50 + 7*100) / 28 = 62.5; ACWR = 1.6
		expect(last).toEqual({ date: "2026-10-28", load: 100, acute_load_7d: 100, chronic_load_28d: 62.5, acwr: 1.6, status: "overreaching_risk" });
	});

	it("treats missing days as zero load and labels status bands", () => {
		const loads = new Map([["2026-10-28", 70]]);
		const [d] = computeLoad(loads, "2026-10-28", "2026-10-28", "2026-01-01");
		expect(d!.acute_load_7d).toBe(10);
		expect(d!.chronic_load_28d).toBe(2.5);
		expect(d!.status).toBe("insufficient_data"); // chronic below minimum
		expect(loadStatus(0.7, 50)).toBe("detraining");
		expect(loadStatus(0.9, 50)).toBe("maintaining");
		expect(loadStatus(1.2, 50)).toBe("productive");
		expect(loadStatus(1.31, 50)).toBe("overreaching_risk");
	});

	it("reports insufficient data when history does not cover the chronic window", () => {
		const loads = new Map(dateRange("2026-10-20", "2026-10-28").map((d) => [d, 60] as const));
		const [d] = computeLoad(loads, "2026-10-28", "2026-10-28", "2026-10-20");
		expect(d!.acute_load_7d).toBe(60);
		expect(d!.chronic_load_28d).toBeNull();
		expect(d!.status).toBe("insufficient_data");
	});
});

describe("readiness", () => {
	const date = "2026-11-05";
	const base = dateRange(addDays(date, -60), addDays(date, -1)).map((d, i) => day(d, 50 + (i % 5) - 2, 55 + (i % 3) - 1));

	it("is deterministic and explains itself", () => {
		const input = { date, day: day(date, 50, 55, 80, 8), baselineDays: base, acwr: 1.0 };
		const a = computeReadiness(input);
		const b = computeReadiness(structuredClone(input));
		expect(a).toEqual(b);
		// 0.3·70 + 0.2·70 + 0.2·80 + 0.15·100 + 0.15·100 = 81
		expect(a.score).toBe(81);
		expect(a.label).toBe("high");
		expect(a.components.hrv.z).toBe(0);
		expect(a.components.sleep_duration.score).toBe(100);
		expect(a.components.load.score).toBe(100);
		expect(a.explanation).toMatch(/^Readiness 81\/100 \(high\): strongest .*; weakest .*\.$/);
	});

	it("drops low HRV / high RHR / short sleep / high load", () => {
		const r = computeReadiness({ date, day: day(date, 40, 62, 55, 5.5), baselineDays: base, acwr: 1.5 });
		expect(r.score!).toBeLessThan(40);
		expect(r.label).toBe("low");
		expect(r.components.load.score).toBe(30);
		expect(r.explanation).toContain("weakest");
	});

	it("renormalizes missing components and refuses with too little data", () => {
		const partial = computeReadiness({ date, day: day(date, 50, 55, null, null), baselineDays: base, acwr: null });
		expect(partial.components.sleep_score.score).toBeNull();
		expect(partial.score).toBe(70); // hrv 70 and rhr 70 renormalized
		const none = computeReadiness({ date, day: null, baselineDays: [], acwr: null });
		expect(none.score).toBeNull();
		expect(none.explanation).toMatch(/Not enough data/);
	});

	it("load component is piecewise linear", () => {
		expect(loadComponentScore(0.5)).toBe(100);
		expect(loadComponentScore(1.15)).toBeCloseTo(85);
		expect(loadComponentScore(1.4)).toBeCloseTo(50);
		expect(loadComponentScore(3)).toBe(0);
	});
});

describe("recovery after a hard day", () => {
	const hard = "2026-10-20";
	const days = new Map<string, DayRecovery>();
	for (const [i, d] of dateRange(addDays(hard, -60), addDays(hard, -1)).entries()) days.set(d, day(d, 50 + (i % 3), 55 + (i % 2)));
	days.set(hard, day(hard, 50, 55));
	const after: Array<[number, number]> = [[38, 62], [40, 60], [45, 56], [49, 55], [51, 55]];
	after.forEach(([h, r], k) => days.set(addDays(hard, k + 1), day(addDays(hard, k + 1), h, r)));

	it("counts days until HRV and RHR are back in band", () => {
		const r = computeRecoveryAfter(hard, days, "2026-11-05");
		expect(r.hrv.band).toEqual({ low: 42, high: 58, source: "Garmin HRV balanced range" });
		expect(r.hrv).toMatchObject({ left_band: true, days_to_return: 3, status: "returned" });
		expect(r.resting_hr.band?.high).toBeCloseTo(56, 0);
		expect(r.resting_hr).toMatchObject({ left_band: true, status: "returned" });
		expect(r.days_until_both_returned).toBe(Math.max(3, r.resting_hr.days_to_return!));
		expect(r.daily[1]).toMatchObject({ day: 1, hrv_last_night_avg_ms: 38, hrv_in_band: false });
	});

	it("regression: a later unrelated spike is not counted as slow recovery", () => {
		const spiky = new Map(days);
		// RHR fine the first night, spike on day 3, fine again on day 4.
		const nights: Array<[number, number]> = [[50, 55], [50, 55], [50, 63], [50, 55]];
		nights.forEach(([h, r], k) => spiky.set(addDays(hard, k + 1), day(addDays(hard, k + 1), h, r)));
		const r = computeRecoveryAfter(hard, spiky, "2026-11-05");
		expect(r.resting_hr).toMatchObject({ left_band: false, days_to_return: 0, status: "never_left_band" });
		expect(r.daily[3]!.resting_hr_in_band).toBe(false); // still visible in the daily values
	});

	it("uses day 2 when the first night has no data", () => {
		const gap = new Map(days);
		gap.set(addDays(hard, 1), day(addDays(hard, 1), null, null));
		const r = computeRecoveryAfter(hard, gap, "2026-11-05");
		expect(r.hrv).toMatchObject({ left_band: true, days_to_return: 3, status: "returned" });
	});

	it("reports never_left_band and insufficient data", () => {
		const calm = new Map(days);
		for (let k = 1; k <= 5; k++) calm.set(addDays(hard, k), day(addDays(hard, k), 50, 55));
		expect(computeRecoveryAfter(hard, calm, "2026-11-05").hrv.status).toBe("never_left_band");
		expect(computeRecoveryAfter("2026-11-05", new Map(), "2026-11-05").hrv.status).toBe("insufficient_data");
	});
});

describe("stats and formatting", () => {
	it("baseline uses sample sd and requires a minimum count", () => {
		expect(baseline([1, 2, 3, null], 3)).toEqual({ mean: 2, sd: 1, n: 3 });
		expect(baseline([1, 2], 3)).toBeNull();
	});

	it("formats durations and paces", () => {
		expect(formatDuration(3725)).toBe("1:02:05");
		expect(formatPace(300)).toBe("5:00/km");
		expect(formatPace(null)).toBeNull();
	});
});
