// The executor. The one loop that plays a take: it applies the scene's log
// strictly in order, each entry only once its precondition holds, and reports
// how far it got. Nothing else delivers anything to the app.
//
// It knows nothing of the DOM: what an entry needs and what applying it does
// come in as `ExecutorDeps`, from the shim (./shim.ts) or from a test. See
// KERNEL.md for the invariants this keeps.

import { type Entry, isInput, isKey, isPointerButton } from "@nustackdev/tape-scene";

export interface Limits {
	/** How long an input's precondition may take to hold, active ms. */
	pre: number;
	/**
	 * How long the app may take to boot: to open a recorded socket, and anything
	 * the take has before its first input. It waits on the bundle loading and
	 * running, which a slow network or a busy machine stretches.
	 */
	open: number;
	/** How long a soft entry (focus, a field's value, selection) waits before it is skipped. */
	soft: number;
	/** At most one progress report per this, active ms, while busy. */
	report: number;
	/** While waiting, a heartbeat this often, so the host knows the take is alive. */
	beat: number;
	/**
	 * A wait counts at most this much per look. A page the machine starves (one
	 * look a second, not one in 30ms) still gets as many looks before it fails as
	 * one that runs freely: a deadline measures the app's chances, not the clock.
	 */
	tick: number;
	/**
	 * A run of server messages goes to the app back to back for at most this
	 * long, active ms, before the page gets a turn to render what they did.
	 */
	burst: number;
	/** And at most this many messages in a run. */
	batch: number;
	/**
	 * A precondition's deadline counts only the looks in which the page did no
	 * work: a page that keeps changing is slow, not stuck. Busy looks count too
	 * once the wait reaches this many times the deadline, so an app that never
	 * goes still (an animation) can't hold a take that went wrong forever.
	 */
	busy: number;
}

export const LIMITS: Limits = {
	pre: 8000,
	open: 20000,
	soft: 400,
	report: 32,
	beat: 500,
	tick: 100,
	burst: 50,
	batch: 256,
	busy: 4,
};

export interface Report {
	t: number;
	idle: boolean;
	settled: boolean;
	wait?: number;
}

export interface ExecutorDeps {
	log: readonly Entry[];
	/** Entry `i`'s precondition holds now. */
	ready(e: Entry, i: number): boolean;
	/** Why it doesn't, for the failure report. */
	why(e: Entry, i: number): string;
	/**
	 * The take went somewhere the recording didn't, and waiting won't bring it
	 * back (the app sent other data than it did): the reason, or null.
	 */
	diverged?(e: Entry, i: number): string | null;
	/** Entry `i`, one of `watch`, held its precondition: it is fine again. */
	passed?(i: number): void;
	/** Entries the host wants to hear about when they pass, after takes failed on them. */
	watch?: ReadonlySet<number>;
	/** Apply entry `i`. Throws only on a fault of ours. */
	apply(e: Entry, i: number): void;
	/** Put the page's clock and randomness where they were for `e`. Undone by `leave`, always. */
	enter(e: Entry): void;
	leave(): void;
	/** One task: what the entry set off runs before the next one, as in a browser. */
	task(): Promise<void>;
	/**
	 * Run `each(0)`, `each(1)`, ..., up to `n`, each in a task of its own, all
	 * queued at once: nothing the page queues meanwhile (a render, a timer) runs
	 * between them, as when a browser has a backlog of socket frames. Stops after
	 * the first that returns false. Without it, every message gets `task` after it.
	 */
	tasks?(n: number, each: (k: number) => boolean): Promise<void>;
	/** A count that rises as the page works (its DOM changes). Without it, every look is idle. */
	work?(): number;
	/** Resolves once the page has gone quiet, or after a bound. Never hangs. */
	settle(): Promise<void>;
	/** Resolves when a precondition may have changed: a mutation, a frame, a short poll. */
	change(): Promise<void>;
	/** Active ms: time the page was visible. Deadlines count only that. */
	now(): number;
	report(r: Report): void;
	fail(at: number | null, reason: string): void;
	/** The host moved `until` while nothing was due: hover follows the page. */
	idle?(): void;
	/**
	 * Entries that failed every take: their precondition is not waited on.
	 * One that doesn't hold is skipped, never applied to the wrong thing.
	 */
	waive?: ReadonlySet<number>;
	limits?: Partial<Limits>;
}

