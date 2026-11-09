// Nightly sync and one-time backfill into D1. Idempotent: every write is an upsert.
// Logs contain counts only, never health values.

import { STATE, type ActivityService } from "../activities/service";
import { addDays, formatOsloTime } from "../dates";
import type { Store } from "../db/store";
import { searchActivities } from "../garmin/activities";
import type { GarminClient } from "../garmin/client";
import type { RecoveryService } from "../recovery/service";

export const SYNC_DAYS = 3;
/** FIT files processed per nightly run (CPU budget of the Workers Free plan); the rest on demand. */
export const NIGHTLY_FIT_LIMIT = 2;

export interface SyncDeps {
	client: GarminClient;
	store: Store;
	recovery: RecoveryService;
	activities: ActivityService;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
}

export interface SyncReport {
	recovery_days: number;
	recovery_incomplete: boolean;
	activities_upserted: number;
	fit_processed: number;
	fit_failed: number;
	fit_pending: number;
}

/** Re-syncs the last 3 days of recovery and activities, then a few pending FIT files. */
export async function dailySync(deps: SyncDeps): Promise<SyncReport> {
	const now = deps.now?.() ?? new Date();
	const today = deps.recovery.today();
	const start = addDays(today, -(SYNC_DAYS - 1));

	const { days, unavailable } = await deps.recovery.fetchRange(start, today);
	if (!unavailable.length) await deps.store.putRecoveryDays(days, today, now);

	const acts = await searchActivities(deps.client, start, today);
	await deps.store.upsertActivities(acts, now);
	await deps.store.setState(STATE.activitiesSyncedAt, now.toISOString(), now);

	const fit = await processPendingFit(deps, NIGHTLY_FIT_LIMIT, 0);
	return {
		recovery_days: unavailable.length ? 0 : days.length,
		recovery_incomplete: unavailable.length > 0,
		activities_upserted: acts.length,
		...fit,
	};
}

export interface BackfillOptions {
	/** Pause between Garmin requests (ms). */
	delayMs?: number;
	/** Stop after this many years without data. */
	maxYears?: number;
}

/**
 * Backfills all history the API provides: recovery walks back in 90-day windows until two
 * consecutive windows are empty; activities are paginated to the end; every FIT is processed.
 * Requests are sequential with a pause between them.
 */
export async function backfill(deps: SyncDeps, opts: BackfillOptions = {}): Promise<SyncReport & { recovery_from: string | null }> {
	const delay = opts.delayMs ?? 1000;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = deps.now?.() ?? new Date();
	const today = deps.recovery.today();
	const floor = addDays(today, -365 * (opts.maxYears ?? 5));

	let recoveryDays = 0;
	let emptyWindows = 0;
	let earliest: string | null = null;
	let incomplete = false;
	for (let end = today; end > floor && emptyWindows < 2; end = addDays(end, -90)) {
		const start = addDays(end, -89);
		const { days, unavailable } = await deps.recovery.fetchRange(start, end);
		const withData = days.filter((d) => d.sleep.duration_seconds != null || d.resting_heart_rate_bpm != null || d.hrv.last_night_avg_ms != null);
		if (unavailable.length) incomplete = true;
		else await deps.store.putRecoveryDays(days, today, now);
		recoveryDays += days.length;
		if (withData.length) {
			emptyWindows = 0;
			earliest = withData[0]!.date;
		} else emptyWindows++;
		console.log("backfill recovery window", { days: days.length, with_data: withData.length });
		await sleep(delay);
	}

	// Activities: the search endpoint paginates over all history in one go.
	const acts = await searchActivities(deps.client, "2000-01-01", today);
	await deps.store.upsertActivities(acts, now);
	await deps.store.setState(STATE.activitiesSyncedAt, now.toISOString(), now);
	console.log("backfill activities", { count: acts.length });

	const fit = await processPendingFit(deps, Number.MAX_SAFE_INTEGER, delay);
	if (!incomplete && fit.fit_pending === 0) await deps.store.setState(STATE.backfillCompletedAt, now.toISOString(), now);
	return {
		recovery_days: recoveryDays,
		recovery_incomplete: incomplete,
		recovery_from: earliest,
		activities_upserted: acts.length,
		...fit,
	};
}

async function processPendingFit(deps: SyncDeps, limit: number, delayMs: number) {
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	let processed = 0;
	let failed = 0;
	while (processed + failed < limit) {
		const ids = await deps.store.pendingFitIds(Math.min(25, limit - processed - failed));
		if (!ids.length) break;
		for (const id of ids) {
			const fit = await deps.activities.fetchAndStoreFit(id);
			if (fit) processed++;
			else failed++;
			if (delayMs) await sleep(delayMs);
		}
	}
	const pending = await deps.store.countPendingFit();
	if (processed + failed) console.log("fit processing", { processed, failed, pending });
	return { fit_processed: processed, fit_failed: failed, fit_pending: pending };
}

/** True when a cron firing corresponds to 05:xx in Europe/Oslo (one of the two UTC crons). */
export function isOsloSyncHour(scheduledTime: number): boolean {
	return formatOsloTime(scheduledTime)?.slice(11, 13) === "05";
}
