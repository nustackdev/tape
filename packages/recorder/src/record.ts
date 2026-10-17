// The recorder. A proxy in front of a running app: every http request and
// websocket passes through untouched, and the page gets the inject script,
// which writes the take's log from inside the page (./inject.ts) and sends it
// here over its own socket.
//
// A take starts when the browser requests a page, so a reload starts over.
// Stopping writes the latest take.

import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import {
	type Entry,
	SCENE_VERSION,
	type Scene,
	type SceneSocket,
	type Viewport,
} from "@nustackdev/tape-scene";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { EVENTS_PATH, INJECT_PATH, INJECT_SCRIPT, injectInto } from "./inject";

export interface RecordOptions {
	target: string;
	port: number;
	out: string;
	title?: string;
	/** Called with a one line status as the take grows. */
	log?: (line: string) => void;
}

/** Tail kept after the last thing that happened, so the end is not cut mid gesture. */
const TAIL_MS = 400;
/** Lead kept before the first pointer move. The app boots before that, and nobody wants to watch a boot. */
const LEAD_MS = 300;

class Take {
	readonly recordedAt = new Date().toISOString();
	url = "";
	path = "/";
	viewport: Viewport = { width: 1280, height: 800, dpr: 1 };
	userAgent?: string;
	seed?: number;
	epoch = 0;
	local: Record<string, string> = {};
	resized = false;
	sockets: SceneSocket[] = [];
	log: Entry[] = [];
	last = 0;

	add(e: Entry) {
		// One channel from one page: in order. Guard anyway, the format requires it.
		const prev = this.log[this.log.length - 1];
		if (prev && e.t < prev.t) e.t = prev.t;
		this.log.push(e);
		if (e.t > this.last) this.last = e.t;
	}

	count(k: Entry["k"]) {
		return this.log.reduce((n, e) => n + (e.k === k ? 1 : 0), 0);
	}

	toScene(title?: string): Scene | null {
		if (this.seed === undefined) return null;
		const firstMove = this.log.find((e) => e.k === "move");
		return {
			tape: SCENE_VERSION,
			meta: {
				recordedAt: this.recordedAt,
				url: this.url,
				path: this.path,
				viewport: this.viewport,
				duration: Math.round(this.last + TAIL_MS),
				...(firstMove && firstMove.t > LEAD_MS ? { start: Math.round(firstMove.t - LEAD_MS) } : {}),
				userAgent: this.userAgent,
				seed: this.seed,
				epoch: this.epoch,
				...(title ? { title } : {}),
			},
			storage: { local: this.local },
			sockets: this.sockets,
			log: this.log,
		};
	}
}

export interface Recorder {
	url: string;
	/** Write the current take. Returns null when nothing was recorded. */
	save(): Scene | null;
	close(): Promise<void>;
}

