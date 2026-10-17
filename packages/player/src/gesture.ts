// Gestures. A press, the moves while it is held, its release and its click
// replay relative to the element that holds the whole gesture, not at raw
// viewport pixels. The replaying browser may lay the page out a little
// differently (other fonts, other metrics), and a slider's value is where the
// pointer is along its track: mapped through the track's box, it ends on its
// recorded value in any browser.

import type { Entry } from "@nustackdev/tape-scene";

type Box = [left: number, top: number, width: number, height: number];

export interface Gesture {
	/** The press. */
	down: number;
	/** How many levels above the pressed element the holding box is. */
	depth: number;
	/** That element's box in the take. */
	box: Box;
}

const SLACK = 1;

function holds(b: Box, x: number, y: number) {
	return (
		x >= b[0] - SLACK && x <= b[0] + b[2] + SLACK && y >= b[1] - SLACK && y <= b[1] + b[3] + SLACK
	);
}

/** Every entry that is part of a gesture, by index, with its gesture. */
export function gestures(log: readonly Entry[]): Map<number, Gesture> {
	const out = new Map<number, Gesture>();
	log.forEach((e, i) => {
		if (e.k !== "down" || !e.bx?.length) return;
		const part = [i];
		const points: [number, number][] = [[e.x, e.y]];
		let released = false;
		for (let j = i + 1; j < log.length; j++) {
			const n = log[j] as Entry;
			if (n.k === "down") break;
			if (
				n.k === "move" ||
				((n.k === "up" || n.k === "click" || n.k === "dblclick") && n.b === e.b)
			) {
				// After the release only its clicks belong; a move then is hover again.
				if (released && n.k === "move") break;
				part.push(j);
				points.push([n.x, n.y]);
				if (n.k === "up") released = true;
			}
		}
		let depth = e.bx.findIndex((b) => points.every(([x, y]) => holds(b, x, y)));
		if (depth < 0) depth = e.bx.length - 1;
		const g = { down: i, depth, box: e.bx[depth] as Box };
		for (const j of part) out.set(j, g);
	});
	return out;
}

/** Box values as recorders stored them before keeping them exact: to 0.1px, then to 0.001px. */
const GRIDS = [10, 1000];

/**
 * A box value stored to 0.001px, back on the layout grid it was measured on:
 * 1/64px (Chromium, WebKit) or 1/60px (Firefox). Spaced 0.0156px and 0.0167px
 * apart, at most one point of either grid is within the rounding. Anything else
 * is returned as it is.
 */
function unround(v: number): number {
	if (Math.round(v * 1000) / 1000 !== v) return v;
	for (const unit of [64, 60]) {
		const s = Math.round(v * unit) / unit;
		if (Math.abs(s - v) <= 0.0005 + 1e-9) return s;
	}
	return v;
}

/**
 * Map a point of the take through `from` (the box then) onto `to` (the box now).
 * Box values stored rounded move the point by the rounding when mapped through
 * as they are: 0.00025px for a top of 408.28125 stored as 408.281. Pointer
 * coordinates are float32 and sit right below the boundaries of what an app
 * rounds them to, so even that changes what it computes: a drawing pad
 * normalizing to 4 decimals sent 0.1738 for a recorded 0.1737. So a 0.001px
 * value is put back on its layout grid first, and a box that rounds to what the
 * element measures now is the same box: the point stays as recorded.
 */
export function mapPoint(x: number, y: number, from: Box, to: Box): [number, number] {
	const exact = from.map(unround) as Box;
	const same = (g: number) => to.every((v, i) => Math.round(v * g) / g === from[i]);
	if (to.every((v, i) => v === exact[i]) || GRIDS.some(same)) return [x, y];
	const sx = exact[2] > 0 ? to[2] / exact[2] : 1;
	const sy = exact[3] > 0 ? to[3] / exact[3] : 1;
	return [to[0] + (x - exact[0]) * sx, to[1] + (y - exact[1]) * sy];
}

/** The path of the element `depth` levels above the one at `p`. */
export function ancestorPath(p: string, depth: number): string {
	if (depth <= 0) return p;
	const parts = p === "" ? [] : p.split("/");
	return parts.slice(0, Math.max(0, parts.length - depth)).join("/");
}
