import { describe, expect, it } from "vitest";
import {
	base64ToBytes,
	bytesToBase64,
	parseScene,
	playWindow,
	type Scene,
	trimScene,
} from "./index";

const scene = (): Scene => ({
	tape: 1,
	meta: {
		recordedAt: "2026-10-10T00:00:00.000Z",
		url: "http://localhost:8080/",
		path: "/",
		viewport: { width: 1280, height: 800, dpr: 2 },
		duration: 5000,
	},
	storage: { local: {} },
	sockets: [{ url: "/ws", open: 120 }],
	frames: [{ t: 130, s: 0, d: "AAE=" }],
	pointer: [[200, 10, 10, 0]],
	nav: [],
});

describe("scene", () => {
	it("round trips bytes", () => {
		const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	it("parses json and rejects other versions", () => {
		expect(parseScene(JSON.stringify(scene())).sockets).toHaveLength(1);
		expect(() => parseScene({ ...scene(), tape: 2 })).toThrow(/version/);
		expect(() => parseScene({ ...scene(), frames: undefined })).toThrow(/frames/);
	});

	it("trims into a play window", () => {
		expect(playWindow(scene())).toEqual([0, 5000]);
		expect(playWindow(trimScene(scene(), 1000, 4000))).toEqual([1000, 4000]);
		expect(playWindow(trimScene(scene(), undefined, 9000))).toEqual([0, 5000]);
		expect(() => trimScene(scene(), 3000, 2000)).toThrow();
	});
});
