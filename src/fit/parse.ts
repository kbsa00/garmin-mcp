// Activity FIT file (as downloaded: a ZIP containing one .fit) -> laps and VO2 max,
// decoded with Garmin's official FIT SDK after stripping unneeded messages (see strip.ts).

import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";
import { MESG, stripFit } from "./strip";

export interface FitLap {
	lap_index: number;
	start_time_utc: string | null;
	elapsed_seconds: number | null;
	moving_seconds: number | null;
	distance_m: number | null;
	avg_speed_mps: number | null;
	max_speed_mps: number | null;
	avg_heart_rate_bpm: number | null;
	max_heart_rate_bpm: number | null;
	/** Steps per minute for running (2 x strides); revolutions per minute otherwise. */
	avg_cadence: number | null;
	max_cadence: number | null;
	avg_power_w: number | null;
	max_power_w: number | null;
	normalized_power_w: number | null;
	avg_step_length_m: number | null;
	avg_vertical_oscillation_mm: number | null;
	avg_ground_contact_ms: number | null;
	avg_vertical_ratio_percent: number | null;
	total_ascent_m: number | null;
	intensity: string | null;
}

/**
 * VO2 max as stored by the watch in the undocumented message 140, field 7 (a fixed-point "max MET"
 * value; VO2 max = raw × 3.5 / 65536). Not part of Garmin's published FIT profile; the decoding is
 * community-documented and was validated against a Garmin watch (the watch shows the value
 * rounded to an integer). 0 means "not updated by this activity" (e.g. treadmill).
 */
export function vo2maxFromRaw(raw: unknown): number | null {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
	const v = (raw * 3.5) / 65536;
	return v >= 10 && v <= 95 ? Math.round(v * 10) / 10 : null;
}

export interface FitActivity {
	sport: string | null;
	sub_sport: string | null;
	laps: FitLap[];
	/** Watch's VO2 max estimate saved with this activity, or null. */
	vo2max: number | null;
}

type Msg = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, d = 2): number | null => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const iso = (v: unknown): string | null => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/** Extracts the first .fit file from Garmin's download ZIP (or returns the input if it is already FIT). */
export function extractFit(download: Uint8Array): Uint8Array {
	if (download[0] === 0x50 && download[1] === 0x4b) {
		const files = unzipSync(download, { filter: (f) => f.name.toLowerCase().endsWith(".fit") });
		const first = Object.values(files)[0];
		if (!first) throw new Error("ZIP contains no .fit file");
		return first;
	}
	return download;
}

export function parseActivityFit(download: Uint8Array): FitActivity {
	const fit = stripFit(extractFit(download));
	const { messages, errors } = new Decoder(Stream.fromByteArray(fit)).read({
		applyScaleAndOffset: true,
		expandSubFields: true,
		expandComponents: false,
		convertTypesToStrings: true,
		convertDateTimesToDates: true,
		// Needed for the undocumented VO2 max message; cheap because the file is stripped first.
		includeUnknownData: true,
		mergeHeartRates: false,
	});
	if (errors.length) throw new Error(`FIT decode failed: ${(errors[0] as Error).message}`);
	const m = messages as unknown as Record<string, Msg[] | undefined>;

	const session = m.sessionMesgs?.[0] ?? {};
	const sport = str(session.sport);
	const running = sport === "running" || sport === "walking" || sport === "hiking";

	const cadence = (whole: unknown, fraction: unknown): number | null => {
		const w = num(whole);
		if (w == null) return null;
		// FIT stores running cadence in strides/min (+ fractional part); report steps/min.
		return running ? round(2 * (w + (num(fraction) ?? 0)), 1) : w;
	};

	const laps: FitLap[] = (m.lapMesgs ?? []).map((l, i) => {
		const stepMm = num(l.avgStepLength);
		return {
			lap_index: i,
			start_time_utc: iso(l.startTime),
			elapsed_seconds: round(num(l.totalElapsedTime), 1),
			moving_seconds: round(num(l.totalTimerTime), 1),
			distance_m: round(num(l.totalDistance), 1),
			avg_speed_mps: round(num(l.enhancedAvgSpeed) ?? num(l.avgSpeed), 3),
			max_speed_mps: round(num(l.enhancedMaxSpeed) ?? num(l.maxSpeed), 3),
			avg_heart_rate_bpm: num(l.avgHeartRate),
			max_heart_rate_bpm: num(l.maxHeartRate),
			avg_cadence: cadence(l.avgCadence, l.avgFractionalCadence),
			max_cadence: cadence(l.maxCadence, l.maxFractionalCadence),
			avg_power_w: num(l.avgPower),
			max_power_w: num(l.maxPower),
			normalized_power_w: num(l.normalizedPower),
			avg_step_length_m: stepMm == null ? null : round(stepMm / 1000, 3),
			avg_vertical_oscillation_mm: round(num(l.avgVerticalOscillation), 1),
			avg_ground_contact_ms: round(num(l.avgStanceTime), 1),
			avg_vertical_ratio_percent: round(num(l.avgVerticalRatio), 2),
			total_ascent_m: num(l.totalAscent),
			intensity: str(l.intensity),
		};
	});

	const physio = (messages as unknown as Record<number, Msg[] | undefined>)[MESG.PHYSIOLOGICAL_METRICS]?.[0];
	return { sport, sub_sport: str(session.subSport), laps, vo2max: vo2maxFromRaw(physio?.[7]) };
}
