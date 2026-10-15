// Captured frames to video and GIF with ffmpeg. Each frame is held until the
// next one's take time, so the output runs at the take's own pace whatever the
// capture rate was, then resampled to a constant frame rate.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FrameIndex } from "./render";

export interface EncodeOptions {
	/** Playback speed over the take. Default 1. */
	speed?: number;
	/** Hold the first frame this long before playing, ms. Default 0. */
	lead?: number;
	/** Hold the last frame this long, ms. Default 1500. */
	hold?: number;
}

export interface Mp4Options extends EncodeOptions {
	fps?: number;
	/** Output width in px. Default the captured width. */
	width?: number;
	/** x264 crf. Default 18. */
	crf?: number;
}

export interface GifOptions extends EncodeOptions {
	/** Default 15. */
	fps?: number;
	/** Output width in px. Default 960. */
	width?: number;
	/** Palette colours. Default 256. */
	colors?: number;
	/** ffmpeg paletteuse dither. Default "sierra2_4a"; "bayer" makes smaller files. */
	dither?: string;
}

/** The concat list: every frame with how long it stays, in output seconds. */
function concatList(dir: string, index: FrameIndex, o: EncodeOptions): string {
	const speed = o.speed ?? 1;
	const lead = (o.lead ?? 0) / 1000;
	const hold = (o.hold ?? 1500) / 1000;
	const { frames } = index;
	const lines: string[] = [];
	frames.forEach((f, i) => {
		const next = frames[i + 1];
		let d = next ? (next.t - f.t) / 1000 / speed : hold;
		if (i === 0) d += lead;
		lines.push(`file '${resolve(dir, f.file)}'`, `duration ${Math.max(0.001, d).toFixed(4)}`);
	});
	// The concat demuxer drops the last duration unless the file is named once more.
	const last = frames.at(-1);
	if (last) lines.push(`file '${resolve(dir, last.file)}'`);
	const file = join(dir, "list.txt");
	writeFileSync(file, lines.join("\n"));
	return file;
}

function ffmpeg(args: string[]) {
	execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
		stdio: "inherit",
	});
}

const even = (n: number) => Math.round(n / 2) * 2;

export function encodeMp4(dir: string, index: FrameIndex, out: string, o: Mp4Options = {}) {
	const list = concatList(dir, index, o);
	const width = even(o.width ?? index.viewport.width * index.scale);
	ffmpeg([
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		list,
		"-vf",
		`fps=${o.fps ?? 30},scale=${width}:-2:flags=lanczos`,
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		String(o.crf ?? 18),
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		out,
	]);
}

export function encodeGif(dir: string, index: FrameIndex, out: string, o: GifOptions = {}) {
	const list = concatList(dir, index, o);
	const width = o.width ?? 960;
	// One palette for the whole take, weighted to what changes, so a mostly
	// still UI keeps its colours; frames only redraw the rectangle that moved.
	const vf = [
		`fps=${o.fps ?? 15},scale=${width}:-1:flags=lanczos,split[a][b]`,
		`[a]palettegen=max_colors=${o.colors ?? 256}:stats_mode=diff[p]`,
		`[b][p]paletteuse=dither=${o.dither ?? "sierra2_4a"}:diff_mode=rectangle`,
	].join(";");
	ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-filter_complex", vf, "-loop", "0", out]);
}