export async function record(opts: RecordOptions): Promise<Recorder> {
	const target = new URL(opts.target);
	const client = target.protocol === "https:" ? https : http;
	const wsTarget = `${target.protocol === "https:" ? "wss:" : "ws:"}//${target.host}`;
	const log = opts.log ?? (() => {});

	let take: Take | null = null;
	let takes = 0;
	const status = () => {
		if (!take) return;
		const s = (take.last / 1000).toFixed(1);
		const input = take.log.length - take.count("msg") - take.count("move");
		log(
			`take ${takes}  ${s}s  frames ${take.count("msg")}  pointer ${take.count("move")}  nav ${take.count("nav")}  input ${input}`,
		);
	};
	const ticker = setInterval(status, 1000);

	const server = http.createServer((req, res) => {
		if (req.url === INJECT_PATH) {
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
			res.end(INJECT_SCRIPT);
			return;
		}
		const isDocument =
			req.headers["sec-fetch-dest"] === "document" ||
			(req.headers["sec-fetch-dest"] === undefined && req.headers.accept?.includes("text/html"));
		if (isDocument && req.method === "GET") {
			take = new Take();
			takes += 1;
			log(`take ${takes} started at ${req.url}`);
		}

		const headers = { ...req.headers, host: target.host, "accept-encoding": "identity" };
		if (isDocument) {
			delete headers["if-none-match"];
			delete headers["if-modified-since"];
		}
		const upstream = client.request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port,
				method: req.method,
				path: req.url,
				headers,
			},
			(up) => {
				const type = String(up.headers["content-type"] ?? "");
				if (!type.includes("text/html")) {
					res.writeHead(up.statusCode ?? 502, up.headers);
					up.pipe(res);
					return;
				}
				const chunks: Buffer[] = [];
				up.on("data", (c: Buffer) => chunks.push(c));
				up.on("end", () => {
					const body = injectInto(Buffer.concat(chunks).toString("utf8"));
					const out = { ...up.headers, "cache-control": "no-store" };
					delete out["content-length"];
					delete out.etag;
					res.writeHead(up.statusCode ?? 200, out);
					res.end(body);
				});
			},
		);
		upstream.on("error", (err) => {
			res.writeHead(502, { "content-type": "text/plain" });
			res.end(`tape: upstream ${target.origin} unreachable: ${err.message}`);
		});
		req.pipe(upstream);
	});

	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req, socket: Duplex, head) => {
		const path = req.url ?? "/";
		if (path === EVENTS_PATH) {
			wss.handleUpgrade(req, socket, head, (ws) => events(ws));
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, path, req.headers));
	});

	/** The inject script's channel: the take's log, in the page's order. */
	function events(ws: WebSocket) {
		const mine = take;
		ws.on("message", (raw) => {
			if (!mine || mine !== take) return;
			let m: Record<string, unknown>;
			try {
				m = JSON.parse(String(raw));
			} catch {
				return;
			}
			switch (m.type) {
				case "hello":
					mine.url = String(m.url);
					mine.path = String(m.path);
					mine.viewport = m.viewport as Viewport;
					mine.userAgent = String(m.userAgent);
					mine.local = (m.local as Record<string, string>) ?? {};
					if (typeof m.seed === "number" && typeof m.epoch === "number") {
						mine.seed = m.seed;
						mine.epoch = Math.round(m.epoch);
					}
					break;
				case "sock":
					mine.sockets[Number(m.s)] = { url: String(m.url) };
					break;
				case "e":
					mine.add(m.e as Entry);
					break;
				case "resize":
					if (!mine.resized) log("viewport changed mid take, the scene keeps the size at load");
					mine.resized = true;
					break;
			}
		});
	}

	/** An app socket: piped both ways, untouched. The page logs what it receives. */
	function pipe(down: WebSocket, path: string, reqHeaders: http.IncomingHttpHeaders) {
		const protocols = reqHeaders["sec-websocket-protocol"]
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const up = new WebSocket(`${wsTarget}${path}`, protocols, {
			headers: {
				origin: target.origin,
				...(reqHeaders.cookie ? { cookie: reqHeaders.cookie } : {}),
			},
		});
		const pending: [RawData, boolean][] = [];

		up.on("open", () => {
			for (const [data, binary] of pending) up.send(data, { binary });
			pending.length = 0;
		});
		down.on("message", (data, binary) => {
			if (up.readyState === WebSocket.OPEN) up.send(data, { binary });
			else pending.push([data, binary]);
		});
		up.on("message", (data, binary) => {
			if (down.readyState === WebSocket.OPEN) down.send(data, { binary });
		});
		up.on("close", (code, reason) => {
			// An abnormal upstream close stays abnormal downstream, so the app reconnects as it would.
			if (down.readyState <= WebSocket.OPEN) down.close(sendable(code, 1012), reason);
		});
		down.on("close", (code, reason) => {
			if (up.readyState <= WebSocket.OPEN) up.close(sendable(code, 1000), reason);
		});
		up.on("error", (err) => {
			log(`upstream socket ${path}: ${err.message}`);
			if (down.readyState <= WebSocket.OPEN) down.close(1011);
		});
		down.on("error", () => {
			up.terminate();
		});
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, "127.0.0.1", () => resolve());
	});

	return {
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
		save() {
			const current = take as Take | null;
			if (!current || current.last === 0) return null;
			const scene = current.toScene(opts.title);
			if (!scene) return null;
			writeFileSync(opts.out, JSON.stringify(scene));
			return scene;
		},
		async close() {
			clearInterval(ticker);
			for (const ws of wss.clients) ws.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** 1005 and 1006 are reserved: they describe a close, nobody may send them. */
function sendable(code: number, fallback: number): number {
	return code === 1005 || code === 1006 || code < 1000 ? fallback : code;
}
