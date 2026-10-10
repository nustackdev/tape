// The script the recorder puts at the top of every page it serves. It reports
// what the server can't see: the viewport, localStorage at load, the pointer,
// client side navigation, and input (buttons, keys, scrolls, field values) so
// local UI replays too. It opens its own socket to the recorder and
// never touches the app's.
//
// Kept as plain browser JS in a string so it ships exactly as written. The
// determinism helpers come in as source, the same code the player runs.

import { installClock, installRandom } from "@nustackdev/tape-scene";

export const INJECT_PATH = "/__tape/inject.js";
export const EVENTS_PATH = "/__tape/events";

export const INJECT_SCRIPT = `(() => {
	if (window.__tapeRecorder) return;
	window.__tapeRecorder = true;

	// Shared randomness, and a clock that holds still while an input event is handled.
	const seed = (Math.random() * 4294967296) >>> 0;
	const rnd = (${installRandom.toString()})(window, seed);
	const realNow = Date.now.bind(Date);
	let pinned = null;
	(${installClock.toString()})(window, () => pinned ?? realNow());
	const pin = () => {
		if (pinned === null) {
			pinned = realNow();
			setTimeout(() => { pinned = null; });
		}
		return pinned;
	};

	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(proto + "//" + location.host + "${EVENTS_PATH}");
	const queue = [];
	const send = (m) => {
		const s = JSON.stringify(m);
		if (ws.readyState === 1) ws.send(s);
		else queue.push(s);
	};
	ws.addEventListener("open", () => {
		for (const s of queue) ws.send(s);
		queue.length = 0;
	});
	const here = () => location.pathname + location.search + location.hash;
	const local = {};
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k !== null) local[k] = localStorage.getItem(k);
		}
	} catch {}
	const viewport = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
	send({ type: "hello", url: location.href, path: here(), viewport: viewport(), userAgent: navigator.userAgent, local, seed, now: realNow() });

	let x = -1, y = -1, queued = false;
	addEventListener("pointermove", (e) => {
		x = e.clientX; y = e.clientY;
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => { queued = false; send({ type: "p", k: 0, x, y }); });
	}, { capture: true, passive: true });
	addEventListener("pointerdown", (e) => send({ type: "p", k: 1, x: e.clientX, y: e.clientY }), true);
	addEventListener("pointerup", (e) => send({ type: "p", k: 2, x: e.clientX, y: e.clientY }), true);

	const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
	const pathOf = (el) => {
		const parts = [];
		while (el && el !== document.documentElement && el.parentElement) {
			parts.unshift([...el.parentElement.children].indexOf(el));
			el = el.parentElement;
		}
		return parts.join("/");
	};
	// Draws are counted before pinning, so the replay seeks to the same point before the same event.
	const ev = (m) => {
		const r = rnd.draws();
		send({ type: "e", e: { ...m, w: pin(), r } });
	};
	const button = (k) => (e) => {
		if (e.isTrusted) ev({ k, x: e.clientX, y: e.clientY, b: e.button, m: mods(e) });
	};
	// Pointer, not mouse: a handler cancelling pointerdown makes the browser skip the mouse events.
	addEventListener("pointerdown", button("down"), true);
	addEventListener("pointerup", button("up"), true);
	addEventListener("click", button("click"), true);
	addEventListener("dblclick", button("dblclick"), true);
	addEventListener("contextmenu", button("contextmenu"), true);
	const key = (k) => (e) => {
		if (!e.isTrusted || e.isComposing) return;
		ev({ k, key: e.key, code: e.code, m: mods(e), ...(e.repeat ? { rep: 1 } : {}) });
	};
	addEventListener("keydown", key("keydown"), true);
	addEventListener("keypress", key("keypress"), true);
	addEventListener("keyup", key("keyup"), true);
	const scrolled = new Map();
	addEventListener("scroll", (e) => {
		const el = e.target === document ? document.scrollingElement : e.target;
		if (!el || scrolled.has(el)) return;
		scrolled.set(el, true);
		requestAnimationFrame(() => {
			scrolled.delete(el);
			ev({ k: "scroll", p: el === document.scrollingElement ? "" : pathOf(el), x: el.scrollLeft, y: el.scrollTop });
		});
	}, { capture: true, passive: true });
	addEventListener("input", (e) => {
		const el = e.target;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			ev({ k: "value", p: pathOf(el), v: el.value });
		}
	}, true);
	document.documentElement.addEventListener("mouseleave", () => send({ type: "p", k: 3, x, y }));

	for (const [name, mode] of [["pushState", "push"], ["replaceState", "replace"]]) {
		const original = history[name];
		history[name] = function (...args) {
			const out = original.apply(this, args);
			send({ type: "nav", mode, path: here() });
			return out;
		};
	}
	addEventListener("popstate", () => send({ type: "nav", mode: "pop", path: here() }));
	addEventListener("resize", () => send({ type: "resize", viewport: viewport() }));
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
