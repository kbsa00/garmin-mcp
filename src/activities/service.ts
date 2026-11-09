// Activities, FIT detail and computed training metrics. Reads D1 first, falls back to Garmin.

import { addDays, dateRange, formatOsloTime, isValidDate, TIMEZONE } from "../dates";
import { Store, type StoredActivity } from "../db/store";
import { type FitLap, parseActivityFit } from "../fit/parse";
import {
	type ActivitySummary,
	downloadActivityFit,
	getActivityDetail,
	isRun,
	normalizeActivityDetail,
	searchActivities,
} from "../garmin/activities";
import { GarminClient, GarminError } from "../garmin/client";
import { computeLoad, type LoadDay, ACWR_THRESHOLDS, MIN_CHRONIC_LOAD } from "../metrics/load";
import { BASELINE_DAYS, computeReadiness, READINESS_WEIGHTS } from "../metrics/readiness";
import { computeRecoveryAfter, FOLLOW_UP_DAYS } from "../metrics/recovery-after";
import { round } from "../metrics/stats";
import { formatPace } from "../format";
import type { DataSource, RecoveryService } from "../recovery/service";

export const STATE = {
	backfillCompletedAt: "backfill_completed_at",
	activitiesSyncedAt: "activities_synced_at",
} as const;

export const MAX_ACTIVITY_RANGE_DAYS = 366;
export const MAX_LOAD_DAYS = 90;
export const MAX_VO2_DAYS = 365;

export interface ActivitiesResult {
	activities: ActivitySummary[];
	source: DataSource;
	/** First date for which the activity list is known to be complete. */
	historyStart: string;
}

export class ActivityService {
	constructor(
		private client: GarminClient,
		private store: Store | null,
		private recovery: RecoveryService,
	) {}

	private today() {
		return this.recovery.today();
	}

	// ---- activity list ---------------------------------------------------------------------

	async listActivities(from: string, to: string): Promise<ActivitiesResult> {
		const backfilled = await this.state(STATE.backfillCompletedAt);
		if (this.store && backfilled) {
			const syncedAt = await this.state(STATE.activitiesSyncedAt);
			const syncedDate = syncedAt ? osloDate(syncedAt) : null;
			const stored = await this.safe(() => this.store!.getActivities(from, to), []);
			const firstDate = (await this.safe(() => this.store!.firstActivityDate(), null)) ?? from;
			let source: DataSource = "d1";
			const byId = new Map<number, ActivitySummary>(stored.map((a) => [a.activity_id, a]));
			// Anything on/after the last sync date may be newer than D1.
			if (!syncedDate || to >= syncedDate) {
				const freshFrom = syncedDate && syncedDate > from ? syncedDate : from;
				const fresh = await searchActivities(this.client, freshFrom, to);
				await this.safe(() => this.store!.upsertActivities(fresh), undefined);
				for (const a of fresh) {
					const old = byId.get(a.activity_id);
					// Keep FIT-derived fields (VO2 max, FIT status) that the search endpoint does not return.
					byId.set(a.activity_id, old ? { ...old, ...a, vo2max: a.vo2max ?? old.vo2max } : a);
				}
				source = freshFrom === from ? "garmin_api" : "d1+garmin_api";
			}
			return { activities: sortActivities([...byId.values()]), source, historyStart: firstDate };
		}
		const fresh = await searchActivities(this.client, from, to);
		if (this.store) await this.safe(() => this.store!.upsertActivities(fresh), undefined);
		return { activities: sortActivities(fresh), source: "garmin_api", historyStart: from };
	}

	async getActivities(from: string, to: string, type?: string) {
		checkRange(from, to, MAX_ACTIVITY_RANGE_DAYS);
		const { activities, source } = await this.listActivities(from, to);
		const filtered = type ? activities.filter((a) => a.type?.includes(type.toLowerCase())) : activities;
		const byType: Record<string, { count: number; distance_m: number; moving_s: number; training_load: number }> = {};
		for (const a of filtered) {
			const t = (byType[a.type ?? "unknown"] ??= { count: 0, distance_m: 0, moving_s: 0, training_load: 0 });
			t.count++;
			t.distance_m = round(t.distance_m + (a.distance_m ?? 0), 1);
			t.moving_s = round(t.moving_s + (a.moving_s ?? a.duration_s ?? 0), 1);
			t.training_load = round(t.training_load + (a.training_load ?? 0), 1);
		}
		return {
			timezone: TIMEZONE,
			from,
			to,
			type_filter: type ?? null,
			count: filtered.length,
			totals_by_type: byType,
			activities: filtered.map(presentActivity),
			notes: [
				"training_load is Garmin's per-activity training load (EPOC-based). aerobic_te/anaerobic_te are Garmin Training Effect (0-5).",
				filtered.some((a) => a.vo2max != null) ? "vo2max is Garmin's VO2 max estimate saved with the activity." : "vo2max: Garmin does not return VO2 max for these activities (null).",
			],
			data_source: source,
		};
	}

