import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isValidDate, TIMEZONE, todayInOslo } from "../dates";
import { PROVENANCE, SERVER_INSTRUCTIONS, type ToolName } from "../provenance";
import { getFitnessAge } from "../garmin/fitness-age";
import { GarminClient, GarminError } from "../garmin/client";
import { MAX_TREND_DAYS, RecoveryService } from "../recovery/service";
import { ActivityService, MAX_ACTIVITY_RANGE_DAYS, MAX_LOAD_DAYS, MAX_VO2_DAYS } from "../activities/service";

export interface ServerDeps {
	client: GarminClient;
	service: RecoveryService;
	activities: ActivityService;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });

async function run(tool: ToolName, fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		// Provenance first, so it is the first thing a model reads.
		return ok({ provenance: PROVENANCE[tool], ...((await fn()) as object) });
	} catch (err) {
		if (err instanceof GarminError || err instanceof RangeError) return fail(err.message);
		console.error("tool error", (err as Error)?.name);
		return fail("Unexpected server error while reading Garmin data.");
	}
}

export function createServer({ client, service, activities }: ServerDeps): McpServer {
	const server = new McpServer({ name: "garmin-recovery", version: "1.1.0" }, { instructions: SERVER_INSTRUCTIONS });

	server.registerTool(
		"get_recovery",
		{
			title: "Garmin recovery for one day",
			description:
				"[Garmin data] Get the user's Garmin recovery summary for ONE day: sleep (score, duration, stages, times), " +
				"overnight HRV (average, status, baseline range), resting heart rate, Body Battery (at wake, high/low, charged/drained) " +
				`and stress (average). Dates are in ${TIMEZONE}. Omit 'date' for today's recovery, meaning the night that ended this morning. ` +
				"Fields Garmin did not return are null and listed in 'missing'. Use this for a morning brief or questions about a specific night or day; " +
				"use get_recovery_trend for multi-day comparisons or baselines.",
			inputSchema: z.object({
				date: z
					.string()
					.optional()
					.describe(`Calendar date YYYY-MM-DD in ${TIMEZONE}. Defaults to today. Sleep/HRV for a date are from the night ending that morning.`),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ date }) => {
			if (date !== undefined && !isValidDate(date)) return fail(`Invalid date "${date}". Use YYYY-MM-DD.`);
			return run("get_recovery", () => service.getRecovery(date));
		},
	);

	server.registerTool(
		"get_recovery_trend",
		{
			title: "Garmin recovery trend over N days",
			description:
				`[Garmin data + connector averages] Get daily Garmin recovery summaries for the last N days ending today (${TIMEZONE}), max ${MAX_TREND_DAYS}, ` +
				"as compact rows (sleep score/duration/stages, HRV, resting HR, Body Battery at wake, stress), plus 7-day and 28-day averages of overnight HRV and resting heart rate. Use this to compare today against the user's " +
				"recent baseline, spot trends, or answer questions spanning several days. For a single day use get_recovery.",
			inputSchema: z.object({
				days: z
					.number()
					.int()
					.min(1)
					.max(MAX_TREND_DAYS)
					.describe(`Number of days to return, including today (1-${MAX_TREND_DAYS}). 7 for a week, 28 for a month.`),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ days }) => run("get_recovery_trend", () => service.getTrend(days)),
	);

	server.registerTool(
		"health_check",
		{
			title: "Check the Garmin connection",
			description:
				"Check that the connector can authenticate with Garmin (exchanges the API key for a fresh access token). " +
				"Returns no health data. Use it only to troubleshoot when other tools fail.",
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () =>
			run("health_check", async () => {
				const info = await client.getToken(true);
				return {
					ok: true,
					garmin_token_exchange: "succeeded",
					access_token_expires_at: new Date(info.expiresAt).toISOString(),
					today_in_timezone: todayInOslo(),
					timezone: TIMEZONE,
				};
			}),
	);

	const dateArg = (what: string) => z.string().describe(`${what} as YYYY-MM-DD (${TIMEZONE}).`);
	const ro = { readOnlyHint: true, openWorldHint: true } as const;

	server.registerTool(
		"get_activities",
		{
			title: "List Garmin activities",
			description:
				"[Garmin data] List the user's Garmin activities (runs, strength sessions, rides, ...) between two dates with per-activity summaries: " +
				"distance, moving time, pace, heart rate, Garmin Training Effect (aerobic/anaerobic), training load, cadence, power, stride length, " +
				`and VO2 max if Garmin provides it. Also totals per activity type. Max ${MAX_ACTIVITY_RANGE_DAYS} days per call. ` +
				"Use get_activity_detail for the laps of one activity.",
			inputSchema: z.object({
				from: dateArg("First local date (inclusive)"),
				to: dateArg("Last local date (inclusive)"),
				type: z
					.string()
					.optional()
					.describe("Optional activity type filter, matched as a substring of Garmin's type key, e.g. 'running', 'strength', 'cycling', 'treadmill'."),
			}),
			annotations: ro,
		},
		async ({ from, to, type }) => run("get_activities", () => activities.getActivities(from, to, type)),
	);

	server.registerTool(
		"get_activity_detail",
		{
			title: "Garmin activity detail (laps)",
			description:
				"[Garmin data from the FIT file] Get one activity in detail from its FIT file: every lap with distance, time, pace, heart rate, cadence (steps/min), " +
				"step length, power and running dynamics (vertical oscillation, ground contact time, vertical ratio), plus the watch's VO2 max if the activity updated it. " +
				"Strength-training sets are not supported. Needs an activity_id from get_activities.",
			inputSchema: z.object({ activity_id: z.number().int().positive().describe("Garmin activity id (from get_activities).") }),
			annotations: ro,
		},
		async ({ activity_id }) => run("get_activity_detail", () => activities.getActivityDetail(activity_id)),
	);

	server.registerTool(
		"get_training_load",
		{
			title: "Training load and ACWR",
			description:
				"[Connector's own calculation on Garmin training load; not Garmin Training Status] Get daily training load for the last N days (sum of Garmin per-activity training load), with acute (7-day) and chronic (28-day) load, " +
				"the acute:chronic workload ratio (ACWR) and a status label (detraining / maintaining / productive / overreaching_risk). " +
				"Use for questions about training volume, ramp rate, or injury/overreaching risk. Computed by this connector, not Garmin Training Status.",
			inputSchema: z.object({
				days: z.number().int().min(1).max(MAX_LOAD_DAYS).describe(`Number of days ending today (1-${MAX_LOAD_DAYS}).`),
			}),
			annotations: ro,
		},
		async ({ days }) => run("get_training_load", () => activities.getTrainingLoad(days)),
	);

	server.registerTool(
		"get_readiness",
		{
			title: "Readiness score (computed)",
			description:
				"[Connector's own calculation; not Garmin Training Readiness] Get a deterministic readiness score 0-100 for a day, computed from last night's HRV and resting HR versus the user's 60-day baseline, " +
				"sleep score, sleep duration and recent training load (ACWR). Returns the score, a label, every component with its inputs, and a one-line explanation. " +
				"Use when deciding how hard to train today. Not Garmin's Training Readiness (unavailable in the Personal API). Omit date for today.",
			inputSchema: z.object({ date: dateArg("Day to score; defaults to today").optional() }),
			annotations: ro,
		},
		async ({ date }) => run("get_readiness", () => activities.getReadiness(date)),
	);

	server.registerTool(
		"get_recovery_after",
		{
			title: "Recovery after a hard day",
			description:
				"[Connector's own calculation on Garmin HRV/RHR; not the watch's recovery time] After a (hard) activity on a given date, report how many days overnight HRV and resting heart rate took to return to the user's baseline band, " +
				"with the daily values for up to 14 days afterwards and the activities done that day. Use to judge how long the user needs to recover from sessions like it.",
			inputSchema: z.object({ date: dateArg("Date of the hard activity") }),
			annotations: ro,
		},
		async ({ date }) => run("get_recovery_after", () => activities.getRecoveryAfter(date)),
	);

	server.registerTool(
		"get_vo2max_trend",
		{
			title: "VO2 max trend",
			description:
				"[Garmin data] Get the VO2 max values Garmin stored with the user's activities over the last N days. If Garmin provides none, returns available=false " +
				"and latest_vo2max=null with an explanation (nothing is estimated).",
			inputSchema: z.object({
				days: z.number().int().min(1).max(MAX_VO2_DAYS).describe(`Number of days ending today (1-${MAX_VO2_DAYS}).`),
			}),
			annotations: ro,
		},
		async ({ days }) => run("get_vo2max_trend", () => activities.getVo2maxTrend(days)),
	);

	server.registerTool(
		"get_fitness_age",
		{
			title: "Garmin Fitness Age",
			description:
				"[Garmin data] Get the user's Garmin Fitness Age (the same metric as on the watch and in Garmin Connect) as of a date: fitness age, actual age, " +
				"achievable fitness age, and the components Garmin bases it on (resting HR, BMI, vigorous days and minutes per week) with Garmin's targets and the " +
				"fitness age reachable by improving each one. Garmin derives Fitness Age from its VO2 max estimate; the VO2 max number itself is not provided. Omit date for today.",
			inputSchema: z.object({ date: z.string().optional().describe(`Date YYYY-MM-DD (${TIMEZONE}); defaults to today. Returns the latest Fitness Age as of that date.`) }),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ date }) => {
			const today = todayInOslo();
			const target = date ?? today;
			if (!isValidDate(target)) return fail(`Invalid date "${target}". Use YYYY-MM-DD.`);
			if (target > today) return fail(`Date ${target} is in the future.`);
			return run("get_fitness_age", () => getFitnessAge(client, target));
		},
	);

	return server;
}
