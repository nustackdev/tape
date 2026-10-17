// The shim. Runs first inside the replay iframe, before the app.
//
// It walls the frame in (./guard.ts, ./history.ts), swaps window.WebSocket
// for a fake the recording feeds, gives the app a private localStorage seeded
// from the take, puts the page on the recorded path, and only then starts the
// app's module scripts (`tape bundle` made them inert). From there the
// executor (./executor.ts) plays the scene's log in order, as far as the host
// lets it, and reports how far it got. What the app sends goes nowhere.
//
// The frame is sandboxed to an opaque origin (see KERNEL.md): the page around
// it is out of reach, so everything here talks to the host by postMessage, and
// storage and cookies, which an opaque origin can't have, are kept in memory.
//
// Without a take id in its url the shim does nothing and the app never starts:
// a frame reloaded by accident stays blank.

import {
	base64ToBytes,
	bytesToBase64,
	type Entry,
	installClock,
	installRandom,
	installTargets,
	isPointerButton,
	type Randomness,
	type Scene,
	type Target,
} from "@nustackdev/tape-scene";
import { installEdit } from "./edit";
import { Executor, type ExecutorDeps, LIMITS } from "./executor";
import { activeElement, FOCUS_ATTR, installFocus } from "./focus";
import { ancestorPath, type Gesture, gestures, mapPoint } from "./gesture";
import { allowNavigation, installGuards, replaying } from "./guard";
import { installHistory, type VirtualHistory } from "./history";
import { InputPlayer, isField } from "./input";
import { SendLedger } from "./ledger";
import { type Body, isTape, TAG, TAKE_KEY, type ToParent, type ToShim } from "./protocol";
import { installPseudo } from "./pseudo";
import { installScroll } from "./scroll";
import { dropStray, installSelection } from "./selection";

const DEFERRED_TYPE = "text/x-tape-module";
/**
 * Nothing in the app is selectable but what the replay is editing: the visitor
 * can't select the take, and a stray selection has nowhere to land.
 */
const UNSELECTABLE = `*,*::before,*::after{-webkit-user-select:none!important;user-select:none!important}
[${FOCUS_ATTR}],[${FOCUS_ATTR}] *{-webkit-user-select:text!important;user-select:text!important}`;
/** The page settles once a frame passes without a DOM change, or after this. */
const SETTLE_MAX_MS = 300;
/** A frame, or this if frames don't come (a throttled frame). */
const FRAME_MAX_MS = 50;
/** How often a waiting precondition looks again when nothing signals a change. */
const POLL_MS = 30;

declare global {
	interface Window {
		/** The take this frame plays, and where it is. For the host and for tests. */
		__tapeShim?: { readonly take: string | null; readonly pos: number };
	}
}

