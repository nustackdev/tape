import { describe, expect, it } from "vitest";
import { installClock, installRandom } from "./determinism";

type Win = Window & typeof globalThis;
const fakeWin = () =>
	({ Math: Object.create(Math), crypto: { ...globalThis.crypto }, Date }) as unknown as Win;

describe("determinism", () => {
	it("draws the same numbers for the same seed, and seeks", () => {
		const a = fakeWin();
		const b = fakeWin();
		const ra = installRandom(a, 42);
		installRandom(b, 42);
		const seq = Array.from({ length: 5 }, () => a.Math.random());
		expect(Array.from({ length: 5 }, () => b.Math.random())).toEqual(seq);
		expect(ra.draws()).toBe(5);
		ra.seek(2);
		expect(a.Math.random()).toBe(seq[2]);
		ra.seek(4);
		expect(a.Math.random()).toBe(seq[4]);
	});

	it("routes crypto through the same draws", () => {
		const a = fakeWin();
		const b = fakeWin();
		installRandom(a, 7);
		installRandom(b, 7);
		expect(a.crypto.randomUUID()).toBe(b.crypto.randomUUID());
		expect(a.crypto.randomUUID()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("puts Date on the given clock and keeps the rest", () => {
		const w = { Date } as unknown as Win;
		installClock(w, () => 1_000_000);
		expect(w.Date.now()).toBe(1_000_000);
		expect(new w.Date().getTime()).toBe(1_000_000);
		expect(new w.Date(5).getTime()).toBe(5);
		expect(new w.Date() instanceof Date).toBe(true);
		expect(w.Date.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
	});
});
