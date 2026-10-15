import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		format: "esm",
		dts: true,
		clean: true,
		external: ["react"],
		banner: { js: '"use client";' },
		onSuccess: "cp src/tape.css dist/tape.css",
	},
	{
		// Runs inside the replay iframe as a classic script, so everything is inlined.
		entry: { shim: "src/shim.ts" },
		format: "iife",
		minify: true,
		noExternal: [/.*/],
		outExtension: () => ({ js: ".js" }),
	},
]);
