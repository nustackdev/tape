import { describe, expect, it } from "vitest";
import { VirtualHistory } from "./history";

/** A url bar that only remembers, and events that are recorded. */
function rig(start = "https://site.test/app/") {
	let href = start;
	const replaced: string[] = [];
	const pops: unknown[] = [];
	const hashes: [string, string][] = [];
	const later: (() => void)[] = [];
	const vh = new VirtualHistory(
		{
			replace: (url) => {
				if (url != null) href = new URL(url, href).href;
				replaced.push(href);
			},
			href: () => href,
		},
		{
			popstate: (s) => pops.push(s),
			hashchange: (a, b) => hashes.push([a, b]),
			later: (fn) => later.push(fn),
		},
	);
	const run = () => {
		while (later.length) later.shift()?.();
	};
	return { vh, replaced, pops, hashes, run, state: () => vh.state, href: () => href };
}

describe("virtual history", () => {
	it("pushes and replaces on its own stack, setting the url by replace only", () => {
		const r = rig();
		r.vh.reset("/");
		expect(r.vh.length).toBe(1);
		r.vh.push({ a: 1 }, "/a");
		r.vh.push({ b: 1 }, "/b?x=1");
		r.vh.replace({ b: 2 }, "/b?x=2");
		expect(r.vh.length).toBe(3);
		expect(r.vh.path).toBe("/b?x=2");
		expect(r.state()).toEqual({ b: 2 });
		expect(r.vh.changes.map((c) => `${c.mode} ${c.path}`)).toEqual([
			"push /a",
			"push /b?x=1",
			"replace /b?x=2",
		]);
	});

	it("traverses a task later, firing popstate with the entry's state", () => {
		const r = rig();
		r.vh.reset("/");
		r.vh.push({ a: 1 }, "/a");
		r.vh.push({ b: 1 }, "/b");
		r.vh.back();
		expect(r.vh.path).toBe("/b");
		expect(r.pops).toEqual([]);
		r.run();
		expect(r.vh.path).toBe("/a");
		expect(r.pops).toEqual([{ a: 1 }]);
		r.vh.forward();
		r.run();
		expect(r.vh.path).toBe("/b");
		// A push after going back drops what was ahead.
		r.vh.go(-2);
		r.run();
		expect(r.vh.path).toBe("/");
		r.vh.push(null, "/c");
		expect(r.vh.length).toBe(2);
		r.vh.forward();
		r.run();
		expect(r.vh.path).toBe("/c");
	});

	it("never leaves its stack: back at the start, go(0) and out of range do nothing", () => {
		const r = rig();
		r.vh.reset("/");
		r.vh.back();
		r.vh.go(0);
		r.vh.go(5);
		r.run();
		expect(r.vh.path).toBe("/");
		expect(r.pops).toEqual([]);
		expect(r.vh.changes).toEqual([]);
	});

	it("fires hashchange when a traversal only moves the fragment", () => {
		const r = rig();
		r.vh.reset("/doc");
		r.vh.push(null, "/doc#two");
		r.vh.back();
		r.run();
		expect(r.hashes).toEqual([["https://site.test/doc#two", "https://site.test/doc"]]);
	});

	it("goes back to a path by the user's back button, and finds the app's changes in order", () => {
		const r = rig();
		r.vh.reset("/");
		r.vh.push(null, "/a");
		r.vh.push(null, "/b");
		expect(r.vh.traverseTo("/a")).toBe(true);
		expect(r.vh.path).toBe("/a");
		expect(r.vh.traverseTo("/nowhere")).toBe(false);
		expect(r.vh.find("/a", 0)).toBe(0);
		expect(r.vh.find("/a", 1)).toBe(2);
		expect(r.vh.find("/b", 2)).toBe(-1);
	});

	it("holds the app's back until the replay performs it where the take had it", () => {
		const r = rig();
		r.vh.reset("/");
		r.vh.push(null, "/a");
		r.vh.hold = true;
		r.vh.back();
		r.run();
		// Asked, not done: no popstate yet, however many tasks pass.
		expect(r.vh.path).toBe("/a");
		expect(r.pops).toEqual([]);
		expect(r.vh.pending).toBe(1);
		r.vh.traverseAsked();
		expect(r.vh.path).toBe("/");
		expect(r.pops).toHaveLength(1);
		expect(r.vh.pending).toBe(0);
	});
});