(() => {
	if (window.__tapeShim) return;
	const take = new URLSearchParams(location.hash.slice(1)).get(TAKE_KEY);
	let exec: Executor | null = null;
	window.__tapeShim = {
		take,
		get pos() {
			return exec?.pos ?? Number.NEGATIVE_INFINITY;
		},
	};
	if (!take) return;

	const post = (m: Body<ToParent>) => window.parent.postMessage({ tape: TAG, take, ...m }, "*");

	// Resolved now: once the path moves to the recorded one, relative urls would resolve elsewhere.
	const deferred: { src: string; attrs: [string, string][] }[] = [];
	const collect = () => {
		for (const el of document.querySelectorAll<HTMLScriptElement>(
			`script[type="${DEFERRED_TYPE}"]`,
		)) {
			const attrs = [...el.attributes]
				.filter((a) => a.name !== "type" && a.name !== "src")
				.map((a) => [a.name, a.value] as [string, string]);
			deferred.push({ src: el.src, attrs });
			el.remove();
		}
	};

	/** Every socket the app made, in creation order: the order the scene numbers them in. */
	const live: FakeSocket[] = [];
	/** What the app sent, against what the take sent. Made at boot. */
	let ledger: SendLedger | null = null;
	const T = installTargets(document);

	/** Call the app's handler as a browser does: what it throws is reported, not passed on. */
	const call = (fn: unknown, self: unknown, ev: Event) => {
		if (typeof fn !== "function") return;
		try {
			fn.call(self, ev);
		} catch (err) {
			reportError(err);
		}
	};

	class FakeSocket extends EventTarget {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly CONNECTING = 0;
		readonly OPEN = 1;
		readonly CLOSING = 2;
		readonly CLOSED = 3;

		readonly url: string;
		/** path, for matching the recorded socket. */
		readonly path: string;
		readyState = 0;
		/** What the app sent, hashed, in order. Null while a Blob is still being read. */

		binaryType: BinaryType = "blob";
		bufferedAmount = 0;
		extensions = "";
		protocol = "";
		onopen: ((ev: Event) => void) | null = null;
		onmessage: ((ev: MessageEvent) => void) | null = null;
		onclose: ((ev: CloseEvent) => void) | null = null;
		onerror: ((ev: Event) => void) | null = null;

		constructor(url: string | URL, _protocols?: string | string[]) {
			super();
			const u = new URL(String(url), location.href);
			this.url = u.href;
			this.path = u.pathname;
			live.push(this);
		}

		open() {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.fire(new Event("open"));
		}

		deliver(data: string | Uint8Array) {
			// The app closed it: a browser drops what still arrives.
			if (this.readyState !== 1) return;
			const payload =
				typeof data === "string"
					? data
					: this.binaryType === "arraybuffer"
						? data.slice().buffer
						: new Blob([data.slice()]);
			this.fire(new MessageEvent("message", { data: payload }));
		}

		end(code: number, clean: boolean) {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.fire(new CloseEvent("close", { code, wasClean: clean }));
		}

		private fire(ev: Event) {
			call((this as unknown as Record<string, unknown>)[`on${ev.type}`], this, ev);
			this.dispatchEvent(ev);
		}

		/** Goes nowhere. Noted, so the take hands over the server's reply only after it. */
		send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
			if (this.readyState === 0) throw new DOMException("still connecting", "InvalidStateError");
			if (this.readyState !== 1) return;
			const s = live.indexOf(this);
			const note = (d: string | Uint8Array) => {
				ledger?.note(s, T.digest(d), () =>
					(typeof d === "string" ? d : bytesToBase64(d)).slice(0, 600),
				);
				wake();
			};
			if (typeof data === "string") note(data);
			else if (data instanceof Blob) data.arrayBuffer().then((buf) => note(new Uint8Array(buf)));
			else
				note(
					ArrayBuffer.isView(data)
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
						: new Uint8Array(data),
				);
		}

		close(code = 1000, _reason?: string) {
			this.end(code, true);
		}
	}

	class MemoryStorage {
		private m = new Map<string, string>();
		constructor(seed: Record<string, string>) {
			for (const [k, v] of Object.entries(seed)) this.m.set(k, String(v));
		}
		get length() {
			return this.m.size;
		}
		key(i: number) {
			return [...this.m.keys()][i] ?? null;
		}
		getItem(k: string) {
			return this.m.get(k) ?? null;
		}
		setItem(k: string, v: string) {
			this.m.set(k, String(v));
		}
		removeItem(k: string) {
			this.m.delete(k);
		}
		clear() {
			this.m.clear();
		}
	}

	// The walls go up before anything of the app runs.
	Object.defineProperty(window, "WebSocket", {
		value: FakeSocket,
		configurable: true,
		writable: true,
	});
	let vh: VirtualHistory | null = null;
	let focusTold = false;
	installGuards(window, {
		realFocus: () => {
			if (focusTold) return;
			focusTold = true;
			queueMicrotask(() => {
				focusTold = false;
			});
			post({ type: "focused" });
		},
		// A fragment link or location.hash: a push on the virtual stack, in the same
		// task queue as traversals, and its hashchange.
		hashNav: (url) =>
			vh?.later(() => {
				const from = location.href;
				vh?.push(null, url);
				window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: from, newURL: url }));
			}),
	});
	vh = installHistory(window, allowNavigation);
	const history = vh;
	// An opaque origin has no storage and no cookies: they throw. The app gets them in memory.
	const memory = (seed: Record<string, string>) => {
		for (const name of ["localStorage", "sessionStorage"]) {
			try {
				Object.defineProperty(window, name, {
					value: new MemoryStorage(name === "localStorage" ? seed : {}),
					configurable: true,
				});
			} catch {}
		}
	};
	memory({});
	const jar = new Map<string, string>();
	try {
		Object.defineProperty(Document.prototype, "cookie", {
			configurable: true,
			get: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
			set: (v: string) => {
				const [pair = ""] = String(v).split(";");
				const at = pair.indexOf("=");
				if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
			},
		});
	} catch {}
	// Focus is pretended, so nothing the app focuses takes focus off the page around it.
	installFocus();
	// Nor scrolls the page around it, by scrollIntoView or by an edit. The edits left
	// to the browser's editor tell the host, which holds its own scroll still.
	installScroll(() => post({ type: "hold" }));
	// And text is edited by hand: Firefox's editor scrolls the page to its caret.
	installEdit();
	// The page going away ends the take; the host replaces it. Into the back/forward
	// cache with the whole tab is not going away: it comes back as it was.
	// A navigation always asks to unload first, in every engine; a frame the host
	// takes out of the document doesn't. So a pagehide with no beforeunload before it
	// is the host recycling the take, not the take leaving.
	let unloading = false;
	window.addEventListener("pagehide", (e) => {
		if (!e.persisted && !unloading) post({ type: "gone", why: "teardown" });
	});
	// Earlier: a navigation the frame starts (a link, location.href, assign, reload)
	// asks to unload before it goes anywhere. The host takes the frame out of the
	// document then, so the navigation never commits.
	window.addEventListener("beforeunload", () => {
		unloading = true;
		post({ type: "gone", why: "beforeunload" });
	});
	// A real fragment change or traversal: where the guard can't cancel one (no
	// Navigation API), the take has left the log; the host replaces it.
	for (const type of ["hashchange", "popstate"] as const) {
		window.addEventListener(type, (e) => {
			if (e.isTrusted) post({ type: "gone", why: type });
		});
	}
	// Nothing is selected but what the replay is editing.
	installSelection();

	// Time the take was playing on a visible page: deadlines count only that, so a
	// paused, off screen or hidden take trips none. The host says when it plays.
	let running = false;
	let counted = 0;
	let since = -1;
	const recount = () => {
		const now = performance.now();
		if (since >= 0) counted += now - since;
		since = running && !document.hidden ? now : -1;
	};
	document.addEventListener("visibilitychange", recount);
	const active = () => counted + (since >= 0 ? performance.now() - since : 0);

	// DOM changes, counted for settling and signalled to a waiting precondition.
	let mutations = 0;
	let changed: (() => void) | null = null;
	const wake = () => {
		const c = changed;
		changed = null;
		c?.();
	};
	new MutationObserver(() => {
		mutations++;
		wake();
	}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

	// A task of its own, as a browser gives each socket message and input event.
	// Not setTimeout: nested, that waits at least 4ms a turn.
	const channel = new MessageChannel();
	const waiting: (() => void)[] = [];
	channel.port1.onmessage = () => waiting.shift()?.();
	const task = () =>
		new Promise<void>((r) => {
			waiting.push(r);
			channel.port2.postMessage(null);
		});
	/** `n` tasks queued at once, so nothing the page queues meanwhile runs between them. */
	const tasks = (n: number, each: (k: number) => boolean) =>
		new Promise<void>((r) => {
			let k = 0;
			let done = false;
			const run = () => {
				if (done) return;
				const go = each(k++);
				if (!go || k === n) {
					done = true;
					r();
				}
			};
			for (let j = 0; j < n; j++) {
				waiting.push(run);
				channel.port2.postMessage(null);
			}
		});
	const frame = () =>
		new Promise<void>((r) => {
			const done = () => {
				clearTimeout(timer);
				cancelAnimationFrame(raf);
				r();
			};
			const raf = requestAnimationFrame(done);
			const timer = setTimeout(done, FRAME_MAX_MS);
		});
	/**
	 * Quiet for two frames running: a framework that commits a frame later (React's
	 * deferred and concurrent renders) has had its turn. Bounded in wall time, so a
	 * page that never goes quiet (an animation) can't hold the take.
	 */
	const settle = async () => {
		const start = performance.now();
		await task();
		let quiet = 0;
		while (quiet < 2) {
			const n = mutations;
			await frame();
			quiet = mutations === n ? quiet + 1 : 0;
			if (performance.now() - start > SETTLE_MAX_MS) break;
		}
		// A backstop for a selection that got past the guards.
		dropStray();
	};
	const change = () =>
		new Promise<void>((r) => {
			const done = () => {
				clearTimeout(timer);
				changed = null;
				r();
			};
			changed = done;
			const timer = setTimeout(done, POLL_MS);
		});

	const boot = (
		scene: Scene,
		withInput: boolean,
		waive: number[],
		watch: number[],
		patience: number,
	) => {
		const targets = T;
		const style = document.createElement("style");
		style.dataset.tape = "unselectable";
		style.textContent = UNSELECTABLE;
		document.head.appendChild(style);
		const input = withInput
			? new InputPlayer(
					document,
					scene.log.some((e) => e.k === "keypress"),
					targets,
				)
			: null;
		installPseudo(document);

		// The take's randomness and clock, so ids the app mints match the ones in the frames.
		const rnd: Randomness = installRandom(window, scene.meta.seed);
		const epoch = scene.meta.epoch;
		/** The clock while an entry is handled, as it read in the take. */
		let pinned: number | null = null;
		installClock(window, () => pinned ?? Math.round(epoch + Math.max(0, exec?.pos ?? 0)));

		memory(scene.storage.local);
		// With input, the log says when the app's back and forward land.
		history.hold = withInput;
		try {
			history.reset(scene.meta.path || "/");
		} catch (err) {
			// WebKit won't move an opaque origin's url off its path: the app would read the
			// wrong one. The host runs takes same origin from here on.
			if (window.origin === "null") {
				post({ type: "origin" });
				return;
			}
			throw err;
		}

		/** Payloads, decoded once. */
		const payloads = new Map<number, string | Uint8Array>();
		const payload = (e: Extract<Entry, { k: "msg" }>, i: number) => {
			let p = payloads.get(i);
			if (p === undefined) {
				p = e.x ? e.d : base64ToBytes(e.d);
				payloads.set(i, p);
			}
			return p;
		};

		/** The app's url changes checked so far. */
		let navs = 0;
		const focusPath = () => {
			const el = activeElement();
			return el ? targets.pathOf(el) : null;
		};
		/** The element a button entry acts on: the recorded one, checked, or nothing. */
		const targetOf = (h: Target) => {
			const el = targets.resolve(h.p);
			return targets.matches(el, h) ? el : null;
		};
		/** Presses and their drags, replayed relative to the element that holds each. */
		const gesture = gestures(scene.log);
		let held: { g: Gesture; box: [number, number, number, number] } | null = null;
		/** `e`, its point mapped through its gesture's box, if it is part of one. */
		type Pointed = Extract<
			Entry,
			{ k: "move" | "down" | "up" | "click" | "dblclick" | "contextmenu" }
		>;
		const placed = <E extends Pointed>(e: E, i: number): E => {
			const g = gesture.get(i);
			if (!g) return e;
			if (g.down === i && e.k === "down") {
				held = null;
				const el = targets.resolve(ancestorPath(e.h.p, g.depth));
				const r = el?.getBoundingClientRect();
				if (r && r.width > 0 && r.height > 0) held = { g, box: [r.left, r.top, r.width, r.height] };
			}
			if (!held || held.g !== g) return e;
			const [x, y] = mapPoint(e.x, e.y, g.box, held.box);
			return { ...e, x, y };
		};
		ledger = new SendLedger(
			scene.log.flatMap((e) => (e.k === "send" ? [[e.s, e.h] as [number, number]] : [])),
		);
		const sends = ledger;
		/** The focused field, if focus is on one. */
		const focusedField = () => {
			const el = activeElement();
			return isField(el) ? el : null;
		};
		/**
		 * Focus, value and selection are what a default action did, recorded in the
		 * middle of it, so their paths can be a step behind the replay, which did the
		 * action by hand already. They act on what the replay focused, and correct
		 * only what differs.
		 */
		const focusTo = (h: Target) => {
			const el = targets.resolve(h.p);
			if (targets.matches(el, h)) return el;
			// Focused already on what it recorded, wherever that is now: nothing to correct.
			return targets.alike(activeElement(), h) ? activeElement() : null;
		};
		/** The field a value or selection goes to: the focused one, if it is the one recorded. */
		const typedInto = (h: Target) => {
			const el = focusedField();
			return el && targets.alike(el, h) ? el : null;
		};

		const deps: ExecutorDeps = {
			log: scene.log,
			waive: new Set(waive),
			watch: new Set(watch),
			// A take that follows failed ones waits longer before it gives up.
			limits: { pre: LIMITS.pre * patience, open: LIMITS.open * patience },
			passed: (at) => post({ type: "passed", at }),

			ready(e) {
				switch (e.k) {
					case "send":
						// Frames only: nothing replays what made the app send, so data isn't held for it.
						return !input || sends.has(e.s, e.h);
					case "open": {
						const ws = live[e.s];
						return (
							!!ws && ws.path === new URL(scene.sockets[e.s]?.url ?? "/", location.href).pathname
						);
					}
					case "msg":
					case "close":
					case "move":
					case "out":
						return true;
					case "nav":
						if (e.by === "user" || !input) return true;
						// The app's own back or forward: it has asked, and the replay performs it here.
						if (e.mode === "pop" && history.find(e.path, navs) < 0) return history.pending > 0;
						return history.find(e.path, navs) >= 0;
				}
				if (!input) return true;
				if (isPointerButton(e)) return targets.matches(targets.resolve(e.h.p), e.h);
				switch (e.k) {
					case "keydown":
					case "keypress":
					case "keyup":
						return focusPath() === e.f;
					case "scroll":
						return !!input.scroller(e.p);
					case "value":
					case "sel":
						return !!typedInto(e.h);
					case "focus":
						return e.h === null || !!focusTo(e.h);
					case "range":
						return !!targets.resolveNode(e.a[0]) && !!targets.resolveNode(e.b[0]);
				}
				return true;
			},
			why(e, i) {
				const at = `entry ${i} (${e.k} at ${e.t}ms)`;
				if (e.k === "open") return `${at}: the app never opened ${scene.sockets[e.s]?.url}`;
				if (e.k === "nav")
					return `${at}: the app never went to ${e.path}, it is at ${history.path}`;
				if (e.k === "send") {
					const last =
						sends.lastExtra && sends.lastExtra !== sends.firstExtra
							? `, latest on ${sends.lastExtra}`
							: "";
					const extra = sends.firstExtra
						? `; it sent ${sends.extra} the take never did, first on ${sends.firstExtra}${last}`
						: "";
					const d = e.d ? `: ${e.d.slice(0, 600)}` : "";
					return `${at}: the app never sent what it sent in the take${d}${extra}`;
				}
				if (isPointerButton(e)) {
					const el = targets.resolve(e.h.p);
					return `${at}: wanted <${e.h.n}> at ${e.h.p}, found ${el ? `<${el.localName}>` : "nothing"}${el?.localName === e.h.n ? " with other text" : ""}`;
				}
				if (e.k === "keydown" || e.k === "keypress" || e.k === "keyup") {
					return `${at}: wanted focus on ${e.f ?? "nothing"}, it is on ${focusPath() ?? "nothing"}`;
				}
				return `${at}: its element is missing`;
			},
			apply(e, i) {
				switch (e.k) {
					case "send":
						if (input) sends.claim(e.s, e.h);
						return;
					case "open":
						live[e.s]?.open();
						return;
					case "msg":
						live[e.s]?.deliver(payload(e, i));
						return;
					case "close":
						live[e.s]?.end(e.c, e.c === 1000);
						return;
					case "nav": {
						if (e.by === "user") {
							history.traverseTo(e.path);
							navs = history.changes.length;
						} else if (input) {
							if (e.mode === "pop" && history.find(e.path, navs) < 0) history.traverseAsked();
							const found = history.find(e.path, navs);
							if (found >= 0) navs = found + 1;
						} else {
							// Frames only: nothing replays the click that navigated, so the url is set here.
							if (e.mode === "pop") history.traverseTo(e.path);
							else {
								if (e.mode === "push") history.push(null, e.path);
								else history.replace(null, e.path);
								window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
							}
							navs = history.changes.length;
						}
						return;
					}
				}
				if (!input) return;
				replaying.on = true;
				try {
					if (isPointerButton(e)) input.play(placed(e, i), targetOf(e.h));
					else if (e.k === "move") input.play(placed(e, i));
					else if (e.k === "focus") input.play(e, e.h && focusTo(e.h));
					else if (e.k === "value" || e.k === "sel") input.play(e, typedInto(e.h));
					else input.play(e);
				} finally {
					replaying.on = false;
				}
			},
			enter(e) {
				if (e.r !== undefined) rnd.seek(e.r);
				pinned = e.w ?? null;
			},
			leave() {
				pinned = null;
			},
			task,
			tasks,
			work: () => mutations,
			settle,
			change,
			now: active,
			report: (r) => post({ type: "pos", ...r }),
			fail: (at, reason) => post({ type: "fail", at, reason }),
			idle: () => input?.hover(),
		};
		exec = new Executor(deps);

		for (const d of deferred) {
			const el = document.createElement("script");
			for (const [k, v] of d.attrs) el.setAttribute(k, v);
			el.type = "module";
			el.src = d.src;
			document.head.appendChild(el);
		}
		if (until > Number.NEGATIVE_INFINITY) exec.setUntil(until);
	};

	let booted = false;
	let until = Number.NEGATIVE_INFINITY;
	window.addEventListener("message", (ev) => {
		if (ev.source !== window.parent || !isTape<ToShim>(ev.data)) return;
		const m = ev.data;
		if (m.type === "run") {
			running = m.on;
			recount();
		} else if (m.type === "scene" && !booted) {
			booted = true;
			try {
				boot(m.scene, m.input, m.waive, m.watch, m.patience ?? 1);
			} catch (err) {
				post({
					type: "fail",
					at: null,
					reason: `boot: ${err instanceof Error ? err.message : err}`,
				});
			}
		} else if (m.type === "until") {
			until = Math.max(until, m.t);
			exec?.setUntil(m.t);
		}
	});

	const hello = () => {
		collect();
		post({ type: "hello" });
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello);
	else hello();
})();
