// Training load: daily Garmin activity training load (EPOC-based "activityTrainingLoad", summed per
// local date), acute = mean daily load over the last 7 days, chronic = mean over the last 28 days,
// ACWR = acute / chronic (rolling averages, coupled: the acute window is inside the chronic one).

import { addDays, dateRange } from "../dates";

export type LoadStatus = "detraining" | "maintaining" | "productive" | "overreaching_risk" | "insufficient_data";

export const ACWR_THRESHOLDS = { detraining: 0.8, maintaining: 1.0, productive: 1.3 } as const;
/** Chronic load below this (mean load/day) is too little training for a meaningful ratio. */
export const MIN_CHRONIC_LOAD = 5;

export interface LoadDay {
	date: string;
	load: number;
	acute_load_7d: number | null;
	chronic_load_28d: number | null;
	acwr: number | null;
	status: LoadStatus;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function loadStatus(acwr: number | null, chronic: number | null): LoadStatus {
	if (acwr == null || chronic == null || chronic < MIN_CHRONIC_LOAD) return "insufficient_data";
	if (acwr < ACWR_THRESHOLDS.detraining) return "detraining";
	if (acwr < ACWR_THRESHOLDS.maintaining) return "maintaining";
	if (acwr <= ACWR_THRESHOLDS.productive) return "productive";
	return "overreaching_risk";
}

/**
 * Computes load metrics for each day in [start, end].
 * @param loads daily load by date (missing dates = 0)
 * @param historyStart first date for which activity data is known to be complete; windows that
 *   reach before it are reported as insufficient_data instead of silently underestimating.
 */
export function computeLoad(loads: Map<string, number>, start: string, end: string, historyStart: string | null): LoadDay[] {
	const at = (d: string) => loads.get(d) ?? 0;
	return dateRange(start, end).map((date) => {
		const acuteOk = historyStart != null && addDays(date, -6) >= historyStart;
		const chronicOk = historyStart != null && addDays(date, -27) >= historyStart;
		const acute = acuteOk ? round(mean(dateRange(addDays(date, -6), date).map(at))) : null;
		const chronic = chronicOk ? round(mean(dateRange(addDays(date, -27), date).map(at))) : null;
		const acwr = acute != null && chronic != null && chronic > 0 ? round(acute / chronic) : null;
		return { date, load: round(at(date), 1), acute_load_7d: acute, chronic_load_28d: chronic, acwr, status: loadStatus(acwr, chronic) };
	});
}
