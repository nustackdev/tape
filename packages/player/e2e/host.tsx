// The page around the take, as a site has it: the real Tape parts.
import { createRoot } from "react-dom/client";
import { Tape } from "../src/index";

(window as unknown as { __host: boolean }).__host = true;
const query = new URLSearchParams(location.search);
const isolation = (query.get("isolation") ?? "auto") as "auto";
const scene = `/${query.get("scene") ?? "scene"}.json`;
const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<div>
			<div style={{ width: 640 }}>
				<Tape.Root
					app="/app/index.html"
					scene={scene}
					label="fixture"
					hold={200}
					eager
					isolation={isolation}
				>
					<Tape.Frame aspect={16 / 10} />
				</Tape.Root>
			</div>
			<button id="host-button" type="button">
				a host button
			</button>
			<p>Text on the host page.</p>
			<div style={{ height: 3000 }} />
		</div>,
	);
