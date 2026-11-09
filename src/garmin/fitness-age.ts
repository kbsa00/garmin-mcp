// Garmin Fitness Age: GET /fitnessage-service/fitnessage/v2/{calendarDate}. Garmin data, passed through.

import type { GarminClient } from "./client";
import type { Maybe } from "./types";

interface ComponentDTO {
	value?: Maybe<number>;
	targetValue?: Maybe<number>;
	improvementValue?: Maybe<number>;
	potentialAge?: Maybe<number>;
	priority?: Maybe<number>;
	stale?: Maybe<boolean>;
	numOfWeeksForIm?: Maybe<number>;
	lastMeasurementDate?: Maybe<string>;
}

export interface FitnessAgeDTO {
	chronologicalAge?: Maybe<number>;
	fitnessAge?: Maybe<number>;
	achievableFitnessAge?: Maybe<number>;
	previousFitnessAge?: Maybe<number>;
	components?: Maybe<Record<string, Maybe<ComponentDTO>>>;
	lastUpdated?: Maybe<string>;
	invalidReason?: Maybe<string>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/** Garmin's component keys -> descriptive names with units. */
const COMPONENTS: Record<string, { name: string; unit: string }> = {
	rhr: { name: "resting_heart_rate", unit: "bpm" },
	bmi: { name: "bmi", unit: "kg/m²" },
	vigorousDaysAvg: { name: "vigorous_days_per_week", unit: "days/week (6-week average)" },
	vigorousMinutesAvg: { name: "vigorous_minutes_per_week", unit: "minutes/week (6-week average)" },
};

export function normalizeFitnessAge(dto: FitnessAgeDTO | null, date: string) {
	const fitness = num(dto?.fitnessAge);
	const components = Object.entries(dto?.components ?? {}).map(([key, c]) => ({
		component: COMPONENTS[key]?.name ?? key,
		unit: COMPONENTS[key]?.unit ?? null,
		value: num(c?.value),
		target: num(c?.targetValue),
		improvement_needed: num(c?.improvementValue),
		fitness_age_if_target_reached: r1(num(c?.potentialAge)),
		priority: num(c?.priority),
		stale: c?.stale ?? null,
		last_measured: c?.lastMeasurementDate ?? null,
	}));
	components.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
	return {
		date,
		available: fitness != null,
		fitness_age: r1(fitness),
		fitness_age_unrounded: fitness,
		chronological_age: num(dto?.chronologicalAge),
		achievable_fitness_age: r1(num(dto?.achievableFitnessAge)),
		previous_fitness_age: r1(num(dto?.previousFitnessAge)),
		last_updated: dto?.lastUpdated ?? null,
		invalid_reason: dto?.invalidReason ?? null,
		components,
	};
}

export async function getFitnessAge(client: GarminClient, date: string) {
	const dto = await client.get<FitnessAgeDTO>(`/fitnessage-service/fitnessage/v2/${date}?fullHistoryScan=true`);
	return normalizeFitnessAge(dto, date);
}