	// ---- detail (laps from FIT) -------------------------------------------------------

	async getActivityDetail(id: number) {
		let summary: StoredActivity | ActivitySummary | null = this.store ? await this.safe(() => this.store!.getActivity(id), null) : null;
		let source: DataSource = summary ? "d1" : "garmin_api";
		if (!summary) {
			const detail = await getActivityDetail(this.client, id).catch((err) => {
				if (err instanceof GarminError && (err.kind === "not_found" || err.kind === "bad_request")) return null;
				throw err;
			});
			summary = detail ? normalizeActivityDetail(detail) : null;
			if (!summary) throw new RangeError(`No activity with id ${id}.`);
			if (this.store) await this.safe(() => this.store!.upsertActivities([summary!]), undefined);
		}

		let laps: FitLap[] = [];
		const notes: string[] = [];
		const stored = summary as Partial<StoredActivity>;
		if (this.store && stored.fit_status === "done") {
			laps = await this.store.getLaps(id);
		} else {
			const fit = await this.fetchAndStoreFit(id);
			if (fit) {
				laps = fit.laps;
				if (fit.vo2max != null) summary = { ...summary, vo2max: fit.vo2max };
				source = source === "d1" ? "d1+garmin_api" : "garmin_api";
			} else notes.push("The FIT file could not be downloaded or parsed, so laps are unavailable.");
		}

		return {
			timezone: TIMEZONE,
			activity: presentActivity(summary),
			laps: laps.map(presentLap),
			units: {
				pace: "min:sec per km",
				avg_cadence: isRun(summary.type) ? "steps per minute" : "revolutions per minute",
				avg_step_length_m: "metres per step",
				avg_vertical_oscillation_mm: "millimetres",
				avg_ground_contact_ms: "milliseconds",
			},
			notes: [
				...notes,
				"Laps come from the activity's FIT file.",
			],
			data_source: source,
		};
	}

	/** Downloads + parses the FIT for one activity and stores its laps. Returns null on failure. */
	async fetchAndStoreFit(id: number) {
		try {
			const bytes = await downloadActivityFit(this.client, id);
			if (!bytes) throw new Error("empty FIT download");
			const fit = parseActivityFit(bytes);
			if (this.store) await this.store.saveFit(id, fit);
			return fit;
		} catch (err) {
			if (err instanceof GarminError && (err.kind === "rate_limited" || err.kind === "auth" || err.kind === "token")) throw err;
			console.error("fit processing failed", (err as Error).name);
			if (this.store) await this.safe(() => this.store!.markFitFailed(id), undefined);
			return null;
		}
	}

	// ---- training load ---------------------------------------------------------------------

	async loadSeries(start: string, end: string): Promise<{ days: LoadDay[]; source: DataSource }> {
		const windowStart = addDays(start, -27);
		const { activities, source, historyStart } = await this.listActivities(windowStart, end);
		const loads = new Map<string, number>();
		for (const a of activities) loads.set(a.date, (loads.get(a.date) ?? 0) + (a.training_load ?? 0));
		const history = historyStart > windowStart ? historyStart : windowStart;
		return { days: computeLoad(loads, start, end, history), source };
	}

