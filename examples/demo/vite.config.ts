import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The take's frame is an opaque origin, so the bundle in public/app is fetched
// cross origin: it needs the header a static host like GitHub Pages sends.
export default defineConfig({
	plugins: [react()],
	server: { headers: { "access-control-allow-origin": "*" } },
	preview: { headers: { "access-control-allow-origin": "*" } },
});
