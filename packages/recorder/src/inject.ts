// The script the recorder puts at the top of every page it serves. It writes
// the take's log from inside the page: the app's socket traffic as the app
// sees it, the pointer, keys, scrolls, field values, focus, selection and
// navigation, each stamped with the page's own clock, all in the order the
// page handled them. One channel to the recorder carries it all, in order, so
// the scene's order is the browser's order.
//
// Each input also records what the replay checks before it acts: the element
// a button event landed on, the element that had focus for a key.
//
// Kept as plain browser JS in a string so it ships exactly as written. The
// determinism and target helpers come in as source, the same code the player
// runs.

import { installClock, installRandom, installTargets } from "@nustackdev/tape-scene";

export const INJECT_PATH = "/__tape/inject.js";
export const EVENTS_PATH = "/__tape/events";

export const INJECT_SCRIPT = `(() => {
	// The page itself, not frames inside it.
	if (window.__tapeRecorder || window !== window.top) return;
	window.__tapeRecorder = true;

	// Shared randomness, and a clock that holds still while an entry is handled.
	const seed = (Math.random() * 4294967296) >>> 0;
	const rnd = (${installRandom.toString()})(window, seed);
	const realNow = Date.now.bind(Date);
	let pinned = null;
	(${installClock.toString()})(window, () => pinned ?? realNow());
	// Held until the next task, so what the entry set off sees it too. The replay does the same.
	const pin = () => {
		if (pinned === null) {
			pinned = realNow();
			setTimeout(() => { pinned = null; });
		}
		return pinned;
	};
	const T = (${installTargets.toString()})(document);

	const RealSocket = window.WebSocket;
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const chan = new RealSocket(proto + "//" + location.host + "${EVENTS_PATH}");
	const early = [];
	chan.addEventListener("open", () => {
		for (const s of early) chan.send(s);
		early.length = 0;
	});
	const ship = (m) => {
		const s = JSON.stringify(m);
		if (chan.readyState === 1) chan.send(s);
		else early.push(s);
	};

	// Out in the order the page handled them. One whose payload is still being read holds the rest.
	const outbox = [];
	const flush = () => {
		while (outbox.length && outbox[0].ready) ship(outbox.shift().m);
	};
	const queue = (m, ready) => {
		const item = { m, ready };
		outbox.push(item);
		flush();
		return item;
	};
	const now = () => Math.round(performance.now() * 10) / 10;
	let moved = null;
	const flushMove = () => {
		if (!moved) return;
		const p = moved;
		moved = null;
		entry({ k: "move", x: p.x, y: p.y });
	};
	// Draws are counted before pinning, so the replay seeks to the same point before the same entry.
	const entry = (e, held, ready = true) => {
		if (e.k !== "move") flushMove();
		const r = rnd.draws();
		const stamp = held ? { t: now(), r, w: pin() } : { t: now(), r };
		return queue({ type: "e", e: { ...stamp, ...e } }, ready);
	};

	const here = () => location.pathname + location.search + location.hash;
	const local = {};
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k !== null) local[k] = localStorage.getItem(k);
		}
	} catch {}
	const viewport = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
	ship({
		type: "hello",
		url: location.href,
		path: here(),
		viewport: viewport(),
		userAgent: navigator.userAgent,
		local,
		seed,
		epoch: realNow() - performance.now(),
	});

	// The app's sockets: every message as the app gets it, just before its own handlers.
	const b64 = (buf) => {
		const bytes = new Uint8Array(buf);
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(bin);
	};
	let sockets = 0;
	class TapeSocket extends RealSocket {
		constructor(url, protocols) {
			super(url, protocols);
			const s = sockets++;
			const u = new URL(String(url), location.href);
			queue({ type: "sock", s, url: u.pathname + u.search }, true);
			let asked = false;
			this.addEventListener("open", () => entry({ k: "open", s }, true));
			this.addEventListener("message", (ev) => {
				const d = ev.data;
				if (typeof d === "string") {
					entry({ k: "msg", s, d, x: 1 }, true);
				} else if (d instanceof ArrayBuffer) {
					entry({ k: "msg", s, d: b64(d) }, true);
				} else {
					const item = entry({ k: "msg", s, d: "" }, true, false);
					d.arrayBuffer()
						.then((buf) => { item.m.e.d = b64(buf); })
						.catch(() => {})
						.finally(() => { item.ready = true; flush(); });
				}
			});
			// A close the app asked for replays by itself; only the server's is the take's.
			this.addEventListener("close", (ev) => {
				if (!asked) entry({ k: "close", s, c: ev.code }, true);
			});
			const close = this.close;
			this.close = function (...a) {
				asked = true;
				return close.apply(this, a);
			};
			// What the app sends: the replay waits for the replayed app to send it before
			// it hands over what the server said next.
			const send = this.send;
			this.send = function (data) {
				const out = send.call(this, data);
				if (typeof data === "string") entry({ k: "send", s, h: T.digest(data), d: data, x: 1 }, false);
				else if (data instanceof Blob) {
					const item = entry({ k: "send", s, h: 0, d: "" }, false, false);
					data.arrayBuffer()
						.then((buf) => {
							const bytes = new Uint8Array(buf);
							item.m.e.h = T.digest(bytes);
							item.m.e.d = b64(bytes);
						})
						.catch(() => {})
						.finally(() => { item.ready = true; flush(); });
				} else {
					const bytes = ArrayBuffer.isView(data)
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
						: new Uint8Array(data);
					entry({ k: "send", s, h: T.digest(bytes), d: b64(bytes) }, false);
				}
				return out;
			};
		}
	}
	Object.defineProperty(window, "WebSocket", { value: TapeSocket, configurable: true, writable: true });

	// The pointer, once per frame.
	let queued = false;
	addEventListener("pointermove", (e) => {
		if (!e.isTrusted) return;
		moved = { x: e.clientX, y: e.clientY };
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			flushMove();
		});
	}, { capture: true, passive: true });
	document.documentElement.addEventListener("mouseleave", () => entry({ k: "out" }));

	const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
	// The element the event really landed on, read before any handler of the app changes it.
	const hit = (e) => {
		const first = e.composedPath ? e.composedPath()[0] : null;
		if (first instanceof Element && first.getRootNode() === document) return first;
		return e.target instanceof Element ? e.target : null;
	};
	// The boxes of an element and its ancestors, innermost first. Exact, never
	// rounded: the replay maps a gesture's points through them, and an app may
	// compute from those points to four decimals (a drawing pad). Rounded to
	// 0.001px, a top of 408.28125 moved the stroke 0.00025px, and that changed
	// points. Layout units are 1/64px or 1/60px, so the values stay short.
	const boxes = (el) => {
		const out = [];
		for (let x = el; x && x !== document.documentElement; x = x.parentElement) {
			const r = x.getBoundingClientRect();
			out.push([r.left, r.top, r.width, r.height]);
		}
		return out;
	};
	const button = (k) => (e) => {
		if (!e.isTrusted) return;
		const el = hit(e);
		if (!el) return;
		const at = { k, x: e.clientX, y: e.clientY, b: e.button, m: mods(e), h: T.describe(el) };
		if (k === "down") at.bx = boxes(el);
		entry(at, true);
	};
	// Pointer, not mouse: a handler cancelling pointerdown makes the browser skip the mouse events.
	addEventListener("pointerdown", button("down"), true);
	addEventListener("pointerup", button("up"), true);
	addEventListener("click", button("click"), true);
	addEventListener("dblclick", button("dblclick"), true);
	addEventListener("contextmenu", button("contextmenu"), true);

	const focused = () => {
		const a = document.activeElement;
		return a && a !== document.body && a !== document.documentElement ? T.pathOf(a) : null;
	};
	const key = (k) => (e) => {
		if (!e.isTrusted || e.isComposing) return;
		entry({ k, key: e.key, code: e.code, m: mods(e), ...(e.repeat ? { rep: 1 } : {}), f: focused() }, true);
	};
	addEventListener("keydown", key("keydown"), true);
	addEventListener("keypress", key("keypress"), true);
	addEventListener("keyup", key("keyup"), true);

	const scrolled = new Set();
	addEventListener("scroll", (e) => {
		const el = e.target === document ? document.scrollingElement : e.target;
		if (!(el instanceof Element) || scrolled.has(el)) return;
		scrolled.add(el);
		requestAnimationFrame(() => {
			scrolled.delete(el);
			if (!el.isConnected) return;
			entry({ k: "scroll", p: el === document.scrollingElement ? "" : T.pathOf(el), x: el.scrollLeft, y: el.scrollTop });
		});
	}, { capture: true, passive: true });

	const isField = (el) =>
		el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.selectionStart !== null);
	addEventListener("input", (e) => {
		const el = e.target;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			entry({ k: "value", h: T.describe(el), v: el.value });
		}
	}, true);

	// Focus: where the browser put it, so the replay needn't guess (Tab, a label, autofocus).
	addEventListener("focusin", (e) => {
		if (e.target instanceof Element) entry({ k: "focus", h: T.describe(e.target) });
	}, true);
	addEventListener("focusout", (e) => {
		// Off to nothing inside the page. The window losing focus is not the take's.
		if (e.relatedTarget === null && document.hasFocus()) entry({ k: "focus", h: null });
	}, true);

	// Selection, in a field or an editable, each time it changes.
	let lastSel = "";
	addEventListener("selectionchange", () => {
		const a = document.activeElement;
		let e = null;
		if (isField(a)) {
			e = { k: "sel", h: T.describe(a), a: a.selectionStart, b: a.selectionEnd };
		} else {
			const s = document.getSelection();
			const editable = (n) => {
				const el = n instanceof Element ? n : n && n.parentElement;
				return !!el && el.isContentEditable;
			};
			if (s && s.anchorNode && s.focusNode && editable(s.anchorNode) && editable(s.focusNode)) {
				const pa = T.nodePathOf(s.anchorNode);
				const pf = T.nodePathOf(s.focusNode);
				if (pa !== null && pf !== null) e = { k: "range", a: [pa, s.anchorOffset], b: [pf, s.focusOffset] };
			}
		}
		if (!e) return;
		const said = JSON.stringify(e);
		if (said === lastSel) return;
		lastSel = said;
		entry(e);
	}, true);

	// Navigation. The app's own goes in as it happens; a popstate nobody asked for is the
	// browser's back or forward button, which the replay performs.
	for (const [name, mode] of [["pushState", "push"], ["replaceState", "replace"]]) {
		const original = history[name];
		history[name] = function (...args) {
			const out = original.apply(this, args);
			entry({ k: "nav", path: here(), mode });
			return out;
		};
	}
	let traversals = 0;
	for (const name of ["back", "forward", "go"]) {
		const original = history[name];
		history[name] = function (...args) {
			if (name !== "go" || Number(args[0])) traversals++;
			return original.apply(this, args);
		};
	}
	addEventListener("popstate", () => {
		const byApp = traversals > 0;
		if (byApp) traversals--;
		entry({ k: "nav", path: here(), mode: "pop", ...(byApp ? {} : { by: "user" }) });
	});
	addEventListener("resize", () => ship({ type: "resize", viewport: viewport() }));
})();
`;

/** Put the inject script first in <head>, so it runs before anything of the app. */
export function injectInto(html: string): string {
	const tag = `<script src="${INJECT_PATH}"></script>`;
	const head = html.match(/<head[^>]*>/i);
	if (head?.index !== undefined) {
		const at = head.index + head[0].length;
		return html.slice(0, at) + tag + html.slice(at);
	}
	return tag + html;
}
