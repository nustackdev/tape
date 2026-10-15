// The replay engine behind <Tape.Root>: a clock we own, driving the tape shim
// inside one or two iframes ("takes").
//
// The shim only delivers forward: tick(t) plays everything up to t. So moving
// forward, paused or not, is just moving the clock. Moving back needs a fresh
// take that boots and catches up to the new time in one tick; the old take
// stays on screen until the new one has painted, so a jump back never blanks.
// Big forward jumps take the same path, so a jump never plays its catch-up on
// screen. One take loads at a time: a jump while one is in flight waits for it
// to land, then the next follows, so a long drag back refreshes step by step.

import { parseScene, playWindow, type Scene } from "@nustackdev/tape-scene";
import { type Body, isTape, TAG, type ToParent, type ToShim } from "./protocol";

/**
 * A new take shows once it has caught up. The shim reports a paint after its
 * first frame, not once the replay has reached the clock, so after the paint
 * the take's document is watched and it shows once it has gone quiet. An app
 * that never goes quiet (an animation) shows anyway after SETTLE_MAX_MS; a
 * document that can't be watched waits an estimate that grows with what it
 * replays.
 */
const QUIET_MS = 140;
const SETTLE_MS = 160;
const SETTLE_PER_ITEM_MS = 3;
const SETTLE_MAX_MS = 1500;
/** A take that opened but never reports a paint is shown anyway after this. */
const PAINT_TIMEOUT_MS = 5000;
/** Past SETTLE_MAX_MS a take still busy catching up gets more time, checked this often, up to SETTLE_HARD_MS after its paint. */
const SETTLE_CHECK_MS = 250;
const SETTLE_BUSY = 5;
const SETTLE_HARD_MS = 10000;
/** A take not started after this is checked: still loading, it waits on; failed, it is replaced or given up. */
const BOOT_TIMEOUT_MS = 8000;
/** Still loading this long after it began counts as failed: an app that never starts doesn't hold the clock for good. */
const BOOT_HARD_MS = 30000;
/** The first take is tried this many times, then the frame stays empty rather than hitting the server forever. */
const BOOT_TRIES = 3;
/** A jump forward further than this loads a fresh take rather than playing through. */
const JUMP_MS = 3000;
/** Back jumps start a take at most this often. */
const RESPAWN_MS = 220;
/** The old take goes once the new one has faded in over it. */
export const FADE_MS = 280;

