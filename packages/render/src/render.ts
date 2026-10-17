// Render a scene to frames: serve the bundle and a harness page, boot the
// replay in headless Chromium, run the take's clock and screenshot it as fast
// as the machine allows, every frame stamped with the take time it shows.
//
// Screenshots are slow at 2x, a few a second on a laptop. So the take runs in
// slow motion: the clock and the page's CSS animations at 1/slow, frames
// stamped in take time, and the encode plays them back at full speed. `slow`
// is picked from a short measure of the capture rate unless given.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import { type Browser, chromium } from "playwright";
import { type HarnessConfig, harnessHtml } from "./harness";

export interface CaptureOptions {
	/** Path to the scene.json. */
	scene: string;
	/** Directory `tape bundle` wrote. Its tape.json names the base it is served at. */
	app: string;
	/** Where the frames and their index go. Emptied first. */
	dir: string;
	/** Device pixel ratio of the frames. Default 2. */
	scale?: number;
	/** Slow motion factor, or "auto" to fit `fps`. Default "auto". */
	slow?: number | "auto";
	/** Captured frames per second of the take that "auto" aims for. Default 30. */
	fps?: number;
	/** Play window override, ms of the take. Default the scene's own trim. */
	start?: number;
	end?: number;
	/** "dark" or "light": the browser's color scheme and a class on the harness root. */
	theme?: string;
	storage?: Record<string, string>;
	input?: boolean;
	cursor?: string;
	click?: string;
	clickMs?: number;
	css?: string;
	jpegQuality?: number;
	log?: (line: string) => void;
}

/** A captured frame: its file and the take time it shows, ms. */
export interface FrameStamp {
	file: string;
	t: number;
}

export interface FrameIndex {
	start: number;
	end: number;
	slow: number;
	scale: number;
	viewport: { width: number; height: number };
	frames: FrameStamp[];
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};

