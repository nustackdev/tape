import { describe, expect, it } from "vitest";
import { rewriteRule } from "./pseudo";

describe("pseudo rewrite", () => {
	it("swaps hover and focus for attributes", () => {
		expect(rewriteRule(".a:hover{color:red}")).toBe(".a[data-tape-hover]{color:red}");
		expect(rewriteRule(".a:focus-visible,.b:focus{x:y}")).toBe(
			".a[data-tape-focus-visible],.b[data-tape-focus]{x:y}",
		);
		expect(rewriteRule(".g:focus-within .c{x:y}")).toBe(".g[data-tape-focus-within] .c{x:y}");
		expect(rewriteRule(".a:not(:hover){x:y}")).toBe(".a:not([data-tape-hover]){x:y}");
	});

	it("lifts hover media and leaves look alikes alone", () => {
		expect(rewriteRule("@media (hover:hover){.a:hover{x:y}}")).toBe(
			"@media (min-width: 0px){.a[data-tape-hover]{x:y}}",
		);
		expect(rewriteRule(".hover\\:bg:hover{x:y}")).toBe(".hover\\:bg[data-tape-hover]{x:y}");
		expect(rewriteRule(".a:hovering{x:y}")).toBe(".a:hovering{x:y}");
	});
});
