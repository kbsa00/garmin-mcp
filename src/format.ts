export function formatDuration(seconds: number): string {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatPace(secondsPerKm: number | null): string | null {
	if (secondsPerKm == null || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return null;
	return `${formatDuration(secondsPerKm)}/km`;
}
