// Activities: search endpoint DTO -> normalized summary row (also the D1 `activities` row).

import type { GarminClient } from "./client";
import type { Maybe } from "./types";

/** Subset of SummarizedActivityDTO (activity search). Units per the API: m, s, m/s, cm. */
export interface SummarizedActivityDTO {
	activityId?: Maybe<number>;
	activityName?: Maybe<string>;
	startTimeLocal?: Maybe<string>; // "YYYY-MM-DD HH:mm:ss"
	startTimeGMT?: Maybe<string>;
	activityType?: Maybe<{ typeKey?: Maybe<string> }>;
	distance?: Maybe<number>;
	duration?: Maybe<number>;
	elapsedDuration?: Maybe<number>;
	movingDuration?: Maybe<number>;
	averageSpeed?: Maybe<number>;
	maxSpeed?: Maybe<number>;
	averageHR?: Maybe<number>;
	maxHR?: Maybe<number>;
	averageRunningCadenceInStepsPerMinute?: Maybe<number>;
	avgPower?: Maybe<number>;
	normPower?: Maybe<number>;
	avgStrideLength?: Maybe<number>; // cm
	avgVerticalOscillation?: Maybe<number>; // cm
	avgVerticalRatio?: Maybe<number>;
	elevationGain?: Maybe<number>;
	calories?: Maybe<number>;
	aerobicTrainingEffect?: Maybe<number>;
	anaerobicTrainingEffect?: Maybe<number>;
	trainingEffectLabel?: Maybe<string>;
	activityTrainingLoad?: Maybe<number>;
	vO2MaxValue?: Maybe<number>;
	lapCount?: Maybe<number>;
}

