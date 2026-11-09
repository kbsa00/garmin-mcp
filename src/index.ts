import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { AuthHandler } from "./auth/handler";
import { GarminClient } from "./garmin/client";
import { createServer } from "./mcp/server";
import { GarminRecoverySource, RecoveryService } from "./recovery/service";
import { ActivityService } from "./activities/service";
import { Store } from "./db/store";
import { backfill, dailySync, isOsloSyncHour } from "./sync/sync";



function services(bindings: Env, opts: { backfill?: boolean } = {}) {
	const client = new GarminClient({
		apiKey: bindings.GARMIN_API_KEY,
		kv: bindings.APP_KV,
		// Backfill waits out rate limits instead of failing fast.
		...(opts.backfill ? { max429Retries: 6, maxRetryAfterMs: 120_000 } : {}),
	});
	const store = bindings.DB ? new Store(bindings.DB) : null;
	const recovery = new RecoveryService(new GarminRecoverySource(client, opts.backfill ? 1000 : null), undefined, store ?? undefined);
	const activities = new ActivityService(client, store, recovery);
	return { client, store, recovery, activities };
}

const DST_CRONS = new Set(["30 3 * * *", "30 4 * * *"]);

const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		const { client, recovery, activities } = services(bindings);
		return createMcpHandler(() => createServer({ client, service: recovery, activities }))(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

// Only /mcp is protected API; it requires a valid OAuth access token. Everything else is
// OAuth discovery/registration/token endpoints (served by the provider) or the login page.
const provider = new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	defaultHandler: AuthHandler as unknown as ExportedHandler<Env>,
	scopesSupported: ["garmin:read"],
	accessTokenTTL: 60 * 60,
	refreshTokenTTL: 90 * 24 * 60 * 60,
	resourceMetadata: { resource: env.MCP_RESOURCE },
});

export default {
	fetch: (request: Request, bindings: Env, ctx: ExecutionContext) => provider.fetch(request, bindings, ctx),

	// Cron: nightly sync at 05:30 Oslo. The two DST crons are gated on Oslo local time so exactly one
	// runs; any other configured cron runs the sync directly. The cron string "backfill" is used only
	// by scripts/backfill.mjs via `wrangler dev --test-scheduled`.
	async scheduled(controller: ScheduledController, bindings: Env, ctx: ExecutionContext) {
		const isBackfill = controller.cron === "backfill";
		if (DST_CRONS.has(controller.cron) && !isOsloSyncHour(controller.scheduledTime)) return;
		const { client, store, recovery, activities } = services(bindings, { backfill: isBackfill });
		if (!store) return;
		const deps = { client, store, recovery, activities };
		const job = isBackfill ? backfill(deps) : dailySync(deps);
		ctx.waitUntil(
			job.then(
				(report) => console.log(isBackfill ? "backfill done" : "daily sync done", report),
				(err) => console.error(isBackfill ? "backfill failed" : "daily sync failed", (err as Error).name, (err as Error).message),
			),
		);
	},
} satisfies ExportedHandler<Env>;