	async getTrainingLoad(days: number) {
		if (!Number.isInteger(days) || days < 1 || days > MAX_LOAD_DAYS) throw new RangeError(`days must be an integer between 1 and ${MAX_LOAD_DAYS}.`);
		const end = this.today();
		const start = addDays(end, -(days - 1));
		const { days: series, source } = await this.loadSeries(start, end);
		const current = series[series.length - 1]!;
		return {
			timezone: TIMEZONE,
			start_date: start,
			end_date: end,
			current: {
				date: current.date,
				acute_load_7d: current.acute_load_7d,
				chronic_load_28d: current.chronic_load_28d,
				acwr: current.acwr,
				status: current.status,
				load_last_7_days_total: round(series.slice(-7).reduce((a, d) => a + d.load, 0), 1),
			},
			days: series,
			method: {
				daily_load: "sum of Garmin activityTrainingLoad for activities starting that local date",
				acute_load_7d: "mean daily load over the 7 days ending that date",
				chronic_load_28d: "mean daily load over the 28 days ending that date",
				acwr: "acute_load_7d / chronic_load_28d",
				status: `insufficient_data if chronic < ${MIN_CHRONIC_LOAD} or <28 days of history; detraining < ${ACWR_THRESHOLDS.detraining}; maintaining < ${ACWR_THRESHOLDS.maintaining}; productive ≤ ${ACWR_THRESHOLDS.productive}; overreaching_risk above`,
			},
			notes: ["This is a computed metric, not Garmin's Training Status (which the Personal API does not provide)."],
			data_source: source,
		};
	}

	// ---- readiness ---------------------------------------------------------------------------

	async getReadiness(date?: string) {
		const today = this.today();
		const target = date ?? today;
		checkDate(target, today);
		const [{ days, unavailable, source }, load] = await Promise.all([
			this.recovery.getDays(addDays(target, -BASELINE_DAYS), target),
			this.loadSeries(addDays(target, -1), addDays(target, -1)),
		]);
		const baselineDays = [...days.values()].filter((d) => d.date < target);
		const result = computeReadiness({ date: target, day: days.get(target) ?? null, baselineDays, acwr: load.days[0]?.acwr ?? null });
		return {
			timezone: TIMEZONE,
			...result,
			method: {
				weights: READINESS_WEIGHTS,
				baseline: `${BASELINE_DAYS} days before the date (needs ≥14 days with data)`,
				formulas: {
					hrv: "70 + 15·z, z = (HRV − baseline mean) / max(sd, 2 ms)",
					resting_hr: "70 + 15·z, z = (baseline mean − RHR) / max(sd, 1 bpm)",
					sleep_score: "Garmin sleep score",
					sleep_duration: "100 · min(1, hours / 8)",
					load: "ACWR through yesterday: ≤1.0 → 100, 1.3 → 70, 1.5 → 30, ≥2.0 → 0, linear between",
				},
				labels: "high ≥ 75, moderate 50-74, low < 50",
			},
			notes: [
				"This is this connector's own deterministic score, not Garmin Training Readiness (not available in the Personal API).",
				"Components with missing data are dropped and the weights renormalized.",
			],
			unavailable_sources: unavailable,
			data_source: source === load.source ? source : "d1+garmin_api",
		};
	}

	// ---- recovery after a hard day -----------------------------------------------------------

	async getRecoveryAfter(date: string) {
		const today = this.today();
		checkDate(date, today);
		const followEnd = addDays(date, FOLLOW_UP_DAYS) < today ? addDays(date, FOLLOW_UP_DAYS) : today;
		const [{ days, unavailable, source }, acts] = await Promise.all([
			this.recovery.getDays(addDays(date, -60), followEnd),
			this.listActivities(date, date),
		]);
		const result = computeRecoveryAfter(date, days, today);
		const activities = acts.activities.map(presentActivity);
		return {
			timezone: TIMEZONE,
			...result,
			activities_on_date: activities,
			notes: [
				"Day k is the night ending on the morning of date + k (day 0 is the night before the activity).",
				"HRV counts as recovered when at or above the low end of its band; resting HR when at or below the high end of its band.",
				...(activities.length ? [] : ["No activity was recorded on this date."]),
			],
			unavailable_sources: unavailable,
			data_source: source,
		};
	}

	// ---- VO2 max -----------------------------------------------------------------------------

