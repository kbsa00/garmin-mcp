// Recovery after a (hard) activity day D: how many days until overnight HRV and resting HR were
// back in the personal baseline band.
//   HRV band:  Garmin's own "balanced" baseline range as of D (fallback: 60-day mean ± 1 sd before D).
//   RHR band:  60-day mean ± 1 sd before D (only "too high" counts as out of band).
// Day k = the night ending on the morning of D+k. Only the first night after the activity decides
// whether a metric "left the band" (day 1, or day 2 if day 1 has no data); a later spike is not
// attributed to the activity. days_to_return is then the first in-band night after it ("first return").

import { addDays } from "../dates";
import type { DayRecovery } from "../recovery/normalize";
import { baseline, round } from "./stats";

export const FOLLOW_UP_DAYS = 14;
/** Nights after the activity that may decide "left the band" (2 tolerates one missing night). */
const FIRST_NIGHT_WINDOW = 2;

export interface Band {
	low: number | null;
	high: number | null;
	source: string;
}

export interface MetricRecovery {
	band: Band | null;
	left_band: boolean | null;
	days_to_return: number | null;
	status: "never_left_band" | "returned" | "not_yet_returned" | "insufficient_data";
}

export interface RecoveryAfterResult {
	activity_date: string;
	hrv: MetricRecovery;
	resting_hr: MetricRecovery;
	days_until_both_returned: number | null;
	daily: Array<{
		day: number;
		date: string;
		hrv_last_night_avg_ms: number | null;
		hrv_in_band: boolean | null;
		resting_heart_rate_bpm: number | null;
		resting_hr_in_band: boolean | null;
	}>;
}

export function computeRecoveryAfter(activityDate: string, days: Map<string, DayRecovery>, today: string): RecoveryAfterResult {
	const before = [...days.values()].filter((d) => d.date < activityDate && d.date >= addDays(activityDate, -60));
	const onDay = days.get(activityDate);

	const hrvBase = baseline(before.map((d) => d.hrv.last_night_avg_ms), 14);
	const garminLow = onDay?.hrv.baseline_balanced_low_ms ?? null;
	const garminHigh = onDay?.hrv.baseline_balanced_high_ms ?? null;
	const hrvBand: Band | null =
		garminLow != null && garminHigh != null
			? { low: garminLow, high: garminHigh, source: "Garmin HRV balanced range" }
			: hrvBase
				? { low: round(hrvBase.mean - hrvBase.sd, 1), high: round(hrvBase.mean + hrvBase.sd, 1), source: "60-day mean ± 1 sd" }
				: null;
	const rhrBase = baseline(before.map((d) => d.resting_heart_rate_bpm), 14);
	const rhrBand: Band | null = rhrBase
		? { low: round(rhrBase.mean - rhrBase.sd, 1), high: round(rhrBase.mean + rhrBase.sd, 1), source: "60-day mean ± 1 sd" }
		: null;

	const daily: RecoveryAfterResult["daily"] = [];
	for (let k = 0; k <= FOLLOW_UP_DAYS; k++) {
		const date = addDays(activityDate, k);
		if (date > today) break;
		const d = days.get(date);
		const hrv = d?.hrv.last_night_avg_ms ?? null;
		const rhr = d?.resting_heart_rate_bpm ?? null;
		daily.push({
			day: k,
			date,
			hrv_last_night_avg_ms: hrv,
			// Above the band after a hard day is not "unrecovered"; only below counts.
			hrv_in_band: hrv == null || !hrvBand ? null : hrv >= hrvBand.low!,
			resting_heart_rate_bpm: rhr,
			resting_hr_in_band: rhr == null || !rhrBand ? null : rhr <= rhrBand.high!,
		});
	}

	const hrv = metric(daily.map((d) => d.hrv_in_band), hrvBand);
	const restingHr = metric(daily.map((d) => d.resting_hr_in_band), rhrBand);
	const both =
		hrv.status === "insufficient_data" || restingHr.status === "insufficient_data"
			? null
			: hrv.days_to_return != null && restingHr.days_to_return != null
				? Math.max(hrv.days_to_return, restingHr.days_to_return)
				: null;
	return { activity_date: activityDate, hrv, resting_hr: restingHr, days_until_both_returned: both, daily };
}

function metric(inBand: Array<boolean | null>, band: Band | null): MetricRecovery {
	// inBand[0] is the activity day itself (night before the activity); recovery starts at day 1.
	const after = inBand.slice(1);
	const first = after.slice(0, FIRST_NIGHT_WINDOW).findIndex((v) => v != null);
	if (!band || first === -1) return { band, left_band: null, days_to_return: null, status: "insufficient_data" };
	if (after[first] === true) return { band, left_band: false, days_to_return: 0, status: "never_left_band" };
	const back = after.findIndex((v, i) => i > first && v === true);
	return back === -1
		? { band, left_band: true, days_to_return: null, status: "not_yet_returned" }
		: { band, left_band: true, days_to_return: back + 1, status: "returned" };
}
