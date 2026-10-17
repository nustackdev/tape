import type { Entry } from "@nustackdev/tape-scene";
import { describe, expect, it } from "vitest";
import { Executor, type ExecutorDeps, type Report } from "./executor";

const btn = (t: number): Entry => ({
	t,
	k: "click",
	x: 1,
	y: 1,
	b: 0,
	m: 0,
	h: { p: "1/0", n: "button" },
});
const msg = (t: number): Entry => ({ t, k: "msg", s: 0, d: String(t), x: 1 });
const key = (t: number): Entry => ({ t, k: "keydown", key: "a", code: "KeyA", m: 0, f: null });

/** An executor on fake deps: time moves only as preconditions wait. */
function rig(log: Entry[], over: Partial<ExecutorDeps> = {}) {
	let now = 0;
	const applied: number[] = [];
	const reports: Report[] = [];
	const fails: [number | null, string][] = [];
	const calls: string[] = [];
	let pinned = 0;
	const deps: ExecutorDeps = {
		log,
		ready: () => true,
		why: (_e, i) => `entry ${i}`,
		apply: (_e, i) => {
			applied.push(i);
			calls.push(`apply ${i}`);
		},
		enter: () => {
			pinned++;
		},
		leave: () => {
			pinned--;
		},
		task: () => Promise.resolve(),
		tasks: async (n, each) => {
			for (let k = 0; k < n; k++) {
				await Promise.resolve();
				if (!each(k)) return;
			}
		},
		settle: async () => {
			calls.push("settle");
		},
		change: () =>
			new Promise<void>((res) =>
				setTimeout(() => {
					now += 30;
					res();
				}, 0),
			),
		now: () => now,
		report: (r) => reports.push(r),
		fail: (at, reason) => fails.push([at, reason]),
		...over,
	};
	const x = new Executor(deps);
	return {
		x,
		applied,
		reports,
		fails,
		calls,
		pinned: () => pinned,
		advance: (ms: number) => (now += ms),
	};
}

