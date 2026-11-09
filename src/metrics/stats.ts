export interface Baseline {
	mean: number;
	sd: number;
	n: number;
}

/** Mean and sample standard deviation of the non-null values; null if fewer than `minN`. */
export function baseline(values: Array<number | null | undefined>, minN: number): Baseline | null {
	const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
	if (xs.length < minN) return null;
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
	return { mean: round(mean, 2), sd: round(Math.sqrt(variance), 2), n: xs.length };
}

export const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
