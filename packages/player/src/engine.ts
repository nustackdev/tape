// The replay engine behind <Tape.Root>: a clock the page owns, driving the
// executor inside one or two iframes ("takes"). See KERNEL.md.
//
// The clock (`t`) only says how far a take may go. What the page shows comes
// from what the take reports it applied (`shown`): the cursor, the captions,
// the scrub position. While playing, the clock runs at most LEAD_MS ahead of
// that, so a busy app slows the replay down and nothing runs ahead of it.
//
// A take only applies forward. Moving back needs a fresh take that boots and
// catches up to the clock; the old take stays on screen until the new one
// reports it got there and settled, so a jump back never blanks. Big forward
// jumps take the same path. One take loads at a time: a jump while one is in
// flight waits for it to land, then the next follows.
//
// A take that fails (a precondition never held, it went silent, its page
// went away) is replaced by a fresh one from the shown position. Nothing is
// ever shown because a timer ran out.

import {
	type PointerSample,
	parseScene,
	playWindow,
	pointerTrack,
	type Scene,
} from "@nustackdev/tape-scene";
import {
	type Body,
	isTape,
	SANDBOX,
	SANDBOX_SAME_ORIGIN,
	TAG,
	TAKE_NAME,
	type ToParent,
	type ToShim,
} from "./protocol";

/** While playing, the clock runs at most this far ahead of what the take applied. */
export const LEAD_MS = 250;
/** A take busy (behind its clock, or not settled) and silent this long, in visible ms, has failed. */
const SILENT_MS = 6000;
/**
 * A take after failures in a row waits this many times longer, per failure, up
 * to PATIENCE_MAX: its deadlines and its silence. A restart is never the same
 * attempt again: whatever timed out gets more room the next time.
 */
const PATIENCE = 2;
const PATIENCE_MAX = 8;
/** A take not started after this is checked: still loading, it waits on; failed, it is replaced. */
const BOOT_CHECK_MS = 8000;
/** Still loading this long after it began counts as failed. */
const BOOT_HARD_MS = 30000;
/** Failures at the same entry before its precondition is waived for later takes. */
const WAIVE_AFTER = 2;
/** Failures in a row, with no take shown in between, before the tape stops trying. */
const GIVE_UP = 6;
/** A replacement after a failure waits this, doubling per failure in a row. */
const RETRY_MS = 250;
const RETRY_MAX_MS = 4000;
/** A jump forward further than this loads a fresh take rather than playing through. */
const JUMP_MS = 3000;
/** Back jumps start a take at most this often. */
const RESPAWN_MS = 220;
/** The old take goes once the new one has faded in over it. */
export const FADE_MS = 280;

interface Take {
	id: string;
	win: Window | null;
	/** The shim said hello: it has the scene, it takes `until`s. */
	hello: boolean;
	/** The last `until` sent. */
	sent: number;
	/** What it reported: applied up to `pos`, idle, settled. */
	pos: number;
	idle: boolean;
	settled: boolean;
	/** Engine active time of its last message. */
	heard: number;
	/** When it was started, wall ms. */
	born: number;
	/** Stopped: kept on screen frozen until its replacement shows, never ticked again. */
	failed: boolean;
	/** Its iframe's load events: the first is the take's page, any later one a navigation. */
	loads: number;
	/** The last run state sent. */
	ran: boolean | null;
	/** Its iframe's sandbox, fixed for its life. */
	sandbox: string;
	/** How many times the usual deadlines it waits: more after failures in a row. */
	patience: number;
	timers: ReturnType<typeof setTimeout>[];
}

export interface EngineEvents {
	/** The set of takes or the shown one changed: render iframes for `ids`. */
	takes(ids: string[], front: string | null): void;
	/** Playing started or stopped, by request or at the end. */
	playing(on: boolean): void;
}

let nextTake = 0;

function post(win: Window, body: Body<ToShim>) {
	win.postMessage({ tape: TAG, ...body } as ToShim, "*");
}

const scenes = new Map<string, Promise<Scene>>();

export function loadScene(src: string | Scene): Promise<Scene> {
	if (typeof src !== "string") return Promise.resolve(parseScene(src));
	let p = scenes.get(src);
	if (!p) {
		p = fetch(src).then(async (r) => {
			if (!r.ok) throw new Error(`tape: ${src} ${r.status}`);
			return parseScene(await r.json());
		});
		p.catch(() => scenes.delete(src));
		scenes.set(src, p);
	}
	return p;
}

