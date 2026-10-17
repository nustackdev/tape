// The kernel in real browsers: Chromium, Firefox and WebKit, as many as
// Playwright has installed. A host page with the real Tape parts plays a scene
// of a tiny app (./fixture), and the tests try to break out of it: navigation,
// history, selection, focus, scroll, listeners left behind.
//
// What a DOM stand-in can't prove: an opaque origin's walls, `inert`, real
// focus and real scrolling.

import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Entry, installTargets, type Scene, type Target } from "@nustackdev/tape-scene";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { type Browser, chromium, type Frame, firefox, type Page, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => readFileSync(path.join(here, "fixture", f), "utf8");

/** Targets as the recorder would describe them, from the fixture's own markup. */
function targets() {
	const win = new Window();
	const html = fixture("index.html");
	win.document.write(html);
	const T = installTargets(win.document as unknown as Document);
	const of = (id: string) =>
		T.describe(win.document.getElementById(id) as unknown as Element) as Target;
	const ask = new TextEncoder().encode("ask");
	return {
		ask: of("ask"),
		go: of("go"),
		sent: T.digest("ask"),
		ping: T.digest("ping"),
		bytes: T.digest(ask),
	};
}

/**
 * The scene, as a recording of the fixture would have it: the app answered a
 * moment after it asked. In the replay the app asks 400ms after the click, so
 * the answer has to wait for it.
 */
function scene(): Scene {
	const t = targets();
	const button = (k: "down" | "up" | "click", at: number, h: Target, x: number, y: number) =>
		({ t: at, k, x, y, b: 0, m: 0, h }) as Entry;
	return {
		tape: 2,
		meta: {
			recordedAt: "2026-10-16T00:00:00.000Z",
			url: "http://fixture/",
			path: "/",
			viewport: { width: 640, height: 400, dpr: 1 },
			duration: 2600,
			seed: 1,
			epoch: 1_790_000_000_000,
		},
		storage: { local: {} },
		sockets: [{ url: "/ws" }],
		log: [
			{ t: 100, k: "open", s: 0 },
			{ t: 110, k: "msg", s: 0, d: "hello", x: 1 },
			{ t: 500, k: "move", x: 20, y: 20 },
			button("down", 600, t.ask, 20, 20),
			button("up", 610, t.ask, 20, 20),
			button("click", 620, t.ask, 20, 20),
			{ t: 1030, k: "send", s: 0, h: t.sent },
			{ t: 1032, k: "send", s: 0, h: t.ping },
			{ t: 1040, k: "msg", s: 0, d: "answer", x: 1 },
			{ t: 1400, k: "move", x: 10, y: 60 },
			button("down", 1500, t.go, 10, 60),
			button("up", 1510, t.go, 10, 60),
			button("click", 1520, t.go, 10, 60),
			{ t: 1521, k: "nav", path: "/two", mode: "push" },
			{ t: 2000, k: "move", x: 400, y: 300 },
		],
	};
}

/** Frames in the burst scene's stream. */
const BURST = 600;

/**
 * A stream: BURST server frames 1.5ms apart with nothing between them, then a
 * click that needs the page settled. A replay on a starved machine must get
 * through it, slower, never by failing and starting over.
 */
function burstScene(): Scene {
	const s = scene();
	const t = targets();
	const button = (k: "down" | "up" | "click", at: number) =>
		({ t: at, k, x: 10, y: 60, b: 0, m: 0, h: t.go }) as Entry;
	const stream: Entry[] = Array.from({ length: BURST }, (_, i) => ({
		t: 300 + i * 1.5,
		k: "msg",
		s: 0,
		d: `b:${i}`,
		x: 1,
	}));
	return {
		...s,
		log: [
			{ t: 100, k: "open", s: 0 },
			{ t: 110, k: "msg", s: 0, d: "hello", x: 1 },
			...stream,
			{ t: 1400, k: "move", x: 10, y: 60 },
			button("down", 1500),
			button("up", 1510),
			button("click", 1520),
			{ t: 1521, k: "nav", path: "/two", mode: "push" },
			{ t: 2000, k: "move", x: 400, y: 300 },
		],
	};
}

let server: http.Server;
let origin = "";
/** TAPE_E2E_KEEP=1: the server stays up, its url on stderr, for poking at by hand. */
const keep = !!process.env.TAPE_E2E_KEEP;

beforeAll(async () => {
	const bundle = async (entry: string, format: "iife" | "esm") =>
		(
			await build({
				entryPoints: [path.join(here, entry)],
				bundle: true,
				write: false,
				format,
				jsx: "automatic",
				define: { "process.env.NODE_ENV": '"production"' },
			})
		).outputFiles[0]?.text ?? "";
	const files: Record<string, [string, string]> = {
		"/host/": [
			"text/html",
			'<!doctype html><html><head><link rel="stylesheet" href="/host/tape.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/host/host.js"></script></body></html>',
		],
		"/host/host.js": ["text/javascript", await bundle("host.tsx", "esm")],
		"/host/tape.css": ["text/css", readFileSync(path.join(here, "../src/tape.css"), "utf8")],
		"/app/index.html": ["text/html", fixture("index.html")],
		"/app/app.js": ["text/javascript", fixture("app.js")],
		"/app/tape-shim.js": ["text/javascript", await bundle("../src/shim.ts", "iife")],
		"/scene.json": ["application/json", JSON.stringify(scene())],
		"/burst.json": ["application/json", JSON.stringify(burstScene())],
	};
	server = http.createServer((req, res) => {
		const p = new URL(req.url ?? "/", "http://x").pathname;
		// Anything else is "the site": what a frame that navigated or reloaded would get.
		const [type, body] = files[p] ?? [
			"text/html",
			// What a page of the site does that would hurt, loaded into a take: it scrolls
			// and focuses, and says it loaded.
			'<!doctype html><title>site</title><body style="height:9000px"><input autofocus><p id="z" style="margin-top:8000px">z</p><script>window.__site = 1; document.getElementById("z").scrollIntoView(); try { parent.postMessage({ site: 1 }, "*"); } catch {}</script></body>',
		];
		// The take's frame is an opaque origin: everything it loads is cross origin.
		res.writeHead(200, {
			"content-type": type,
			"access-control-allow-origin": "*",
			"cache-control": "no-store",
		});
		res.end(body);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	if (keep) {
		process.stderr.write(`tape e2e: ${origin}/host/\n`);
		await new Promise((r) => setTimeout(r, 10 * 60_000));
	}
}, 11 * 60_000);

afterAll(() => {
	server?.close();
});

/** The engines Playwright has here. */
async function available() {
	const out: [string, typeof chromium][] = [];
	for (const [name, type] of [
		["chromium", chromium],
		["firefox", firefox],
		["webkit", webkit],
	] as const) {
		try {
			const b = await type.launch();
			await b.close();
			out.push([name, type]);
		} catch {}
	}
	return out;
}
const engines = await available();

/** Counts the host's listeners as they come and go, before anything of the page runs. */
const COUNT_LISTENERS = () => {
	const live = new Set<string>();
	let n = 0;
	const add = EventTarget.prototype.addEventListener;
	const remove = EventTarget.prototype.removeEventListener;
	const key = (t: EventTarget, type: string, fn: unknown, capture: boolean) => {
		const ids = (fn as { __id?: number }) ?? {};
		if (typeof fn === "function" || typeof fn === "object") {
			ids.__id ??= ++n;
		}
		const who = t === window ? "w" : t === document ? "d" : null;
		return who && `${who}:${type}:${ids.__id}:${capture}`;
	};
	EventTarget.prototype.addEventListener = function (type, fn, opts) {
		const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
		const k = key(this, type, fn, capture);
		if (k) {
			live.add(k);
			const signal = typeof opts === "object" ? opts?.signal : undefined;
			signal?.addEventListener("abort", () => live.delete(k));
		}
		return add.call(this, type, fn, opts);
	};
	EventTarget.prototype.removeEventListener = function (type, fn, opts) {
		const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
		const k = key(this, type, fn, capture);
		if (k) live.delete(k);
		return remove.call(this, type, fn, opts);
	};
	(window as unknown as { __listeners: () => number }).__listeners = () => live.size;
};

for (const [name, type] of engines) {
	describe(`in ${name}`, () => {
		let browser: Browser;
		beforeAll(async () => {
			browser = await type.launch();
		});
		afterAll(async () => {
			await browser?.close();
		});

		/** The host page, once a take is on screen; the warnings the tape logged. */
		async function open(query = ""): Promise<{ page: Page; warnings: string[] }> {
			const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
			const warnings: string[] = [];
			page.on("console", (m) => {
				// Recycled takes are logged at debug level: not a warning.
				if (m.type() !== "debug" && m.text().startsWith("tape:")) warnings.push(m.text());
			});
			await page.addInitScript(COUNT_LISTENERS);
			await page.goto(`${origin}/host/${query}`);
			await page.waitForSelector('.tape-take[style*="z-index: 1"]', { timeout: 20_000 });
			return { page, warnings };
		}

		/** The take on screen. */
		async function take(page: Page): Promise<Frame> {
			const el = await page.waitForSelector('.tape-take[style*="z-index: 1"] iframe');
			const frame = await el.contentFrame();
			if (!frame) throw new Error("no frame");
			return frame;
		}

		/** Wait for the app to have done `what`, in the take on screen. */
		async function until(page: Page, what: string, timeout = 15_000) {
			const end = Date.now() + timeout;
			for (;;) {
				try {
					const events = await (await take(page)).evaluate(
						() => (window as unknown as { __events?: string[] }).__events ?? [],
					);
					if (events.includes(what)) return events;
				} catch {}
				if (Date.now() > end) throw new Error(`the app never did ${what}`);
				await page.waitForTimeout(50);
			}
		}

		it("plays the take, and hands the server's answer over only after the app asked", async () => {
			const { page, warnings } = await open();
			const before = await page.evaluate(() => history.length);
			let hovered = false;
			const end = Date.now() + 15_000;
			let events: string[] = [];
			while (Date.now() < end && !events.includes("nav")) {
				const f = await take(page);
				const s = await f
					.evaluate(() => ({
						events: (window as unknown as { __events?: string[] }).__events ?? [],
						hover: !!document.getElementById("ask")?.hasAttribute("data-tape-hover"),
					}))
					.catch(() => ({ events: [] as string[], hover: false }));
				events = s.events;
				hovered ||= s.hover;
				await page.waitForTimeout(40);
			}
			expect(events).toEqual(["got:hello", "sent", "got:answer", "nav"]);
			// The frame is inert to the visitor, yet hit testing inside it works: hover followed.
			expect(hovered).toBe(true);
			expect(await (await take(page)).evaluate(() => location.pathname)).toBe("/two");
			expect(await page.evaluate(() => [location.pathname, history.length])).toEqual([
				"/host/",
				before,
			]);
			expect(warnings).toEqual([]);
			await page.close();
		}, 40_000);

		/** Run `code` in the take on screen; what it threw, if anything. */
		async function inTake(page: Page, code: string) {
			try {
				await (await take(page)).evaluate(code);
				return "ran";
			} catch (e) {
				return String(e).split("\n")[0] ?? "";
			}
		}

		/**
		 * The host is the page it was: its url and history, its scroll and focus, no page
		 * of the site loaded into a take; and a take plays on.
		 */
		async function intact(page: Page, before: Before) {
			await page.waitForTimeout(1000);
			const now = await snapshot(page);
			expect(now).toEqual(before);
			await page.waitForSelector('.tape-take[style*="z-index: 1"]', { timeout: 20_000 });
			const on = await take(page);
			await expect
				.poll(() => on.evaluate(() => !!(window as { __tapeShim?: unknown }).__tapeShim), {
					timeout: 10_000,
				})
				.toBe(true);
		}

		type Before = Awaited<ReturnType<typeof snapshot>>;
		const snapshot = (page: Page) =>
			page.evaluate(() => ({
				href: location.href,
				history: history.length,
				host: (window as unknown as { __host?: boolean }).__host,
				scroll: window.scrollY,
				focus: document.activeElement?.id ?? document.activeElement?.tagName,
				site: (window as unknown as { __site?: number }).__site ?? 0,
			}));

		/** The host, scrolled a little, its button focused, a site page reporting itself. */
		async function ready(page: Page) {
			await until(page, "got:hello");
			await page.evaluate(() => {
				window.scrollTo(0, 60);
				addEventListener("message", (e) => {
					if ((e.data as { site?: number })?.site)
						(window as unknown as { __site: number }).__site = 1;
				});
			});
			await page.focus("#host-button");
			return snapshot(page);
		}

		const reach: Record<string, string> = {
			"parent.document": "window.parent.document.body",
			"parent.history": "window.parent.history.back()",
			"top.location": 'window.top.location.href = "https://example.com/"',
		};
		const escapes: Record<string, string> = {
			"location.href": 'location.href = "/elsewhere"',
			"location.hash": 'location.hash = "#frag"',
			"location.assign": 'location.assign("/assigned")',
			"location.reload": "location.reload()",
			"history api": 'history.pushState({}, "", "/a"); history.back(); history.go(-10);',
			"window.open": 'if (window.open("https://example.com/") !== null) throw new Error("opened")',
			"detached link": 'const a = document.createElement("a"); a.href = "/elsewhere"; a.click();',
			"form.submit":
				'const f = document.createElement("form"); f.action = "/posted"; document.body.append(f); f.submit();',
			"stopped link":
				'const a = document.createElement("a"); a.href = "/elsewhere"; a.addEventListener("click", (e) => e.stopPropagation()); document.body.append(a); a.click();',
		};

		it("can't reach the page around it, opaque", async () => {
			const { page } = await open("?isolation=opaque");
			const before = await ready(page);
			const sandbox = await page.$eval('.tape-take[style*="z-index: 1"] iframe', (f) =>
				f.getAttribute("sandbox"),
			);
			// WebKit refuses an opaque take its path and falls back (see KERNEL.md).
			if (!sandbox?.includes("allow-same-origin")) {
				for (const [what, code] of Object.entries(reach)) {
					expect(await inTake(page, code), what).toMatch(/SecurityError|denied|insecure|Blocked/i);
				}
			} else expect(name).toBe("webkit");
			await intact(page, before);
			await page.close();
		}, 60_000);

		for (const [what, code] of Object.entries(escapes)) {
			it(`leaves the page, its history, scroll and focus as they were: ${what}`, async () => {
				const { page } = await open();
				const before = await ready(page);
				await inTake(page, code);
				await intact(page, before);
				await page.close();
			}, 60_000);
		}

		// Opaque, without the Navigation API to cancel them: a navigation is stopped as it
		// asks to unload, the frame taken out before it commits. (A fragment change can't
		// be stopped there; that is why auto isolation runs same origin where it can.)
		for (const what of ["location.href", "location.assign", "location.reload", "form.submit"]) {
			it(`leaves the page as it was, opaque: ${what}`, async () => {
				const { page, warnings } = await open("?isolation=opaque");
				const before = await ready(page);
				await inTake(page, escapes[what] as string);
				await intact(page, before);
				// The take says why it went: the navigation's beforeunload, not a recycle.
				// (WebKit runs this take same origin, where the navigation is cancelled.)
				if (name !== "webkit" && what !== "form.submit") {
					expect(warnings.filter((w) => w.includes("unloaded"))).toEqual([
						expect.stringContaining("its page unloaded (beforeunload)"),
					]);
				}
				await page.close();
			}, 60_000);
		}

		it("has nothing to select, by script, by select all or by find", async () => {
			const { page } = await open();
			await until(page, "got:hello");
			const frame = await take(page);
			expect(
				await frame.evaluate(
					() => getComputedStyle(document.getElementById("out") as Element).userSelect,
				),
			).toBe("none");
			await frame.evaluate(() => getSelection()?.selectAllChildren(document.body));
			await page.waitForTimeout(100);
			expect(await frame.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
			await page.click("#host-button");
			await page.keyboard.press(
				name === "webkit" || process.platform === "darwin" ? "Meta+A" : "Control+A",
			);
			await page.waitForTimeout(100);
			expect(await (await take(page)).evaluate(() => getSelection()?.toString() ?? "")).toBe("");
			await page.close();
		}, 40_000);

		it("never takes focus or scrolls the page around it", async () => {
			const { page } = await open();
			await until(page, "got:hello");
			await page.evaluate(() => window.scrollTo(0, 60));
			await page.click("#host-button");
			const tags: string[] = [];
			for (let i = 0; i < 6; i++) {
				await page.keyboard.press("Tab");
				tags.push(await page.evaluate(() => document.activeElement?.tagName ?? ""));
			}
			expect(tags).not.toContain("IFRAME");
			await page.click("#host-button");
			// WebKit doesn't focus a button on click: whatever had focus, keeps it.
			const had = await page.evaluate(() => document.activeElement?.id ?? "");
			const frame = await take(page);
			await frame.evaluate(async () => {
				document.getElementById("far")?.scrollIntoView();
				(document.getElementById("f") as HTMLInputElement).focus();
				(document.getElementById("dlg") as HTMLDialogElement).showModal();
				const auto = document.createElement("input");
				auto.autofocus = true;
				document.body.append(auto);
				const parsed = document.createElement("div");
				parsed.innerHTML = "<input autofocus>";
				document.body.append(parsed);
				const label = document.createElement("label");
				label.htmlFor = "f";
				label.textContent = "name";
				document.body.append(label);
				label.click();
				const form = document.createElement("form");
				const need = document.createElement("input");
				need.required = true;
				form.append(need);
				document.body.append(form);
				form.requestSubmit();
				await new Promise((r) => setTimeout(r, 300));
			});
			await page.waitForTimeout(200);
			expect(await page.evaluate(() => window.scrollY)).toBe(60);
			expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe(had);
			expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
			await page.close();
		}, 40_000);

		it.skipIf(name !== "chromium")(
			"plays through a burst of server data on a starved machine, slower, never restarting",
			async () => {
				const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
				const warnings: string[] = [];
				page.on("console", (m) => {
					if (m.type() !== "debug" && m.text().startsWith("tape:")) warnings.push(m.text());
				});
				const cdp = await page.context().newCDPSession(page);
				await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
				await page.goto(`${origin}/host/?scene=burst`);
				type Seen = { events: string[]; burst: { n: number; order: boolean; renders: number } };
				let seen: Seen = { events: [], burst: { n: 0, order: true, renders: 0 } };
				const takes = new Set<string>();
				const end = Date.now() + 50_000;
				while (Date.now() < end && !seen.events.includes("nav")) {
					for (const src of await page.evaluate(() =>
						[...document.querySelectorAll(".tape-take iframe")].map(
							(f) => f.getAttribute("src") ?? "",
						),
					))
						takes.add(src);
					const el = await page.$('.tape-take[style*="z-index: 1"] iframe');
					const f = await el?.contentFrame();
					if (f) {
						seen = await f
							.evaluate(() => ({
								events: (window as unknown as { __events?: string[] }).__events ?? [],
								burst: (window as unknown as { __burst: Seen["burst"] }).__burst,
							}))
							.catch(() => seen);
					}
					await page.waitForTimeout(100);
				}
				await page.close();
				expect(warnings.filter((w) => w.includes("failed"))).toEqual([]);
				expect(takes.size).toBe(1);
				expect(seen.events).toEqual(["got:hello", "nav"]);
				expect(seen.burst.n).toBe(BURST);
				expect(seen.burst.order).toBe(true);
				// A backlog of frames gets a render for many, as in a browser that fell behind.
				expect(seen.burst.renders).toBeLessThan(BURST / 2);
			},
			60_000,
		);

		it("leaves nothing behind on the host as takes come and go", async () => {
			const { page } = await open();
			await until(page, "nav");
			const count = () =>
				page.evaluate(() => (window as unknown as { __listeners: () => number }).__listeners());
			const first = await count();
			// Several loops: each a fresh take, the old one torn down.
			let ids = new Set<string>();
			const end = Date.now() + 14_000;
			while (Date.now() < end && ids.size < 5) {
				const src = await page.evaluate(() =>
					[...document.querySelectorAll(".tape-take iframe")].map(
						(f) => f.getAttribute("src") ?? "",
					),
				);
				ids = new Set([...ids, ...src]);
				await page.waitForTimeout(200);
			}
			expect(ids.size).toBeGreaterThanOrEqual(4);
			await page.waitForTimeout(600);
			expect(
				await page.evaluate(() => document.querySelectorAll(".tape-take iframe").length),
			).toBeLessThanOrEqual(2);
			expect(await count()).toBeLessThanOrEqual(first);
			await page.close();
		}, 40_000);
	});
}
