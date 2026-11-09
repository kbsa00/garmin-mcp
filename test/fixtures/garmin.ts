// Synthetic Garmin responses shaped like the real Personal API output.

import type {
	BodyBatteryDailyReportDTO,
	DailySleepDTO,
	HrvSummaryDTO,
	UserDailySummaryV2DTO,
} from "../../src/garmin/types";

// Night ending 2026-11-05: 23:10 -> 06:50 Oslo (UTC+1).
export const SLEEP_START = Date.UTC(2026, 10, 4, 22, 10);
export const SLEEP_END = Date.UTC(2026, 10, 5, 5, 50);

export function sleepDay(date: string, overrides: Partial<DailySleepDTO> = {}): DailySleepDTO {
	return {
		calendarDate: date,
		sleepTimeSeconds: 26400,
		napTimeSeconds: 0,
		sleepStartTimestampGMT: SLEEP_START,
		sleepEndTimestampGMT: SLEEP_END,
		deepSleepSeconds: 4800,
		lightSleepSeconds: 15000,
		remSleepSeconds: 6600,
		awakeSleepSeconds: 1200,
		deviceRemCapable: true,
		averageSpO2Value: 95,
		averageRespirationValue: 13,
		awakeCount: 1,
		avgSleepStress: 18,
		avgHeartRate: 55,
		sleepScoreFeedback: "POSITIVE_DEEP",
		sleepScores: { overall: { value: 82, qualifierKey: "GOOD" } },
		...overrides,
	};
}

export function hrvDay(date: string, lastNightAvg: number | null = 52): HrvSummaryDTO {
	return {
		calendarDate: date,
		weeklyAvg: 50,
		lastNightAvg,
		lastNight5MinHigh: 78,
		baseline: { lowUpper: 39, balancedLow: 42, balancedUpper: 59, markerValue: 0.5 },
		status: "BALANCED",
		feedbackPhrase: "HRV_BALANCED_2",
	};
}

export function summaryDay(date: string, resting: number | null = 50, stressAvg = 30): UserDailySummaryV2DTO {
	return {
		calendarDate: date,
		heartRate: { minValue: 48, maxValue: 160, restingValue: resting },
		stress: { avgLevel: stressAvg, maxLevel: 90, qualifier: "balanced" },
		bodyBattery: { minValue: 15, maxValue: 85, chargedValue: 65, drainedValue: 40, latestValue: 60 },
	};
}

export function bodyBatteryDay(date: string): BodyBatteryDailyReportDTO {
	return {
		date,
		charged: 65,
		drained: 5,
		bodyBatteryValuesArray: [
			[SLEEP_START - 3600_000, 20],
			[SLEEP_START + 2 * 3600_000, 45],
			// 15-minute chunks (low/high per interval) around wake-up.
			[SLEEP_END - 25 * 60_000, 81],
			[SLEEP_END - 5 * 60_000, 84],
			[SLEEP_END + 10 * 60_000, 85],
			[SLEEP_END + 3 * 3600_000, 70],
		],
		bodyBatteryValueDescriptorDTOList: [
			{ bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
			{ bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" },
		],
	};
}

/** A JWT-shaped token whose exp claim is `expSeconds`. */
export function fakeJwt(expSeconds: number): string {
	const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
	return `${b64({ alg: "RS256" })}.${b64({ sub: "x", exp: expSeconds })}.sig`;
}
