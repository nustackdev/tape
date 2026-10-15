"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FADE_MS, pointerAt } from "./engine";
import { TAKE_KEY } from "./protocol";
import { useTape, useTapeStore } from "./Root";

/** Class names, styled in tape.css. */
const s = {
	box: "tape-frame",
	stage: "tape-stage",
	take: "tape-take",
	pointer: "tape-pointer",
	pebble: "tape-pebble",
	edge: "tape-pebble-edge",
	body: "tape-pebble-body",
	clicks: "tape-clicks",
	click: "tape-click",
	overlay: "tape-overlay",
	loading: "tape-loading",
};

/** A clock step longer than this is a jump: its clicks are not drawn. */
const JUMP_MS = 250;
/** How long a click stays drawn, ms. Matches the disc's animation. */
const CLICK_MS = 480;

/** The default pointer: a rounded pebble in the accent with a white edge, tip at the top left. */
function Pebble() {
	const d = "M4.5 3.5 L19.5 10 L12.4 12.4 L10 19.5 Z";
	return (
		<svg className={s.pebble} width="22" height="22" viewBox="0 0 24 24" aria-hidden>
			<path className={s.edge} d={d} />
			<path className={s.body} d={d} />
		</svg>
	);
}

export interface FrameProps {
	/** Frame width / height, reserved up front. */
	aspect?: number;
	/** The pointer drawn over the replay, tip at its box's top left. */
	cursor?: ReactNode;
	className?: string;
	style?: CSSProperties;
	/** Over the replay, eg a Scrubber. */
	children?: ReactNode;
}

/**
 * Tape.Frame — the take on screen: the app at its recorded size, scaled to
 * fit and centred, the recorded pointer and clicks over it. Loads its take
 * once near the viewport and plays only while on screen. The app can't be
 * reached: the overlay owns the pointer.
 */
export function Frame({ aspect = 16 / 10, cursor, className, style, children }: FrameProps) {
	const store = useTapeStore();
	const e = store.engine;
	const app = useTape((t) => t.app);
	const label = useTape((t) => t.label);
	const viewport = useTape((t) => t.viewport);
	const takes = useTape((t) => t.takes);
	const box = useRef<HTMLDivElement>(null);
	const pointer = useRef<HTMLDivElement>(null);
	const clicks = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });

	// Near the viewport: load. In it: advance.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const near = new IntersectionObserver(([x]) => x?.isIntersecting && store.set({ near: true }), {
			rootMargin: "400px",
		});
		const seen = new IntersectionObserver(([x]) => (e.visible = !!x?.isIntersecting), {
			threshold: 0.25,
		});
		near.observe(el);
		seen.observe(el);
		return () => {
			near.disconnect();
			seen.disconnect();
		};
	}, [store, e]);

	// Scale the recorded viewport into the frame, centred.
	useEffect(() => {
		const el = box.current;
		if (!el || !viewport) return;
		const ro = new ResizeObserver(() => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			const scale = Math.min(w / viewport.width, h / viewport.height);
			setFit({ scale, x: (w - viewport.width * scale) / 2, y: (h - viewport.height * scale) / 2 });
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [viewport]);

	// The pointer and its clicks go with what is on screen, not the clock, while a take loads in.
	useEffect(() => {
		let lastT = -1;
		let lastPtr = -1;
		const spawnClick = (x: number, y: number) => {
			const host = clicks.current;
			if (!host) return;
			const el = document.createElement("div");
			el.className = s.click;
			el.style.transform = `translate(${x}px, ${y}px)`;
			host.appendChild(el);
			setTimeout(() => el.remove(), CLICK_MS);
		};
		return store.onFrame((now) => {
			const scene = e.scene;
			if (!scene || now === lastT) return;
			const track = scene.pointer;
			const i = pointerAt(track, now);
			const el = pointer.current;
			if (el) {
				const a = track[i];
				if (!a || a[3] === 3) el.style.opacity = "0";
				else {
					// Samples come at frame rate; easing between them hides the jitter.
					const b = track[i + 1];
					let x = a[1];
					let y = a[2];
					if (b && b[3] !== 3 && b[0] > a[0]) {
						const k = Math.min(1, (now - a[0]) / (b[0] - a[0]));
						x += (b[1] - x) * k;
						y += (b[2] - y) * k;
					}
					el.style.opacity = "1";
					el.style.transform = `translate(${x}px, ${y}px)`;
					el.dataset.down = a[3] === 1 ? "1" : "0";
				}
			}
			// Clicks only when played through, not when jumped over.
			const step = now - lastT;
			if (lastT >= 0 && step > 0 && step < JUMP_MS)
				for (let j = Math.max(0, lastPtr + 1); j <= i; j++) {
					const p = track[j];
					if (p && p[3] === 1 && track[j - 1]?.[3] !== 1) spawnClick(p[1], p[2]);
				}
			lastPtr = i;
			lastT = now;
		});
	}, [store, e]);

	return (
		<div
			ref={box}
			className={className ? `${s.box} ${className}` : s.box}
			style={{ aspectRatio: String(aspect), ...style }}
		>
			{!takes.front && <div className={s.loading} aria-hidden />}
			{viewport && (
				<div
					className={s.stage}
					style={{
						width: viewport.width,
						height: viewport.height,
						transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
						opacity: fit.scale ? 1 : 0,
					}}
					role="img"
					aria-label={label}
				>
					{takes.ids.map((id, i) => (
						<iframe
							key={id}
							ref={(el) => e.attach(id, el?.contentWindow ?? null)}
							src={`${app}#${TAKE_KEY}=${id}`}
							title={label}
							tabIndex={-1}
							aria-hidden
							className={s.take}
							style={{
								// The shown take and any older one fading out under it stay opaque,
								// so a swap is the new one fading in over a full picture, never a dip.
								opacity: i <= takes.ids.indexOf(takes.front ?? "") ? 1 : 0,
								zIndex: id === takes.front ? 1 : 0,
								transitionDuration: `${FADE_MS}ms`,
							}}
						/>
					))}
					<div ref={clicks} className={s.clicks} />
					<div ref={pointer} className={s.pointer}>
						{cursor ?? <Pebble />}
					</div>
				</div>
			)}
			{/* Over the replay, so touch never reaches it: iOS scrolls an iframe's page despite pointer-events none. */}
			<div className={s.overlay}>{viewport && children}</div>
		</div>
	);
}
