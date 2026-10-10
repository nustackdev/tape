// The script the recorder puts at the top of every page it serves. It reports
// what the server can't see: the viewport, localStorage at load, the pointer
// and client side navigation. It opens its own socket to the recorder and
// never touches the app's.
//
// Kept as plain browser JS in a string so it ships exactly as written.

export const INJECT_PATH = "/__tape/inject.js";
export const EVENTS_PATH = "/__tape/events";

export const INJECT_SCRIPT = `(() => {
	if (window.__tapeRecorder) return;
	window.__tapeRecorder = true;
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
	send({ type: "hello", url: location.href, path: here(), viewport: viewport(), userAgent: navigator.userAgent, local });

	let x = -1, y = -1, queued = false;
	addEventListener("pointermove", (e) => {
		x = e.clientX; y = e.clientY;
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => { queued = false; send({ type: "p", k: 0, x, y }); });
	}, { capture: true, passive: true });
	addEventListener("pointerdown", (e) => send({ type: "p", k: 1, x: e.clientX, y: e.clientY }), true);
	addEventListener("pointerup", (e) => send({ type: "p", k: 2, x: e.clientX, y: e.clientY }), true);
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
