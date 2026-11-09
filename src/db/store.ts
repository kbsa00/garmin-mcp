// D1 access layer. All multi-row writes go through db.batch() (one query against the
// per-invocation limit). No health values are ever logged here.

import type { ActivitySummary } from "../garmin/activities";
import type { FitActivity, FitLap } from "../fit/parse";
import type { DayRecovery } from "../recovery/normalize";

/** The subset of D1Database used here (lets tests run against node:sqlite). */
export interface D1Like {
	prepare(sql: string): D1StatementLike;
	batch(statements: D1StatementLike[]): Promise<unknown[]>;
}
export interface D1StatementLike {
	bind(...values: unknown[]): D1StatementLike;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<unknown>;
}

export interface StoredDay {
	day: DayRecovery;
	final: boolean;
}

export interface DailyLoadRow {
	date: string;
	load: number;
	activities: number;
}

export type FitStatus = "pending" | "done" | "error";

export interface StoredActivity extends ActivitySummary {
	fit_status: FitStatus;
	fit_attempts: number;
}

const ACTIVITY_COLUMNS = [
	"activity_id", "date", "start_local", "start_utc", "type", "name", "distance_m", "duration_s", "moving_s",
	"elapsed_s", "avg_speed_mps", "max_speed_mps", "avg_hr_bpm", "max_hr_bpm", "avg_cadence_spm", "avg_power_w",
	"normalized_power_w", "avg_stride_length_m", "avg_vertical_oscillation_cm", "avg_vertical_ratio_percent",
	"elevation_gain_m", "calories", "aerobic_te", "anaerobic_te", "te_label", "training_load", "vo2max", "lap_count",
] as const satisfies ReadonlyArray<keyof ActivitySummary>;

export const MAX_FIT_ATTEMPTS = 3;

export class Store {
	constructor(private db: D1Like) {}

	// ---- daily recovery ------------------------------------------------------------------

	async getRecoveryDays(start: string, end: string): Promise<Map<string, StoredDay>> {
		const { results } = await this.db
			.prepare("SELECT date, data, final FROM daily_recovery WHERE date BETWEEN ? AND ? ORDER BY date")
			.bind(start, end)
			.all<{ date: string; data: string; final: number }>();
		const out = new Map<string, StoredDay>();
		for (const r of results) {
			try {
				out.set(r.date, { day: JSON.parse(r.data) as DayRecovery, final: r.final === 1 });
			} catch {
				// Corrupt row: ignore, it will be re-fetched and overwritten.
			}
		}
		return out;
	}

	/** Upserts normalized days. A day is final when synced on a later date (Oslo) than itself. */
	async putRecoveryDays(days: DayRecovery[], today: string, now = new Date()): Promise<void> {
		if (!days.length) return;
		const sql = `INSERT INTO daily_recovery (date, data, hrv_last_night_ms, hrv_status, hrv_balanced_low_ms, hrv_balanced_high_ms,
			resting_hr_bpm, sleep_score, sleep_seconds, body_battery_at_wake, stress_avg, final, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(date) DO UPDATE SET data = excluded.data, hrv_last_night_ms = excluded.hrv_last_night_ms,
			hrv_status = excluded.hrv_status, hrv_balanced_low_ms = excluded.hrv_balanced_low_ms,
			hrv_balanced_high_ms = excluded.hrv_balanced_high_ms, resting_hr_bpm = excluded.resting_hr_bpm,
			sleep_score = excluded.sleep_score, sleep_seconds = excluded.sleep_seconds,
			body_battery_at_wake = excluded.body_battery_at_wake, stress_avg = excluded.stress_avg,
			final = excluded.final, synced_at = excluded.synced_at`;
		const stmts = days.map((d) =>
			this.db
				.prepare(sql)
				.bind(
					d.date,
					JSON.stringify(d),
					d.hrv.last_night_avg_ms,
					d.hrv.status,
					d.hrv.baseline_balanced_low_ms,
					d.hrv.baseline_balanced_high_ms,
					d.resting_heart_rate_bpm,
					d.sleep.score,
					d.sleep.duration_seconds,
					d.body_battery.at_wake,
					d.stress.avg_level,
					d.date < today ? 1 : 0,
					now.toISOString(),
				),
		);
		await this.db.batch(stmts);
	}

	// ---- activities ----------------------------------------------------------------------

	/** Upserts activity summaries; never resets FIT processing state of existing rows. */
	async upsertActivities(rows: ActivitySummary[], now = new Date()): Promise<void> {
		if (!rows.length) return;
		const cols = [...ACTIVITY_COLUMNS, "updated_at"];
		// vo2max may come from the FIT file (summary has none): never overwrite a stored value with null.
		const updates = cols
			.filter((c) => c !== "activity_id")
			.map((c) => (c === "vo2max" ? "vo2max = COALESCE(excluded.vo2max, activities.vo2max)" : `${c} = excluded.${c}`))
			.join(", ");
		const sql = `INSERT INTO activities (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
			ON CONFLICT(activity_id) DO UPDATE SET ${updates}`;
		const ts = now.toISOString();
		await this.db.batch(rows.map((r) => this.db.prepare(sql).bind(...ACTIVITY_COLUMNS.map((c) => r[c]), ts)));
	}

