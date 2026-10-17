// Virtual history. An iframe shares the tab's session history: its pushState
// adds entries to the tab, and its history.back() walks the tab's, so an app
// going "back" in the replay can take the page around it back with it. Here
// the take's history is a stack in memory, `state` included. The url the app
// reads is set with the real replaceState, which never adds an entry to the
// tab, and only when the url changes; traversals fire popstate by hand, a task
// later, as a browser does.

export interface HistoryEntry {
	url: string;
	state: unknown;
}

/** What the real history is used for: the url the app reads. */
export interface UrlBar {
	/** Show `url`, adding no entry anywhere. Throws as replaceState does. */
	replace(url: string | null | undefined): void;
	/** The url now, absolute. */
	href(): string;
}

export interface HistoryEvents {
	popstate(state: unknown): void;
	hashchange(oldURL: string, newURL: string): void;
	/** Run `fn` in a task of its own. */
	later(fn: () => void): void;
}

/** One change of the url the app saw, in order. Recorded navigation is checked against these. */
export interface Change {
	path: string;
	mode: "push" | "replace" | "pop";
}

/** As the browser keeps history state: a structured clone. */
function clone(state: unknown): unknown {
	if (state === null || state === undefined || typeof state !== "object") return state ?? null;
	try {
		return structuredClone(state);
	} catch (err) {
		throw new DOMException(String(err), "DataCloneError");
	}
}

function pathOf(href: string): string {
	const u = new URL(href);
	return u.pathname + u.search + u.hash;
}

function sameDocument(a: string, b: string): boolean {
	const x = new URL(a);
	const y = new URL(b);
	return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
}

export class VirtualHistory {
	private entries: HistoryEntry[];
	private index = 0;
	readonly changes: Change[] = [];
	/**
	 * Hold the app's traversals (back, forward, go) until `traverseAsked`: the
	 * replay performs each where the take's log has its popstate, so the app sees
	 * it in the order it did, not a task after it asked.
	 */
	hold = false;
	/** Traversals the app asked for, held. */
	private asked: number[] = [];

	constructor(
		private bar: UrlBar,
		private on: HistoryEvents,
	) {
		this.entries = [{ url: bar.href(), state: null }];
	}

	get length() {
		return this.entries.length;
	}

	/** The current entry's state, as history.state. */
	get state() {
		return this.entries[this.index]?.state ?? null;
	}

	/** Run `fn` in its own task, in order with traversals. */
	later(fn: () => void) {
		this.on.later(fn);
	}

	/** Start over at `url`: one entry, no change counted. The shim's own move to the recorded path. */
	reset(url: string) {
		this.bar.replace(url);
		this.entries = [{ url: this.bar.href(), state: null }];
		this.index = 0;
	}

	/** Where the app is: path + search + hash. */
	get path() {
		return pathOf(this.bar.href());
	}

	push(state: unknown, url?: string | URL | null) {
		this.bar.replace(url == null ? null : String(url));
		this.entries.splice(this.index + 1);
		this.entries.push({ url: this.bar.href(), state: clone(state) });
		this.index = this.entries.length - 1;
		this.changes.push({ path: this.path, mode: "push" });
	}

	replace(state: unknown, url?: string | URL | null) {
		this.bar.replace(url == null ? null : String(url));
		this.entries[this.index] = { url: this.bar.href(), state: clone(state) };
		this.changes.push({ path: this.path, mode: "replace" });
	}

	/** As history.go: async, a no-op out of range. go(0) would reload, so it does nothing. */
	go(delta = 0) {
		if (!delta) return;
		if (this.hold) this.asked.push(delta);
		else this.on.later(() => this.traverse(this.index + delta));
	}

	/** How many traversals the app asked for that are still held. */
	get pending() {
		return this.asked.length;
	}

	/** Perform the first held traversal now. */
	traverseAsked() {
		const delta = this.asked.shift();
		if (delta !== undefined) this.traverse(this.index + delta);
	}

	back() {
		this.go(-1);
	}