/** This page is itself playing inside a take's frame: the site loaded into its own replay. */
export function insideTake(): boolean {
	return typeof window !== "undefined" && window.name === TAKE_NAME;
}

/**
 * This browser refused a take in an opaque origin (WebKit won't let it move its
 * url to the recorded path). Every take on the page runs same origin from then.
 */
let opaqueRefused = false;

/**
 * Whether takes run same origin. Where the browser has the Navigation API, yes:
 * a same origin frame gets it too, and the shim cancels every navigation the
 * frame starts at its source, a fragment change included, which nothing can in
 * an opaque frame (the tab's history grows, and in Chromium and WebKit stays
 * grown). Without it, an opaque origin. See KERNEL.md, Isolation.
 */
function sameOriginFor(force: "same-origin" | "opaque" | "auto"): boolean {
	// Refused (WebKit): a take that can't play is no isolation at all.
	if (opaqueRefused || force === "same-origin") return true;
	if (force === "opaque") return false;
	return typeof window !== "undefined" && "navigation" in window;
}

/** How long the page's scroll is held after the take's editor says it will edit, ms. */
const HOLD_MS = 100;

export class Engine {
	scene: Scene | null = null;
	/** The pointer's path, for the drawn cursor. */
	track: PointerSample[] = [];
	start = 0;
	end = 0;
	/** The clock, ms of the take: how far takes may go. */
	t = 0;
	rate = 1;
	/** Wants to play. Whether it advances also needs `visible` and the tab. */
	wantPlay: boolean;
	visible = false;
	loop: boolean;
	hold: number;
	/** Feed recorded input into the app, not just server frames. */
	input = true;
	/** Local storage laid over the take's, eg the theme. Applies to new takes. */
	storage: Record<string, string> = {};
	/** Stopped trying after failures in a row; the reason is on the console. */
	gaveUp = false;
	/** How takes are isolated (RootProps.isolation). */
	isolation: "auto" | "same-origin" | "opaque" = "auto";
	/**
	 * Put the page's focus and scroll back where they were: a take pulled real
	 * focus into its frame, or its page started to leave. Set by the Frame.
	 */
	restore: (() => void) | null = null;
	/** Take the iframe of take `id` out of the document now. Set by the Frame. */
	remove: ((id: string) => void) | null = null;

	private takes = new Map<string, Take>();
	private front: Take | null = null;
	private pending: Take | null = null;
	private lastSpawn = 0;
	private trailing: ReturnType<typeof setTimeout> | undefined;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private endedAt = 0;
	private dead = false;
	private parked = false;
	/** Visible ms so far: the watchdog's clock. */
	private active = 0;
	private waive = new Set<number>();
	private failsAt = new Map<number, number>();
	private failsInRow = 0;
	/** The page's scroll, held while a take's editor edits. */
	private held: { x: number; y: number; until: number } | null = null;
	private viewer = false;
	private holding: AbortController | null = null;

	constructor(
		private events: EngineEvents,
		opts: { autoplay: boolean; loop: boolean; hold: number },
	) {
		this.wantPlay = opts.autoplay;
		this.loop = opts.loop;
		this.hold = opts.hold;
	}

	get ready() {
		return this.front !== null;
	}

	/** Whether a take is loading in: the clock waits for it. */
	get busy() {
		return this.pending !== null;
	}

	get playing() {
		return this.wantPlay;
	}

	/** The time on screen: what the shown take applied. The clock until one shows. */
	get shown() {
		const f = this.front;
		if (!f || !Number.isFinite(f.pos)) return this.t;
		return Math.min(this.end, Math.max(this.start, f.pos));
	}

	setScene(scene: Scene) {
		this.scene = scene;
		this.track = pointerTrack(scene);
		[this.start, this.end] = playWindow(scene);
		this.t = this.start;
		this.spawn();
	}

	/**
	 * Play. At the end, `rewind` starts over at once; without it the end holds
	 * first, as a loop does, eg when a scrub let go at the end resumes.
	 */
	play({ rewind = true }: { rewind?: boolean } = {}) {
		if (!this.scene) {
			this.wantPlay = true;
			return;
		}
		if (rewind && this.shown >= this.end) this.seek(this.start, { jump: true });
		if (!this.wantPlay) {
			this.wantPlay = true;
			this.events.playing(true);
		}
	}

