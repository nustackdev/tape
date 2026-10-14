// Messages between <LiveScene> (the parent page) and the shim (inside the
// iframe). postMessage only, so the bundle may live on another origin.
//
// The parent owns time: it ticks, and the shim delivers whatever is due.
// One clock drives both the frames and the cursor, so they never drift.

import type { Scene } from "@nustackdev/tape-scene";

export const TAG = "tape";

export type ToShim =
	/** `input`: feed recorded input into the app too, not just server frames. */
	| { tape: typeof TAG; type: "scene"; scene: Scene; input: boolean }
	/** Deliver everything up to `t`. */
	| { tape: typeof TAG; type: "tick"; t: number };

/**
 * Every message to the parent carries the take it comes from, as the player
 * put it in the iframe's url. The parent tells takes apart by it, not by the
 * event's source: WebKit sometimes reports the parent page itself there.
 */
export type ToParent = { tape: typeof TAG; take: string } & ToParentBody;

type ToParentBody =
	/** The shim is installed and waits for its scene. */
	| { type: "hello" }
	/** The app opened its first socket, the clock may start. */
	| { type: "open" }
	/** The first frames are on screen. */
	| { type: "painted" };

/** The url hash key the take id travels in. */
export const TAKE_KEY = "tape-take";

/** A message without its envelope. Distributes over the union, unlike a bare Omit. */
export type Body<M> = M extends unknown ? Omit<M, "tape" | "take"> : never;

export function isTape<T extends { tape: string }>(data: unknown): data is T {
	return typeof data === "object" && data !== null && (data as { tape?: unknown }).tape === TAG;
}