	forward() {
		this.go(1);
	}

	/** Move to entry `to` now, firing popstate (and hashchange), as a traversal does. */
	traverse(to: number) {
		const entry = this.entries[to];
		if (!entry || to === this.index) return;
		const from = this.bar.href();
		this.index = to;
		this.bar.replace(entry.url);
		this.changes.push({ path: this.path, mode: "pop" });
		this.on.popstate(entry.state);
		const now = this.bar.href();
		if (sameDocument(from, now) && new URL(from).hash !== new URL(now).hash) {
			this.on.hashchange(from, now);
		}
	}

	/**
	 * The browser's back or forward, to the nearest entry at `path`: back
	 * first, then forward. False when there is none and the url is elsewhere.
	 */
	traverseTo(path: string): boolean {
		if (this.path === path) return true;
		for (let d = 1; d < this.entries.length; d++) {
			for (const to of [this.index - d, this.index + d]) {
				const e = this.entries[to];
				if (e && pathOf(e.url) === path) {
					this.traverse(to);
					return true;
				}
			}
		}
		return false;
	}

	/** The first change at or after `from` to `path`, or -1. */
	find(path: string, from: number): number {
		for (let i = from; i < this.changes.length; i++) {
			if (this.changes[i]?.path === path) return i;
		}
		return -1;
	}
}

/**
 * Put `win`'s history on a virtual stack. `allow` runs the real replaceState
 * past the navigation guard (./guard.ts).
 */
export function installHistory(
	win: Window & typeof globalThis,
	allow: <T>(fn: () => T) => T,
): VirtualHistory {
	const proto = win.History.prototype;
	const realReplace = proto.replaceState;
	const channel = new win.MessageChannel();
	const queue: (() => void)[] = [];
	channel.port1.onmessage = () => queue.shift()?.();
	// The real url changes only when it differs, so a replay that replaces in place
	// costs nothing. Browsers cap how often replaceState may be called and throw
	// past it; the app then sees that throw from pushState, as it would in a tab.
	const vh = new VirtualHistory(
		{
			replace: (url) => {
				if (url == null) return;
				const next = new URL(url, win.location.href).href;
				if (next === win.location.href) return;
				allow(() => realReplace.call(win.history, null, "", next));
			},
			href: () => win.location.href,
		},
		{
			popstate: (state) => win.dispatchEvent(new win.PopStateEvent("popstate", { state })),
			hashchange: (oldURL, newURL) =>
				win.dispatchEvent(new win.HashChangeEvent("hashchange", { oldURL, newURL })),
			later: (fn) => {
				queue.push(fn);
				channel.port2.postMessage(null);
			},
		},
	);
	const method = (name: string, fn: (...a: never[]) => unknown) =>
		Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
	method("pushState", (state: unknown, _title: string, url?: string | URL | null) =>
		vh.push(state, url),
	);
	method("replaceState", (state: unknown, _title: string, url?: string | URL | null) =>
		vh.replace(state, url),
	);
	method("back", () => vh.back());
	method("forward", () => vh.forward());
	method("go", (delta?: number) => vh.go(Number(delta) || 0));
	Object.defineProperty(proto, "length", { configurable: true, get: () => vh.length });
	Object.defineProperty(proto, "state", { configurable: true, get: () => vh.state });

	// The Navigation API walks the tab's history too.
	const nav = (win as unknown as { navigation?: Record<string, unknown> }).navigation;
	if (nav) {
		const done = () => {
			const p = Promise.resolve(undefined);
			return { committed: p, finished: p };
		};
		for (const [name, fn] of [
			["back", () => vh.back()],
			["forward", () => vh.forward()],
		] as const) {
			try {
				Object.defineProperty(nav, name, {
					configurable: true,
					value: () => {
						fn();
						return done();
					},
				});
			} catch {}
		}
		try {
			Object.defineProperty(nav, "canGoBack", { configurable: true, get: () => vh.length > 1 });
		} catch {}
	}
	return vh;
}
