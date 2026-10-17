// The scene format. One recorded session of a websocket driven UI, as one
// ordered log: what the server sent, what the pointer and keys did, where
// focus, selection and the url went, in the order the recorded browser
// handled them.
//
// Frames are opaque. Tape never looks inside them, so anything that speaks
// over a websocket can be recorded, and nothing app or site specific lands in
// here. Every time is milliseconds of the recorded page's own clock
// (performance.now(), from its navigation start).

export const SCENE_VERSION = 2;

export type Ms = number;

export interface Viewport {
	width: number;
	height: number;
	dpr: number;
}

export interface SceneMeta {
	/** ISO timestamp of the take. */
	recordedAt: string;
	/** Page url the take was recorded on. */
	url: string;
	/** path + search + hash at load. The player puts the app there before it boots. */
	path: string;
	/** Browser viewport at load. The player renders the app at exactly this size. */
	viewport: Viewport;
	/** Length of the take. */
	duration: Ms;
	/** Trim window. Everything before `start` is fast forwarded, `end` cuts. */
	start?: Ms;
	end?: Ms;
	userAgent?: string;
	title?: string;
	/** Seed of the shared generator, see ./determinism.ts. */
	seed: number;
	/** Browser Date.now() at t = 0. */
	epoch: number;
}

/** A websocket the page created during the take, in creation order. */
export interface SceneSocket {
	/** path + search, origin dropped. */
	url: string;
}

export const MOD_SHIFT = 1;
export const MOD_CTRL = 2;
export const MOD_ALT = 4;
export const MOD_META = 8;

/**
 * Where an element sits: child indices from <html> down, eg "1/0/3". Empty
 * for <html> itself. The replay builds the same DOM, so it resolves.
 */
export type ElementPath = string;

/** Where a node sits, text nodes too: childNodes indices from <html> down. */
export type NodePath = string;

/**
 * What the recorded page had where an input landed. `h` is a hash of the
 * element's text, kept only when that text is short (a button, a menu item):
 * long text is a container, and its hash says nothing about the target. `a`,
 * on form fields, is a hash of what names the field (type, name, id,
 * placeholder, label), which its text can't.
 */
export interface Target {
	p: ElementPath;
	/** Tag name, lower case. */
	n: string;
	h?: number;
	a?: number;
}

/** On every entry: `t` its time, `r` the random draws before it, `w` the clock while it was handled. */
type Stamp = { t: Ms; r?: number; w?: number };

export type PointerButtonKind = "down" | "up" | "click" | "dblclick" | "contextmenu";
export type KeyKind = "keydown" | "keypress" | "keyup";

export type Entry = Stamp &
	/** Socket `s` opened. */
	(
		| { k: "open"; s: number }
		/** A server message on socket `s`. `d` is base64 for binary, the text itself when `x`. */
		| { k: "msg"; s: number; d: string; x?: 1 }
		/** The server closed socket `s`. A close the app asked for is not here: the replayed app asks again. */
		| { k: "close"; s: number; c: number }
		/**
		 * The app sent a message on socket `s`; `h` hashes it, `d` is it (base64 for
		 * binary, the text when `x`), for telling what differed. The replay doesn't
		 * send it, it waits for the replayed app to: what the server said after it
		 * was a reply, and goes to the app only once the app asked.
		 */
		| { k: "send"; s: number; h: number; d?: string; x?: 1 }
		/** The pointer moved to x, y, viewport css pixels. */
		| { k: "move"; x: number; y: number }
		/** The pointer left the page. */
		| { k: "out" }
		/**
		 * A pointer button event at x, y on target `h`. `b` the button, `m` modifier
		 * bits. On `down`, `bx` has the boxes of the target and its ancestors,
		 * [left, top, width, height] each, innermost first: a press and its drag
		 * replay relative to the one that holds the whole gesture, so a slider ends on
		 * its recorded value whatever the replaying browser's layout.
		 */
		| {
				k: PointerButtonKind;
				x: number;
				y: number;
				b: number;
				m: number;
				h: Target;
				bx?: [number, number, number, number][];
		  }
		/**
		 * A key, with focus on `f` (null: nothing focused). `keypress` is the
		 * character step, its own task after keydown's. `rep` marks a held key repeating.
		 */
		| { k: KeyKind; key: string; code: string; m: number; rep?: 1; f: ElementPath | null }
		/** An element (or the document, "") scrolled to x, y. */
		| { k: "scroll"; p: ElementPath; x: number; y: number }
		/** The input or textarea typed into, `h`, now holds `v`. */
		| { k: "value"; h: Target; v: string }
		/**
		 * Focus moved to `h`, or off everything. Like value and selection, this is
		 * what a default action did: the replay does it by hand, so this corrects
		 * it only where it differs.
		 */
		| { k: "focus"; h: Target | null }
		/** The focused field, `h`, has its selection at a..b. */
		| { k: "sel"; h: Target; a: number; b: number }
		/** The selection in an editable runs from a to b. */
		| { k: "range"; a: [NodePath, number]; b: [NodePath, number] }
		/**
		 * The url changed. Done by the app (no `by`): the replayed app does it
		 * again, this only checks it did. `by: "user"`: the browser's back or
		 * forward, which the replay performs.
		 */
		| { k: "nav"; path: string; mode: "push" | "replace" | "pop"; by?: "user" }
	);

