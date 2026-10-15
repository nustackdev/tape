"use client";

import type { Scene } from "@nustackdev/tape-scene";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type Chapter, chapterAt, progressAt } from "./chapter";
import { Engine, loadScene } from "./engine";

/** What the parts of a tape read: where it is, what plays, what is shown. */
export interface TapeState {
	/** Url of the app build the take replays in. */
	app: string;
	label: string;
	chapters: readonly Chapter[];
	/** Near the viewport: the scene loads. */
	near: boolean;
	scene: Scene | null;
	/** The recorded viewport, once loaded. */
	viewport: { width: number; height: number } | null;
	/** The playable part of the take, ms, once loaded. */
	range: [number, number] | null;
	playing: boolean;
	/** The clock, ms of the take. Moves every frame. */
	time: number;
	/** The chapter playing, -1 with none. */
	chapter: number;
	/** 0 to chapters.length, see progressAt. */
	progress: number;
	/** The iframes to render, and the one shown. */
	takes: { ids: string[]; front: string | null };
}

/** What a part can do to the tape. Stable for the tape's life. */
export interface TapeApi {
	/** Move the clock to `t`. A `jump` far ahead loads in rather than playing through. */
	seek(t: number, opts?: { jump?: boolean }): void;
	/** Play; at the end, from the top unless `rewind` is false. */
	play(opts?: { rewind?: boolean }): void;
	pause(): void;
	/** The clock now, without subscribing to it. */
	time(): number;
	readonly playing: boolean;
	/** Jump to chapter `i` and play. */
	chapter(i: number): void;
}

/** The store behind the hooks, and the engine. Internal to the parts. */
export class TapeStore {
	state: TapeState;
	private subs = new Set<() => void>();
	private frames = new Set<(shown: number, dt: number) => void>();
	readonly api: TapeApi;

	constructor(
		readonly engine: Engine,
		init: Pick<TapeState, "app" | "label" | "chapters">,
	) {
		this.state = {
			...init,
			near: false,
			scene: null,
			viewport: null,
			range: null,
			playing: false,
			time: 0,
			chapter: chapterAt(init.chapters, 0),
			progress: 0,
			takes: { ids: [], front: null },
		};
		const e = engine;
		this.api = {
			seek: (t, opts) => e.seek(t, opts),
			play: (opts) => e.play(opts),
			pause: () => e.pause(),
			time: () => e.t,
			get playing() {
				return e.playing;
			},
			chapter: (i) => {
				const c = this.state.chapters[i];
				if (!c) return;
				e.seek(Math.max(c.t, e.start), { jump: true });
				e.play();
			},
		};
	}

	get = () => this.state;

	subscribe = (fn: () => void) => {
		this.subs.add(fn);
		return () => {
			this.subs.delete(fn);
		};
	};

	set(patch: Partial<TapeState>) {
		let changed = false;
		for (const k in patch) {
			const key = k as keyof TapeState;
			if (!Object.is(this.state[key], patch[key])) changed = true;
		}
		if (!changed) return;
		this.state = { ...this.state, ...patch };
		for (const fn of this.subs) fn();
	}

	/** Every frame the tape is loaded: what is on screen, ms, and the frame's length. */
	onFrame(fn: (shown: number, dt: number) => void) {
		this.frames.add(fn);
		return () => {
			this.frames.delete(fn);
		};
	}

	/** Local storage for new takes; `restart` runs the take again in it. */
	setStorage(storage: Record<string, string>, restart: boolean) {
		this.engine.storage = storage;
		if (restart) this.engine.restart();
	}

	tick(dt: number) {
		const e = this.engine;
		e.frame(dt);
		if (!e.scene) return;
		const { chapters, range } = this.state;
		this.set({
			time: e.t,
			chapter: chapterAt(chapters, e.t),
			progress: range ? progressAt(chapters, e.t, range[0], range[1]) : 0,
		});
		for (const fn of this.frames) fn(e.shown, dt);
	}
}

const Ctx = createContext<TapeStore | null>(null);