interface Take {
	id: string;
	win: Window | null;
	open: boolean;
	/** Last time ticked to. */
	sent: number;
	/** When it was started, wall ms. */
	born: number;
	/** How long after its first paint it is shown, when its document can't be watched. */
	settle: number;
	timers: ReturnType<typeof setTimeout>[];
	/** Watches the document for quiet after the paint. */
	observer?: MutationObserver;
	quiet?: ReturnType<typeof setTimeout>;
	/** Shown anyway if it opened but never painted. Cleared by the paint. */
	paintTimer?: ReturnType<typeof setTimeout>;
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

export function loadScene(src: string): Promise<Scene> {
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

export class Engine {
	scene: Scene | null = null;
	start = 0;
	end = 0;
	/** The clock, in ms of the take. */
	t = 0;
	rate = 1;
	/** Wants to play. Whether it advances also needs `visible` and the tab. */
	wantPlay: boolean;
	visible = false;
	loop: boolean;
	hold: number;
	/** Local storage laid over the take's, eg the theme. Applies to new takes. */
	storage: Record<string, string> = {};

	private takes = new Map<string, Take>();
	private front: Take | null = null;
	private pending: Take | null = null;
	private lastSpawn = 0;
	private trailing: ReturnType<typeof setTimeout> | undefined;
	private endedAt = 0;
	/** First takes that failed to start, in a row. */
	private bootFails = 0;
	private dead = false;

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

	setScene(scene: Scene) {
		this.scene = scene;
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
		if (rewind && this.t >= this.end) this.seek(this.start, { jump: true });
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

	/** The time on screen: the clock, unless a take is loading in over an older one. */
	get shown() {
		return this.pending && this.front ? this.front.sent : this.t;
	}

	/** Make sure a take is headed for the clock, starting one if the one ahead can't get there. */
	private sync(jump = false) {
		const lead = this.pending ?? this.front;
		// Not started yet: it picks the clock up as it opens.
		if (!lead?.open) return;
		const back = this.t < lead.sent;
		const far = jump && this.t - lead.sent > JUMP_MS;
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
		if (this.scene) this.spawn();
	}

	/** Advance the clock by `dt` ms of wall time and tick the takes. */
	frame(dt: number) {
		if (!this.scene || this.dead) return;
		// Nothing on screen yet, or a take loading in: the clock waits.
		const advancing =
			this.wantPlay && this.visible && !document.hidden && !this.pending && this.front !== null;
		if (advancing) {
			if (this.t < this.end) {
				this.t = Math.min(this.end, this.t + dt * this.rate);
				if (this.t >= this.end) this.endedAt = performance.now();
			} else if (this.loop) {
				if (!this.endedAt) this.endedAt = performance.now();
				else if (performance.now() - this.endedAt >= this.hold) this.seek(this.start);
			} else {
				this.pause();
			}
		}
		// While a take loads in, the one on screen holds still: it's the one being replaced.
		for (const take of this.pending ? [this.pending] : [this.front]) {
			if (take?.open && take.win && this.t > take.sent) {
				take.sent = this.t;
				post(take.win, { type: "tick", t: this.t });
			}
		}
	}

	/** The iframe of take `id` is in the document. */
	attach(id: string, win: Window | null) {
		const take = this.takes.get(id);
		if (take && win) take.win = win;
	}

	/** A message from a shim. */
	message(data: unknown) {
		if (!isTape<ToParent>(data)) return;
		const m = data;
		const take = this.takes.get(m.take);
		if (!take?.win || !this.scene) return;
		if (m.type === "hello") {
			const scene = {
				...this.scene,
				storage: { local: { ...this.scene.storage.local, ...this.storage } },
			};
			post(take.win, { type: "scene", scene, input: true });
		} else if (m.type === "open" && !take.open) {
			take.open = true;
			take.sent = this.t;
			take.settle =
				SETTLE_MS + Math.min(SETTLE_MAX_MS - SETTLE_MS, SETTLE_PER_ITEM_MS * this.replayed(this.t));
			post(take.win, { type: "tick", t: this.t });
			take.paintTimer = setTimeout(() => this.promote(take), PAINT_TIMEOUT_MS);
			take.timers.push(take.paintTimer);
		} else if (m.type === "painted" && !take.observer) {
			clearTimeout(take.paintTimer);
			this.settle(take);
		}
	}

	/** Mounted. Strict mode unmounts and mounts again, so dispose is not final. */
	mount() {
		this.dead = false;
	}

	dispose() {
		this.dead = true;
		clearTimeout(this.trailing);
		this.trailing = undefined;
	}

	private spawn() {
		this.lastSpawn = performance.now();
		if (this.pending) this.drop(this.pending);
		const take: Take = {
			id: `s${nextTake++}`,
			win: null,
			open: false,
			sent: -Infinity,
			born: performance.now(),
			settle: SETTLE_MS,
			timers: [],
		};
		this.takes.set(take.id, take);
		this.pending = take;
		this.watchBoot(take);
		this.emit();
	}

	/**
	 * A take that hasn't started in BOOT_TIMEOUT_MS. Still loading (a slow
	 * network): it waits on, since replacing it would only start the download
	 * over, up to BOOT_HARD_MS. Loaded but no shim, a page that can't be read,
	 * or loading past that: it failed. The first take is then tried again, up
	 * to BOOT_TRIES; a replacement is given up, and the clock goes back to what
	 * is on screen, so nothing retries in a loop. Not after unmount.
	 */
	private watchBoot(take: Take) {
		take.timers.push(
			setTimeout(() => {
				if (take.open || this.pending !== take || this.dead) return;
				let loading = false;
				try {
					const w = take.win as (Window & { __tapeShim?: unknown }) | null;
					// Still on the blank page an iframe starts as, mid-download, or the
					// shim is up and the app is still coming: all still loading.
					loading =
						!w ||
						w.location.href === "about:blank" ||
						w.document.readyState !== "complete" ||
						w.__tapeShim !== undefined;
				} catch {
					// Can't read it: an error page from elsewhere. Failed.
				}
				if (loading && performance.now() - take.born < BOOT_HARD_MS) this.watchBoot(take);
				else if (!this.front) {
					if (++this.bootFails < BOOT_TRIES) this.spawn();
					else this.drop(take);
				} else {
					const shown = this.front.sent;
					this.drop(take);
					if (this.t < shown) this.t = shown;
				}
			}, BOOT_TIMEOUT_MS),
		);
	}

	/**
	 * Show `take` once its document has been quiet a moment. At SETTLE_MAX_MS
	 * it shows unless it is still busy catching up (a slow device); then it
	 * gets more time, to SETTLE_HARD_MS after the paint.
	 */
	private settle(take: Take) {
		let doc: Document | null = null;
		try {
			doc = take.win?.document ?? null;
		} catch {
			// Another origin: can't watch it.
		}
		if (!doc) {
			take.timers.push(setTimeout(() => this.promote(take), take.settle));
			return;
		}
		let recent = 0;
		const arm = (records: MutationRecord[] = []) => {
			recent += records.length;
			clearTimeout(take.quiet);
			take.quiet = setTimeout(() => this.promote(take), QUIET_MS);
		};
		take.observer = new MutationObserver(arm);
		take.observer.observe(doc, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		arm();
		const check = () => {
			if (recent <= SETTLE_BUSY) {
				this.promote(take);
				return;
			}
			recent = 0;
			take.timers.push(setTimeout(check, SETTLE_CHECK_MS));
		};
		take.timers.push(
			setTimeout(() => {
				recent = 0;
				take.timers.push(setTimeout(check, SETTLE_CHECK_MS));
			}, SETTLE_MAX_MS - SETTLE_CHECK_MS),
		);
		take.timers.push(setTimeout(() => this.promote(take), SETTLE_HARD_MS));
	}

	/** How many frames and input events a take replays to reach `t`. */
	private replayed(t: number) {
		const scene = this.scene;
		if (!scene) return 0;
		let n = 0;
		for (const f of scene.frames) if (f.t <= t) n++;
		for (const e of scene.events ?? []) if (e.t <= t) n++;
		return n;
	}

	private promote(take: Take) {
		if (this.pending !== take) return;
		this.bootFails = 0;
		take.observer?.disconnect();
		clearTimeout(take.quiet);
		this.pending = null;
		const old = this.front;
		this.front = take;
		this.emit();
		if (old) old.timers.push(setTimeout(() => this.front !== old && this.drop(old), FADE_MS));
		// The clock moved back past it while it loaded: the next one.
		this.sync();
	}

	private drop(take: Take) {
		take.timers.forEach(clearTimeout);
		take.observer?.disconnect();
		clearTimeout(take.quiet);
		this.takes.delete(take.id);
		if (this.pending === take) this.pending = null;
		this.emit();
	}

	private emit() {
		this.events.takes([...this.takes.keys()], this.front?.id ?? null);
	}
}

/** Index of the last pointer sample at or before t, or -1. */
export function pointerAt(track: Scene["pointer"], t: number) {
	let lo = 0;
	let hi = track.length - 1;
	const first = track[0];
	if (!first || first[0] > t) return -1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((track[mid]?.[0] ?? Infinity) <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}
