// Messages between the host (Tape.Root's engine, or the render harness) and
// the shim inside the iframe. postMessage only, so the bundle may live on
// another origin.
//
// The host says how far the take may go (`until`); the shim's executor applies
// the log up to there, in order, and says how far it got (`pos`). The host
// draws everything from `pos`, so nothing on the page can run ahead of the app.

import type { Scene } from "@nustackdev/tape-scene";

export const TAG = "tape";

export type ToShim =
	/**
	 * The scene to play. `input`: feed recorded input into the app too, not
	 * just server frames. `waive`: entries whose precondition is skipped, after
	 * takes failed on them.
	 */
	| {
			tape: typeof TAG;
			type: "scene";
			scene: Scene;
			input: boolean;
			waive: number[];
			/** Entries takes failed on: say when one passes. */
			watch: number[];
			/**
			 * How many times the usual deadlines this take waits. Takes that follow
			 * failed ones get more, so a restart never repeats a timeout as it was.
			 */
			patience?: number;
	  }
	/** Whether the take is playing on a visible page: only then do its deadlines count. */
	| { tape: typeof TAG; type: "run"; on: boolean }
	/** Apply everything up to `t`. Never moves back: a new take does that. */
	| { tape: typeof TAG; type: "until"; t: number };

/**
 * Every message to the host carries the take it comes from, as the host put
 * it in the iframe's url. The host tells takes apart by it, not by the
 * event's source: WebKit sometimes reports the host page itself there.
 */
export type ToParent = { tape: typeof TAG; take: string } & ToParentBody;

type ToParentBody =
	/** The shim is installed and waits for its scene. */
	| { type: "hello" }
	/**
	 * Where the executor is: the log is applied up to `t`. `idle`: nothing more
	 * is due before the host's `until`. `settled`: and the page went quiet after
	 * it. `wait`: the entry it waits on, while a precondition doesn't hold.
	 */
	| { type: "pos"; t: number; idle: boolean; settled: boolean; wait?: number }
	/** The take can't go on: entry `at` (or none) failed for `reason`. */
	| { type: "fail"; at: number | null; reason: string }
	/**
	 * The take's page is unloading, and why: `beforeunload` (a navigation it
	 * started), `hashchange` or `popstate` (a real one, the guard missed),
	 * `pagehide` with no navigation before it is `teardown` (the host removed it).
	 */
	| { type: "gone"; why: GoneWhy }
	/** Real focus came into the take's frame: the page takes it back. */
	| { type: "focused" }
	/** This browser can't run a take in an opaque origin: run takes same origin. */
	| { type: "origin" }
	/** Entry `at`, which takes failed on before, held this time. */
	| { type: "passed"; at: number }
	/** The browser's own editor is about to edit: some scroll the page around the frame to the caret. */
	| { type: "hold" };

export type GoneWhy = "beforeunload" | "hashchange" | "popstate" | "teardown";

/** The url hash key the take id travels in. */
export const TAKE_KEY = "tape-take";

/** The attribute on a take's iframe. */
export const TAKE_ATTR = "data-tape-take";

/**
 * A take's frame is named this, a name its page can read whatever its origin.
 * A Tape.Root in such a frame (the site loaded into its own replay) stays inert.
 */
export const TAKE_NAME = "tape-take";

/**
 * What the iframe may do: run scripts, and submit forms (else no submit event
 * fires at all; the shim cancels the navigation). An opaque origin: the page
 * around it, its history, storage and cookies are out of reach. See KERNEL.md,
 * Isolation.
 */
export const SANDBOX = "allow-scripts allow-forms";

/**
 * The fallback, for a host that can't serve the bundle with
 * `Access-Control-Allow-Origin` (an opaque origin needs it for module scripts,
 * fonts and css). Same origin: the frame could reach the page around it.
 */
export const SANDBOX_SAME_ORIGIN = "allow-scripts allow-forms allow-same-origin";

/** A message without its envelope. Distributes over the union, unlike a bare Omit. */
export type Body<M> = M extends unknown ? Omit<M, "tape" | "take"> : never;

export function isTape<T extends { tape: string }>(data: unknown): data is T {
	return typeof data === "object" && data !== null && (data as { tape?: unknown }).tape === TAG;
}
