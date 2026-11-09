// Pure functions: raw Garmin DTOs -> normalized, LLM-friendly recovery summaries.

import { formatOsloTime } from "../dates";
import type {
	BodyBatteryDailyReportDTO,
	DailySleepDTO,
	HrvSummaryDTO,
	Maybe,
	UserDailySummaryV2DTO,
} from "../garmin/types";

export const UNITS = {
	"*_seconds": "seconds",
	"*_hours": "hours",
	"*_ms": "milliseconds (HRV RMSSD)",
	"*_bpm": "beats per minute",
	"*_brpm": "breaths per minute",
	"*_percent": "percent",
	"sleep.score": "Garmin sleep score, 0-100",
	"body_battery.*": "Garmin Body Battery, 0-100",
	"stress.*_level": "Garmin stress level, 0-100 (lower is calmer)",
	"*_local": "local time in Europe/Oslo (YYYY-MM-DDTHH:mm)",
} as const;

export interface SleepSummary {
	score: number | null;
	quality: string | null;
	duration_seconds: number | null;
	duration_hours: number | null;
	deep_seconds: number | null;
	light_seconds: number | null;
	rem_seconds: number | null;
	awake_seconds: number | null;
	start_local: string | null;
	end_local: string | null;
	awake_count: number | null;
	avg_heart_rate_bpm: number | null;
	avg_respiration_brpm: number | null;
	avg_spo2_percent: number | null;
	avg_sleep_stress_level: number | null;
	feedback: string | null;
}

export interface HrvSummary {
	last_night_avg_ms: number | null;
	last_night_5min_high_ms: number | null;
	weekly_avg_ms: number | null;
	status: string | null;
	baseline_balanced_low_ms: number | null;
	baseline_balanced_high_ms: number | null;
	baseline_low_upper_ms: number | null;
}

export interface BodyBatterySummary {
	at_wake: number | null;
	highest: number | null;
	lowest: number | null;
	latest: number | null;
	charged: number | null;
	drained: number | null;
}

export interface StressSummary {
	avg_level: number | null;
	max_level: number | null;
	qualifier: string | null;
	previous_day_avg_level: number | null;
}

export interface DayRecovery {
	date: string;
	sleep: SleepSummary;
	hrv: HrvSummary;
	resting_heart_rate_bpm: number | null;
	body_battery: BodyBatterySummary;
	stress: StressSummary;
	/** Not exposed by the Garmin Personal API; always null. */
	training_readiness: null;
	/** Dotted paths of fields Garmin did not return for this day. */
	missing: string[];
}

export interface RawDay {
	date: string;
	sleep?: Maybe<DailySleepDTO>;
	hrv?: Maybe<HrvSummaryDTO>;
	summary?: Maybe<UserDailySummaryV2DTO>;
	previousSummary?: Maybe<UserDailySummaryV2DTO>;
	bodyBatteryReport?: Maybe<BodyBatteryDailyReportDTO>;
}

