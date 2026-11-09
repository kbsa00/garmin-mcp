import { describe, expect, it } from "vitest";
import { ActivityService } from "../src/activities/service";
import { GarminClient, TOKEN_PATH } from "../src/garmin/client";
import { createServer } from "../src/mcp/server";
import { COMPUTED_STATEMENTS, GARMIN_STATEMENT, PROVENANCE, SERVER_INSTRUCTIONS } from "../src/provenance";
import { GarminRecoverySource, RecoveryService } from "../src/recovery/service";
import { fakeJwt } from "./fixtures/garmin";
import { json, MemoryKV, mockFetch } from "./helpers";

const NOW = new Date("2026-11-05T06:30:00Z");

function server() {
	const { fn } = mockFetch((url) => {
		if (url.pathname === TOKEN_PATH) return new Response(fakeJwt(NOW.getTime() / 1000 + 86400));
		if (url.pathname.includes("dailysummaries")) return json({ data: [] });
		if (url.pathname.startsWith("/hrv-service")) return new Response(null, { status: 204 });
		if (url.pathname.startsWith("/fitnessage-service")) return json({ chronologicalAge: 32, fitnessAge: 29.66, components: { rhr: { value: 57 } } });
		return json([]);
	});
	const client = new GarminClient({ apiKey: "k", kv: new MemoryKV(), fetch: fn, now: () => NOW.getTime() });
	const service = new RecoveryService(new GarminRecoverySource(client), () => NOW);
	const activities = new ActivityService(client, null, service);
	return createServer({ client, service, activities });
}

type Registered = { description?: string; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const tools = (s: ReturnType<typeof server>) => (s as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;

const CALLS: Record<string, unknown> = {
	get_recovery: { date: "2026-11-04" },
	get_recovery_trend: { days: 7 },
	health_check: {},
	get_activities: { from: "2026-11-01", to: "2026-11-05" },
	get_training_load: { days: 7 },
	get_readiness: { date: "2026-11-04" },
	get_recovery_after: { date: "2026-11-01" },
	get_vo2max_trend: { days: 30 },
	get_fitness_age: { date: "2026-11-05" },
};

describe("provenance", () => {
	it("tells Claude in the server instructions to attribute Garmin vs connector values", () => {
		expect(SERVER_INSTRUCTIONS).toMatch(/garmin_provided/);
		expect(SERVER_INSTRUCTIONS).toMatch(/computed_by_connector/);
	});

	it("every tool has a provenance entry and a source label in its description", () => {
		const t = tools(server());
		for (const name of Object.keys(t)) {
			expect(PROVENANCE, name).toHaveProperty(name);
			if (name !== "health_check") expect(t[name]!.description, name).toMatch(/^\[(Garmin data|Connector's own calculation)/);
		}
	});

	it("computed tools say they are not Garmin's", () => {
		for (const name of ["get_training_load", "get_readiness", "get_recovery_after"] as const) {
			expect(PROVENANCE[name].computed_by_connector?.statement).toBe(COMPUTED_STATEMENTS.garmin);
			expect(PROVENANCE[name].computed_by_connector?.fields.join(" ")).toMatch(/NOT/);
		}
	});

	it("every tool result starts with the matching provenance block", async () => {
		const t = tools(server());
		for (const [name, args] of Object.entries(CALLS)) {
			const res = await t[name]!.handler(args, {});
			expect(res.isError, `${name}: ${res.content[0]!.text}`).toBeFalsy();
			const body = JSON.parse(res.content[0]!.text);
			expect(Object.keys(body)[0], name).toBe("provenance");
			expect(body.provenance, name).toEqual(PROVENANCE[name as keyof typeof PROVENANCE]);
			expect(body.provenance.garmin_provided.statement).toBe(GARMIN_STATEMENT);
		}
	});
});

describe("get_fitness_age", () => {
	it("passes Garmin's Fitness Age through with components sorted by priority", async () => {
		const { normalizeFitnessAge } = await import("../src/garmin/fitness-age");
		const r = normalizeFitnessAge(
			{
				chronologicalAge: 32,
				fitnessAge: 29.66853500136648,
				achievableFitnessAge: 25.658,
				components: { rhr: { value: 57, stale: false }, bmi: { value: 26.3, targetValue: 21, potentialAge: 27.21, priority: 1 }, vigorousDaysAvg: { value: 1.6, targetValue: 3, priority: 3 } },
				lastUpdated: "2026-11-05T00:00:00.0",
			},
			"2026-11-05",
		);
		expect(r).toMatchObject({ available: true, fitness_age: 29.7, fitness_age_unrounded: 29.66853500136648, chronological_age: 32, achievable_fitness_age: 25.7 });
		expect(r.components.map((c) => c.component)).toEqual(["bmi", "vigorous_days_per_week", "resting_heart_rate"]);
		expect(normalizeFitnessAge({ invalidReason: "NO_DATA" }, "2026-11-05")).toMatchObject({ available: false, fitness_age: null, invalid_reason: "NO_DATA" });
	});
});
