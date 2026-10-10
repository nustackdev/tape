import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundle, normalizeBase, rewriteCss, rewriteHtml, rewriteJs } from "./bundle";

const BASE = "/scenes/app/";

const HTML = `<!doctype html><html><head>
<link rel="icon" href="/favicon.png" />
<script type="module" crossorigin src="/assets/index-a.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-b.js">
<link rel="stylesheet" href="/assets/index-c.css">
<link rel="preconnect" href="//fonts.example.com">
</head><body><div id="root"></div></body></html>`;

describe("bundle rewrites", () => {
	it("needs an absolute base", () => {
		expect(normalizeBase("/x")).toBe("/x/");
		expect(() => normalizeBase("x/")).toThrow();
	});

	it("moves html urls under base, defers modules, puts the shim first", () => {
		const { html, count } = rewriteHtml(HTML, BASE);
		expect(count).toBe(4);
		expect(html).toContain('href="/scenes/app/favicon.png"');
		expect(html).toContain('href="//fonts.example.com"');
		expect(html).toContain(
			'<script type="text/x-tape-module" crossorigin src="/scenes/app/assets/index-a.js">',
		);
		expect(html).not.toContain('type="module"');
		expect(html.indexOf("tape-shim.js")).toBeLessThan(html.indexOf("favicon"));
	});

	it("moves css urls under base", () => {
		const { css, count } = rewriteCss(
			"a{src:url(/assets/a.woff2)}b{src:url('/assets/b.woff2')}c{src:url(//cdn/x)}",
			BASE,
		);
		expect(count).toBe(2);
		expect(css).toContain("url(/scenes/app/assets/a.woff2)");
		expect(css).toContain("url('/scenes/app/assets/b.woff2')");
		expect(css).toContain("url(//cdn/x)");
	});

	it("prefixes vite's preload helper", () => {
		const { js, count } = rewriteJs('const x=function(e){return"/"+e},y=1;', BASE);
		expect(count).toBe(1);
		expect(js).toBe('const x=function(e){return"/scenes/app/"+e},y=1;');
	});

	it("bundles a build directory and refuses foreign output", () => {
		const root = mkdtempSync(path.join(tmpdir(), "tape-"));
		const src = path.join(root, "dist");
		mkdirSync(path.join(src, "assets"), { recursive: true });
		writeFileSync(path.join(src, "index.html"), HTML);
		writeFileSync(path.join(src, "assets/index-c.css"), "a{src:url(/assets/a.woff2)}");
		writeFileSync(path.join(src, "assets/index-a.js"), 'f=function(e){return"/"+e}');
		const out = path.join(root, "out");
		expect(bundle({ src, out, base: BASE })).toEqual({ html: 4, css: 1, preload: 1 });
		expect(readFileSync(path.join(out, "tape-shim.js"), "utf8")).toContain("__tapeShim");
		// Again over its own output is fine; over anything else is not.
		bundle({ src, out, base: BASE });
		const other = path.join(root, "other");
		mkdirSync(other);
		writeFileSync(path.join(other, "keep.txt"), "x");
		expect(() => bundle({ src, out: other, base: BASE })).toThrow(/not a tape bundle/);
	});
});
