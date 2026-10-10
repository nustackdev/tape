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

export type ToParent =
	/** The shim is installed and waits for its scene. */
	| { tape: typeof TAG; type: "hello" }
	/** The app opened its first socket, the clock may start. */
	| { tape: typeof TAG; type: "open" }
	/** The first frames are on screen. */
	| { tape: typeof TAG; type: "painted" };

/** A message without its tag. Distributes over the union, unlike a bare Omit. */
export type Body<M> = M extends unknown ? Omit<M, "tape"> : never;

export function isTape<T extends { tape: string }>(data: unknown): data is T {
	return typeof data === "object" && data !== null && (data as { tape?: unknown }).tape === TAG;
}
