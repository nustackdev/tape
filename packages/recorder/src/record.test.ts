import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { base64ToBytes, parseScene } from "@nustackdev/tape-scene";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { INJECT_PATH } from "./inject";
import { type Recorder, record } from "./record";

/** A tiny app: a page, and a socket that greets then echoes reversed. */
function app(): Promise<{ port: number; close: () => void }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><head><title>app</title></head><body></body></html>");
	});
	const wss = new WebSocketServer({ server, path: "/ws" });
	wss.on("connection", (ws) => {
		ws.send(Buffer.from([1, 2, 3]));
		ws.send("hello");
		ws.on("message", (d) => ws.send(Buffer.from([...(d as Buffer)].reverse())));
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({ port, close: () => server.close() });
		}),
	);
}

const open = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});

const settle = () => new Promise((r) => setTimeout(r, 150));

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn();
	cleanup = [];
});

describe("record", () => {
	it("proxies a page and socket, and writes the take", async () => {
		const target = await app();
		cleanup.push(target.close);
		const out = path.join(mkdtempSync(path.join(tmpdir(), "tape-")), "scene.json");
		const rec: Recorder = await record({ target: `http://127.0.0.1:${target.port}`, port: 0, out });
		cleanup.push(() => rec.close());
		const base = rec.url;

		const page = await fetch(`${base}/`, { headers: { "sec-fetch-dest": "document" } });
		expect(await page.text()).toContain(`<head><script src="${INJECT_PATH}"></script>`);

		const events = await open(`${base.replace("http", "ws")}/__tape/events`);
		const say = (m: unknown) => events.send(JSON.stringify(m));
		say({
			type: "hello",
			url: `${base}/`,
			path: "/",
			viewport: { width: 800, height: 600, dpr: 2 },
			userAgent: "test",
			local: { theme: "dark" },
			seed: 7,
			epoch: 1_700_000_000_000.4,
		});
		const got: unknown[] = [];
		const ws = await open(`${base.replace("http", "ws")}/ws`);
		ws.on("message", (d, binary) => got.push(binary ? [...(d as Buffer)] : String(d)));
		await settle();
		ws.send(Buffer.from([7, 8, 9]));
		await new Promise((r) => setTimeout(r, 400));
		// What the page's inject script reports, in the page's order.
		say({ type: "sock", s: 0, url: "/ws" });
		say({ type: "e", e: { t: 500, k: "open", s: 0 } });
		say({ type: "e", e: { t: 510, k: "msg", s: 0, d: "AQID" } });
		say({ type: "e", e: { t: 520, k: "msg", s: 0, d: "hello", x: 1 } });
		say({ type: "e", e: { t: 900, k: "move", x: 10, y: 20 } });
		say({
			type: "e",
			e: { t: 950, k: "down", x: 10, y: 20, b: 0, m: 0, h: { p: "1/0", n: "button" } },
		});
		say({ type: "e", e: { t: 960, k: "nav", path: "/a", mode: "push" } });
		await settle();
		ws.close();
		events.close();
		await settle();

		// The app saw exactly what it would have without the proxy.
		expect(got).toEqual([[1, 2, 3], "hello", [9, 8, 7]]);

		const saved = rec.save();
		expect(saved).not.toBeNull();
		const scene = parseScene(readFileSync(out, "utf8"));
		expect(scene.meta.viewport).toEqual({ width: 800, height: 600, dpr: 2 });
		expect(scene.meta.seed).toBe(7);
		expect(scene.meta.epoch).toBe(1_700_000_000_000);
		expect(scene.storage.local).toEqual({ theme: "dark" });
		expect(scene.sockets).toEqual([{ url: "/ws" }]);
		expect(scene.log.map((e) => e.k)).toEqual(["open", "msg", "msg", "move", "down", "nav"]);
		const msgs = scene.log.flatMap((e) =>
			e.k === "msg" ? [e.x ? e.d : [...base64ToBytes(e.d)]] : [],
		);
		expect(msgs).toEqual([[1, 2, 3], "hello"]);
		// Starts just before the pointer does, ends a little after the last entry.
		expect(scene.meta.start).toBe(600);
		expect(scene.meta.duration).toBeGreaterThan(960);
	});

	it("starts a new take on reload", async () => {
		const target = await app();
		cleanup.push(target.close);
		const out = path.join(mkdtempSync(path.join(tmpdir(), "tape-")), "scene.json");
		const rec = await record({ target: `http://127.0.0.1:${target.port}`, port: 0, out });
		cleanup.push(() => rec.close());
		const doc = { headers: { "sec-fetch-dest": "document" } };
		await fetch(`${rec.url}/`, doc);
		const ws = await open(`${rec.url.replace("http", "ws")}/ws`);
		await settle();
		ws.close();
		await fetch(`${rec.url}/`, doc);
		expect(rec.save()).toBeNull();
	});
});
