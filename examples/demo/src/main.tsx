import { LiveScene } from "@nustackdev/tape-player";
import { createRoot } from "react-dom/client";

// The bundle goes in public/app, served at /app/:
//   tape bundle <dist> -o examples/demo/public/app --base /app/
// and the scene at public/scene.json.
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main style={{ maxWidth: 1100, margin: "48px auto", padding: "0 16px" }}>
			<h1 style={{ fontWeight: 600 }}>tape demo</h1>
			<p>The page paints first. The scene fills the frame once it is on screen.</p>
			<LiveScene
				app="/app/index.html"
				scene="/scene.json"
				aspect={16 / 10}
				label="a recorded session"
				style={{ borderRadius: 12, border: "1px solid #2a2a33", background: "#141418" }}
			/>
			<div style={{ height: "120vh" }} />
		</main>,
	);
}
