// Where every value in a tool result comes from. Each result starts with a `provenance` block so
// Claude can say explicitly what Garmin measured and what this connector calculated.

export const GARMIN_STATEMENT =
	"Provided by Garmin (Garmin Connect Personal API): measured by the user's Garmin device or calculated by Garmin's own algorithms. Passed through unchanged except for unit conversion.";
export const COMPUTED_STATEMENTS = {
	garmin:
		"Calculated by this connector, NOT by Garmin or the watch. It is this connector's own model built on Garmin data and may differ from anything the watch or Garmin Connect shows.",
} as const;


export const SERVER_INSTRUCTIONS = `This server exposes the user's Garmin data plus a few metrics this connector calculates itself.
Every tool result starts with a "provenance" block.
- Values listed under "garmin_provided" come from Garmin. When you present them, say they are Garmin's data (e.g. "Garmin reports…", "according to your Garmin…").
- Values listed under "computed_by_connector" are this connector's own calculations, not Garmin's and not the watch's. When you present them, say so explicitly (e.g. "the connector's own estimate, not your watch's…"), and never present them as Garmin Training Readiness, Training Status, recovery time or any other Garmin feature.
- If a computed value seems to conflict with what the user's watch shows, prefer the watch for Garmin features and explain that the connector's metric uses a different method.`;

export interface Provenance {
	garmin_provided: { statement: string; fields: string[] };
	computed_by_connector: { statement: string; fields: string[] } | null;
}

const p = (garmin: string[], computed: string[] = []): Provenance => ({
	garmin_provided: { statement: GARMIN_STATEMENT, fields: garmin },
	computed_by_connector: computed.length ? { statement: COMPUTED_STATEMENTS.garmin, fields: computed } : null,
});

export const PROVENANCE = {
	get_recovery: p(
		[
			"recovery.sleep.* (score, quality, duration, stages, times, heart rate, respiration, SpO2, sleep stress, feedback)",
			"recovery.hrv.* (last-night average, 5-min high, weekly average, status, Garmin's baseline range)",
			"recovery.resting_heart_rate_bpm",
			"recovery.body_battery.highest, lowest, latest, charged, drained",
			"recovery.stress.* (average, max, qualifier, previous day's average)",
		],
		[
			"recovery.body_battery.at_wake: Garmin's Body Battery reading closest to the end of sleep (within 20 min), picked by the connector from Garmin's 15-minute Body Battery report (Garmin does not report a wake-up value itself)",
			"recovery.sleep.duration_hours: unit conversion of Garmin's sleep seconds",
		],
	),
	get_recovery_trend: p(
		["days[].sleep_score, sleep_duration_hours, deep/rem hours, hrv_last_night_avg_ms, hrv_status, resting_heart_rate_bpm, body_battery_highest, stress_avg_level"],
		[
			"averages.* (7-day and 28-day means of Garmin's HRV and resting HR, calculated by the connector)",
			"days[].body_battery_at_wake (Garmin's reading closest to the end of sleep, picked by the connector)",
			"days_missing (counts)",
		],
	),
	get_activities: p(
		[
			"activities[].* : distance, times, heart rate, Training Effect (aerobic_te, anaerobic_te, te_label), training_load, cadence, power, stride length, running dynamics, elevation, calories, vo2max",
		],
		["activities[].avg_pace (from Garmin's distance and moving time)", "totals_by_type (sums calculated by the connector)"],
	),
	get_activity_detail: p(
		[
			"activity.* (Garmin's activity summary)",
			"laps[] from the activity's FIT file: distance, time, heart rate, cadence, step length, power, vertical oscillation, ground contact time, vertical ratio, ascent",
		],
		[
			"laps[].pace (from Garmin's lap speed)",
			"laps[].avg_cadence for runs: converted by the connector from Garmin's strides/min to steps/min",
		],
	),
	get_training_load: p(
		["the per-activity training load summed into days[].load (Garmin's EPOC-based activityTrainingLoad)"],
		[
			"acute_load_7d, chronic_load_28d, acwr, status and everything under current: the connector's own ACWR model using simple 7/28-day averages. This is NOT Garmin's Training Status, Load Ratio or Acute Load and will often differ from the watch.",
		],
	),
	get_readiness: p(
		["the inputs shown in components[].value: last-night HRV, resting HR, sleep score, sleep duration (and the per-activity training load behind the ACWR)"],
		[
			"score, label, explanation, every components[].score, baselines and z-scores, the ACWR: the connector's own readiness model. This is NOT Garmin Training Readiness and will differ from the score on the watch.",
		],
	),
	get_recovery_after: p(
		["daily[].hrv_last_night_avg_ms and resting_heart_rate_bpm", "hrv.band when its source is 'Garmin HRV balanced range'", "activities_on_date[] (Garmin activity summaries)"],
		[
			"in_band flags, left_band, days_to_return, status, days_until_both_returned, the resting HR band and any HRV band marked '60-day mean ± 1 sd': the connector's own analysis. Garmin has no equivalent; it is NOT the watch's recovery time.",
		],
	),
	get_vo2max_trend: p(
		["points[].vo2max: Garmin's own VO2 max estimate (ml/kg/min) as saved by the watch in each activity's FIT file; the watch displays it rounded to a whole number"],
		[
			"the decoding: Garmin does not document this FIT message; the connector reads it with a community-known formula (raw × 3.5 / 65536), validated against a Garmin watch",
			"latest_vo2max_rounded_like_watch and change (rounding and difference calculated by the connector)",
		],
	),
	get_fitness_age: p(
		["fitness_age, chronological_age, achievable_fitness_age, previous_fitness_age, last_updated, every components[] value/target/potential age/priority (Garmin Fitness Age)"],
		["fitness_age is Garmin's value rounded to 1 decimal (fitness_age_unrounded is Garmin's exact value; the watch may round differently)"],
	),
	health_check: p(["Garmin token exchange status"]),
} satisfies Record<string, Provenance>;

export type ToolName = keyof typeof PROVENANCE;