const num = (v: unknown): number | null => {
	if (v == null || v === "") return null;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const round = (v: number | null, digits = 1): number | null =>
	v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits;

export function normalizeSleep(s: Maybe<DailySleepDTO>): SleepSummary {
	const duration = num(s?.sleepTimeSeconds);
	// A record with no measured sleep is an empty placeholder: treat the stages as missing too.
	const hasSleep = duration != null && duration > 0;
	const stage = (v: unknown) => (hasSleep ? num(v) : null);
	return {
		score: num(s?.sleepScores?.overall?.value),
		quality: str(s?.sleepScores?.overall?.qualifierKey),
		duration_seconds: hasSleep ? duration : null,
		duration_hours: hasSleep ? round(duration! / 3600, 2) : null,
		deep_seconds: stage(s?.deepSleepSeconds),
		light_seconds: stage(s?.lightSleepSeconds),
		rem_seconds: s?.deviceRemCapable === false ? null : stage(s?.remSleepSeconds),
		awake_seconds: stage(s?.awakeSleepSeconds),
		start_local: hasSleep ? formatOsloTime(num(s?.sleepStartTimestampGMT)) : null,
		end_local: hasSleep ? formatOsloTime(num(s?.sleepEndTimestampGMT)) : null,
		awake_count: stage(s?.awakeCount),
		avg_heart_rate_bpm: num(s?.avgHeartRate),
		avg_respiration_brpm: num(s?.averageRespirationValue),
		avg_spo2_percent: num(s?.averageSpO2Value),
		avg_sleep_stress_level: num(s?.avgSleepStress),
		feedback: str(s?.sleepScoreFeedback),
	};
}

export function normalizeHrv(h: Maybe<HrvSummaryDTO>): HrvSummary {
	const status = str(h?.status);
	return {
		last_night_avg_ms: num(h?.lastNightAvg),
		last_night_5min_high_ms: num(h?.lastNight5MinHigh),
		weekly_avg_ms: num(h?.weeklyAvg),
		status: status === "NONE" || status === "INVALID" ? null : status,
		baseline_balanced_low_ms: num(h?.baseline?.balancedLow),
		baseline_balanced_high_ms: num(h?.baseline?.balancedUpper),
		baseline_low_upper_ms: num(h?.baseline?.lowUpper),
	};
}

/** Body Battery report resolution requested from Garmin: 96 intervals = 15 minutes. */
export const BODY_BATTERY_CHUNKS = 96;
/** A reading must be this close to the end of sleep to count as the wake-up value. */
const AT_WAKE_TOLERANCE_MS = 20 * 60 * 1000;

/**
 * Body Battery level when you woke up.
 * Garmin's daily report is NOT a time series: it holds the lowest and highest reading of each
 * interval (`chunks` per day). With 15-minute intervals, the reading closest to the end of sleep
 * (within 20 minutes) is the level at wake-up. Returns null if no reading is that close.
 */
export function bodyBatteryAtWake(report: Maybe<BodyBatteryDailyReportDTO>, sleepEndMs: number | null): number | null {
	const rows = report?.bodyBatteryValuesArray;
	if (!rows?.length || sleepEndMs == null) return null;
	const descriptors = report?.bodyBatteryValueDescriptorDTOList ?? [];
	const idx = (key: string, fallback: number) =>
		descriptors.find((d) => d.bodyBatteryValueDescriptorKey === key)?.bodyBatteryValueDescriptorIndex ?? fallback;
	const tsIdx = idx("timestamp", 0);
	const levelIdx = idx("bodyBatteryLevel", 1);

	let best: { distance: number; ts: number; level: number } | null = null;
	for (const row of rows) {
		const ts = num(row?.[tsIdx]);
		const level = num(row?.[levelIdx]);
		if (ts == null || level == null) continue;
		const distance = Math.abs(ts - sleepEndMs);
		if (distance > AT_WAKE_TOLERANCE_MS) continue;
		// Closest wins; on a tie, the later reading (after waking) wins.
		if (!best || distance < best.distance || (distance === best.distance && ts > best.ts)) best = { distance, ts, level };
	}
	return best?.level ?? null;
}

export function normalizeDay(raw: RawDay): DayRecovery {
	const bb = raw.summary?.bodyBattery;
	const stress = raw.summary?.stress;
	const resting = num(raw.summary?.heartRate?.restingValue);

	const day: DayRecovery = {
		date: raw.date,
		sleep: normalizeSleep(raw.sleep),
		hrv: normalizeHrv(raw.hrv),
		resting_heart_rate_bpm: resting != null && resting > 0 ? resting : null,
		body_battery: {
			at_wake: bodyBatteryAtWake(raw.bodyBatteryReport, num(raw.sleep?.sleepEndTimestampGMT)),
			highest: num(bb?.maxValue),
			lowest: num(bb?.minValue),
			latest: num(bb?.latestValue),
			charged: num(bb?.chargedValue ?? raw.bodyBatteryReport?.charged),
			drained: num(bb?.drainedValue ?? raw.bodyBatteryReport?.drained),
		},
		stress: {
			avg_level: positive(num(stress?.avgLevel)),
			max_level: positive(num(stress?.maxLevel)),
			qualifier: stress?.qualifier && stress.qualifier !== "unknown" ? stress.qualifier : null,
			previous_day_avg_level: positive(num(raw.previousSummary?.stress?.avgLevel)),
		},
		training_readiness: null,
		missing: [],
	};
	day.missing = findMissing(day);
	return day;
}

// Garmin uses negative values (-1, -2) as "not enough data" sentinels for stress.
function positive(v: number | null): number | null {
	return v != null && v >= 0 ? v : null;
}

function findMissing(day: DayRecovery): string[] {
	const out: string[] = [];
	const walk = (obj: Record<string, unknown>, prefix: string) => {
		for (const [k, v] of Object.entries(obj)) {
			if (k === "missing" || k === "date") continue;
			const path = prefix ? `${prefix}.${k}` : k;
			if (v === null) out.push(path);
			else if (typeof v === "object") walk(v as Record<string, unknown>, path);
		}
	};
	walk(day as unknown as Record<string, unknown>, "");
	return out;
}

export interface Average {
	value: number | null;
	days_with_data: number;
}

/** Mean of the non-null values; rounds to 1 decimal. */
export function average(values: Array<number | null>): Average {
	const present = values.filter((v): v is number => v != null);
	return {
		value: present.length ? round(present.reduce((a, b) => a + b, 0) / present.length) : null,
		days_with_data: present.length,
	};
}

/** Compact per-day row for trends (keeps 60-day responses small enough for an LLM context). */
export interface TrendDay {
	date: string;
	sleep_score: number | null;
	sleep_duration_hours: number | null;
	deep_sleep_hours: number | null;
	rem_sleep_hours: number | null;
	hrv_last_night_avg_ms: number | null;
	hrv_status: string | null;
	resting_heart_rate_bpm: number | null;
	body_battery_at_wake: number | null;
	body_battery_highest: number | null;
	stress_avg_level: number | null;
}

export function toTrendDay(d: DayRecovery): TrendDay {
	const hours = (s: number | null) => round(s == null ? null : s / 3600, 2);
	return {
		date: d.date,
		sleep_score: d.sleep.score,
		sleep_duration_hours: d.sleep.duration_hours,
		deep_sleep_hours: hours(d.sleep.deep_seconds),
		rem_sleep_hours: hours(d.sleep.rem_seconds),
		hrv_last_night_avg_ms: d.hrv.last_night_avg_ms,
		hrv_status: d.hrv.status,
		resting_heart_rate_bpm: d.resting_heart_rate_bpm,
		body_battery_at_wake: d.body_battery.at_wake,
		body_battery_highest: d.body_battery.highest,
		stress_avg_level: d.stress.avg_level,
	};
}
