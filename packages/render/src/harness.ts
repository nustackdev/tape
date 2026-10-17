// The page a render runs in: the app's replay in an iframe at the recorded
// viewport, the cursor and clicks drawn over it, and a clock the renderer
// starts. Plain DOM, no framework: it only has to drive the shim and place two
// layers. The same protocol as the player's engine (see the player's
// KERNEL.md): the clock says how far the take may go, the shim says how far it
// got, and everything drawn and stamped is from the latter.
//
// The clock runs on wall time divided by `slow`, so a machine that captures
// few frames a second still gets a smooth take: the renderer slows the page's
// CSS animations by the same factor and plays the frames back that much faster.

/** The url hash key the take id travels in, as the player shim reads it. */
const TAKE_KEY = "tape-take";
/** The iframe's sandbox, as the player has it: an opaque origin. The server sends CORS headers for it. */
const SANDBOX = "allow-scripts allow-forms";
/** The clock runs at most this far ahead of what the take applied, ms of the take. */
const LEAD_MS = 250;

export interface HarnessConfig {
	/** Url of the bundle's index.html. */
	app: string;
	/** Url of the scene.json. */
	scene: string;
	/** localStorage laid over the take's, eg the app's theme. */
	storage: Record<string, string>;
	/** Replay recorded input too, not just server frames. */
	input: boolean;
	/** Html drawn at the pointer, its top left on the tip. Empty for none. */
	cursor: string;
	/** Html drawn centred on each click. Empty for none. */
	click: string;
	/** How long a click stays drawn, ms of the take. */
	clickMs: number;
	/** Extra css: style `.tape-cursor`, `.tape-click`, `[data-down="1"]`, `body`. */
	css: string;
	/** Class on <html>, eg "dark", for css that differs by theme. */
	theme: string;
}

export const TAKE = "render";

