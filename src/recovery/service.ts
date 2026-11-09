// Recovery data access + aggregation. Tools call this; it talks to a RecoverySource.
// A future cache/dashboard can wrap or replace the source without touching the tools.

import { addDays, chunkRange, dateRange, TIMEZONE, todayInOslo } from "../dates";
import { GarminClient, GarminError } from "../garmin/client";
import type {
	BodyBatteryDailyReportDTO,
	DailySleepDTO,
	DailySummariesV2Response,
	HrvDailySummaryDTO,
	HrvSummaryDTO,
	UserDailySummaryV2DTO,
} from "../garmin/types";
import { average, type Average, BODY_BATTERY_CHUNKS, type DayRecovery, normalizeDay, toTrendDay, type TrendDay, UNITS } from "./normalize";

export const MAX_TREND_DAYS = 60;
const SLEEP_MAX_RANGE_DAYS = 31;
const BODY_BATTERY_MAX_RANGE_DAYS = 31;
const DAILY_SUMMARIES_MAX_RANGE_DAYS = 365;
// No documented maximum; 309 days was accepted. 90 keeps backfill requests small.
const HRV_MAX_RANGE_DAYS = 90;

/** Raw data provider, one method per Garmin dataset. All ranges are inclusive. */
export interface RecoverySource {
	dailySummaries(start: string, end: string): Promise<UserDailySummaryV2DTO[]>;
	sleep(start: string, end: string): Promise<DailySleepDTO[]>;
	hrv(start: string, end: string): Promise<HrvSummaryDTO[]>;
	bodyBattery(start: string, end: string): Promise<BodyBatteryDailyReportDTO[]>;
	/** When true, datasets are fetched one after another instead of in parallel. */
	readonly sequential?: boolean;
}

export class GarminRecoverySource implements RecoverySource {
	/** `sequentialDelayMs` fetches range chunks one by one with a pause (backfill); default is parallel. */
	constructor(
		private client: GarminClient,
		private sequentialDelayMs: number | null = null,
	) {}

	get sequential() {
		return this.sequentialDelayMs != null;
	}

	async dailySummaries(start: string, end: string) {
		return this.chunked(start, end, DAILY_SUMMARIES_MAX_RANGE_DAYS, async (s, e) => {
			const res = await this.client.get<DailySummariesV2Response>(`/usersummary-service/v2/dailysummaries?startDate=${s}&endDate=${e}`);
			return res?.data ?? [];
		});
	}

	async sleep(start: string, end: string) {
		return this.chunked(start, end, SLEEP_MAX_RANGE_DAYS, (s, e) =>
			this.client.get<DailySleepDTO[]>(`/sleep-service/sleep/dailySleepSummariesByDate?startDate=${s}&endDate=${e}`),
		);
	}

	async hrv(start: string, end: string) {
		return this.chunked(start, end, HRV_MAX_RANGE_DAYS, async (s, e) => {
			const res = await this.client.get<HrvDailySummaryDTO>(`/hrv-service/hrv/daily/${s}/${e}`);
			return res?.hrvSummaries ?? [];
		});
	}

	async bodyBattery(start: string, end: string) {
		return this.chunked(start, end, BODY_BATTERY_MAX_RANGE_DAYS, (s, e) =>
			this.client.get<BodyBatteryDailyReportDTO[]>(
				`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${s}&endDate=${e}&chunks=${BODY_BATTERY_CHUNKS}`,
			),
		);
	}

	private async chunked<T>(start: string, end: string, max: number, fetchChunk: (s: string, e: string) => Promise<T[] | null>) {
		const ranges = chunkRange(start, end, max);
		let parts: Array<T[] | null>;
		if (this.sequentialDelayMs == null) {
			parts = await Promise.all(ranges.map(([s, e]) => fetchChunk(s, e)));
		} else {
			parts = [];
			for (const [s, e] of ranges) {
				parts.push(await fetchChunk(s, e));
				await new Promise((r) => setTimeout(r, this.sequentialDelayMs!));
			}
		}
		return parts.flatMap((p) => (Array.isArray(p) ? p : []));
	}
}

export interface RecoveryResult {
	timezone: string;
	units: typeof UNITS;
	recovery: DayRecovery;
	notes: string[];
	unavailable_sources: string[];
	/** Where the data came from: stored (D1), live Garmin API, or both. */
	data_source: DataSource;
}

