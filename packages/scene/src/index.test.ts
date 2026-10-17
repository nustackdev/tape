import { describe, expect, it } from "vitest";
import {
	base64ToBytes,
	bytesToBase64,
	parseScene,
	playWindow,
	pointerAt,
	pointerTrack,
	type Scene,
	trimScene,
} from "./index";

const scene = (): Scene => ({
	tape: 2,
	meta: {
		recordedAt: "2026-10-10T00:00:00.000Z",
		url: "http://localhost:8080/",
		path: "/",
		viewport: { width: 1280, height: 800, dpr: 2 },
		duration: 5000,
		seed: 1,
		epoch: 1_000_000,
	},
	storage: { local: {} },
	sockets: [{ url: "/ws" }],
	log: [
		{ t: 120, k: "open", s: 0 },
		{ t: 130, k: "msg", s: 0, d: "AAE=" },
		{ t: 200, k: "move", x: 10, y: 10 },
		{ t: 210, k: "down", x: 10, y: 10, b: 0, m: 0, h: { p: "1/0", n: "button" } },
		{ t: 260, k: "up", x: 12, y: 10, b: 0, m: 0, h: { p: "1/0", n: "button" } },
		{ t: 300, k: "out" },
	],
});

describe("scene", () => {
	it("round trips bytes", () => {
		const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	it("parses json and rejects what it can't play", () => {
		expect(parseScene(JSON.stringify(scene())).log).toHaveLength(6);
		expect(() => parseScene({ ...scene(), tape: 1 })).toThrow(/version/);
		expect(() => parseScene({ ...scene(), log: undefined })).toThrow(/log/);
		const back = scene();
		back.log.push({ t: 100, k: "out" });
		expect(() => parseScene(back)).toThrow(/back in time/);
		const stray = scene();
		stray.log.push({ t: 400, k: "msg", s: 3, d: "" });
		expect(() => parseScene(stray)).toThrow(/socket 3/);
	});

	it("trims into a play window", () => {
		expect(playWindow(scene())).toEqual([0, 5000]);
		expect(playWindow(trimScene(scene(), 1000, 4000))).toEqual([1000, 4000]);
		expect(playWindow(trimScene(scene(), undefined, 9000))).toEqual([0, 5000]);
		expect(() => trimScene(scene(), 3000, 2000)).toThrow();
	});

	it("takes the pointer's path out of the log", () => {
		const track = pointerTrack(scene());
		expect(track).toEqual([
			[200, 10, 10, 0],
			[210, 10, 10, 1],
			[260, 12, 10, 2],
			[300, 12, 10, 3],
		]);
		expect(pointerAt(track, 100)).toBe(-1);
		expect(pointerAt(track, 255)).toBe(1);
		expect(pointerAt(track, 9999)).toBe(3);
	});
});