	pause() {
		if (this.wantPlay) {
			this.wantPlay = false;
			this.events.playing(false);
		}
	}

	/**
	 * Move the clock. A `jump` (a step, Home, End) far ahead loads a fresh take
	 * instead of playing the way there on screen; a scrub plays through.
	 */
	seek(t: number, { jump = false }: { jump?: boolean } = {}) {
		if (!this.scene) return;
		this.t = Math.min(this.end, Math.max(this.start, t));
		this.endedAt = 0;
		this.sync(jump);
	}

	/** Make sure a take is headed for the clock, starting one if the one ahead can't get there. */
	private sync(jump = false) {
		const lead = this.pending ?? this.front;
		// Not started yet: it picks the clock up as it says hello.
		if (!lead?.hello) return;
		const back = this.t < lead.sent;
		const far = jump && this.t - lead.pos > JUMP_MS;
		if (!back && !far) return;
		// One in flight lands first; promote() syncs again from there.
		if (this.pending) return;
		const wait = this.lastSpawn + RESPAWN_MS - performance.now();
		if (wait <= 0) this.spawn();
		else if (!this.trailing)
			this.trailing = setTimeout(() => {
				this.trailing = undefined;
				this.sync(jump);
			}, wait);
	}

	/** A fresh take from the clock's time, eg when its storage changed. */
	restart() {
		if (this.scene && !this.parked) this.spawn();
	}

	/** Far off screen: drop the takes, holding the clock. `unpark` starts a take there again. */
	park() {
		if (this.parked || !this.scene) return;
		this.parked = true;
		this.t = this.shown;
		for (const take of [...this.takes.values()]) this.drop(take);
		this.front = null;
		this.pending = null;
		this.emit();
	}

	unpark() {
		if (!this.parked) return;
		this.parked = false;
		// A new chance: failures before it went off screen don't count against it.
		this.gaveUp = false;
		this.failsInRow = 0;
		if (this.scene) this.spawn();
	}

	/** Advance the clock by `dt` ms of wall time and tick the takes. */
	frame(dt: number) {
		if (!this.scene || this.dead || this.parked) return;
		const on = this.visible && !document.hidden;
		if (!document.hidden) this.active += dt;
		const f = this.front;
		// Nothing on screen yet, or a take loading in: the clock waits.
		if (this.wantPlay && on && !this.pending && f && !f.failed) {
			if (f.pos < this.end) {
				this.endedAt = 0;
				const next = Math.min(this.end, this.t + dt * this.rate, f.pos + LEAD_MS);
				if (next > this.t) this.t = next;
			} else if (this.loop) {
				if (!this.endedAt) this.endedAt = performance.now();
				else if (performance.now() - this.endedAt >= this.hold) this.seek(this.start);
			} else {
				this.pause();
			}
		}
		// While a take loads in, the one on screen holds still: it's the one being replaced.
		const take = this.pending ?? (f?.failed ? null : f);
		if (take?.hello && take.win && this.t > take.sent) {
			take.sent = this.t;
			post(take.win, { type: "until", t: this.t });
		}
		// Each take hears whether it plays: its deadlines count only then. One loading in
		// plays even paused, it has to catch up; the one on screen when the clock runs.
		for (const k of [this.pending, f]) {
			if (!k?.hello || !k.win || k.failed) continue;
			const run = on && (k === this.pending || this.wantPlay);
			if (k.ran !== run) {
				k.ran = run;
				post(k.win, { type: "run", on: run });
			}
			// A take that has work and says nothing has stopped: replace it.
			// A slow take still reports as it applies, so only silence fails it, not slowness.
			const busy = k.pos < k.sent || !k.settled;
			const silent = SILENT_MS * k.patience;
			if (run && busy && this.active - k.heard > silent) {
				this.failed(k, null, `silent for ${silent}ms while busy at ${Math.round(k.pos)}ms`);
			}
			if (!run) k.heard = this.active;
		}
	}

	/** The sandbox of take `id`'s iframe. */
	sandboxOf(id: string) {
		return this.takes.get(id)?.sandbox ?? SANDBOX;
	}

