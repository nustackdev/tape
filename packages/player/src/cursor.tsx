// The cursor drawn over the replay. Moved by the player's clock through a
// handle, never through react state: it updates every frame.

import type { PointerSample, Scene } from "@nustackdev/tape-scene";
import { forwardRef, useImperativeHandle, useRef } from "react";

export interface CursorHandle {
	reset(scene: Scene, t: number): void;
	seek(t: number): void;
}

const RIPPLE_MS = 450;

/** Index of the last sample at or before `t`, from `from` on. */
function advance(track: PointerSample[], from: number, t: number): number {
	let i = from;
	while (i + 1 < track.length && (track[i + 1] as PointerSample)[0] <= t) i++;
	return i;
}

export const Cursor = forwardRef<CursorHandle>(function Cursor(_props, ref) {
	const arrow = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	const state = useRef({ track: [] as PointerSample[], i: -1, t: 0 });

	const place = (t: number) => {
		const el = arrow.current;
		const { track, i } = state.current;
		const a = track[i];
		if (!el || !a || a[3] === 3) {
			if (el) el.style.opacity = "0";
			return;
		}
		// Samples come at frame rate; easing between them hides the jitter of the take.
		const b = track[i + 1];
		let x = a[1];
		let y = a[2];
		if (b && b[3] !== 3 && b[0] > a[0]) {
			const k = Math.min(1, (t - a[0]) / (b[0] - a[0]));
			x += (b[1] - x) * k;
			y += (b[2] - y) * k;
		}
		el.style.opacity = "1";
		el.style.transform = `translate(${x}px, ${y}px)`;
		el.dataset.down = a[3] === 1 ? "1" : "0";
	};

	const ripple = (x: number, y: number) => {
		const host = layer.current;
		if (!host) return;
		const r = document.createElement("div");
		r.style.cssText = `position:absolute;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;border-radius:50%;background:rgba(120,140,255,.35);pointer-events:none`;
		host.appendChild(r);
		r.animate(
			[
				{ transform: "scale(.3)", opacity: 1 },
				{ transform: "scale(1.4)", opacity: 0 },
			],
			{ duration: RIPPLE_MS, easing: "ease-out" },
		).onfinish = () => r.remove();
	};

	useImperativeHandle(ref, () => ({
		reset(scene, t) {
			state.current = { track: scene.pointer, i: -1, t };
			state.current.i = advance(scene.pointer, -1, t);
			for (const r of [...(layer.current?.children ?? [])]) if (r !== arrow.current) r.remove();
			place(t);
		},
		seek(t) {
			const s = state.current;
			const from = s.i;
			s.i = advance(s.track, s.i, t);
			for (let j = from + 1; j <= s.i; j++) {
				const p = s.track[j];
				if (p && p[3] === 1) ripple(p[1], p[2]);
			}
			s.t = t;
			place(t);
		},
	}));

	return (
		<div ref={layer} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
			<div
				ref={arrow}
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					opacity: 0,
					willChange: "transform",
					transition: "opacity 150ms",
				}}
			>
				<svg
					width="22"
					height="22"
					viewBox="0 0 22 22"
					aria-hidden="true"
					style={{ display: "block" }}
				>
					<path
						d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19.2 L10.6 12.8 L16.5 12.8 Z"
						fill="#fff"
						stroke="#111"
						strokeWidth="1.4"
						strokeLinejoin="round"
					/>
				</svg>
			</div>
		</div>
	);
});