export interface TrendResult {
	timezone: string;
	units: typeof UNITS;
	start_date: string;
	end_date: string;
	averages: {
		hrv_last_night_avg_ms: { last_7_days: Average; last_28_days: Average };
		resting_heart_rate_bpm: { last_7_days: Average; last_28_days: Average };
	};
	days: TrendDay[];
	/** For each field, how many of the returned days have no value. */
	days_missing: Record<string, number>;
	notes: string[];
	unavailable_sources: string[];
	data_source: DataSource;
}

const TRAINING_READINESS_NOTE =
	"Training Readiness is not available through the Garmin Personal API, so training_readiness is always null.";

/** Optional persistence (D1). Final rows are served without calling Garmin. */
export interface RecoveryStore {
	getRecoveryDays(start: string, end: string): Promise<Map<string, { day: DayRecovery; final: boolean }>>;
	putRecoveryDays(days: DayRecovery[], today: string): Promise<void>;
}

export type DataSource = "d1" | "garmin_api" | "d1+garmin_api";

export interface DaysResult {
	days: Map<string, DayRecovery>;
	unavailable: string[];
	source: DataSource;
}

export class RecoveryService {
	constructor(
		private source: RecoverySource,
		private now: () => Date = () => new Date(),
		private store?: RecoveryStore,
	) {}

	today(): string {
		return todayInOslo(this.now());
	}

	/**
	 * Normalized days for [start, end]. Final days come from the store; everything from the first
	 * non-final/missing day to `end` is fetched from Garmin in one range and written back.
	 */
	async getDays(start: string, end: string): Promise<DaysResult> {
		const today = this.today();
		const stored = this.store ? await this.readStore(start, end) : new Map<string, { day: DayRecovery; final: boolean }>();
		const firstMissing = dateRange(start, end).find((d) => !stored.get(d)?.final);
		const days = new Map<string, DayRecovery>();
		for (const [d, row] of stored) if (row.final) days.set(d, row.day);
		if (!firstMissing) return { days, unavailable: [], source: "d1" };

		const { days: fetched, unavailable } = await this.fetchRange(firstMissing, end);
		for (const day of fetched) days.set(day.date, day);
		// Only persist complete fetches; a failed dataset would otherwise be stored as "final" nulls.
		if (this.store && unavailable.length === 0) {
			await this.store.putRecoveryDays(fetched, today).catch((err) => console.error("store write failed", (err as Error).name));
		}
		return { days, unavailable, source: firstMissing === start ? "garmin_api" : "d1+garmin_api" };
	}

	/** Fetches and normalizes [start, end] straight from Garmin (used by getDays and the sync job). */
	async fetchRange(start: string, end: string): Promise<{ days: DayRecovery[]; unavailable: string[] }> {
		const unavailable: string[] = [];
		const tasks = [
			() => this.settle("daily_summaries", unavailable, this.source.dailySummaries(addDays(start, -1), end)),
			() => this.settle("sleep", unavailable, this.source.sleep(start, end)),
			() => this.settle("hrv", unavailable, this.source.hrv(start, end)),
			() => this.settle("body_battery", unavailable, this.source.bodyBattery(start, end)),
		] as const;
		let results: unknown[];
		if (this.source.sequential) {
			results = [];
			for (const t of tasks) results.push(await t());
		} else results = await Promise.all(tasks.map((t) => t()));
		const [summaries, sleep, hrv, bb] = results as [
			UserDailySummaryV2DTO[],
			DailySleepDTO[],
			HrvSummaryDTO[],
			BodyBatteryDailyReportDTO[],
		];
		const summaryBy = byDate(summaries, (d) => d.calendarDate);
		const sleepBy = byDate(sleep, (d) => d.calendarDate);
		const hrvBy = byDate(hrv, (d) => d.calendarDate);
		const bbBy = byDate(bb, (d) => d.date);
		const days = dateRange(start, end).map((date) =>
			normalizeDay({
				date,
				summary: summaryBy.get(date),
				previousSummary: summaryBy.get(addDays(date, -1)),
				sleep: sleepBy.get(date),
				hrv: hrvBy.get(date),
				bodyBatteryReport: bbBy.get(date),
			}),
		);
		return { days, unavailable };
	}

