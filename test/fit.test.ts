import { CrcCalculator, Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { extractFit, parseActivityFit, vo2maxFromRaw } from "../src/fit/parse";
import { fitCrc, FitFormatError, stripFit } from "../src/fit/strip";
import { runFit, strengthFit, VO2_RAW_45_7, withVo2, zip } from "./fixtures/fit";

describe("stripFit", () => {
	it("produces a valid, much smaller FIT file without record messages", () => {
		const raw = runFit();
		const stripped = stripFit(raw);
		expect(stripped.length).toBeLessThan(raw.length / 3);
		const decoder = new Decoder(Stream.fromByteArray(stripped));
		expect(decoder.isFIT()).toBe(true);
		expect(decoder.checkIntegrity()).toBe(true);
		const { messages, errors } = new Decoder(Stream.fromByteArray(stripped)).read();
		expect(errors).toHaveLength(0);
		expect(messages.recordMesgs ?? []).toHaveLength(0);
		expect(messages.lapMesgs).toHaveLength(3);
		expect(messages.sessionMesgs).toHaveLength(1);
	});

	it("computes the same CRC as the SDK", () => {
		const raw = runFit();
		expect(fitCrc(raw, 0, raw.length - 2)).toBe(CrcCalculator.calculateCRC(raw, 0, raw.length - 2));
	});

	it("rejects non-FIT input", () => {
		expect(() => stripFit(new Uint8Array(20))).toThrow(FitFormatError);
	});
});

describe("parseActivityFit", () => {
	it("extracts run laps with pace inputs, cadence in steps/min and running dynamics", () => {
		const fit = parseActivityFit(zip(runFit()));
		expect(fit.sport).toBe("running");
		expect(fit.laps).toHaveLength(3);
		expect(fit.laps[1]).toMatchObject({
			lap_index: 1,
			distance_m: 1000,
			moving_seconds: 300,
			avg_speed_mps: 3.333,
			avg_heart_rate_bpm: 151,
			avg_cadence: 171,
			avg_power_w: 250,
			normalized_power_w: 255,
			avg_step_length_m: 0.98,
			avg_vertical_oscillation_mm: 85,
			avg_ground_contact_ms: 245,
			avg_vertical_ratio_percent: 8.5,
		});
	});

	it("ignores strength-training set messages (not supported)", () => {
		const fit = parseActivityFit(zip(strengthFit()));
		expect(fit.laps).toHaveLength(0);
		expect(fit).not.toHaveProperty("sets");
	});

	it("accepts a bare FIT file as well as the ZIP download", () => {
		expect(extractFit(runFit())[8]).toBe(0x2e);
		expect(parseActivityFit(runFit()).laps).toHaveLength(3);
	});

	it("reads the watch's VO2 max from the undocumented message 140", () => {
		const fit = parseActivityFit(zip(withVo2(runFit())));
		expect(fit.vo2max).toBe(45.7);
		expect(fit.laps).toHaveLength(3);
		expect(parseActivityFit(zip(runFit())).vo2max).toBeNull();
		expect(parseActivityFit(zip(withVo2(runFit(), 0))).vo2max).toBeNull(); // treadmill: not updated
	});

	it("converts and sanity-checks raw VO2 max values", () => {
		expect(vo2maxFromRaw(VO2_RAW_45_7)).toBe(45.7);
		expect(vo2maxFromRaw(855054)).toBe(45.7); // a typical raw value as written by the watch
		expect(vo2maxFromRaw(0)).toBeNull();
		expect(vo2maxFromRaw(10)).toBeNull(); // implausibly low
		expect(vo2maxFromRaw(undefined)).toBeNull();
	});
});
