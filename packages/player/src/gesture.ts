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

/** A box value as recorders before full precision stored it: to 0.1px. */
const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * Map a point of the take through `from` (the box then) onto `to` (the box now).
 * A box stored to 0.1px that rounds to what the element measures now is the same
 * box: the point stays as recorded. Mapped through the rounded box it would move
 * by the rounding, up to 0.05px, enough to change what an app computes from it
 * (seen: a drawing pad's stroke, normalized to 4 decimals, sent other points).
 */
export function mapPoint(x: number, y: number, from: Box, to: Box): [number, number] {
	const coarse = from.every((v) => tenth(v) === v);
	if (coarse && to.every((v, i) => tenth(v) === from[i])) return [x, y];
	const sx = from[2] > 0 ? to[2] / from[2] : 1;
	const sy = from[3] > 0 ? to[3] / from[3] : 1;
	return [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy];
}

/** The path of the element `depth` levels above the one at `p`. */
export function ancestorPath(p: string, depth: number): string {
	if (depth <= 0) return p;
	const parts = p === "" ? [] : p.split("/");
	return parts.slice(0, Math.max(0, parts.length - depth)).join("/");
}