/** Let the executor's promise chain run out. */
const drain = async () => {
	for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("executor", () => {
	it("applies the log in order, only up to until, and reports where it is", async () => {
		const r = rig([msg(10), msg(20), btn(30), msg(40)]);
		r.x.setUntil(25);
		await drain();
		expect(r.applied).toEqual([0, 1]);
		expect(r.x.pos).toBe(25);
		const last = r.reports.at(-1);
		expect(last).toEqual({ t: 25, idle: true, settled: true });
		r.x.setUntil(100);
		await drain();
		expect(r.applied).toEqual([0, 1, 2, 3]);
		expect(r.x.pos).toBe(100);
	});

	it("never moves back, and holds still while until does", async () => {
		const r = rig([msg(10), msg(50)]);
		r.x.setUntil(20);
		await drain();
		r.x.setUntil(5);
		await drain();
		expect(r.x.pos).toBe(20);
		expect(r.applied).toEqual([0]);
		// Paused for a while: nothing moves.
		r.advance(10_000);
		await drain();
		expect(r.x.pos).toBe(20);
		r.x.setUntil(60);
		await drain();
		expect(r.applied).toEqual([0, 1]);
	});

	it("waits for a precondition, and applies nothing after it before it holds", async () => {
		let there = false;
		const r = rig([msg(10), btn(20), msg(30)], {
			ready: (e) => e.k !== "click" || there,
		});
		r.x.setUntil(100);
		await drain();
		expect(r.applied).toEqual([0]);
		expect(r.x.pos).toBe(10);
		expect(r.reports.some((x) => x.wait === 1)).toBe(true);
		there = true;
		await drain();
		expect(r.applied).toEqual([0, 1, 2]);
		expect(r.fails).toEqual([]);
	});

	it("fails the take when a precondition never holds", async () => {
		const r = rig([msg(10), btn(20), msg(30)], {
			ready: (e) => e.k !== "click",
			limits: { pre: 300 },
		});
		r.x.setUntil(100);
		for (let i = 0; i < 40 && !r.fails.length; i++) await drain();
		expect(r.fails).toEqual([[1, "entry 1"]]);
		expect(r.applied).toEqual([0]);
		expect(r.x.stopped).toBe(true);
		r.x.setUntil(1000);
		await drain();
		expect(r.applied).toEqual([0]);
	});

	it("skips a soft entry that doesn't hold, and plays on", async () => {
		const focus: Entry = { t: 20, k: "focus", h: { p: "1/9", n: "div" } };
		const r = rig([msg(10), focus, msg(30)], {
			ready: (e) => e.k !== "focus",
			limits: { soft: 100 },
		});
		r.x.setUntil(100);
		for (let i = 0; i < 20 && r.applied.length < 2; i++) await drain();
		expect(r.applied).toEqual([0, 2]);
		expect(r.fails).toEqual([]);
	});

	it("doesn't wait on a waived entry, and skips it unless it holds", async () => {
		let holds = false;
		const r = rig([btn(10), msg(20), btn(30)], {
			ready: (e) => e.k !== "click" || holds,
			waive: new Set([0, 2]),
		});
		r.x.setUntil(25);
		await drain();
		// Never fired on what isn't its target, and nothing waited.
		expect(r.applied).toEqual([1]);
		holds = true;
		r.x.setUntil(100);
		await drain();
		expect(r.applied).toEqual([1, 2]);
		expect(r.fails).toEqual([]);
	});

	it("says when an entry takes failed on passes", async () => {
		const passed: number[] = [];
		const r = rig([msg(10), btn(20)], { watch: new Set([1]), passed: (i) => passed.push(i) });
		r.x.setUntil(100);
		await drain();
		expect(passed).toEqual([1]);
	});

	it("fails at once when the take went where the recording didn't", async () => {
		const send: Entry = { t: 20, k: "send", s: 0, h: 1 };
		let sent = false;
		const r = rig([msg(10), send, msg(30)], {
			ready: (e) => e.k !== "send" || sent,
			diverged: (e) => (e.k === "send" && sent ? "other data" : null),
		});
		r.x.setUntil(100);
		await drain();
		// Waiting for the app to send: the reply after it is not delivered yet.
		expect(r.applied).toEqual([0]);
		sent = true;
		await drain();
		expect(r.fails).toEqual([[1, "other data"]]);
		expect(r.applied).toEqual([0]);
	});

	it("always unpins, and fails on a fault of its own", async () => {
		const r = rig([msg(10), msg(20)], {
			apply: (_e, i) => {
				if (i === 1) throw new Error("boom");
			},
		});
		r.x.setUntil(100);
		await drain();
		expect(r.pinned()).toBe(0);
		expect(r.fails).toEqual([[1, "fault: boom"]]);
	});

	it("lets the page settle before every input that follows a change", async () => {
		const send: Entry = { t: 45, k: "send", s: 0, h: 1 };
		const r = rig([msg(10), btn(40), send, key(46), key(47)]);
		r.x.setUntil(300);
		await drain();
		// A send changes nothing on the page: no settle for it.
		expect(r.calls).toEqual([
			"apply 0",
			"settle",
			"apply 1",
			"apply 2",
			"settle",
			"apply 3",
			"settle",
			"apply 4",
			"settle",
		]);
	});

	it("reports settled only after the page settled at the end of what is due", async () => {
		let release = () => {};
		const r = rig([msg(10)], {
			settle: () =>
				new Promise<void>((res) => {
					release = res;
				}),
		});
		r.x.setUntil(50);
		await drain();
		// Not ahead of the page while it settles: still where the last entry left it.
		expect(r.reports.at(-1)).toEqual({ t: 10, idle: true, settled: false });
		expect(r.x.pos).toBe(10);
		release();
		await drain();
		expect(r.reports.at(-1)).toEqual({ t: 50, idle: true, settled: true });
	});

	it("gives a run of server messages back to back, each in its own task, settling only before input", async () => {
		const r = rig([msg(10), msg(11), msg(12), msg(13), btn(20), msg(30)]);
		r.x.setUntil(100);
		await drain();
		expect(r.applied).toEqual([0, 1, 2, 3, 4, 5]);
		expect(r.calls).toEqual([
			"apply 0",
			"apply 1",
			"apply 2",
			"apply 3",
			"settle",
			"apply 4",
			"apply 5",
			"settle",
		]);
		expect(r.pinned()).toBe(0);
	});

	it("queues the run's tasks at once, and lets the page render when a run reaches its bound", async () => {
		let now = 0;
		const runs: number[] = [];
		const r = rig([msg(10), msg(11), msg(12), msg(13), msg(14)], {
			now: () => now,
			limits: { burst: 50 },
			tasks: async (n, each) => {
				runs.push(n);
				for (let k = 0; k < n; k++) {
					await Promise.resolve();
					now += 30;
					if (!each(k)) return;
				}
			},
		});
		r.x.setUntil(100);
		await drain();
		expect(r.applied).toEqual([0, 1, 2, 3, 4]);
		// 30ms a message: each run stops at the second, the rest go in the next; the
		// last one alone is no run.
		expect(runs).toEqual([5, 3]);
		expect(r.pinned()).toBe(0);
		expect(r.x.pos).toBe(100);
	});

	it("fails a take on a fault inside a run, unpinned", async () => {
		const r = rig([msg(10), msg(11), msg(12)], {
			apply: (_e, i) => {
				if (i === 1) throw new Error("boom");
			},
		});
		r.x.setUntil(100);
		await drain();
		expect(r.fails).toEqual([[1, "fault: boom"]]);
		expect(r.pinned()).toBe(0);
	});

	it("doesn't count a wait against its deadline while the page keeps working, within a bound", async () => {
		let now = 0;
		let work = 0;
		let working = true;
		// Looks left before the test lets the next one through.
		let looks = 15;
		let held: (() => void) | null = null;
		const r = rig([msg(10), btn(20)], {
			ready: (e) => e.k !== "click",
			limits: { pre: 1000, tick: 100, busy: 4 },
			now: () => now,
			work: () => work,
			change: () =>
				new Promise<void>((res) => {
					const look = () => {
						now += 100;
						if (working) work++;
						res();
					};
					if (looks-- > 0) setTimeout(look, 0);
					else held = look;
				}),
		});
		r.x.setUntil(100);
		await drain();
		// Slow, not stuck: 1500ms of looks, every one with the page at work.
		expect(now).toBe(1500);
		expect(r.fails).toEqual([]);
		// It stops working: the deadline runs from there.
		working = false;
		const stopped = now;
		looks = 1000;
		(held as (() => void) | null)?.();
		for (let i = 0; i < 10 && !r.fails.length; i++) await drain();
		expect(r.fails).toHaveLength(1);
		expect(now - stopped).toBeGreaterThanOrEqual(1000);
		expect(now - stopped).toBeLessThan(1300);
	});

	it("still fails a wait on a page that never stops working, at the bound", async () => {
		let now = 0;
		let work = 0;
		const r = rig([msg(10), btn(20)], {
			ready: (e) => e.k !== "click",
			limits: { pre: 1000, tick: 100, busy: 4 },
			now: () => now,
			work: () => ++work,
			change: () =>
				new Promise<void>((res) =>
					setTimeout(() => {
						now += 100;
						res();
					}, 0),
				),
		});
		r.x.setUntil(100);
		for (let i = 0; i < 10 && !r.fails.length; i++) await drain();
		expect(r.fails).toHaveLength(1);
		expect(now).toBeGreaterThanOrEqual(4000);
		expect(now).toBeLessThan(4300);
	});

	it("goes on at once when until passes the next entry while the page settles", async () => {
		let release = () => {};
		const r = rig([msg(10), msg(60)], {
			settle: () =>
				new Promise<void>((res) => {
					release = res;
				}),
		});
		r.x.setUntil(50);
		await drain();
		expect(r.reports.at(-1)).toEqual({ t: 10, idle: true, settled: false });
		// The page is still settling when the clock reaches the next message: it goes.
		r.x.setUntil(70);
		await drain();
		expect(r.applied).toEqual([0, 1]);
		release();
		await drain();
		expect(r.reports.at(-1)?.settled).toBe(true);
		expect(r.x.pos).toBe(70);
	});

	it("gives a starved page as many looks as a free one before it fails", async () => {
		let now = 0;
		let looks = 0;
		const r = rig([msg(10), btn(20)], {
			ready: (e) => e.k !== "click",
			limits: { pre: 1000, tick: 100 },
			now: () => now,
			change: () =>
				new Promise<void>((res) =>
					setTimeout(() => {
						// Each look comes 2s late: the machine is starved.
						now += 2000;
						looks++;
						res();
					}, 0),
				),
		});
		r.x.setUntil(100);
		for (let i = 0; i < 60 && !r.fails.length; i++) await drain();
		expect(r.fails).toHaveLength(1);
		// 20s of wall time went by in 10 looks, yet it failed only after 1000ms of looks.
		expect(looks).toBeGreaterThanOrEqual(10);
	});

	it("matches the app's sends by content, in either order, and only counts ones the take never made", async () => {
		const { SendLedger } = await import("./ledger");
		const l = new SendLedger([
			[0, 1],
			[0, 2],
			[1, 1],
		]);
		// The app sends 2 before 1: both entries can be claimed.
		l.note(0, 2, () => "two");
		expect(l.has(0, 1)).toBe(false);
		expect(l.has(0, 2)).toBe(true);
		l.note(0, 1, () => "one");
		l.claim(0, 1);
		l.claim(0, 2);
		// More than the take sent: counted, and it can't stand in for a later send.
		l.note(0, 1, () => "one again");
		expect([l.extra, l.firstExtra]).toEqual([1, "socket 0: one again"]);
		expect(l.has(0, 1)).toBe(false);
		// The one on socket 1 is still due: what holds the take.
		expect(l.has(1, 1)).toBe(false);
		l.note(1, 1, () => "");
		expect(l.has(1, 1)).toBe(true);
	});

	it("applies a traversal the app asked for in log order, without settling first", async () => {
		const pop: Entry = { t: 30, k: "nav", path: "/a", mode: "pop" };
		const push: Entry = { t: 20, k: "nav", path: "/a?x", mode: "push" };
		const r = rig([msg(10), push, pop]);
		r.x.setUntil(100);
		await drain();
		expect(r.calls).toEqual(["apply 0", "apply 1", "apply 2", "settle"]);
	});

	it("gives what the take has before its first input the boot deadline", async () => {
		const nav: Entry = { t: 20, k: "nav", path: "/home", mode: "replace" };
		const r = rig([msg(10), nav, btn(30)], {
			ready: (e) => e.k !== "nav",
			limits: { pre: 100, open: 5000, tick: 100 },
		});
		r.x.setUntil(100);
		// About 1500ms of looks: past what an input gets, within what the boot gets.
		await drain();
		expect(r.fails).toEqual([]);
		for (let i = 0; i < 60 && !r.fails.length; i++) await drain();
		expect(r.fails).toHaveLength(1);
	});
});
