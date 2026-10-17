// @vitest-environment happy-dom
import type { Scene } from "@nustackdev/tape-scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, LEAD_MS } from "./engine";
import { TAG, type ToShim } from "./protocol";

const scene = (): Scene => ({
	tape: 2,
	meta: {
		recordedAt: "",
		url: "",
		path: "/",
		viewport: { width: 100, height: 100, dpr: 1 },
		duration: 10_000,
		seed: 1,
		epoch: 0,
	},
	storage: { local: {} },
	sockets: [{ url: "/ws" }],
	log: [{ t: 10, k: "open", s: 0 }],
});

/** An engine whose takes are fake windows that keep what the engine posts. */
function rig() {
	const takes: { ids: string[]; front: string | null }[] = [];
	const e = new Engine(
		{ takes: (ids, front) => takes.push({ ids, front }), playing: () => {} },
		{ autoplay: true, loop: false, hold: 0 },
	);
	e.visible = true;
	const inbox = new Map<string, ToShim[]>();
	const attach = () => {
		for (const id of takes.at(-1)?.ids ?? []) {
			if (inbox.has(id)) continue;
			const box: ToShim[] = [];
			inbox.set(id, box);
			e.attach(id, { postMessage: (m: ToShim) => box.push(m) } as unknown as Window);
		}
	};
	const say = (id: string, body: Record<string, unknown>) =>
		e.message({ tape: TAG, take: id, ...body });
	const latest = () => takes.at(-1) ?? { ids: [], front: null };
	return { e, takes, inbox, attach, say, latest };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("engine", () => {
	it("shows a take only on its own report of reaching the clock, settled", () => {
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const id = r.latest().ids[0] as string;
		r.say(id, { type: "hello" });
		expect(r.inbox.get(id)?.map((m) => m.type)).toEqual(["scene", "until"]);
		// Time alone never shows it.
		vi.advanceTimersByTime(60_000);
		for (let i = 0; i < 100; i++) r.e.frame(16);
		expect(r.latest().front).toBeNull();
		r.say(id, { type: "pos", t: 0, idle: true, settled: false });
		expect(r.latest().front).toBeNull();
		r.say(id, { type: "pos", t: 0, idle: true, settled: true });
		expect(r.latest().front).toBe(id);
	});

	it("runs the clock no further than LEAD_MS ahead of what the take applied", () => {
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const id = r.latest().ids[0] as string;
		r.say(id, { type: "hello" });
		r.say(id, { type: "pos", t: 0, idle: true, settled: true });
		// The take is stuck at 0: the clock stops at the lead, and what is shown stays at 0.
		for (let i = 0; i < 100; i++) r.e.frame(16);
		expect(r.e.t).toBe(LEAD_MS);
		expect(r.e.shown).toBe(0);
		r.say(id, { type: "pos", t: 200, idle: false, settled: false });
		for (let i = 0; i < 100; i++) r.e.frame(16);
		expect(r.e.t).toBe(200 + LEAD_MS);
		expect(r.e.shown).toBe(200);
		const untils = (r.inbox.get(id) ?? []).flatMap((m) => (m.type === "until" ? [m.t] : []));
		expect(Math.max(...untils)).toBe(200 + LEAD_MS);
	});

	it("replaces a failed take, and waives an entry that fails twice", () => {
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const first = r.latest().ids[0] as string;
		r.say(first, { type: "hello" });
		r.say(first, { type: "fail", at: 0, reason: "nope" });
		expect(r.latest().ids).toEqual([]);
		vi.advanceTimersByTime(5000);
		r.attach();
		const second = r.latest().ids[0] as string;
		expect(second).not.toBe(first);
		r.say(second, { type: "hello" });
		r.say(second, { type: "fail", at: 0, reason: "nope" });
		vi.advanceTimersByTime(5000);
		r.attach();
		const third = r.latest().ids[0] as string;
		r.say(third, { type: "hello" });
		const sent = r.inbox.get(third)?.[0];
		expect(sent?.type === "scene" && sent.waive).toEqual([0]);
	});

	it("stops trying after failures in a row", () => {
		const r = rig();
		r.e.setScene(scene());
		for (let i = 0; i < 10; i++) {
			r.attach();
			const id = r.latest().ids[0];
			if (!id) break;
			r.say(id, { type: "hello" });
			r.say(id, { type: "fail", at: null, reason: "boot" });
			vi.advanceTimersByTime(10_000);
		}
		expect(r.e.gaveUp).toBe(true);
		expect(r.latest().ids).toEqual([]);
	});

	it("keeps a stuck front on screen, frozen, until its replacement shows", () => {
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const a = r.latest().ids[0] as string;
		r.say(a, { type: "hello" });
		r.say(a, { type: "pos", t: 0, idle: true, settled: true });
		r.say(a, { type: "pos", t: 100, idle: false, settled: false });
		// Busy and silent past the watchdog.
		for (let i = 0; i < 500; i++) r.e.frame(16);
		expect(r.latest().front).toBe(a);
		vi.advanceTimersByTime(1000);
		r.attach();
		const b = r.latest().ids.find((id) => id !== a) as string;
		expect(b).toBeDefined();
		r.say(b, { type: "hello" });
		const until = r.inbox.get(b)?.find((m) => m.type === "until");
		expect(until?.type === "until" && until.t).toBe(100);
		r.say(b, { type: "pos", t: 100, idle: true, settled: true });
		expect(r.latest().front).toBe(b);
	});

	it("drops a take whose page went away", () => {
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const a = r.latest().ids[0] as string;
		r.say(a, { type: "hello" });
		r.say(a, { type: "pos", t: 0, idle: true, settled: true });
		r.say(a, { type: "gone", why: "beforeunload" });
		expect(r.latest().front).toBeNull();
		expect(r.latest().ids).not.toContain(a);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unloaded (beforeunload)"));
	});

	it("tells a recycled take's unload from a take that left", () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const a = r.latest().ids[0] as string;
		r.say(a, { type: "hello" });
		r.say(a, { type: "pos", t: 0, idle: true, settled: true });
		// A fresh take (its storage changed): the old one goes once the new one shows.
		r.e.restart();
		r.attach();
		const b = r.latest().ids.find((id) => id !== a) as string;
		r.say(b, { type: "hello" });
		r.say(b, { type: "pos", t: 0, idle: true, settled: true });
		vi.advanceTimersByTime(1000);
		expect(r.latest().ids).toEqual([b]);
		r.say(a, { type: "gone", why: "teardown" });
		expect(debug).toHaveBeenCalledWith(`tape: take ${a} gone (teardown)`);
		expect(console.warn).not.toHaveBeenCalled();
		expect(r.latest().front).toBe(b);
	});

	it("gives each take after failures in a row more patience, so a restart never repeats a timeout", () => {
		const r = rig();
		r.e.setScene(scene());
		const patience: (number | undefined)[] = [];
		for (let i = 0; i < 4; i++) {
			r.attach();
			const id = r.latest().ids.at(-1) as string;
			r.say(id, { type: "hello" });
			const sent = r.inbox.get(id)?.[0];
			patience.push(sent?.type === "scene" ? sent.patience : undefined);
			r.say(id, { type: "fail", at: null, reason: "slow" });
			vi.advanceTimersByTime(10_000);
		}
		expect(patience).toEqual([1, 2, 4, 8]);
	});

	it("forgets a failure once the entry passes, and lifts its waiver", () => {
		const r = rig();
		r.e.setScene(scene());
		const take = () => {
			r.attach();
			const id = r.latest().ids.find((x) => !r.inbox.get(x)?.length) as string;
			r.say(id, { type: "hello" });
			return id;
		};
		for (let i = 0; i < 2; i++) {
			r.say(take(), { type: "fail", at: 0, reason: "nope" });
			vi.advanceTimersByTime(5000);
		}
		const third = take();
		const first = r.inbox.get(third)?.[0];
		expect(first?.type === "scene" && [first.waive, first.watch]).toEqual([[0], [0]]);
		r.say(third, { type: "passed", at: 0 });
		r.say(third, { type: "fail", at: 0, reason: "nope" });
		vi.advanceTimersByTime(5000);
		const fourth = take();
		const sent = r.inbox.get(fourth)?.[0];
		// One failure since it passed: watched, not waived.
		expect(sent?.type === "scene" && [sent.waive, sent.watch]).toEqual([[], [0]]);
	});

	it("tries again after giving up, once it comes back near", () => {
		const r = rig();
		r.e.setScene(scene());
		for (let i = 0; i < 10 && !r.e.gaveUp; i++) {
			r.attach();
			const id = r.latest().ids[0];
			if (!id) break;
			r.say(id, { type: "hello" });
			r.say(id, { type: "fail", at: null, reason: "boot" });
			vi.advanceTimersByTime(10_000);
		}
		expect(r.e.gaveUp).toBe(true);
		r.e.park();
		r.e.unpark();
		expect(r.e.gaveUp).toBe(false);
		expect(r.latest().ids).toHaveLength(1);
	});

	it("tells a take whether it plays, so its deadlines only count then", () => {
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const id = r.latest().ids[0] as string;
		r.say(id, { type: "hello" });
		r.say(id, { type: "pos", t: 0, idle: true, settled: true });
		r.e.frame(16);
		r.e.pause();
		r.e.frame(16);
		r.e.visible = false;
		r.e.play({ rewind: false });
		r.e.frame(16);
		const runs = (r.inbox.get(id) ?? []).flatMap((m) => (m.type === "run" ? [m.on] : []));
		expect(runs).toEqual([true, false]);
	});

	it("holds the page's scroll while a take's editor edits, and leaves no listener behind", () => {
		const added: AbortSignal[] = [];
		const add = window.addEventListener.bind(window);
		vi.spyOn(window, "addEventListener").mockImplementation(((
			type: string,
			fn: EventListener,
			opts?: AddEventListenerOptions,
		) => {
			if (opts?.signal) added.push(opts.signal);
			else throw new Error(`a listener for ${type} without a way to remove it`);
			add(type, fn, opts);
		}) as typeof window.addEventListener);
		const r = rig();
		r.e.setScene(scene());
		r.attach();
		const id = r.latest().ids[0] as string;
		r.say(id, { type: "hello" });
		r.say(id, { type: "hold" });
		expect(added.length).toBeGreaterThan(0);
		expect(added.every((x) => !x.aborted)).toBe(true);
		vi.advanceTimersByTime(500);
		expect(added.every((x) => x.aborted)).toBe(true);
		r.say(id, { type: "hold" });
		r.e.dispose();
		expect(added.every((x) => x.aborted)).toBe(true);
	});
});