	/** The iframe of take `id` is in the document. */
	attach(id: string, win: Window | null) {
		const take = this.takes.get(id);
		if (take && win) take.win = win;
	}

	/**
	 * The iframe of take `id` loaded a page. The first load is the take; any
	 * later one means the frame navigated (the shim's `gone` usually says so
	 * first). The take's page is of another origin, so the host never reads it.
	 */
	loaded(id: string) {
		const take = this.takes.get(id);
		if (!take) return;
		take.loads++;
		if (take.loads > 1) {
			this.failed(take, null, "its frame navigated away");
			this.restore?.();
		}
	}

	/**
	 * A take's editor is about to edit: some browsers scroll the page around the
	 * frame to the caret. The page's scroll is put back in its scroll events for
	 * HOLD_MS, unless the viewer scrolls meanwhile. The listeners go with the hold.
	 */
	private holdScroll() {
		if (typeof window === "undefined") return;
		const now = performance.now();
		if (this.held) {
			this.held.until = now + HOLD_MS;
			return;
		}
		this.held = { x: window.scrollX, y: window.scrollY, until: now + HOLD_MS };
		this.viewer = false;
		const ac = new AbortController();
		this.holding = ac;
		const opts = { capture: true, passive: true, signal: ac.signal };
		const mark = () => {
			this.viewer = true;
		};
		for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) {
			window.addEventListener(type, mark, opts);
		}
		window.addEventListener(
			"scroll",
			() => {
				const h = this.held;
				if (!h || this.viewer) return;
				if (window.scrollX !== h.x || window.scrollY !== h.y) {
					window.scrollTo({ left: h.x, top: h.y, behavior: "instant" });
				}
			},
			opts,
		);
		const end = () => {
			if (this.held && performance.now() < this.held.until) {
				setTimeout(end, Math.max(0, this.held.until - performance.now()));
				return;
			}
			this.release();
		};
		setTimeout(end, HOLD_MS);
	}

	private release() {
		this.holding?.abort();
		this.holding = null;
		this.held = null;
	}

	/** A message from a shim. */
	message(data: unknown) {
		if (!isTape<ToParent>(data)) return;
		const m = data;
		const take = this.takes.get(m.take);
		if (m.type === "gone" && !take) {
			// A take already removed, unloading: the host recycled it.
			console.debug(`tape: take ${m.take} gone (${m.why ?? "unknown"})`);
			return;
		}
		if (!take?.win || !this.scene || take.failed) return;
		take.heard = this.active;
		if (m.type === "hello" && !take.hello) {
			take.hello = true;
			const scene = {
				...this.scene,
				storage: { local: { ...this.scene.storage.local, ...this.storage } },
			};
			post(take.win, {
				type: "scene",
				scene,
				input: this.input,
				waive: [...this.waive],
				watch: [...this.failsAt.keys()],
				patience: take.patience,
			});
			take.sent = this.t;
			post(take.win, { type: "until", t: this.t });
		} else if (m.type === "pos") {
			take.pos = m.t;
			take.idle = m.idle;
			take.settled = m.settled;
			// Promoted only on its own report: it applied the log up to the clock and settled.
			if (take === this.pending && m.idle && m.settled && m.t >= this.t) this.promote(take);
		} else if (m.type === "fail") {
			this.failed(take, m.at, m.reason);
		} else if (m.type === "gone") {
			// Its page is leaving: out of the document before the navigation commits, so it
			// never loads and never adds to the tab's history; the page stays as it was.
			this.failed(take, null, `its page unloaded (${m.why ?? "unknown"})`);
			this.restore?.();
			requestAnimationFrame(() => requestAnimationFrame(() => this.restore?.()));
		} else if (m.type === "focused") {
			this.restore?.();
		} else if (m.type === "origin") {
			// Not the take's fault: the same take again, same origin.
			opaqueRefused = true;
			this.drop(take);
			if (take === this.front) this.front = null;
			if (!this.pending) this.spawn();
		} else if (m.type === "passed") {
			// It holds again: what failed on it was passing trouble, not the take.
			this.failsAt.delete(m.at);
			this.waive.delete(m.at);
		} else if (m.type === "hold" && (take === this.front || take === this.pending)) {
			this.holdScroll();
		}
	}

	/** Mounted. Strict mode unmounts and mounts again, so dispose is not final. */
	mount() {
		this.dead = false;
	}

	dispose() {
		this.dead = true;
		clearTimeout(this.trailing);
		clearTimeout(this.retry);
		this.trailing = undefined;
		this.retry = undefined;
		this.release();
	}

	private spawn() {
		this.lastSpawn = performance.now();
		clearTimeout(this.retry);
		this.retry = undefined;
		if (this.pending) this.drop(this.pending);
		const take: Take = {
			id: `s${nextTake++}`,
			win: null,
			hello: false,
			sent: Number.NEGATIVE_INFINITY,
			pos: Number.NEGATIVE_INFINITY,
			idle: false,
			settled: false,
			heard: this.active,
			born: performance.now(),
			failed: false,
			loads: 0,
			ran: null,
			sandbox: sameOriginFor(this.isolation) ? SANDBOX_SAME_ORIGIN : SANDBOX,
			patience: Math.min(PATIENCE_MAX, PATIENCE ** this.failsInRow),
			timers: [],
		};
		this.takes.set(take.id, take);
		this.pending = take;
		this.watchBoot(take);
		this.emit();
	}

	/**
	 * A take that hasn't said hello in BOOT_CHECK_MS. Not loaded yet (a slow
	 * network): it waits on, since replacing it would only start the download
	 * over, up to BOOT_HARD_MS. Loaded without a hello (no shim, an error page),
	 * or loading past that: it failed.
	 */
	private watchBoot(take: Take) {
		take.timers.push(
			setTimeout(() => {
				if (take.hello || !this.takes.has(take.id) || this.dead) return;
				const loading = take.loads === 0;
				if (loading && performance.now() - take.born < BOOT_HARD_MS) this.watchBoot(take);
				else this.failed(take, null, loading ? "still loading" : "no shim in the frame");
			}, BOOT_CHECK_MS),
		);
	}

	/**
	 * Take `take` can't go on. A pending one is dropped; a shown one stays on
	 * screen, frozen, unless its page is gone. A fresh take follows from what
	 * was shown, after a backoff. Failing twice at one entry waives its check.
	 */
	private failed(take: Take, at: number | null, reason: string) {
		if (!this.takes.has(take.id) || take.failed) return;
		take.failed = true;
		console.warn(`tape: take ${take.id} failed: ${reason}`);
		const gone = at === null && /unloaded|navigated/.test(reason);
		if (take === this.pending || gone) this.drop(take);
		if (take === this.front) {
			// The clock goes back to what was on screen; the replacement catches up to it.
			this.t = Math.min(this.t, this.shown);
			if (gone) this.front = null;
			this.emit();
		}
		if (at !== null) {
			const n = (this.failsAt.get(at) ?? 0) + 1;
			this.failsAt.set(at, n);
			if (n >= WAIVE_AFTER && !this.waive.has(at)) {
				this.waive.add(at);
				console.warn(`tape: entry ${at} fails every take, playing on without its check`);
			}
		}
		this.failsInRow++;
		if (this.failsInRow >= GIVE_UP) {
			this.gaveUp = true;
			console.error(`tape: gave up after ${this.failsInRow} failed takes in a row`);
			return;
		}
		if (this.pending && this.pending !== take) return;
		const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (this.failsInRow - 1));
		clearTimeout(this.retry);
		this.retry = setTimeout(() => {
			this.retry = undefined;
			if (!this.dead && !this.parked && !this.gaveUp && !this.pending) this.spawn();
		}, wait);
	}

	private promote(take: Take) {
		if (this.pending !== take) return;
		this.failsInRow = 0;
		this.gaveUp = false;
		this.pending = null;
		const old = this.front;
		this.front = take;
		this.emit();
		if (old) old.timers.push(setTimeout(() => this.front !== old && this.drop(old), FADE_MS));
		// The clock moved back past it while it loaded: the next one.
		this.sync();
	}

	private drop(take: Take) {
		this.remove?.(take.id);
		take.timers.forEach(clearTimeout);
		this.takes.delete(take.id);
		if (this.pending === take) this.pending = null;
		this.emit();
	}

	private emit() {
		this.events.takes([...this.takes.keys()], this.front?.id ?? null);
	}
}