export interface ActivitySummary {
	activity_id: number;
	date: string;
	start_local: string | null;
	start_utc: string | null;
	type: string | null;
	name: string | null;
	distance_m: number | null;
	duration_s: number | null;
	moving_s: number | null;
	elapsed_s: number | null;
	avg_speed_mps: number | null;
	max_speed_mps: number | null;
	avg_hr_bpm: number | null;
	max_hr_bpm: number | null;
	avg_cadence_spm: number | null;
	avg_power_w: number | null;
	normalized_power_w: number | null;
	avg_stride_length_m: number | null;
	avg_vertical_oscillation_cm: number | null;
	avg_vertical_ratio_percent: number | null;
	elevation_gain_m: number | null;
	calories: number | null;
	aerobic_te: number | null;
	anaerobic_te: number | null;
	te_label: string | null;
	training_load: number | null;
	vo2max: number | null;
	lap_count: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Garmin reports 0 for "not measured" on several averages. */
const pos = (v: unknown): number | null => {
	const n = num(v);
	return n != null && n > 0 ? n : null;
};
const round = (v: number | null, d = 2): number | null => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** "YYYY-MM-DD HH:mm:ss" (GMT) -> ISO 8601 UTC. */
function gmtToIso(s: Maybe<string>): string | null {
	if (!s || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return null;
	const d = new Date(s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z"));
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeActivity(a: SummarizedActivityDTO): ActivitySummary | null {
	const id = num(a.activityId);
	const local = a.startTimeLocal ?? null;
	if (id == null || !local || !/^\d{4}-\d{2}-\d{2}/.test(local)) return null;
	const stride = pos(a.avgStrideLength);
	return {
		activity_id: id,
		date: local.slice(0, 10),
		start_local: local.replace(" ", "T").slice(0, 16),
		start_utc: gmtToIso(a.startTimeGMT),
		type: a.activityType?.typeKey ?? null,
		name: a.activityName ?? null,
		distance_m: round(pos(a.distance), 1),
		duration_s: round(pos(a.duration), 1),
		moving_s: round(pos(a.movingDuration), 1),
		elapsed_s: round(pos(a.elapsedDuration), 1),
		avg_speed_mps: round(pos(a.averageSpeed), 3),
		max_speed_mps: round(pos(a.maxSpeed), 3),
		avg_hr_bpm: pos(a.averageHR),
		max_hr_bpm: pos(a.maxHR),
		avg_cadence_spm: round(pos(a.averageRunningCadenceInStepsPerMinute), 1),
		avg_power_w: pos(a.avgPower),
		normalized_power_w: pos(a.normPower),
		avg_stride_length_m: stride == null ? null : round(stride / 100, 3),
		avg_vertical_oscillation_cm: round(pos(a.avgVerticalOscillation), 2),
		avg_vertical_ratio_percent: round(pos(a.avgVerticalRatio), 2),
		elevation_gain_m: num(a.elevationGain),
		calories: pos(a.calories),
		aerobic_te: num(a.aerobicTrainingEffect),
		anaerobic_te: num(a.anaerobicTrainingEffect),
		te_label: a.trainingEffectLabel ?? null,
		training_load: num(a.activityTrainingLoad),
		vo2max: pos(a.vO2MaxValue),
		lap_count: num(a.lapCount),
	};
}

export const SEARCH_PAGE_SIZE = 100;

/** All activities whose local start date is in [start, end], paginated. */
export async function searchActivities(client: GarminClient, start: string, end: string): Promise<ActivitySummary[]> {
	const out: ActivitySummary[] = [];
	for (let offset = 0; ; offset += SEARCH_PAGE_SIZE) {
		const page = await client.get<SummarizedActivityDTO[]>(
			`/activitylist-service/activities/search/activities?startDate=${start}&endDate=${end}&start=${offset}&limit=${SEARCH_PAGE_SIZE}&sortOrder=desc`,
		);
		const rows = Array.isArray(page) ? page : [];
		for (const r of rows) {
			const n = normalizeActivity(r);
			if (n) out.push(n);
		}
		if (rows.length < SEARCH_PAGE_SIZE) return out;
	}
}

export function downloadActivityFit(client: GarminClient, id: number): Promise<Uint8Array | null> {
	return client.getBytes(`/download-service/files/activity/${id}`);
}

export const isRun = (type: string | null | undefined) => !!type && /running|treadmill|track/.test(type);

/** Subset of ActivitySummaryDTO (GET /activity-service/activity/{id}). */
export interface ActivityDetailDTO {
	activityId?: Maybe<number>;
	activityName?: Maybe<string>;
	activityTypeDTO?: Maybe<{ typeKey?: Maybe<string> }>;
	metadataDTO?: Maybe<{ lapCount?: Maybe<number> }>;
	summaryDTO?: Maybe<{
		startTimeLocal?: Maybe<string>; // "YYYY-MM-DDTHH:mm:ss.S"
		startTimeGMT?: Maybe<string>;
		distance?: Maybe<number>;
		duration?: Maybe<number>;
		movingDuration?: Maybe<number>;
		elapsedDuration?: Maybe<number>;
		averageSpeed?: Maybe<number>;
		maxSpeed?: Maybe<number>;
		averageHR?: Maybe<number>;
		maxHR?: Maybe<number>;
		averageRunCadence?: Maybe<number>;
		averagePower?: Maybe<number>;
		normalizedPower?: Maybe<number>;
		strideLength?: Maybe<number>; // cm
		verticalOscillation?: Maybe<number>; // cm
		verticalRatio?: Maybe<number>;
		elevationGain?: Maybe<number>;
		calories?: Maybe<number>;
		trainingEffect?: Maybe<number>;
		anaerobicTrainingEffect?: Maybe<number>;
		trainingEffectLabel?: Maybe<string>;
		activityTrainingLoad?: Maybe<number>;
	}>;
}

/** Maps the detail endpoint onto the search DTO shape and normalizes it the same way. */
export function normalizeActivityDetail(d: ActivityDetailDTO): ActivitySummary | null {
	const s = d.summaryDTO ?? {};
	return normalizeActivity({
		activityId: d.activityId,
		activityName: d.activityName,
		startTimeLocal: s.startTimeLocal?.replace("T", " ") ?? null,
		startTimeGMT: s.startTimeGMT?.replace("T", " ") ?? null,
		activityType: { typeKey: d.activityTypeDTO?.typeKey },
		distance: s.distance,
		duration: s.duration,
		movingDuration: s.movingDuration,
		elapsedDuration: s.elapsedDuration,
		averageSpeed: s.averageSpeed,
		maxSpeed: s.maxSpeed,
		averageHR: s.averageHR,
		maxHR: s.maxHR,
		averageRunningCadenceInStepsPerMinute: s.averageRunCadence,
		avgPower: s.averagePower,
		normPower: s.normalizedPower,
		avgStrideLength: s.strideLength,
		avgVerticalOscillation: s.verticalOscillation,
		avgVerticalRatio: s.verticalRatio,
		elevationGain: s.elevationGain,
		calories: s.calories,
		aerobicTrainingEffect: s.trainingEffect,
		anaerobicTrainingEffect: s.anaerobicTrainingEffect,
		trainingEffectLabel: s.trainingEffectLabel,
		activityTrainingLoad: s.activityTrainingLoad,
		lapCount: d.metadataDTO?.lapCount,
	});
}

export function getActivityDetail(client: GarminClient, id: number): Promise<ActivityDetailDTO | null> {
	return client.get<ActivityDetailDTO>(`/activity-service/activity/${id}`);
}
