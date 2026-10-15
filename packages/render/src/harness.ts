// The page a render runs in: the app's replay in an iframe at the recorded
// viewport, the cursor and clicks drawn over it, and a clock the renderer
// starts. Plain DOM, no framework: it only has to tick the shim and place two
// layers.
//
// The clock runs on wall time divided by `slow`, so a machine that captures
// few frames a second still gets a smooth take: the renderer slows the page's
// CSS animations by the same factor and plays the frames back that much faster.

/** The url hash key the take id travels in, as the player shim reads it. */
const TAKE_KEY = "tape-take";

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

	const state = { scene: null, start: 0, end: 0, opened: false, painted: false, t: 0, running: false, done: false };
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

	function draw(t) {
		const track = state.scene.pointer;
		const i = pointerAt(track, t);
		const a = track[i];
		if (!a || a[3] === 3) cursor.style.opacity = "0";
		else {
			// Samples come at frame rate: easing between them hides the jitter.
			const b = track[i + 1];
			let x = a[1], y = a[2];
			if (b && b[3] !== 3 && b[0] > a[0]) {
				const k = Math.min(1, (t - a[0]) / (b[0] - a[0]));
				x += (b[1] - x) * k;
				y += (b[2] - y) * k;
			}
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
		const t = Math.min(state.end, state.start + (Date.now() - wall0) / slow);
		state.t = t;
		send({ type: "tick", t });
		draw(t);
		if (t >= state.end) { state.running = false; state.done = true; }
	}

	window.addEventListener("message", (ev) => {
		const m = ev.data;
		if (!m || m.tape !== "tape" || m.take !== "${TAKE}") return;
		if (m.type === "hello") {
			const scene = { ...state.scene, storage: { local: { ...(state.scene.storage?.local ?? {}), ...cfg.storage } } };
			send({ type: "scene", scene, input: cfg.input });
		} else if (m.type === "open" && !state.opened) {
			state.opened = true;
			// Everything before the start plays at once, so the take opens on the state it had there.
			state.t = Math.max(state.start, state.scene.sockets[0]?.open ?? 0);
			send({ type: "tick", t: state.t });
			draw(state.t);
		} else if (m.type === "painted") state.painted = true;
	});

	window.__tape = {
		state,
		/** Load the scene and boot the app. */
		async load() {
			const scene = await (await fetch(cfg.scene)).json();
			state.scene = scene;
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