	async getActivities(start: string, end: string, type?: string): Promise<StoredActivity[]> {
		const where = ["date BETWEEN ? AND ?"];
		const binds: unknown[] = [start, end];
		if (type) {
			where.push("type LIKE ?");
			binds.push(`%${type}%`);
		}
		const { results } = await this.db
			.prepare(`SELECT * FROM activities WHERE ${where.join(" AND ")} ORDER BY start_utc, activity_id`)
			.bind(...binds)
			.all<StoredActivity>();
		return results;
	}

	async getActivity(id: number): Promise<StoredActivity | null> {
		return this.db.prepare("SELECT * FROM activities WHERE activity_id = ?").bind(id).first<StoredActivity>();
	}

	async pendingFitIds(limit: number): Promise<number[]> {
		const { results } = await this.db
			.prepare("SELECT activity_id FROM activities WHERE fit_status = 'pending' AND fit_attempts < ? AND type NOT LIKE '%strength%' ORDER BY date DESC LIMIT ?")
			.bind(MAX_FIT_ATTEMPTS, limit)
			.all<{ activity_id: number }>();
		return results.map((r) => r.activity_id);
	}

	async countPendingFit(): Promise<number> {
		const r = await this.db
			.prepare("SELECT COUNT(*) AS n FROM activities WHERE fit_status = 'pending' AND fit_attempts < ? AND type NOT LIKE '%strength%'")
			.bind(MAX_FIT_ATTEMPTS)
			.first<{ n: number }>();
		return r?.n ?? 0;
	}

	/** Replaces the laps of an activity and marks its FIT as processed, atomically. */
	async saveFit(id: number, fit: FitActivity): Promise<void> {
		const stmts: D1StatementLike[] = [
			this.db.prepare("DELETE FROM activity_laps WHERE activity_id = ?").bind(id),
		];
		for (const l of fit.laps) {
			stmts.push(
				this.db
					.prepare(
						"INSERT INTO activity_laps (activity_id, lap_index, data, distance_m, moving_s, avg_speed_mps, avg_hr_bpm) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.bind(id, l.lap_index, JSON.stringify(l), l.distance_m, l.moving_seconds, l.avg_speed_mps, l.avg_heart_rate_bpm),
			);
		}
		stmts.push(
			this.db
				.prepare(
					"UPDATE activities SET fit_status = 'done', fit_attempts = fit_attempts + 1, vo2max = COALESCE(?, vo2max), vo2max_source = CASE WHEN ? IS NOT NULL THEN 'fit_file' ELSE vo2max_source END WHERE activity_id = ?",
				)
				.bind(fit.vo2max, fit.vo2max, id),
		);
		await this.db.batch(stmts);
	}

	async markFitFailed(id: number): Promise<void> {
		await this.db
			.prepare(
				"UPDATE activities SET fit_attempts = fit_attempts + 1, fit_status = CASE WHEN fit_attempts + 1 >= ? THEN 'error' ELSE 'pending' END WHERE activity_id = ?",
			)
			.bind(MAX_FIT_ATTEMPTS, id)
			.run();
	}

	async getLaps(id: number): Promise<FitLap[]> {
		const { results } = await this.db
			.prepare("SELECT data FROM activity_laps WHERE activity_id = ? ORDER BY lap_index")
			.bind(id)
			.all<{ data: string }>();
		return results.map((r) => JSON.parse(r.data) as FitLap);
	}

	/** Sum of Garmin training load per local date (dates without activities are absent). */
	async dailyLoad(start: string, end: string): Promise<DailyLoadRow[]> {
		const { results } = await this.db
			.prepare(
				"SELECT date, COALESCE(SUM(training_load), 0) AS load, COUNT(*) AS activities FROM activities WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date",
			)
			.bind(start, end)
			.all<DailyLoadRow>();
		return results;
	}

	async firstActivityDate(): Promise<string | null> {
		const r = await this.db.prepare("SELECT MIN(date) AS d FROM activities").first<{ d: string | null }>();
		return r?.d ?? null;
	}

	// ---- sync state ----------------------------------------------------------------------

	async getState(key: string): Promise<string | null> {
		const r = await this.db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>();
		return r?.value ?? null;
	}

	async setState(key: string, value: string, now = new Date()): Promise<void> {
		await this.db
			.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
			.bind(key, value, now.toISOString())
			.run();
	}
}