	async getVo2maxTrend(days: number) {
		if (!Number.isInteger(days) || days < 1 || days > MAX_VO2_DAYS) throw new RangeError(`days must be an integer between 1 and ${MAX_VO2_DAYS}.`);
		const end = this.today();
		const start = addDays(end, -(days - 1));
		const { activities, source } = await this.listActivities(start, end);
		const points = activities
			.filter((a) => a.vo2max != null)
			.map((a) => ({ date: a.date, activity_id: a.activity_id, type: a.type, vo2max: a.vo2max }));
		if (!points.length) {
			return {
				start_date: start,
				end_date: end,
				available: false,
				latest_vo2max: null,
				points: [],
				explanation: `None of the ${activities.length} activities in this period has a VO2 max value. Garmin's watch stores VO2 max only in the FIT file of outdoor activities that update it (not treadmill), and only FIT files already processed are included. No value is estimated.`,
				data_source: source,
			};
		}
		const latest = points[points.length - 1]!;
		return {
			start_date: start,
			end_date: end,
			available: true,
			latest_vo2max: latest.vo2max,
			latest_date: latest.date,
			latest_vo2max_rounded_like_watch: Math.round(latest.vo2max!),
			change: round(latest.vo2max! - points[0]!.vo2max!, 1),
			points,
			notes: [
				"VO2 max is Garmin's own estimate (ml/kg/min), as saved by the watch in each activity's FIT file. The watch displays it rounded to a whole number.",
				"Only activities that updated the estimate (typically outdoor runs with GPS and heart rate) have a value; treadmill sessions do not.",
			],
			data_source: source,
		};
	}

	private async state(key: string): Promise<string | null> {
		return this.store ? this.safe(() => this.store!.getState(key), null) : null;
	}

	/** D1 failures must never break a tool; fall back to the value given. */
	private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			console.error("store operation failed", (err as Error).name);
			return fallback;
		}
	}
}

function osloDate(iso: string): string {
	return formatOsloTime(new Date(iso).getTime())?.slice(0, 10) ?? iso.slice(0, 10);
}

function sortActivities(a: ActivitySummary[]): ActivitySummary[] {
	return a.sort((x, y) => (x.start_utc ?? x.date).localeCompare(y.start_utc ?? y.date) || x.activity_id - y.activity_id);
}

function checkDate(date: string, today: string) {
	if (!isValidDate(date)) throw new RangeError(`Invalid date "${date}". Use YYYY-MM-DD.`);
	if (date > today) throw new RangeError(`Date ${date} is in the future (today in ${TIMEZONE} is ${today}).`);
}

function checkRange(from: string, to: string, maxDays: number) {
	if (!isValidDate(from) || !isValidDate(to)) throw new RangeError("Dates must be YYYY-MM-DD.");
	if (from > to) throw new RangeError("'from' must not be after 'to'.");
	if (dateRange(from, to).length > maxDays) throw new RangeError(`The range may span at most ${maxDays} days.`);
}

export function presentActivity(a: ActivitySummary) {
	const moving = a.moving_s ?? a.duration_s;
	return {
		activity_id: a.activity_id,
		date: a.date,
		start_local: a.start_local,
		type: a.type,
		name: a.name,
		distance_m: a.distance_m,
		moving_s: moving,
		elapsed_s: a.elapsed_s,
		avg_pace: isRun(a.type) && a.distance_m && moving ? formatPace(moving / (a.distance_m / 1000)) : null,
		avg_hr_bpm: a.avg_hr_bpm,
		max_hr_bpm: a.max_hr_bpm,
		aerobic_te: a.aerobic_te,
		anaerobic_te: a.anaerobic_te,
		te_label: a.te_label,
		training_load: a.training_load,
		vo2max: a.vo2max,
		avg_cadence_spm: a.avg_cadence_spm,
		avg_power_w: a.avg_power_w,
		avg_stride_length_m: a.avg_stride_length_m,
		avg_vertical_oscillation_cm: a.avg_vertical_oscillation_cm,
		avg_vertical_ratio_percent: a.avg_vertical_ratio_percent,
		elevation_gain_m: a.elevation_gain_m,
		calories: a.calories,
	};
}

function presentLap(l: FitLap) {
	return {
		lap: l.lap_index + 1,
		distance_m: l.distance_m,
		moving_s: l.moving_seconds,
		pace: l.avg_speed_mps && l.avg_speed_mps > 0 ? formatPace(1000 / l.avg_speed_mps) : null,
		avg_hr_bpm: l.avg_heart_rate_bpm,
		max_hr_bpm: l.max_heart_rate_bpm,
		avg_cadence: l.avg_cadence,
		avg_step_length_m: l.avg_step_length_m,
		avg_power_w: l.avg_power_w,
		normalized_power_w: l.normalized_power_w,
		avg_vertical_oscillation_mm: l.avg_vertical_oscillation_mm,
		avg_ground_contact_ms: l.avg_ground_contact_ms,
		avg_vertical_ratio_percent: l.avg_vertical_ratio_percent,
		total_ascent_m: l.total_ascent_m,
		intensity: l.intensity,
	};
}