/** Entries a browser gives a task of their own. */
function ownTask(e: Entry): boolean {
	return e.k === "open" || e.k === "msg" || e.k === "close" || isPointerButton(e) || isKey(e);
}

/** Entries skipped, not failed, when their precondition doesn't hold in time. */
export function isSoft(e: Entry): boolean {
	return e.k === "focus" || e.k === "value" || e.k === "sel" || e.k === "range";
}

/** A back or forward the app itself asked for: the replay performs it where the log has it. */
function traversal(e: Entry): boolean {
	return e.k === "nav" && e.mode === "pop";
}

/** Entries that act on what the page shows, so wait for it to settle after a change. */
function dependent(e: Entry): boolean {
	return isInput(e) && e.k !== "move" && e.k !== "out";
}

/** Entries that change what the page shows. */
function changes(e: Entry): boolean {
	return e.k !== "send" && (e.k !== "nav" || traversal(e));
}

export class Executor {
	/** Where the log is applied up to, ms of the take. Only moves forward. */
	pos = Number.NEGATIVE_INFINITY;
	/** Next entry to apply. */
	next = 0;
	private until = Number.NEGATIVE_INFINITY;
	private dead = false;
	private running = false;
	private wake: (() => void) | null = null;
	private limits: Limits;
	/** Something applied since the page last settled. */
	private dirty = false;
	/** The entry index the page last settled at while idle. */
	private settledAt = -1;
	private lastReport = Number.NEGATIVE_INFINITY;

	/** Entries before this one are the app booting. */
	private booted: number;

	constructor(private deps: ExecutorDeps) {
		this.limits = { ...LIMITS, ...deps.limits };
		const first = deps.log.findIndex((e) => isInput(e));
		this.booted = first < 0 ? deps.log.length : first;
	}

	get stopped() {
		return this.dead;
	}

	/** Let the take go up to `t`. Never back. */
	setUntil(t: number) {
		if (this.dead || !(t > this.until)) return;
		this.until = t;
		const w = this.wake;
		this.wake = null;
		w?.();
		if (!this.running) {
			this.running = true;
			void this.loop();
		}
	}

	stop() {
		this.dead = true;
		const w = this.wake;
		this.wake = null;
		w?.();
	}

	private fail(at: number | null, reason: string) {
		if (this.dead) return;
		this.dead = true;
		this.deps.fail(at, reason);
	}

	private report(r: Omit<Report, "t">, force = true) {
		const now = this.deps.now();
		if (!force && now - this.lastReport < this.limits.report) return;
		this.lastReport = now;
		this.deps.report({ t: this.pos, ...r });
	}

	/** Settles; false if `until` reached `e` first. */
	private async settleUnless(e: Entry | undefined): Promise<boolean> {
		if (!e) {
			await this.deps.settle();
			return true;
		}
		let moved = false;
		const settled = this.deps.settle();
		while (!this.dead && !moved) {
			const woke = await Promise.race([
				settled.then(() => false),
				this.waitUntil().then(() => true),
			]);
			if (!woke) break;
			moved = e.t <= this.until;
		}
		this.wake = null;
		return !moved;
	}

	private waitUntil() {
		return new Promise<void>((r) => {
			this.wake = r;
		});
	}

	/**
	 * Messages `from` to `to` (exclusive), each in its own task, queued back to
	 * back. A run stops at the `burst` bound, and the page renders before the next.
	 * Each message's clock stays pinned into the next one's task, as `apply` keeps
	 * it into the task after it. False: the take failed.
	 */
	private async burst(from: number, to: number): Promise<boolean> {
		const d = this.deps;
		const start = d.now();
		let fault: unknown = null;
		let pinned = false;
		try {
			await d.tasks?.(to - from, (k) => {
				if (this.dead) return false;
				const i = from + k;
				const e = d.log[i] as Entry;
				if (pinned) d.leave();
				d.enter(e);
				pinned = true;
				if (d.watch?.has(i)) d.passed?.(i);
				try {
					d.apply(e, i);
				} catch (err) {
					fault = err;
					return false;
				}
				this.next = i + 1;
				this.pos = Math.max(this.pos, e.t);
				this.dirty = true;
				return d.now() - start < this.limits.burst;
			});
			if (fault === null && pinned && !this.dead) await d.task();
		} finally {
			if (pinned) d.leave();
		}
		if (fault !== null) {
			this.fail(this.next, `fault: ${fault instanceof Error ? fault.message : String(fault)}`);
			return false;
		}
		if (this.dead) return false;
		this.report({ idle: false, settled: false });
		return true;
	}

