#!/usr/bin/env node
// tape-render: a tape scene to video and GIF.

import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encodeGif, encodeMp4 } from "./encode";
import { capture } from "./render";

const HELP = `tape-render: render a tape scene to video and GIF

usage:
  tape-render <scene.json> --app <bundle> -o <out>
      --app <dir>            the app as \`tape bundle\` wrote it (required)
      -o, --out <path>       output path without extension (required)
      -f, --format <list>    mp4,gif (default both)

  the take
      --start <s>  --end <s> play window, seconds (default the scene's trim)
      --speed <n>            playback speed (default 1)
      --lead <ms>            hold the first frame (default 0)
      --hold <ms>            hold the last frame (default 1500)
      --theme <name>         dark or light: color scheme, and a class on the root for --css
      --storage <k=v>        localStorage over the take's, repeatable (eg nuspace.theme=dark)
      --no-input             server frames only, no recorded input

  the pointer
      --cursor <file>        html for the cursor, top left on the tip ("none" to hide)
      --click <file>         html drawn centred on each click ("none" to hide)
      --click-ms <ms>        how long a click stays (default 450)
      --css <file>           css for .tape-cursor, .tape-click, [data-down="1"], var(--tape-click-p)

  quality
      --scale <n>            device pixel ratio (default 2)
      --slow <n|auto>        slow motion while capturing (default auto)
      --capture-fps <n>      what auto slow motion aims for (default 30)
      --fps <n>              mp4 frame rate (default 30)
      --width <px>           mp4 width (default captured width)
      --crf <n>              mp4 quality (default 18)
      --gif-fps <n>          (default 15)
      --gif-width <px>       (default 960)
      --gif-colors <n>       (default 256)
      --gif-dither <name>    ffmpeg paletteuse dither (default sierra2_4a)
      --frames <dir>         keep captured frames here (default a temp dir, removed)
`;

function fail(msg: string): never {
	process.stderr.write(`tape-render: ${msg}\n`);
	process.exit(1);
}

const text = (file: string | undefined) =>
	file === undefined ? undefined : file === "none" ? "" : readFileSync(file, "utf8");
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const mb = (file: string) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

async function main(argv: string[]) {
	const { values: v, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			app: { type: "string" },
			out: { type: "string", short: "o" },
			format: { type: "string", short: "f", default: "mp4,gif" },
			start: { type: "string" },
			end: { type: "string" },
			speed: { type: "string" },
			lead: { type: "string" },
			hold: { type: "string" },
			theme: { type: "string" },
			storage: { type: "string", multiple: true },
			"no-input": { type: "boolean" },
			cursor: { type: "string" },
			click: { type: "string" },
			"click-ms": { type: "string" },
			css: { type: "string" },
			scale: { type: "string" },
			slow: { type: "string" },
			"capture-fps": { type: "string" },
			fps: { type: "string" },
			width: { type: "string" },
			crf: { type: "string" },
			"gif-fps": { type: "string" },
			"gif-width": { type: "string" },
			"gif-colors": { type: "string" },
			"gif-dither": { type: "string" },
			frames: { type: "string" },
		},
	});
	if (v.help || positionals.length === 0) {
		process.stdout.write(HELP);
		return;
	}
	const scene = positionals[0] as string;
	const app = v.app ?? fail("--app is required: the directory `tape bundle` wrote");
	const out = v.out ?? fail("-o is required: the output path without extension");
	const formats = (v.format ?? "").split(",").filter(Boolean);
	for (const f of formats) if (f !== "mp4" && f !== "gif") fail(`unknown format ${f}`);

	const storage: Record<string, string> = {};
	for (const kv of v.storage ?? []) {
		const i = kv.indexOf("=");
		if (i < 1) fail(`--storage takes key=value, got ${kv}`);
		storage[kv.slice(0, i)] = kv.slice(i + 1);
	}
	const sec = (s: string | undefined) => (s === undefined ? undefined : Number(s) * 1000);
	const dir = v.frames ?? join(tmpdir(), `tape-render-${process.pid}`);
	const log = (line: string) => process.stderr.write(`${line}\n`);

	try {
		const index = await capture({
			scene,
			app,
			dir,
			scale: num(v.scale),
			slow: v.slow === undefined || v.slow === "auto" ? "auto" : Number(v.slow),
			fps: num(v["capture-fps"]),
			start: sec(v.start),
			end: sec(v.end),
			theme: v.theme,
			storage,
			input: !v["no-input"],
			cursor: text(v.cursor),
			click: text(v.click),
			clickMs: num(v["click-ms"]),
			css: text(v.css),
			log,
		});
		const pace = { speed: num(v.speed), lead: num(v.lead), hold: num(v.hold) };
		if (formats.includes("mp4")) {
			encodeMp4(dir, index, `${out}.mp4`, {
				...pace,
				fps: num(v.fps),
				width: num(v.width),
				crf: num(v.crf),
			});
			log(`${out}.mp4  ${mb(`${out}.mp4`)}`);
		}
		if (formats.includes("gif")) {
			encodeGif(dir, index, `${out}.gif`, {
				...pace,
				fps: num(v["gif-fps"]),
				width: num(v["gif-width"]),
				colors: num(v["gif-colors"]),
				dither: v["gif-dither"],
			});
			log(`${out}.gif  ${mb(`${out}.gif`)}`);
		}
	} finally {
		if (!v.frames) rmSync(dir, { recursive: true, force: true });
	}
}

main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
