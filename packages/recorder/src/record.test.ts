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
		events.send(
			JSON.stringify({
				type: "hello",
				url: `${base}/`,
				path: "/",
				viewport: { width: 800, height: 600, dpr: 2 },
				userAgent: "test",
				local: { theme: "dark" },
			}),
		);
		const got: unknown[] = [];
		const ws = await open(`${base.replace("http", "ws")}/ws`);
		ws.on("message", (d, binary) => got.push(binary ? [...(d as Buffer)] : String(d)));
		await settle();
		ws.send(Buffer.from([7, 8, 9]));
		await new Promise((r) => setTimeout(r, 400));
		events.send(JSON.stringify({ type: "p", k: 0, x: 10, y: 20 }));
		events.send(JSON.stringify({ type: "p", k: 1, x: 10, y: 20 }));
		events.send(JSON.stringify({ type: "nav", mode: "push", path: "/a" }));
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
		expect(scene.storage.local).toEqual({ theme: "dark" });
		expect(scene.sockets).toHaveLength(1);
		expect(scene.sockets[0]?.url).toBe("/ws");
		// Closed by the client, so not part of the take.
		expect(scene.sockets[0]?.close).toBeUndefined();
		// Starts just before the pointer does.
		expect(scene.meta.start).toBeGreaterThan(0);
		expect(scene.meta.start).toBeLessThan(scene.pointer[0]?.[0] ?? 0);
		expect(scene.frames.map((f) => (f.x ? f.d : [...base64ToBytes(f.d)]))).toEqual([
			[1, 2, 3],
			"hello",
			[9, 8, 7],
		]);
		expect(scene.pointer.map((p) => p.slice(1))).toEqual([
			[10, 20, 0],
			[10, 20, 1],
		]);
		expect(scene.nav.map((n) => n.path)).toEqual(["/a"]);
		const times = [...scene.frames.map((f) => f.t), ...scene.pointer.map((p) => p[0])];
		expect(Math.max(...times)).toBeLessThan(scene.meta.duration);
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
