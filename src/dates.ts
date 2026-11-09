// Date helpers. All calendar dates are plain YYYY-MM-DD strings interpreted in Europe/Oslo.

export const TIMEZONE = "Europe/Oslo";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date: string): boolean {
	if (!DATE_RE.test(date)) return false;
	const d = new Date(`${date}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Today's calendar date in Europe/Oslo. */
export function todayInOslo(now: Date = new Date()): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from start to end. */
export function dateRange(start: string, end: string): string[] {
	const out: string[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
	return out;
}

/** Split an inclusive range into chunks of at most `maxDays` days. */
export function chunkRange(start: string, end: string, maxDays: number): Array<[string, string]> {
	const chunks: Array<[string, string]> = [];
	for (let s = start; s <= end; s = addDays(s, maxDays)) {
		const e = addDays(s, maxDays - 1);
		chunks.push([s, e < end ? e : end]);
	}
	return chunks;
}

/** Format an epoch-ms instant as local Oslo time, e.g. "2026-11-05T07:15". */
export function formatOsloTime(epochMs: number | null | undefined): string | null {
	if (epochMs == null || !Number.isFinite(epochMs)) return null;
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(epochMs));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