export type EntryKind = Entry["k"];

export interface Scene {
	tape: typeof SCENE_VERSION;
	meta: SceneMeta;
	/** localStorage at load. The player seeds a private copy so the app boots as it did. */
	storage: { local: Record<string, string> };
	sockets: SceneSocket[];
	log: Entry[];
}

const POINTER_BUTTONS = new Set(["down", "up", "click", "dblclick", "contextmenu"]);
const KEYS = new Set(["keydown", "keypress", "keyup"]);

export function isPointerButton(e: Entry): e is Extract<Entry, { k: PointerButtonKind }> {
	return POINTER_BUTTONS.has(e.k);
}

export function isKey(e: Entry): e is Extract<Entry, { k: KeyKind }> {
	return KEYS.has(e.k);
}

/** Entries that are the user's input, as opposed to the server's frames or the app's navigation. */
export function isInput(e: Entry): boolean {
	return (
		isPointerButton(e) ||
		isKey(e) ||
		e.k === "move" ||
		e.k === "out" ||
		e.k === "scroll" ||
		e.k === "value" ||
		e.k === "focus" ||
		e.k === "sel" ||
		e.k === "range" ||
		(e.k === "nav" && e.by === "user")
	);
}

/** Parse and check a scene. Throws on anything it can't play. */
export function parseScene(input: string | unknown): Scene {
	const scene = (typeof input === "string" ? JSON.parse(input) : input) as Scene;
	if (!scene || typeof scene !== "object") throw new Error("tape: scene is not an object");
	if (scene.tape !== SCENE_VERSION) {
		throw new Error(
			`tape: unsupported scene version ${String(scene.tape)}, record it again with tape ${SCENE_VERSION}`,
		);
	}
	if (!Array.isArray(scene.sockets)) throw new Error("tape: scene.sockets is missing");
	if (!Array.isArray(scene.log)) throw new Error("tape: scene.log is missing");
	if (!scene.meta?.viewport) throw new Error("tape: scene.meta.viewport is missing");
	if (typeof scene.meta.seed !== "number" || typeof scene.meta.epoch !== "number") {
		throw new Error("tape: scene.meta.seed and epoch are missing");
	}
	let last = Number.NEGATIVE_INFINITY;
	for (const [i, e] of scene.log.entries()) {
		if (!e || typeof e.t !== "number" || typeof e.k !== "string") {
			throw new Error(`tape: scene.log[${i}] is not an entry`);
		}
		if (e.t < last) throw new Error(`tape: scene.log[${i}] goes back in time`);
		last = e.t;
		if (
			(e.k === "open" || e.k === "msg" || e.k === "close" || e.k === "send") &&
			!scene.sockets[e.s]
		) {
			throw new Error(`tape: scene.log[${i}] names socket ${e.s}, not in scene.sockets`);
		}
	}
	scene.storage ??= { local: {} };
	return scene;
}

/** The part of the take that plays, after trimming. */
export function playWindow(scene: Scene): [start: Ms, end: Ms] {
	const start = Math.max(0, scene.meta.start ?? 0);
	const end = Math.min(scene.meta.duration, scene.meta.end ?? scene.meta.duration);
	return [start, Math.max(start, end)];
}

/** Set the trim window. Entries stay, they still build the state at `start`. */
export function trimScene(scene: Scene, start?: Ms, end?: Ms): Scene {
	const meta = { ...scene.meta };
	if (start !== undefined) meta.start = start;
	if (end !== undefined) meta.end = end;
	if (meta.start !== undefined && meta.end !== undefined && meta.end <= meta.start) {
		throw new Error("tape: trim end must come after start");
	}
	return { ...scene, meta };
}

export const POINTER_MOVE = 0;
export const POINTER_DOWN = 1;
export const POINTER_UP = 2;
export const POINTER_OUT = 3;

export type PointerKind =
	| typeof POINTER_MOVE
	| typeof POINTER_DOWN
	| typeof POINTER_UP
	| typeof POINTER_OUT;

/** [t, x, y, kind]. What a drawn cursor needs, taken out of the log. */
export type PointerSample = [t: Ms, x: number, y: number, kind: PointerKind];

/** The pointer's path through the take, for drawing a cursor: moves, presses, releases, leaving. */
export function pointerTrack(scene: Scene): PointerSample[] {
	const out: PointerSample[] = [];
	let x = -1;
	let y = -1;
	for (const e of scene.log) {
		let kind: PointerKind;
		if (e.k === "move") kind = POINTER_MOVE;
		else if (e.k === "down" && e.b === 0) kind = POINTER_DOWN;
		else if (e.k === "up" && e.b === 0) kind = POINTER_UP;
		else if (e.k === "out") {
			out.push([e.t, x, y, POINTER_OUT]);
			continue;
		} else continue;
		x = e.x;
		y = e.y;
		out.push([e.t, x, y, kind]);
	}
	return out;
}

/** Index of the last pointer sample at or before t, or -1. */
export function pointerAt(track: readonly PointerSample[], t: number): number {
	const first = track[0];
	if (!first || first[0] > t) return -1;
	let lo = 0;
	let hi = track.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((track[mid]?.[0] ?? Number.POSITIVE_INFINITY) <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export { installClock, installRandom, type Randomness } from "./determinism";
export { installTargets, type Targets } from "./targets";
