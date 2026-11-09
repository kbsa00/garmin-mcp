// Deterministic readiness score (0-100). Pure function: same inputs -> same output.
//
// Components (each 0-100), weighted:
//   hrv            30%  70 + 15·z, z = (last-night HRV − 60-day mean) / sd
//   resting_hr     20%  70 + 15·z, z = (60-day mean − resting HR) / sd   (lower is better)
//   sleep_score    20%  Garmin sleep score as-is
//   sleep_duration 15%  100 · min(1, hours / 8)
//   load           15%  from ACWR through yesterday: ≤1.0 → 100, 1.3 → 70, 1.5 → 30, ≥2.0 → 0 (linear between)
// Missing components are dropped and the remaining weights renormalized. If less than half of
// the total weight is available the score is null. sd is floored (HRV 2 ms, RHR 1 bpm) so a very
// stable baseline does not turn tiny deviations into huge z-scores. Baselines need ≥14 days.

import type { DayRecovery } from "../recovery/normalize";
import { type Baseline, baseline, clamp, round } from "./stats";

export const READINESS_WEIGHTS = { hrv: 0.3, resting_hr: 0.2, sleep_score: 0.2, sleep_duration: 0.15, load: 0.15 } as const;
export const BASELINE_DAYS = 60;
export const MIN_BASELINE_DAYS = 14;
export const SLEEP_TARGET_HOURS = 8;
const SD_FLOOR = { hrv: 2, resting_hr: 1 } as const;

type ComponentName = keyof typeof READINESS_WEIGHTS;

export interface ReadinessComponent {
	score: number | null;
	weight: number;
	value: number | null;
	baseline?: Baseline | null;
	z?: number | null;
	note: string;
}

export interface ReadinessResult {
	date: string;
	score: number | null;
	label: "high" | "moderate" | "low" | null;
	components: Record<ComponentName, ReadinessComponent>;
	explanation: string;
}

export interface ReadinessInput {
	date: string;
	day: DayRecovery | null;
	/** Days strictly before `date` (up to 60); only HRV and resting HR are used. */
	baselineDays: DayRecovery[];
	/** ACWR as of the end of the previous day, or null. */
	acwr: number | null;
}

export function loadComponentScore(acwr: number): number {
	const pts: Array<[number, number]> = [
		[1.0, 100],
		[1.3, 70],
		[1.5, 30],
		[2.0, 0],
	];
	if (acwr <= pts[0]![0]) return 100;
	for (let i = 1; i < pts.length; i++) {
		const [x1, y1] = pts[i]!;
		const [x0, y0] = pts[i - 1]!;
		if (acwr <= x1) return y0 + ((acwr - x0) / (x1 - x0)) * (y1 - y0);
	}
	return 0;
}

export function computeReadiness(input: ReadinessInput): ReadinessResult {
	const { day, baselineDays, acwr } = input;

	const hrvBase = baseline(baselineDays.map((d) => d.hrv.last_night_avg_ms), MIN_BASELINE_DAYS);
	const rhrBase = baseline(baselineDays.map((d) => d.resting_heart_rate_bpm), MIN_BASELINE_DAYS);
	const hrv = day?.hrv.last_night_avg_ms ?? null;
	const rhr = day?.resting_heart_rate_bpm ?? null;
	const sleepScore = day?.sleep.score ?? null;
	const sleepHours = day?.sleep.duration_seconds != null ? day.sleep.duration_seconds / 3600 : null;

	const zScore = (x: number | null, b: Baseline | null, floor: number, invert: boolean) =>
		x == null || b == null ? null : round(((invert ? b.mean - x : x - b.mean) / Math.max(b.sd, floor)), 2);
	const hrvZ = zScore(hrv, hrvBase, SD_FLOOR.hrv, false);
	const rhrZ = zScore(rhr, rhrBase, SD_FLOOR.resting_hr, true);

	const comp = (score: number | null, name: ComponentName, value: number | null, note: string, extra: Partial<ReadinessComponent> = {}) => ({
		score: score == null ? null : Math.round(clamp(score)),
		weight: READINESS_WEIGHTS[name],
		value,
		note,
		...extra,
	});

	const components: Record<ComponentName, ReadinessComponent> = {
		hrv: comp(hrvZ == null ? null : 70 + 15 * hrvZ, "hrv", hrv, hrvBase ? "last-night HRV vs 60-day baseline" : "not enough HRV history (needs 14 days)", {
			baseline: hrvBase,
			z: hrvZ,
		}),
		resting_hr: comp(rhrZ == null ? null : 70 + 15 * rhrZ, "resting_hr", rhr, rhrBase ? "resting HR vs 60-day baseline (lower is better)" : "not enough resting HR history (needs 14 days)", {
			baseline: rhrBase,
			z: rhrZ,
		}),
		sleep_score: comp(sleepScore, "sleep_score", sleepScore, "Garmin sleep score"),
		sleep_duration: comp(
			sleepHours == null ? null : 100 * Math.min(1, sleepHours / SLEEP_TARGET_HOURS),
			"sleep_duration",
			sleepHours == null ? null : round(sleepHours, 2),
			`hours slept vs ${SLEEP_TARGET_HOURS} h target`,
		),
		load: comp(acwr == null ? null : loadComponentScore(acwr), "load", acwr, "acute:chronic workload ratio through yesterday"),
	};

	const available = (Object.entries(components) as Array<[ComponentName, ReadinessComponent]>).filter(([, c]) => c.score != null);
	const totalWeight = available.reduce((a, [, c]) => a + c.weight, 0);
	const score = totalWeight >= 0.5 ? Math.round(available.reduce((a, [, c]) => a + c.score! * c.weight, 0) / totalWeight) : null;
	const label = score == null ? null : score >= 75 ? "high" : score >= 50 ? "moderate" : "low";

	return { date: input.date, score, label, components, explanation: explain(score, label, available, components) };
}

const DISPLAY: Record<ComponentName, (c: ReadinessComponent) => string> = {
	hrv: (c) => `HRV ${c.value} ms vs baseline ${c.baseline?.mean} (z ${fmtSigned(c.z)})`,
	resting_hr: (c) => `resting HR ${c.value} bpm vs baseline ${c.baseline?.mean} (z ${fmtSigned(c.z)})`,
	sleep_score: (c) => `sleep score ${c.value}`,
	sleep_duration: (c) => `sleep ${c.value} h`,
	load: (c) => `ACWR ${c.value}`,
};

function fmtSigned(z: number | null | undefined): string {
	return z == null ? "n/a" : `${z >= 0 ? "+" : ""}${z}`;
}

function explain(
	score: number | null,
	label: string | null,
	available: Array<[ComponentName, ReadinessComponent]>,
	components: Record<ComponentName, ReadinessComponent>,
): string {
	if (score == null) {
		const missing = (Object.keys(components) as ComponentName[]).filter((k) => components[k].score == null);
		return `Not enough data for a readiness score (missing: ${missing.join(", ")}).`;
	}
	// Stable ordering: by score, then by name, so the explanation is deterministic.
	const sorted = [...available].sort((a, b) => a[1].score! - b[1].score! || a[0].localeCompare(b[0]));
	const weakest = sorted[0]!;
	const strongest = sorted[sorted.length - 1]!;
	return `Readiness ${score}/100 (${label}): strongest ${DISPLAY[strongest[0]](strongest[1])}; weakest ${DISPLAY[weakest[0]](weakest[1])}.`;
}
