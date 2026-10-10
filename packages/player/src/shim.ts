// The shim. Runs first inside the replay iframe, before the app.
//
// It swaps window.WebSocket for a fake that plays the recorded server frames,
// gives the app a private localStorage seeded from the take, puts the page on
// the recorded path, and only then starts the app's module scripts (`tape
// bundle` made them inert). After that it waits for ticks from the parent and
// delivers whatever is due: server frames, and the recorded input as DOM
// events (./input.ts). What the app sends goes nowhere.

import {
	base64ToBytes,
	installClock,
	installRandom,
	type Randomness,
	type Scene,
	type SceneFrame,
} from "@nustackdev/tape-scene";
import { installFocus } from "./focus";
import { InputPlayer } from "./input";
import { type Body, isTape, TAG, type ToParent, type ToShim } from "./protocol";
import { installPseudo } from "./pseudo";
import { installScroll } from "./scroll";

const DEFERRED_TYPE = "text/x-tape-module";

declare global {
	interface Window {
		/** Where the replay is, for tests and debugging. */
		__tapeShim?: { readonly now: number };
	}
}

(() => {
	if (window.__tapeShim) return;
	window.__tapeShim = {
		get now() {
			return now;
		},
	};

	const post = (m: Body<ToParent>) => window.parent.postMessage({ tape: TAG, ...m }, "*");

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

	let scene: Scene | null = null;
	let now = Number.NEGATIVE_INFINITY;
	/** Recorded sockets the app has not claimed yet, by url. */
	const unclaimed = new Map<string, number[]>();
	/** Frames per recorded socket, payload decoded once. */
	let byS: { frame: SceneFrame; data: string | Uint8Array }[][] = [];
	const live: FakeSocket[] = [];
	let opened = false;
	let painted = false;

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
		readyState = 0;
		binaryType: BinaryType = "blob";
		bufferedAmount = 0;
		extensions = "";
		protocol = "";
		onopen: ((ev: Event) => void) | null = null;
		onmessage: ((ev: MessageEvent) => void) | null = null;
		onclose: ((ev: CloseEvent) => void) | null = null;
		onerror: ((ev: Event) => void) | null = null;

		/** Which recorded socket this plays, -1 until claimed. */
		rec = -1;
		next = 0;
		private key: string;

		constructor(url: string | URL, _protocols?: string | string[]) {
			super();
			const u = new URL(String(url), location.href);
			this.url = u.href;
			this.key = u.pathname + u.search;
			live.push(this);
			this.claim();
		}

		claim() {
			if (this.rec >= 0 || !scene || this.readyState === 3) return;
			const queue = unclaimed.get(this.key);
			const rec = queue?.shift();
			if (rec === undefined) return;
			this.rec = rec;
			if (!opened) {
				opened = true;
				post({ type: "open" });
			}
			void pump();
		}

		/** When this socket's next step is due: its open, its next frame or its close. */
		due(): number | null {
			if (!scene || this.rec < 0 || this.readyState >= 2) return null;
			const rec = scene.sockets[this.rec];
			if (!rec) return null;
			if (this.readyState === 0) return rec.open;
			const item = byS[this.rec]?.[this.next];
			if (item) return item.frame.t;
			return rec.close ?? null;
		}

		/** Take the step `due` named. */
		step() {
			const rec = scene?.sockets[this.rec];
			if (!rec || this.readyState >= 2) return;
			if (this.readyState === 0) {
				this.readyState = 1;
				this.fire(new Event("open"));
				return;
			}
			const item = byS[this.rec]?.[this.next];
			if (!item) {
				this.end(rec.code ?? 1006, false);
				return;
			}
			this.next++;
			this.fire(new MessageEvent("message", { data: this.payload(item.data) }));
			if (!painted) {
				painted = true;
				requestAnimationFrame(() => requestAnimationFrame(() => post({ type: "painted" })));
			}
		}

		private payload(data: string | Uint8Array): string | ArrayBuffer | Blob {
			if (typeof data === "string") return data;
			const copy = data.slice().buffer;
			return this.binaryType === "arraybuffer" ? copy : new Blob([copy]);
		}

		private fire(ev: Event) {
			const handler = (this as unknown as Record<string, unknown>)[`on${ev.type}`];
			if (typeof handler === "function") handler.call(this, ev);
			this.dispatchEvent(ev);
		}

		private end(code: number, clean: boolean) {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.fire(new CloseEvent("close", { code, wasClean: clean }));
		}

		send(_data: unknown) {
			if (this.readyState === 0) throw new DOMException("still connecting", "InvalidStateError");
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

	Object.defineProperty(window, "WebSocket", {
		value: FakeSocket,
		configurable: true,
		writable: true,
	});
	// Before the app runs, so nothing it focuses can take focus off the page around it.
	installFocus();
	// Nor scroll the page around it.
	installScroll();
	// A replayed click or submit must never navigate the replay away. Bubble phase on
	// window runs last, so the app's own handlers had their say.
	window.addEventListener("click", (e) => {
		if (!e.isTrusted && !e.defaultPrevented && (e.target as Element)?.closest?.("a[href]")) {
			e.preventDefault();
		}
	});
	window.addEventListener("submit", (e) => e.preventDefault());

	/** How long recorded navigation waits for the replayed input to cause it before forcing it. */
	const NAV_GRACE_MS = 300;
	let input: InputPlayer | null = null;
	let rnd: Randomness | null = null;
	/** The clock while a replayed event is handled, as it read in the take. */
	let pinned: number | null = null;
	let pumping = false;
	let ev = 0;
	let ptr = -1;

	const boot = (s: Scene, withInput: boolean) => {
		scene = s;
		if (withInput && s.events?.length)
			input = new InputPlayer(
				document,
				s.events.some((e) => e.k === "keypress"),
			);
		installPseudo(document);
		// The take's randomness and clock, so ids the app mints match the ones in the frames.
		if (s.meta.seed !== undefined && s.meta.epoch !== undefined) {
			rnd = installRandom(window, s.meta.seed);
			const epoch = s.meta.epoch;
			installClock(window, () => pinned ?? Math.round(epoch + Math.max(0, now)));
		}
		byS = s.sockets.map(() => []);
		for (const frame of s.frames) {
			byS[frame.s]?.push({ frame, data: frame.x ? frame.d : base64ToBytes(frame.d) });
		}
		s.sockets.forEach((sock, i) => {
			const q = unclaimed.get(sock.url) ?? [];
			q.push(i);
			unclaimed.set(sock.url, q);
		});
		try {
			Object.defineProperty(window, "localStorage", {
				value: new MemoryStorage(s.storage.local),
				configurable: true,
			});
		} catch {}
		try {
			history.replaceState(null, "", s.meta.path || "/");
		} catch {}
		nav = 0;
		for (const d of deferred) {
			const el = document.createElement("script");
			for (const [k, v] of d.attrs) el.setAttribute(k, v);
			el.type = "module";
			el.src = d.src;
			document.head.appendChild(el);
		}
		for (const ws of live) ws.claim();
	};

	// A task of its own, as a browser gives each socket message and input event.
	// Not setTimeout: nested, that waits at least 4ms a turn.
	const channel = new MessageChannel();
	const waiting: (() => void)[] = [];
	channel.port1.onmessage = () => waiting.shift()?.();
	const nextTask = () =>
		new Promise<void>((r) => {
			waiting.push(r);
			channel.port2.postMessage(null);
		});

	/**
	 * Play everything due, one task each, in the order of the take: server
	 * frames, input events and pointer moves on one timeline. The app's
	 * decisions hang on that order (did the key land before the frame that
	 * mounted the editor?), so a slow tick must not batch one kind ahead of
	 * the other.
	 *
	 * The recorder held the clock until the task after an event, so whatever
	 * the event set off (microtasks, a framework's batched render) saw the
	 * pinned time; the replay does the same.
	 */
	const pump = async () => {
		if (pumping || !scene) return;
		pumping = true;
		try {
			const events = scene.events ?? [];
			const track = scene.pointer;
			for (;;) {
				let sock: FakeSocket | null = null;
				let at = Number.POSITIVE_INFINITY;
				for (const ws of live) {
					const d = ws.due();
					if (d !== null && d <= now && d < at) {
						at = d;
						sock = ws;
					}
				}
				// Input waits for the app's first socket: before that there is nothing on screen to act on.
				const e = input && opened ? events[ev] : undefined;
				const p = input && opened ? track[ptr + 1] : undefined;
				if (p && p[0] <= now && p[0] < at && !(e && e.t <= p[0])) {
					ptr++;
					if (p[3] !== 3) input?.move(p[1], p[2]);
					continue;
				}
				if (e && e.t <= now && e.t < at) {
					ev++;
					if (rnd && e.r !== undefined) rnd.seek(e.r);
					pinned = e.w ?? null;
					input?.play(e);
					await nextTask();
					pinned = null;
					continue;
				}
				if (!sock) break;
				sock.step();
				await nextTask();
			}
		} finally {
			pumping = false;
		}
	};

	let nav = 0;
	const tick = (t: number) => {
		if (!scene) return;
		now = t;
		void pump();
		// Hover follows the page changing under a pointer that stands still.
		if (!pumping) input?.hover();
		while (nav < scene.nav.length) {
			const n = scene.nav[nav];
			// With input, the replayed click usually navigates by itself. Recorded nav is the fallback.
			if (!n || n.t + (input ? NAV_GRACE_MS : 0) > now) break;
			nav++;
			if (location.pathname + location.search + location.hash === n.path) continue;
			try {
				if (n.mode === "replace") history.replaceState(null, "", n.path);
				else history.pushState(null, "", n.path);
				window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
			} catch {}
		}
	};

	window.addEventListener("message", (ev) => {
		if (ev.source !== window.parent || !isTape<ToShim>(ev.data)) return;
		const m = ev.data;
		if (m.type === "scene" && !scene) boot(m.scene, m.input);
		else if (m.type === "tick") tick(m.t);
	});

	const hello = () => {
		collect();
		post({ type: "hello" });
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello);
	else hello();
})();