export function harnessHtml(cfg: HarnessConfig): string {
	const json = JSON.stringify(cfg).replaceAll("<", "\\u003c");
	return `<!doctype html>
<html class="${cfg.theme}">
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
#stage { position: absolute; left: 0; top: 0; overflow: hidden; }
#stage iframe { position: absolute; left: 0; top: 0; border: 0; display: block; pointer-events: none; color-scheme: normal; }
#clicks { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.tape-click-at { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.tape-click-at > * { position: absolute; }
#cursor { position: absolute; left: 0; top: 0; z-index: 3; pointer-events: none; opacity: 0; will-change: transform; }
${cfg.css}
</style>
</head>
<body>
<div id="stage"><div id="clicks"></div><div id="cursor"></div></div>
<script id="cfg" type="application/json">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const SCRIPT = `
(() => {
	const cfg = JSON.parse(document.getElementById("cfg").textContent);
	const stage = document.getElementById("stage");
	const cursor = document.getElementById("cursor");
	const clicks = document.getElementById("clicks");
	cursor.innerHTML = cfg.cursor;

	// painted: the take reached the start and settled. pos: how far it applied the log.
	const state = { scene: null, track: [], start: 0, end: 0, painted: false, failed: null, t: 0, sent: -Infinity, pos: -Infinity, running: false, done: false };
	let win = null;
	let slow = 1;
	let wall0 = 0;
	let lastPtr = -1;
	let lastT = -1;
	const live = [];

	const send = (m) => win && win.postMessage({ tape: "tape", ...m }, "*");

	function pointerAt(track, t) {
		let lo = 0, hi = track.length - 1;
		if (hi < 0 || track[0][0] > t) return -1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (track[mid][0] <= t) lo = mid; else hi = mid - 1;
		}
		return lo;
	}

	// The pointer's path, out of the log: moves, presses, releases, leaving.
	function trackOf(log) {
		const out = [];
		let x = -1, y = -1;
		for (const e of log) {
			if (e.k === "move") { x = e.x; y = e.y; out.push([e.t, x, y, 0]); }
			else if (e.k === "down" && e.b === 0) { x = e.x; y = e.y; out.push([e.t, x, y, 1]); }
			else if (e.k === "up" && e.b === 0) { x = e.x; y = e.y; out.push([e.t, x, y, 2]); }
			else if (e.k === "out") out.push([e.t, x, y, 3]);
		}
		return out;
	}

	function until(t) {
		if (t > state.sent) { state.sent = t; send({ type: "until", t }); }
	}

	function draw(t) {
		const track = state.track;
		const i = pointerAt(track, t);
		const a = track[i];
		if (!a || a[3] === 3) cursor.style.opacity = "0";
		else {
			// Where the last applied sample put it, never on the way to one the app hasn't had.
			const x = a[1], y = a[2];
			cursor.style.opacity = "1";
			cursor.style.transform = "translate(" + x + "px, " + y + "px)";
			cursor.dataset.down = a[3] === 1 ? "1" : "0";
		}
		// A click per press edge played through since the last draw.
		if (cfg.click && lastT >= 0)
			for (let j = Math.max(0, lastPtr + 1); j <= i; j++) {
				const p = track[j];
				if (p[3] === 1 && (j === 0 || track[j - 1][3] !== 1)) {
					const el = document.createElement("div");
					el.className = "tape-click-at";
					el.style.transform = "translate(" + p[1] + "px, " + p[2] + "px)";
					el.innerHTML = cfg.click;
					clicks.appendChild(el);
					live.push({ el, t: p[0] });
				}
			}
		// Clicks go by the take's clock, so a slowed render keeps them as long as a real one.
		for (let k = live.length - 1; k >= 0; k--) {
			const c = live[k];
			const age = t - c.t;
			c.el.style.setProperty("--tape-click-p", String(Math.min(1, age / cfg.clickMs)));
			if (age >= cfg.clickMs) { c.el.remove(); live.splice(k, 1); }
		}
		lastPtr = i;
		lastT = t;
	}

	function frame() {
		requestAnimationFrame(frame);
		if (!state.running) return;
		const t = Math.min(state.end, state.start + (Date.now() - wall0) / slow, state.pos + ${LEAD_MS});
		if (t > state.t) state.t = t;
		until(state.t);
		draw(Math.max(state.start, state.pos));
		if (state.pos >= state.end) { state.running = false; state.done = true; }
	}

	window.addEventListener("message", (ev) => {
		const m = ev.data;
		if (!m || m.tape !== "tape" || m.take !== "${TAKE}") return;
		if (m.type === "hello") {
			const scene = { ...state.scene, storage: { local: { ...(state.scene.storage?.local ?? {}), ...cfg.storage } } };
			send({ type: "scene", scene, input: cfg.input, waive: [], watch: [] });
			// A render always plays: the take's deadlines count from the start.
			send({ type: "run", on: true });
			// Everything before the start plays at once, so the take opens on the state it had there.
			state.t = state.start;
			until(state.t);
		} else if (m.type === "pos") {
			state.pos = m.t;
			if (!state.painted && m.idle && m.settled && m.t >= state.start) {
				state.painted = true;
				draw(state.start);
			}
		} else if (m.type === "fail") state.failed = m.reason;
		else if (m.type === "gone") state.failed = "the take's page unloaded (" + m.why + ")";
	});

	window.__tape = {
		state,
		/** Load the scene and boot the app. */
		async load() {
			const scene = await (await fetch(cfg.scene)).json();
			if (scene.tape !== 2) throw new Error("tape: scene version " + scene.tape + ", record it again");
			state.scene = scene;
			state.track = trackOf(scene.log);
			state.start = Math.max(0, scene.meta.start ?? 0);
			state.end = Math.max(state.start, Math.min(scene.meta.duration, scene.meta.end ?? scene.meta.duration));
			const vp = scene.meta.viewport;
			stage.style.width = vp.width + "px";
			stage.style.height = vp.height + "px";
			const frame = document.createElement("iframe");
			frame.width = vp.width;
			frame.height = vp.height;
			frame.style.width = vp.width + "px";
			frame.style.height = vp.height + "px";
			frame.tabIndex = -1;
			frame.setAttribute("sandbox", "${SANDBOX}");
			frame.setAttribute("data-tape-take", "");
			frame.name = "tape-take";
			frame.inert = true;
			frame.src = cfg.app + "#${TAKE_KEY}=${TAKE}";
			stage.prepend(frame);
			win = frame.contentWindow;
			return { viewport: vp, start: state.start, end: state.end };
		},
		/** Resolves once the app's document has been still for quietMs, or after maxMs. */
		quiet(quietMs, maxMs) {
			return new Promise((resolve) => {
				let doc = null;
				try { doc = win.document; } catch {}
				if (!doc) return setTimeout(resolve, maxMs);
				let timer = 0;
				const done = () => { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); };
				const arm = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
				const obs = new MutationObserver(arm);
				obs.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
				const cap = setTimeout(done, maxMs);
				arm();
			});
		},
		/** Start the clock: from now, one ms of the take per slow ms of wall time. Returns the wall start. */
		run(factor) {
			slow = factor;
			wall0 = Date.now();
			state.running = true;
			return wall0;
		},
	};
	requestAnimationFrame(frame);
})();
`;