	private async loop() {
		const d = this.deps;
		const log = d.log;
		const L = this.limits;
		while (!this.dead) {
			const e = log[this.next];
			const i = this.next;

			// Nothing due before `until`: the page settles, then time passes up to it, and
			// the host hears. Not before: what is shown must not get ahead of the page.
			if (!e || e.t > this.until) {
				if (this.settledAt !== i) {
					this.report({ idle: true, settled: false });
					// Settling only gates what is reported. Should `until` move past the next
					// entry meanwhile, it goes on at once, still unsettled: a page busy
					// rendering a stream would otherwise pay a settle per LEAD_MS of it.
					if (this.dirty && !(await this.settleUnless(e))) continue;
					this.dirty = false;
					this.settledAt = i;
					if (this.dead) return;
					if (e && e.t <= this.until) continue;
				}
				this.pos = Math.max(this.pos, this.until);
				this.report({ idle: true, settled: true });
				await this.waitUntil();
				if (!this.dead) d.idle?.();
				continue;
			}

			// Input acts on what the page shows: whatever was applied before it has to be
			// rendered first, a framework's deferred commit too.
			if (this.dirty && dependent(e)) {
				await d.settle();
				this.dirty = false;
				if (this.dead) return;
			}

			// Server messages with nothing else between them are one backlog: the app gets
			// them back to back and renders once for many, not once per message.
			if (e.k === "msg" && d.tasks && !d.waive?.has(i)) {
				let end = i + 1;
				while (end < log.length && end - i < L.batch) {
					const n = log[end];
					if (n?.k !== "msg" || n.t > this.until || d.waive?.has(end)) break;
					end++;
				}
				if (end - i > 1) {
					if (!(await this.burst(i, end))) return;
					continue;
				}
			}

			let skip = false;
			const waived = d.waive?.has(i) ?? false;
			const off = d.diverged?.(e, i);
			if (off && !waived) {
				this.fail(i, off);
				return;
			}
			if (waived) {
				// Not waited on, and not applied unless it holds.
				skip = !!off || !d.ready(e, i);
			} else if (!d.ready(e, i)) {
				this.report({ idle: false, settled: false, wait: i });
				let last = d.now();
				let beat = last;
				// Looks in which the page did nothing, and ones in which it worked.
				let waited = 0;
				let worked = 0;
				let work = d.work?.();
				const limit = e.k === "open" || i < this.booted ? L.open : isSoft(e) ? L.soft : L.pre;
				while (!d.ready(e, i)) {
					if (this.dead) return;
					const now = d.now();
					const dt = Math.min(now - last, L.tick);
					last = now;
					const w = d.work?.();
					if (w !== work) {
						worked += dt;
						work = w;
					} else waited += dt;
					if (waited > limit || waited + worked > limit * L.busy) {
						if (isSoft(e)) {
							skip = true;
							break;
						}
						this.fail(i, d.why(e, i));
						return;
					}
					if (now - beat >= L.beat) {
						beat = now;
						this.report({ idle: false, settled: false, wait: i });
					}
					await d.change();
					const gone = d.diverged?.(e, i);
					if (gone) {
						this.fail(i, gone);
						return;
					}
				}
				if (this.dead) return;
			}
			if (!skip && d.watch?.has(i)) d.passed?.(i);

			d.enter(e);
			try {
				if (!skip) d.apply(e, i);
				if (ownTask(e)) await d.task();
			} catch (err) {
				this.fail(i, `fault: ${err instanceof Error ? err.message : String(err)}`);
				return;
			} finally {
				d.leave();
			}
			this.next = i + 1;
			this.pos = Math.max(this.pos, e.t);
			if (!skip && changes(e)) this.dirty = true;
			this.report({ idle: false, settled: false }, false);
		}
	}
}
