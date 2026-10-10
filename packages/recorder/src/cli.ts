#!/usr/bin/env node
// tape: record a websocket UI session, replay it anywhere.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseScene, playWindow, trimScene } from "@nustackdev/tape-scene";
import { bundle } from "./bundle";
import { record } from "./record";

const HELP = `tape: record a websocket UI session, replay it anywhere

usage:
  tape record <target>   proxy a running app and record a take
      -p, --port <n>       port to serve on (default 7357)
      -o, --out <file>     scene file (default scene.json)
      -t, --title <s>      title stored in the scene
  tape bundle <dist>     prepare an app build for replay
      -o, --out <dir>      output directory (required)
      -b, --base <path>    absolute path it is served at (required)
      -s, --source <s>     what the build is, eg "nuspace-ui 0.5.1"
  tape trim <scene>      set the play window, in seconds
      --start <s>  --end <s>  -o, --out <file> (default: in place)
  tape info <scene>      print what is in a scene
`;

function fail(msg: string): never {
	process.stderr.write(`tape: ${msg}\n`);
	process.exit(1);
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

async function main(argv: string[]) {
	const [cmd, ...rest] = argv;
	if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
		process.stdout.write(HELP);
		return;
	}

	if (cmd === "record") {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				port: { type: "string", short: "p", default: "7357" },
				out: { type: "string", short: "o", default: "scene.json" },
				title: { type: "string", short: "t" },
			},
		});
		const target = positionals[0] ?? fail("record needs a target, eg http://127.0.0.1:8080");
		const tty = process.stderr.isTTY;
		const rec = await record({
			target: /^https?:\/\//.test(target) ? target : `http://${target}`,
			port: Number(values.port),
			out: values.out,
			title: values.title,
			log: (line) => {
				if (tty && line.startsWith("take ") && !line.includes("started")) {
					process.stderr.write(`\r\x1b[2K${line}`);
				} else process.stderr.write(`${tty ? "\r\x1b[2K" : ""}${line}\n`);
			},
		});
		process.stderr.write(
			`recording ${target} at ${rec.url}\nopen it, click around, ctrl+c to save. a reload starts a new take.\n`,
		);
		const stop = async () => {
			process.stderr.write("\n");
			const scene = rec.save();
			await rec.close();
			if (!scene) fail("nothing recorded, open the page first");
			const s = (scene.meta.duration / 1000).toFixed(1);
			process.stderr.write(`saved ${values.out}: ${s}s, ${scene.frames.length} frames\n`);
			process.exit(0);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		return;
	}

	if (cmd === "bundle") {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				out: { type: "string", short: "o" },
				base: { type: "string", short: "b" },
				source: { type: "string", short: "s" },
			},
		});
		const src = positionals[0] ?? fail("bundle needs a build directory");
		const out = values.out ?? fail("bundle needs --out");
		const base = values.base ?? fail("bundle needs --base");
		const r = bundle({ src, out, base, source: values.source });
		process.stderr.write(
			`bundled ${src} -> ${out} at ${base}: ${r.html} html urls, ${r.css} css urls, ${r.preload} preload helpers\n`,
		);
		if (r.preload === 0) {
			process.stderr.write(
				"warning: no vite preload helper found, lazy chunks may load off root\n",
			);
		}
		return;
	}

	if (cmd === "trim") {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				start: { type: "string" },
				end: { type: "string" },
				out: { type: "string", short: "o" },
			},
		});
		const file = positionals[0] ?? fail("trim needs a scene file");
		const ms = (s?: string) => (s === undefined ? undefined : Math.round(Number(s) * 1000));
		const scene = trimScene(
			parseScene(readFileSync(file, "utf8")),
			ms(values.start),
			ms(values.end),
		);
		writeFileSync(values.out ?? file, JSON.stringify(scene));
		const [a, b] = playWindow(scene);
		process.stderr.write(`plays ${(a / 1000).toFixed(2)}s to ${(b / 1000).toFixed(2)}s\n`);
		return;
	}

	if (cmd === "info") {
		const file = rest[0] ?? fail("info needs a scene file");
		const raw = readFileSync(file, "utf8");
		const scene = parseScene(raw);
		const [a, b] = playWindow(scene);
		const bytes = scene.frames.reduce((n, f) => n + (f.x ? f.d.length : (f.d.length * 3) / 4), 0);
		const { width, height, dpr } = scene.meta.viewport;
		const lines = [
			`${file}  ${kb(raw.length)}`,
			`recorded  ${scene.meta.recordedAt}  ${scene.meta.url}`,
			`viewport  ${width}x${height} @${dpr}x`,
			`length    ${(scene.meta.duration / 1000).toFixed(2)}s, plays ${(a / 1000).toFixed(2)}s to ${(b / 1000).toFixed(2)}s`,
			`sockets   ${scene.sockets.map((s) => s.url).join(", ") || "none"}`,
			`frames    ${scene.frames.length}, ${kb(bytes)} payload`,
			`pointer   ${scene.pointer.length} samples, ${scene.pointer.filter((p) => p[3] === 1).length} clicks`,
			`nav       ${scene.nav.map((n) => n.path).join(" > ") || "none"}`,
			`input     ${scene.events?.length ?? 0} events, ${scene.events?.filter((e) => e.k === "keydown").length ?? 0} keys`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}

	fail(`unknown command ${cmd}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((err: Error) => fail(err.message));
