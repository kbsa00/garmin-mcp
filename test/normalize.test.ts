import { describe, expect, it } from "vitest";
import { addDays, chunkRange, dateRange, formatOsloTime, isValidDate, todayInOslo } from "../src/dates";
import { average, bodyBatteryAtWake, normalizeDay } from "../src/recovery/normalize";
import { bodyBatteryDay, hrvDay, SLEEP_END, SLEEP_START, sleepDay, summaryDay } from "./fixtures/garmin";

describe("dates", () => {
	it("uses Europe/Oslo for today", () => {
		expect(todayInOslo(new Date("2026-11-04T23:30:00Z"))).toBe("2026-11-05");
		expect(todayInOslo(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
		expect(todayInOslo(new Date("2026-07-01T22:01:00Z"))).toBe("2026-07-02");
	});
	it("validates and walks dates", () => {
		expect(isValidDate("2026-02-29")).toBe(false);
		expect(isValidDate("2028-02-29")).toBe(true);
		expect(isValidDate("2026-1-1")).toBe(false);
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(dateRange("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
	});
	it("chunks ranges to the API maximum", () => {
		const chunks = chunkRange("2026-09-07", "2026-11-05", 31);
		expect(chunks).toEqual([
			["2026-09-07", "2026-10-07"],
			["2026-10-08", "2026-11-05"],
		]);
	});
	it("formats instants in Oslo time", () => {
		expect(formatOsloTime(SLEEP_START)).toBe("2026-11-04T23:10");
		expect(formatOsloTime(Date.UTC(2026, 6, 1, 4, 0))).toBe("2026-07-01T06:00");
		expect(formatOsloTime(null)).toBeNull();
	});
});

describe("normalizeDay", () => {
	const date = "2026-11-05";

	it("normalizes a complete day", () => {
		const day = normalizeDay({
			date,
			sleep: sleepDay(date),
			hrv: hrvDay(date),
			summary: summaryDay(date, 49, 25),
			previousSummary: summaryDay("2026-11-04", 51, 40),
			bodyBatteryReport: bodyBatteryDay(date),
		});
		expect(day.sleep).toMatchObject({
			score: 82,
			quality: "GOOD",
			duration_seconds: 26400,
			duration_hours: 7.33,
			deep_seconds: 4800,
			rem_seconds: 6600,
			start_local: "2026-11-04T23:10",
			end_local: "2026-11-05T06:50",
		});
		expect(day.hrv).toEqual({
			last_night_avg_ms: 52,
			last_night_5min_high_ms: 78,
			weekly_avg_ms: 50,
			status: "BALANCED",
			baseline_balanced_low_ms: 42,
			baseline_balanced_high_ms: 59,
			baseline_low_upper_ms: 39,
		});
		expect(day.resting_heart_rate_bpm).toBe(49);
		expect(day.body_battery).toEqual({ at_wake: 84, highest: 85, lowest: 15, latest: 60, charged: 65, drained: 40 });
		expect(day.stress).toEqual({ avg_level: 25, max_level: 90, qualifier: "balanced", previous_day_avg_level: 40 });
		expect(day.training_readiness).toBeNull();
		expect(day.missing).toEqual(["training_readiness"]);
	});

	it("never crashes on missing data and lists every null field", () => {
		const day = normalizeDay({ date });
		expect(day.sleep.score).toBeNull();
		expect(day.hrv.status).toBeNull();
		expect(day.body_battery.at_wake).toBeNull();
		expect(day.missing).toContain("sleep.score");
		expect(day.missing).toContain("hrv.last_night_avg_ms");
		expect(day.missing).toContain("resting_heart_rate_bpm");
		expect(day.missing).toContain("stress.avg_level");
		expect(day.missing).toContain("training_readiness");
	});

	it("handles partial / sentinel values", () => {
		const day = normalizeDay({
			date,
			sleep: sleepDay(date, { sleepTimeSeconds: 0, sleepScores: null, deviceRemCapable: false }),
			hrv: { calendarDate: date, status: "NONE", baseline: null },
			summary: { calendarDate: date, stress: { avgLevel: -1, qualifier: "unknown" }, heartRate: { restingValue: 0 } },
		});
		expect(day.sleep.duration_seconds).toBeNull();
		expect(day.sleep.deep_seconds).toBeNull();
		expect(day.sleep.rem_seconds).toBeNull();
		expect(day.hrv.status).toBeNull();
		expect(day.hrv.baseline_balanced_low_ms).toBeNull();
		expect(day.stress.avg_level).toBeNull();
		expect(day.stress.qualifier).toBeNull();
		expect(day.resting_heart_rate_bpm).toBeNull();
	});
});

describe("bodyBatteryAtWake", () => {
	it("takes the 15-minute reading closest to the end of sleep", () => {
		expect(bodyBatteryAtWake(bodyBatteryDay("d"), SLEEP_END)).toBe(84);
	});

	it("regression: does not pick the bedtime low from a coarse 3-chunk report", () => {
		// Real 2026-11-03 shape with Garmin's default 3 chunks: only interval extremes, the nearest
		// to wake-up is 31 min after it. The old logic returned the bedtime low (25).
		const coarse = bodyBatteryDay("d");
		coarse.bodyBatteryValuesArray = [
			[SLEEP_END - 371 * 60_000, 25],
			[SLEEP_END + 31 * 60_000, 82],
			[SLEEP_END + 109 * 60_000, 74],
		];
		expect(bodyBatteryAtWake(coarse, SLEEP_END)).toBeNull();
	});

	it("prefers the later reading on a tie and needs a sleep end", () => {
		const r = bodyBatteryDay("d");
		r.bodyBatteryValuesArray = [
			[SLEEP_END - 3 * 60_000, 70],
			[SLEEP_END + 3 * 60_000, 71],
		];
		expect(bodyBatteryAtWake(r, SLEEP_END)).toBe(71);
		expect(bodyBatteryAtWake(bodyBatteryDay("d"), null)).toBeNull();
		expect(bodyBatteryAtWake(null, SLEEP_END)).toBeNull();
	});

	it("respects the descriptor column order", () => {
		const report = bodyBatteryDay("d");
		report.bodyBatteryValuesArray = report.bodyBatteryValuesArray!.map(([t, v]) => [v!, t!]);
		report.bodyBatteryValueDescriptorDTOList = [
			{ bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "timestamp" },
			{ bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" },
		];
		expect(bodyBatteryAtWake(report, SLEEP_END)).toBe(84);
	});
});

describe("average", () => {
	it("ignores nulls and reports coverage", () => {
		expect(average([50, null, 53, 54])).toEqual({ value: 52.3, days_with_data: 3 });
		expect(average([null, null])).toEqual({ value: null, days_with_data: 0 });
	});
});
