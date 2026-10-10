// Prepare an app build for replay. Copies a built web app, the dist/ of a
// vite build, into a directory a site serves under some path, and puts the
// player shim in front of it.
//
// Two things change in the copy, nothing in the app:
// - root absolute urls point under `base`, so the build works off a sub path.
//   Vite writes them in html attributes, css url() and its preload helper.
// - module scripts go inert. The shim starts them once the scene has arrived,
//   so the app boots on the recorded path with the recorded storage.

import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const SHIM_FILE = "tape-shim.js";
export const DEFERRED_TYPE = "text/x-tape-module";

export interface BundleOptions {
	src: string;
	out: string;
	/** Absolute path the bundle is served at, eg /scenes/nuspace-0.5.1/ */
	base: string;
	/** Free form, lands in tape.json. eg "nuspace-ui 0.5.1" */
	source?: string;
}

export interface BundleReport {
	html: number;
	css: number;
	preload: number;
}

export function normalizeBase(base: string): string {
	if (!base.startsWith("/")) throw new Error(`tape: --base must be an absolute path, got ${base}`);
	return base.endsWith("/") ? base : `${base}/`;
}

/** html: root absolute src/href under base, module scripts inert, shim first in head. */
export function rewriteHtml(html: string, base: string): { html: string; count: number } {
	let count = 0;
	let out = html.replace(/\b(src|href)=(["'])\/(?!\/)/g, (_m, attr: string, q: string) => {
		count++;
		return `${attr}=${q}${base}`;
	});
	out = out.replace(
		/<script\b([^>]*)\btype=(["'])module\2([^>]*)>/gi,
		(_m, a: string, _q, b: string) => {
			return `<script${a}type="${DEFERRED_TYPE}"${b}>`;
		},
	);
	const shim = `<script src="${base}${SHIM_FILE}"></script>`;
	const head = out.match(/<head[^>]*>/i);
	out =
		head?.index !== undefined
			? out.slice(0, head.index + head[0].length) + shim + out.slice(head.index + head[0].length)
			: shim + out;
	return { html: out, count };
}

/** css: url(/x) under base. */
export function rewriteCss(css: string, base: string): { css: string; count: number } {
	let count = 0;
	const out = css.replace(/url\((["']?)\/(?!\/)/g, (_m, q: string) => {
		count++;
		return `url(${q}${base}`;
	});
	return { css: out, count };
}

/** js: vite's preload helper, `function(e){return"/"+e}`, prefixes deps with base. */
export function rewriteJs(js: string, base: string): { js: string; count: number } {
	let count = 0;
	const out = js.replace(/return(["'`])\/\1\+(\w+)\}/g, (_m, q: string, v: string) => {
		count++;
		return `return${q}${base}${q}+${v}}`;
	});
	return { js: out, count };
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

function shimSource(): string {
	const require = createRequire(import.meta.url);
	return readFileSync(require.resolve("@nustackdev/tape-player/shim.js"), "utf8");
}

export function bundle(opts: BundleOptions): BundleReport {
	const base = normalizeBase(opts.base);
	const index = path.join(opts.src, "index.html");
	if (!existsSync(index)) throw new Error(`tape: no index.html in ${opts.src}`);

	// A previous bundle is replaced whole, so no stale chunks linger. Anything else is left alone.
	if (existsSync(opts.out) && readdirSync(opts.out).length > 0) {
		if (!existsSync(path.join(opts.out, "tape.json"))) {
			throw new Error(`tape: ${opts.out} is not empty and not a tape bundle`);
		}
		rmSync(opts.out, { recursive: true });
	}
	cpSync(opts.src, opts.out, { recursive: true });
	const report: BundleReport = { html: 0, css: 0, preload: 0 };
	for (const file of walk(opts.out)) {
		const ext = path.extname(file);
		if (ext === ".html") {
			const r = rewriteHtml(readFileSync(file, "utf8"), base);
			writeFileSync(file, r.html);
			report.html += r.count;
		} else if (ext === ".css") {
			const r = rewriteCss(readFileSync(file, "utf8"), base);
			writeFileSync(file, r.css);
			report.css += r.count;
		} else if (ext === ".js" || ext === ".mjs") {
			const r = rewriteJs(readFileSync(file, "utf8"), base);
			if (r.count > 0) writeFileSync(file, r.js);
			report.preload += r.count;
		}
	}
	writeFileSync(path.join(opts.out, SHIM_FILE), shimSource());
	writeFileSync(
		path.join(opts.out, "tape.json"),
		`${JSON.stringify({ base, source: opts.source ?? opts.src, bundledAt: new Date().toISOString() }, null, "\t")}\n`,
	);
	return report;
}
