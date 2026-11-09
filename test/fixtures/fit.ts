// Synthetic FIT activity files, encoded with the official SDK and zipped like Garmin's download.

import { Encoder, Profile } from "@garmin/fitsdk";
import { zipSync } from "fflate";
import { fitCrc } from "../../src/fit/strip";

const MESG = Profile.MesgNum as Record<string, number>;
export const START = new Date("2026-11-03T06:00:00Z");

function encode(write: (enc: Encoder) => void): Uint8Array {
	const enc = new Encoder();
	enc.onMesg(MESG.FILE_ID!, { type: "activity", manufacturer: "garmin", product: 1, timeCreated: START, serialNumber: 1234 } as never);
	write(enc);
	return enc.close();
}

export const zip = (fit: Uint8Array, name = "123_ACTIVITY.fit") => zipSync({ [name]: fit });

/** 3 laps of 1 km at 5:00/km plus 900 per-second records (stripped before decoding). */
export function runFit(): Uint8Array {
	return encode((enc) => {
		for (let i = 0; i < 900; i++) {
			enc.onMesg(MESG.RECORD!, {
				timestamp: new Date(START.getTime() + i * 1000),
				heartRate: 140 + (i % 20),
				distance: i * 3.33,
				enhancedSpeed: 3.33,
				cadence: 85,
			} as never);
		}
		for (let lap = 0; lap < 3; lap++) {
			enc.onMesg(MESG.LAP!, {
				messageIndex: lap,
				timestamp: new Date(START.getTime() + (lap + 1) * 300_000),
				startTime: new Date(START.getTime() + lap * 300_000),
				totalElapsedTime: 300,
				totalTimerTime: 300,
				totalDistance: 1000,
				enhancedAvgSpeed: 1000 / 300,
				enhancedMaxSpeed: 3.6,
				avgHeartRate: 150 + lap,
				maxHeartRate: 160 + lap,
				avgCadence: 85,
				avgFractionalCadence: 0.5,
				maxCadence: 90,
				avgPower: 250,
				maxPower: 300,
				normalizedPower: 255,
				avgStepLength: 980,
				avgVerticalOscillation: 85,
				avgStanceTime: 245,
				avgVerticalRatio: 8.5,
				totalAscent: 5,
				intensity: "active",
				sport: "running",
			} as never);
		}
		enc.onMesg(MESG.SESSION!, {
			timestamp: new Date(START.getTime() + 900_000),
			startTime: START,
			totalElapsedTime: 900,
			totalTimerTime: 900,
			totalDistance: 3000,
			sport: "running",
			subSport: "generic",
			numLaps: 3,
			firstLapIndex: 0,
		} as never);
	});
}

/** Strength session: squat 3x10 @ 60 kg, bench 1x8 @ 70 kg, rests between sets. */
export function strengthFit(): Uint8Array {
	return encode((enc) => {
		let t = START.getTime();
		const set = (i: number, type: "active" | "rest", extra: Record<string, unknown> = {}) => {
			enc.onMesg(MESG.SET!, {
				messageIndex: i,
				timestamp: new Date(t + 30_000),
				startTime: new Date(t),
				duration: 30,
				setType: type,
				...extra,
			} as never);
			t += 30_000;
		};
		let i = 0;
		for (let s = 0; s < 3; s++) {
			set(i++, "active", { repetitions: 10, weight: 60, category: ["squat"], categorySubtype: [2] });
			set(i++, "rest");
		}
		set(i++, "active", { repetitions: 8, weight: 70, category: ["benchPress"], categorySubtype: [1] });
		enc.onMesg(MESG.SESSION!, {
			timestamp: new Date(t),
			startTime: START,
			totalElapsedTime: (t - START.getTime()) / 1000,
			totalTimerTime: (t - START.getTime()) / 1000,
			sport: "training",
			subSport: "strengthTraining",
		} as never);
	});
}

/** Raw value Garmin writes in message 140 field 7 for a VO2 max of 45.7 (45.7 × 65536 / 3.5). */
export const VO2_RAW_45_7 = Math.round((45.7 * 65536) / 3.5);

/**
 * Appends the undocumented message 140 (field 7 = uint32 raw VO2 max) to a FIT file, as Garmin
 * watches write it. The SDK encoder cannot encode unknown messages, so this works on raw bytes.
 */
export function withVo2(fit: Uint8Array, raw = VO2_RAW_45_7): Uint8Array {
	const headerSize = fit[0]!;
	const dataSize = new DataView(fit.buffer, fit.byteOffset).getUint32(4, true);
	const local = 15;
	const def = [0x40 | local, 0, 0, 140 & 0xff, 140 >> 8, 1, 7, 4, 0x86];
	const data = [local, raw & 0xff, (raw >> 8) & 0xff, (raw >> 16) & 0xff, (raw >>> 24) & 0xff];
	const body = new Uint8Array(dataSize + def.length + data.length);
	body.set(fit.subarray(headerSize, headerSize + dataSize));
	body.set([...def, ...data], dataSize);
	const out = new Uint8Array(14 + body.length + 2);
	out.set(fit.subarray(0, 12));
	out[0] = 14;
	const view = new DataView(out.buffer);
	view.setUint32(4, body.length, true);
	view.setUint16(12, fitCrc(out, 0, 12), true);
	out.set(body, 14);
	view.setUint16(14 + body.length, fitCrc(out, 0, 14 + body.length), true);
	return out;
}