/** Serves the bundle at its base, the harness at /__tape/, the scene beside it. */
function serve(app: string, base: string, harness: string, scene: string): Promise<Server> {
	const root = resolve(app);
	const server = createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		let body: Buffer | string | null = null;
		let type = "text/plain";
		if (path === "/__tape/index.html") {
			body = harness;
			type = TYPES[".html"] as string;
		} else if (path === "/__tape/scene.json") {
			body = scene;
			type = TYPES[".json"] as string;
		} else if (path.startsWith(base)) {
			const rel = path.slice(base.length) || "index.html";
			const file = normalize(join(root, rel));
			if (file.startsWith(root)) {
				try {
					body = readFileSync(file);
					type = TYPES[extname(file)] ?? "application/octet-stream";
				} catch {
					// An app route, not a file: the app's own index, as a static host would.
					body = readFileSync(join(root, "index.html"));
					type = TYPES[".html"] as string;
				}
			}
		}
		if (body === null) {
			res.writeHead(404).end();
			return;
		}
		// The take's frame is an opaque origin: its module scripts, css and fonts are cross origin.
		res
			.writeHead(200, {
				"content-type": type,
				"cache-control": "no-store",
				"access-control-allow-origin": "*",
			})
			.end(body);
	});
	return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function capture(opts: CaptureOptions): Promise<FrameIndex> {
	const log = opts.log ?? (() => {});
	const scale = opts.scale ?? 2;
	const fps = opts.fps ?? 30;
	const sceneText = readFileSync(opts.scene, "utf8");
	const scene = JSON.parse(sceneText);
	if (opts.start !== undefined) scene.meta.start = opts.start;
	if (opts.end !== undefined) scene.meta.end = opts.end;
	const { base } = JSON.parse(readFileSync(join(opts.app, "tape.json"), "utf8")) as {
		base: string;
	};

	const cfg: HarnessConfig = {
		app: `${base}index.html`,
		scene: "/__tape/scene.json",
		storage: opts.storage ?? {},
		input: opts.input ?? true,
		cursor: opts.cursor ?? DEFAULT_CURSOR,
		click: opts.click ?? DEFAULT_CLICK,
		clickMs: opts.clickMs ?? 450,
		css: opts.css ?? DEFAULT_CSS,
		theme: opts.theme ?? "",
	};
	const server = await serve(opts.app, base, harnessHtml(cfg), JSON.stringify(scene));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	rmSync(opts.dir, { recursive: true, force: true });
	mkdirSync(opts.dir, { recursive: true });

	let browser: Browser | null = null;
	try {
		browser = await chromium.launch({ args: ["--hide-scrollbars", "--font-render-hinting=none"] });
		const vp = scene.meta.viewport as { width: number; height: number };
		const ctx = await browser.newContext({
			viewport: { width: vp.width, height: vp.height },
			deviceScaleFactor: scale,
			colorScheme:
				opts.theme === "light" ? "light" : opts.theme === "dark" ? "dark" : "no-preference",
			reducedMotion: "no-preference",
		});
		const page = await ctx.newPage();
		page.on("pageerror", (e) => log(`page error: ${e.message}`));
		const cdp = await ctx.newCDPSession(page);
		await page.goto(`${origin}/__tape/index.html`);
		const win = await page.evaluate(() => (window as unknown as TapeWindow).__tape.load());
		log(
			`take ${(win.start / 1000).toFixed(1)}s to ${(win.end / 1000).toFixed(1)}s, ${vp.width}x${vp.height} @${scale}x`,
		);

		await page.waitForFunction(
			() => {
				const s = (window as unknown as TapeWindow).__tape.state;
				return s.painted || s.failed !== null;
			},
			null,
			{ timeout: 60000 },
		);
		const bad = await page.evaluate(() => (window as unknown as TapeWindow).__tape.state.failed);
		if (bad) throw new Error(`tape: the take failed: ${bad}`);
		await page.evaluate(() => (window as unknown as TapeWindow).__tape.quiet(400, 6000));

		// clip.scale is what gives true device pixels: without it a shot caps at css size.
		const clip = { x: 0, y: 0, width: vp.width, height: vp.height, scale };
		const quality = opts.jpegQuality ?? 92;
		const shot = async () =>
			(
				await cdp.send("Page.captureScreenshot", {
					format: "jpeg",
					quality,
					clip,
					captureBeyondViewport: false,
				})
			).data;

		// How fast this machine captures, to pick the slow motion.
		let slow = opts.slow === "auto" || opts.slow === undefined ? 0 : opts.slow;
		if (!slow) {
			const n = 8;
			const t0 = Date.now();
			for (let i = 0; i < n; i++) await shot();
			const rate = (n * 1000) / (Date.now() - t0);
			slow = Math.max(1, Math.ceil(fps / rate));
			log(`captures at ${rate.toFixed(1)} fps, slow motion x${slow}`);
		}

		await cdp.send("Animation.enable");
		await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / slow });

		const frames: FrameStamp[] = [];
		await page.evaluate((f) => (window as unknown as TapeWindow).__tape.run(f), slow);
		const span = win.end - win.start;
		let n = 0;
		let lastLog = 0;
		for (;;) {
			// Stamped with what the take had applied as the shot was taken: never the clock,
			// which may run ahead of a busy app.
			const s = await page.evaluate(() => {
				const st = (window as unknown as TapeWindow).__tape.state;
				return { pos: st.pos, failed: st.failed };
			});
			if (s.failed) throw new Error(`tape: the take failed: ${s.failed}`);
			const t = Math.min(win.end, Math.max(win.start, s.pos));
			const data = await shot();
			const file = `${String(n++).padStart(6, "0")}.jpg`;
			writeFileSync(join(opts.dir, file), Buffer.from(data, "base64"));
			frames.push({ file, t });
			if (Date.now() - lastLog > 5000) {
				lastLog = Date.now();
				log(`  ${Math.round(((t - win.start) / span) * 100)}%  ${n} frames`);
			}
			// A little past the end, so the last frames' paint is in.
			if (t >= win.end) {
				await sleep(150 * slow);
				const last = await shot();
				const tail = `${String(n++).padStart(6, "0")}.jpg`;
				writeFileSync(join(opts.dir, tail), Buffer.from(last, "base64"));
				frames.push({ file: tail, t: win.end });
				break;
			}
		}
		await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
		const index: FrameIndex = { start: win.start, end: win.end, slow, scale, viewport: vp, frames };
		writeFileSync(join(opts.dir, "index.json"), JSON.stringify(index));
		log(
			`captured ${frames.length} frames, ${((frames.length * 1000) / span).toFixed(1)} per take second`,
		);
		return index;
	} finally {
		await browser?.close();
		server.close();
	}
}

interface TapeWindow {
	__tape: {
		state: { painted: boolean; failed: string | null; pos: number };
		load(): Promise<{ start: number; end: number }>;
		quiet(quietMs: number, maxMs: number): Promise<void>;
		run(slow: number): number;
	};
}

/** A plain arrow, white with a dark edge, tip at the top left. */
export const DEFAULT_CURSOR = `<svg class="tape-cursor" width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.8 L11.5 14 L18 14 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

/** A ring that opens and fades. */
export const DEFAULT_CLICK = `<span class="tape-click"></span>`;

export const DEFAULT_CSS = `
.tape-cursor { display: block; margin: -2px 0 0 -4px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); transition: transform 120ms ease-out; transform-origin: 4px 2px; }
[data-down="1"] > .tape-cursor { transform: scale(0.86); }
.tape-click { display: block; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 2px solid rgba(124, 92, 250, .9); animation: tape-click 450ms ease-out forwards; }
@keyframes tape-click { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
`;
