import type { Entry } from "@nustackdev/tape-scene";
import { describe, expect, it } from "vitest";
import { ancestorPath, gestures, mapPoint } from "./gesture";

const h = { p: "1/0/2/0", n: "span" };

describe("gestures", () => {
	it("replays a drag relative to the smallest box that held all of it", () => {
		const log: Entry[] = [
			{ t: 0, k: "move", x: 5, y: 5 },
			{
				t: 1,
				k: "down",
				x: 110,
				y: 50,
				b: 0,
				m: 0,
				h,
				// thumb, track, slider root, page
				bx: [
					[103, 43, 14, 14],
					[100, 48, 200, 4],
					[100, 40, 200, 20],
					[0, 0, 800, 600],
				],
			},
			{ t: 2, k: "move", x: 150, y: 51 },
			{ t: 3, k: "move", x: 250, y: 52 },
			{ t: 4, k: "up", x: 250, y: 52, b: 0, m: 0, h },
			{ t: 5, k: "click", x: 250, y: 52, b: 0, m: 0, h },
			{ t: 6, k: "move", x: 400, y: 300 },
		];
		const g = gestures(log);
		// The hover before and after is not part of it.
		expect([...g.keys()]).toEqual([1, 2, 3, 4, 5]);
		// The thumb holds only the press; the track (within a pixel) holds the whole drag.
		expect(g.get(1)?.depth).toBe(1);
		expect(ancestorPath(h.p, 1)).toBe("1/0/2");
	});

	it("maps a point to the same place along the box, whatever the box is now", () => {
		// The track moved right 30px and grew 10% in another browser: 75% along stays 75% along.
		expect(mapPoint(250, 50, [100, 48, 200, 4], [130, 60, 220, 4])).toEqual([295, 62]);
	});

	it("leaves a point as recorded when the box, stored to 0.1px, is the same box now", () => {
		// The training pad: recorded at top 408.3, it measures 408.28125. Mapped through
		// the rounded box the stroke would move up 0.019px, and the app, normalizing to
		// four decimals, sent 0.2199 where the take sent 0.22.
		const y = 408.28125 + 0.22 * 280;
		expect(mapPoint(435.6, y, [346, 408.3, 280, 280], [346, 408.28125, 280, 280])).toEqual([
			435.6,
			y,
		]);
		// A box stored at full precision is mapped exactly, by however little it moved.
		const [, my] = mapPoint(435.6, y, [346, 408.28125, 280, 280], [346, 408.29999, 280, 280]);
		expect(Math.round(((my - 408.29999) / 280) * 1e4) / 1e4).toBe(0.22);
		// And a rounded box that really moved is still mapped.
		expect(mapPoint(350, 410, [346, 408.3, 280, 280], [356, 408.3, 280, 280])).toEqual([360, 410]);
	});
});