export function useTapeStore() {
	const s = useContext(Ctx);
	if (!s) throw new Error("tape: a part is used outside Tape.Root");
	return s;
}

/**
 * The part of the tape's state `select` picks; re-renders only when that
 * changes. Pick small: `s => s.chapter` re-renders per chapter, `s => s.time`
 * every frame.
 */
export function useTape<T>(select: (s: TapeState) => T): T {
	const store = useTapeStore();
	return useSyncExternalStore(
		store.subscribe,
		() => select(store.state),
		() => select(store.state),
	);
}

/** The tape's controls, stable. */
export function useTapeApi(): TapeApi {
	return useTapeStore().api;
}

function prefersReducedMotion() {
	return (
		typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export interface RootProps {
	/** Url of the scene.json. */
	scene: string;
	/** Url of the app build it replays in, with the tape shim in it. */
	app: string;
	/** What the take shows, for screen readers. */
	label: string;
	/** How the take is told, if it is. Change them freely, the take stays. */
	chapters?: readonly Chapter[];
	/** Local storage laid over the take's, eg its theme. A change restarts the take in it. */
	storage?: Record<string, string>;
	/** Hold off loading until true, eg until the theme is known. */
	ready?: boolean;
	/** Starts playing once on screen. Off anyway under reduced motion. */
	autoplay?: boolean;
	loop?: boolean;
	/** Pause at the end before looping, ms. */
	hold?: number;
	children?: ReactNode;
}

const NONE: readonly Chapter[] = [];
const NO_STORAGE: Record<string, string> = {};

/**
 * Tape.Root — one take and its clock. Renders nothing of its own: the parts
 * inside it (Frame, Scrubber, Caption, Chapters, or your own on useTape) read
 * and drive it, wherever in the tree they sit.
 */
export function Root({
	scene: src,
	app,
	label,
	chapters = NONE,
	storage = NO_STORAGE,
	ready = true,
	autoplay = true,
	loop = true,
	hold = 1800,
	children,
}: RootProps) {
	const [store] = useState(() => {
		let s: TapeStore | null = null;
		const e = new Engine(
			{
				takes: (ids, front) => s?.set({ takes: { ids, front } }),
				playing: (on) => s?.set({ playing: on }),
			},
			{ autoplay: autoplay && !prefersReducedMotion(), loop, hold },
		);
		s = new TapeStore(e, { app, label, chapters });
		return s;
	});
	const e = store.engine;

	useEffect(() => {
		store.set({ app, label, chapters });
	}, [store, app, label, chapters]);

	// New takes boot in it; a change after the first restarts the take in it.
	const key = JSON.stringify(storage);
	const lastKey = useRef(key);
	useEffect(() => {
		const changed = lastKey.current !== key;
		lastKey.current = key;
		store.setStorage(JSON.parse(key), changed);
	}, [store, key]);

	const near = useSyncExternalStore(
		store.subscribe,
		() => store.state.near,
		() => false,
	);
	useEffect(() => {
		if (!near || !ready) return;
		let dead = false;
		loadScene(src).then(
			(scene) => {
				if (dead || e.scene) return;
				e.setScene(scene);
				store.set({
					scene,
					viewport: scene.meta.viewport,
					range: [e.start, e.end],
					playing: e.playing,
				});
			},
			(err) => console.error(err),
		);
		return () => {
			dead = true;
		};
	}, [near, ready, src, e, store]);

	useEffect(() => {
		const onMessage = (ev: MessageEvent) => e.message(ev.data);
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [e]);

	useEffect(() => {
		e.mount();
		return () => e.dispose();
	}, [e]);

	// The clock, once loaded.
	const loaded = useSyncExternalStore(
		store.subscribe,
		() => !!store.state.scene,
		() => false,
	);
	useEffect(() => {
		if (!loaded) return;
		let raf = 0;
		let last = 0;
		const step = (ts: number) => {
			raf = requestAnimationFrame(step);
			const dt = last ? Math.min(ts - last, 100) : 0;
			last = ts;
			store.tick(dt);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [loaded, store]);

	return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
