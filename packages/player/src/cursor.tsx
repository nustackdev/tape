// The cursor drawn over the replay. Moved by the player's clock through a
// handle, never through react state: it updates every frame. Clicks are rare,
// so they do go through state, each drawn for a while then dropped.

import type { PointerSample, Scene } from "@nustackdev/tape-scene";
import {
	forwardRef,
	type ReactNode,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

export interface CursorHandle {
	reset(scene: Scene, t: number): void;
	seek(t: number): void;
}

export interface CursorProps {
	/** Drawn at the pointer, its top left on the tip. Default: an arrow. */
	arrow?: ReactNode;
	/** Drawn at each click, centred on it. Null for none. Default: a ripple. */
	click?: ReactNode;
	/** How long a click stays drawn, ms. */
	clickMs: number;
}

/** The default arrow. */
const ARROW = (
	<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" style={{ display: "block" }}>
		<path
			d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19.2 L10.6 12.8 L16.5 12.8 Z"
			fill="#fff"
			stroke="#111"
			strokeWidth="1.4"
			strokeLinejoin="round"
		/>
	</svg>
);

/** The default click: a ring that grows and fades. */
function Ripple({ ms }: { ms: number }) {
	const el = useRef<HTMLDivElement>(null);
	useEffect(() => {
		el.current?.animate(
			[
				{ transform: "scale(.3)", opacity: 1 },
				{ transform: "scale(1.4)", opacity: 0 },
			],
			{ duration: ms, easing: "ease-out", fill: "forwards" },
		);
	}, [ms]);
	return (
		<div
			ref={el}
			style={{
				width: 36,
				height: 36,
				marginLeft: -18,
				marginTop: -18,
				borderRadius: "50%",
				background: "rgba(120,140,255,.35)",
			}}
		/>
	);
}

/** Index of the last sample at or before `t`, from `from` on. */
function advance(track: PointerSample[], from: number, t: number): number {
	let i = from;
	while (i + 1 < track.length && (track[i + 1] as PointerSample)[0] <= t) i++;
	return i;
}

export const Cursor = forwardRef<CursorHandle, CursorProps>(function Cursor(
	{ arrow: arrowNode = ARROW, click, clickMs },
	ref,
) {
	const arrow = useRef<HTMLDivElement>(null);
	const state = useRef({ track: [] as PointerSample[], i: -1, t: 0 });
	const ids = useRef(0);
	const [clicks, setClicks] = useState<{ id: number; x: number; y: number }[]>([]);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => () => timers.current.forEach(clearTimeout), []);

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

	const press = (x: number, y: number) => {
		if (click === null) return;
		const id = ids.current++;
		setClicks((c) => [...c, { id, x, y }]);
		const timer = setTimeout(() => {
			timers.current.delete(timer);
			setClicks((c) => c.filter((k) => k.id !== id));
		}, clickMs);
		timers.current.add(timer);
	};

	useImperativeHandle(ref, () => ({
		reset(scene, t) {
			state.current = { track: scene.pointer, i: -1, t };
			state.current.i = advance(scene.pointer, -1, t);
			timers.current.forEach(clearTimeout);
			timers.current.clear();
			setClicks([]);
			place(t);
		},
		seek(t) {
			const s = state.current;
			const from = s.i;
			s.i = advance(s.track, s.i, t);
			for (let j = from + 1; j <= s.i; j++) {
				const p = s.track[j];
				if (p && p[3] === 1) press(p[1], p[2]);
			}
			s.t = t;
			place(t);
		},
	}));

	return (
		<div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
			{clicks.map((k) => (
				<div key={k.id} style={{ position: "absolute", left: k.x, top: k.y }}>
					{click === undefined ? <Ripple ms={clickMs} /> : click}
				</div>
			))}
			<div
				ref={arrow}
				data-tape-cursor=""
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					opacity: 0,
					willChange: "transform",
					transition: "opacity 150ms",
				}}
			>
				{arrowNode}
			</div>
		</div>
	);
});