	async getRecovery(date?: string): Promise<RecoveryResult> {
		const today = this.today();
		const target = date ?? today;
		if (target > today) throw new RangeError(`Date ${target} is in the future (today in ${TIMEZONE} is ${today}).`);

		const { days, unavailable, source } = await this.getDays(target, target);
		const recovery = days.get(target) ?? normalizeDay({ date: target });

		const notes = [
			`Sleep and HRV for ${target} are from the night that ended on the morning of ${target}.`,
			TRAINING_READINESS_NOTE,
		];
		if (target === today) {
			notes.push(
				"Stress and Body Battery highest/lowest/latest/charged/drained cover today so far, not a full day. stress.previous_day_avg_level is yesterday's full-day average.",
			);
		}
		return { timezone: TIMEZONE, units: UNITS, recovery, notes, unavailable_sources: unavailable, data_source: source };
	}

	async getTrend(days: number): Promise<TrendResult> {
		if (!Number.isInteger(days) || days < 1 || days > MAX_TREND_DAYS) {
			throw new RangeError(`days must be an integer between 1 and ${MAX_TREND_DAYS}.`);
		}
		const end = this.today();
		const start = addDays(end, -(days - 1));
		// HRV and resting HR are needed for the 28-day average even when fewer days are requested.
		const avgStart = addDays(end, -27);
		const wideStart = start < avgStart ? start : avgStart;

		const { days: byDay, unavailable, source } = await this.getDays(wideStart, end);
		const wideDays = dateRange(wideStart, end).map((d) => byDay.get(d) ?? normalizeDay({ date: d }));
		const lastN = (n: number) => wideDays.slice(-n);
		const avg = (n: number, pick: (d: DayRecovery) => number | null) => average(lastN(n).map(pick));
		const hrvPick = (d: DayRecovery) => d.hrv.last_night_avg_ms;
		const rhrPick = (d: DayRecovery) => d.resting_heart_rate_bpm;

		const rows = wideDays.filter((d) => d.date >= start).map(toTrendDay);
		return {
			timezone: TIMEZONE,
			units: UNITS,
			start_date: start,
			end_date: end,
			averages: {
				hrv_last_night_avg_ms: { last_7_days: avg(7, hrvPick), last_28_days: avg(28, hrvPick) },
				resting_heart_rate_bpm: { last_7_days: avg(7, rhrPick), last_28_days: avg(28, rhrPick) },
			},
			days: rows,
			days_missing: countMissing(rows),
			notes: [
				`Days are oldest first and end today (${end}, ${TIMEZONE}). Averages are over the 7 and 28 days ending ${end} and ignore days without data.`,
				"Today's stress and Body Battery cover the day so far. Use get_recovery for one day's full detail.",
				TRAINING_READINESS_NOTE,
			],
			unavailable_sources: unavailable,
			data_source: source,
		};
	}

	private async readStore(start: string, end: string) {
		try {
			return await this.store!.getRecoveryDays(start, end);
		} catch (err) {
			// D1 problems must never break the tools: fall back to the API.
			console.error("store read failed", (err as Error).name);
			return new Map<string, { day: DayRecovery; final: boolean }>();
		}
	}

	/**
	 * Resolves a dataset fetch to [] on non-fatal errors (recording the source as unavailable), so
	 * one failing endpoint yields null fields rather than a failed tool call. Auth, token and
	 * rate-limit errors are rethrown because every other call would fail the same way.
	 */
	private async settle<T>(name: string, unavailable: string[], p: Promise<T[]>): Promise<T[]> {
		try {
			return await p;
		} catch (err) {
			if (err instanceof GarminError && ["auth", "token", "rate_limited"].includes(err.kind)) throw err;
			unavailable.push(`${name}: ${(err as Error).message}`);
			return [];
		}
	}
}

function byDate<T>(items: T[], key: (item: T) => string | null | undefined): Map<string, T> {
	const map = new Map<string, T>();
	for (const item of items) {
		const k = key(item);
		if (k) map.set(k.slice(0, 10), item);
	}
	return map;
}

function countMissing(days: TrendDay[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const day of days) {
		for (const [k, v] of Object.entries(day)) if (v === null) counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
}
