// The scene format. One recorded session of a websocket driven UI: what the
// server sent, when, and what the pointer did meanwhile.
//
// Frames are opaque. Tape never looks inside them, so anything that speaks
// over a websocket can be recorded, and nothing app or site specific lands in
// here. Every time is milliseconds from the start of the take, which is the
// moment the page was requested.

export const SCENE_VERSION = 1;

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
}

/** A websocket the page opened during the take, in open order. */
export interface SceneSocket {
	/** path + search, origin dropped. The player matches app sockets by it. */
	url: string;
	open: Ms;
	close?: Ms;
	code?: number;
}

/** A server to client message. `d` is base64 for binary, the text itself for text. */
export interface SceneFrame {
	t: Ms;
	/** Index into `sockets`. */
	s: number;
	d: string;
	/** 1 when the message was text. */
	x?: 1;
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

/** [t, x, y, kind]. Viewport css pixels. Tuples, because there are thousands. */
export type PointerSample = [t: Ms, x: number, y: number, kind: PointerKind];

/** A location change. Client side routing is not on the wire, so it is recorded on its own. */
export interface SceneNav {
	t: Ms;
	path: string;
	mode: "push" | "replace" | "pop";
}

export interface Scene {
	tape: typeof SCENE_VERSION;
	meta: SceneMeta;
	/** localStorage at load. The player seeds a private copy so the app boots as it did. */
	storage: { local: Record<string, string> };
	sockets: SceneSocket[];
	frames: SceneFrame[];
	pointer: PointerSample[];
	nav: SceneNav[];
}

/** Parse and check a scene. Throws on anything it can't play. */
export function parseScene(input: string | unknown): Scene {
	const scene = (typeof input === "string" ? JSON.parse(input) : input) as Scene;
	if (!scene || typeof scene !== "object") throw new Error("tape: scene is not an object");
	if (scene.tape !== SCENE_VERSION) {
		throw new Error(`tape: unsupported scene version ${String(scene.tape)}`);
	}
	for (const key of ["sockets", "frames", "pointer", "nav"] as const) {
		if (!Array.isArray(scene[key])) throw new Error(`tape: scene.${key} is missing`);
	}
	if (!scene.meta?.viewport) throw new Error("tape: scene.meta.viewport is missing");
	scene.storage ??= { local: {} };
	return scene;
}

/** The part of the take that plays, after trimming. */
export function playWindow(scene: Scene): [start: Ms, end: Ms] {
	const start = Math.max(0, scene.meta.start ?? 0);
	const end = Math.min(scene.meta.duration, scene.meta.end ?? scene.meta.duration);
	return [start, Math.max(start, end)];
}

/** Set the trim window. Frames stay, they still build the state at `start`. */
export function trimScene(scene: Scene, start?: Ms, end?: Ms): Scene {
	const meta = { ...scene.meta };
	if (start !== undefined) meta.start = start;
	if (end !== undefined) meta.end = end;
	if (meta.start !== undefined && meta.end !== undefined && meta.end <= meta.start) {
		throw new Error("tape: trim end must come after start");
	}
	return { ...scene, meta };
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
