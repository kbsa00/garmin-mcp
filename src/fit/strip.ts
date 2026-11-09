// Removes FIT messages we don't need (per-second records, device info, ...) before decoding.
//
// The official SDK decodes every field of every message. A 1-hour run has ~2000 `record` messages,
// which costs more CPU than the Workers Free plan allows per invocation (10 ms). Stripping only
// needs the message headers and definitions (sizes), so it is cheap. The result is a valid FIT
// file (new data size and CRCs) that the official decoder reads in a fraction of the time.

export const MESG = {
	FILE_ID: 0,
	SPORT: 12,
	SESSION: 18,
	LAP: 19,
	ACTIVITY: 34,
	FIELD_DESCRIPTION: 206,
	DEVELOPER_DATA_ID: 207,
	/** Undocumented Garmin "physiological metrics" message; field 7 holds the watch's VO2 max estimate. */
	PHYSIOLOGICAL_METRICS: 140,
} as const;

export const DEFAULT_KEEP = new Set<number>(Object.values(MESG));

const CRC_TABLE = [
	0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length, crc = 0): number {
	for (let i = start; i < end; i++) {
		const byte = bytes[i]!;
		let tmp = CRC_TABLE[crc & 0xf]!;
		crc = (crc >> 4) & 0x0fff;
		crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
		tmp = CRC_TABLE[crc & 0xf]!;
		crc = (crc >> 4) & 0x0fff;
		crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
	}
	return crc;
}

interface LocalDef {
	global: number;
	size: number; // data message body size in bytes
}

export class FitFormatError extends Error {}

/** Returns a new FIT file containing only messages whose global number is in `keep`. */
export function stripFit(fit: Uint8Array, keep: Set<number> = DEFAULT_KEEP): Uint8Array {
	if (fit.length < 14) throw new FitFormatError("File too short to be FIT");
	const headerSize = fit[0]!;
	if (headerSize !== 12 && headerSize !== 14) throw new FitFormatError("Invalid FIT header size");
	if (String.fromCharCode(fit[8]!, fit[9]!, fit[10]!, fit[11]!) !== ".FIT") throw new FitFormatError("Missing .FIT signature");
	const view = new DataView(fit.buffer, fit.byteOffset, fit.byteLength);
	const dataSize = view.getUint32(4, true);
	const end = headerSize + dataSize;
	if (end + 2 > fit.length) throw new FitFormatError("Truncated FIT file");

	const out = new Uint8Array(fit.length);
	let w = 14; // always write a 14-byte header
	const defs: Array<LocalDef | undefined> = new Array(16);
	let pos = headerSize;

	while (pos < end) {
		const header = fit[pos]!;
		if (header & 0x80) {
			// Compressed timestamp header: data message for local type in bits 5-6.
			const def = defs[(header >> 5) & 0x03];
			if (!def) throw new FitFormatError("Data message before its definition");
			const len = 1 + def.size;
			if (keep.has(def.global)) out.set(fit.subarray(pos, pos + len), w), (w += len);
			pos += len;
			continue;
		}
		const local = header & 0x0f;
		if (header & 0x40) {
			// Definition message.
			const hasDev = (header & 0x20) !== 0;
			const little = fit[pos + 2] === 0;
			const global = little ? view.getUint16(pos + 3, true) : view.getUint16(pos + 3, false);
			const nFields = fit[pos + 5]!;
			let len = 6 + nFields * 3;
			let size = 0;
			for (let i = 0; i < nFields; i++) size += fit[pos + 6 + i * 3 + 1]!;
			if (hasDev) {
				const nDev = fit[pos + len]!;
				for (let i = 0; i < nDev; i++) size += fit[pos + len + 1 + i * 3 + 1]!;
				len += 1 + nDev * 3;
			}
			defs[local] = { global, size };
			if (keep.has(global)) out.set(fit.subarray(pos, pos + len), w), (w += len);
			pos += len;
			continue;
		}
		const def = defs[local];
		if (!def) throw new FitFormatError("Data message before its definition");
		const len = 1 + def.size;
		if (keep.has(def.global)) out.set(fit.subarray(pos, pos + len), w), (w += len);
		pos += len;
	}
	if (pos !== end) throw new FitFormatError("FIT data does not end on a message boundary");

	// Header: copy protocol/profile version, write new data size, recompute header CRC.
	out[0] = 14;
	out[1] = fit[1]!;
	out[2] = fit[2]!;
	out[3] = fit[3]!;
	const outView = new DataView(out.buffer);
	outView.setUint32(4, w - 14, true);
	out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
	outView.setUint16(12, fitCrc(out, 0, 12), true);
	outView.setUint16(w, fitCrc(out, 0, w), true);
	return out.slice(0, w + 2);
}
