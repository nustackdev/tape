"use client";

import { pointerAt } from "@nustackdev/tape-scene";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FADE_MS } from "./engine";
import { TAKE_ATTR, TAKE_KEY, TAKE_NAME } from "./protocol";
import { useTape, useTapeStore } from "./Root";

/** Class names, styled in tape.css. */
const s = {
	box: "tape-frame",
	stage: "tape-stage",
	take: "tape-take",
	frame: "tape-take-frame",
	pointer: "tape-pointer",
	pebble: "tape-pebble",
	edge: "tape-pebble-edge",
	body: "tape-pebble-body",
	clicks: "tape-clicks",
	click: "tape-click",
	overlay: "tape-overlay",
	loading: "tape-loading",
};

/** A step of the shown time longer than this is a jump: its clicks are not drawn. */
const JUMP_MS = 250;
/** How long a click stays drawn, ms. Matches the disc's animation. */
const CLICK_MS = 480;
/** Off screen this far (a share of the viewport) for PARK_MS, the takes are dropped to save memory. */
const PARK_MARGIN = "150%";
const PARK_MS = 15000;

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
	/** The pointer drawn over the replay, tip at its box's top left. False for none. */
	cursor?: ReactNode | false;
	/**
	 * Drawn centred on each click for `clickMs`, animate it with CSS. Null for
	 * none. Default: a disc.
	 */
	click?: ReactNode | null;
	clickMs?: number;
	/** Shown until the first take is on screen. Default: a loading sweep. */
	placeholder?: ReactNode;
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
export function Frame({
	aspect = 16 / 10,
	cursor,
	click,
	clickMs = CLICK_MS,
	placeholder,
	className,
	style,
	children,
}: FrameProps) {
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
		// Far away for a while: the takes go, and come back from the same time when near again.
		let park: ReturnType<typeof setTimeout> | undefined;
		const far = new IntersectionObserver(
			([x]) => {
				clearTimeout(park);
				if (x?.isIntersecting) e.unpark();
				else park = setTimeout(() => e.park(), PARK_MS);
			},
			{ rootMargin: PARK_MARGIN },
		);
		near.observe(el);
		seen.observe(el);
		far.observe(el);
		return () => {
			clearTimeout(park);
			near.disconnect();
			seen.disconnect();
			far.disconnect();
		};
	}, [store, e]);

	/**
	 * Each take's iframe is made here, not by React, in a box React renders: so
	 * the engine can take one out of the document the moment its page starts to
	 * leave, before a navigation commits, rather than at the next render.
	 */
	const frames = useRef(new Map<string, HTMLIFrameElement>());
	const place = (id: string, box: HTMLDivElement | null) => {
		if (!box || frames.current.has(id)) return;
		const f = document.createElement("iframe");
		f.name = TAKE_NAME;
		f.setAttribute("sandbox", e.sandboxOf(id));
		// Out of reach of the keyboard and of focus, its own included: nothing in it
		// takes focus off the page or scrolls it. Script inside still runs.
		f.inert = true;
		f.tabIndex = -1;
		f.title = label;
		f.setAttribute("aria-hidden", "true");
		f.className = s.frame;
		f.addEventListener("load", () => e.loaded(id));
		f.src = `${app}#${TAKE_KEY}=${id}`;
		box.appendChild(f);
		frames.current.set(id, f);
		e.attach(id, f.contentWindow);
	};
	useEffect(() => {
		e.remove = (id) => {
			const f = frames.current.get(id);
			frames.current.delete(id);
			if (!f) return;
			// Gone with focus in it, the page would have none: it goes back where it was.
			const held = document.activeElement === f;
			const at = { x: window.scrollX, y: window.scrollY };
			f.remove();
			if (held) e.restore?.(at);
		};
		return () => {
			e.remove = null;
		};
	}, [e]);

	// Focus that lands in a take (a modal dialog in the app, a label) goes back where
	// it was on the page: the take never holds the visitor's focus. The take says so.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const ac = new AbortController();
		let last: Element | null = null;
		// Where the page stood last frame, and when the visitor last moved it themselves:
		// a focus taken may have scrolled it, and it goes back unless they did.
		let stood = { x: window.scrollX, y: window.scrollY };
		let moved = Number.NEGATIVE_INFINITY;
		const off = store.onFrame(() => {
			stood = { x: window.scrollX, y: window.scrollY };
		});
		for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) {
			window.addEventListener(
				type,
				() => {
					moved = performance.now();
				},
				{ capture: true, passive: true, signal: ac.signal },
			);
		}
		document.addEventListener(
			"focusin",
			(ev) => {
				if (ev.target instanceof Element && !el.contains(ev.target)) last = ev.target;
			},
			{ capture: true, signal: ac.signal },
		);
		e.restore = (at = stood) => {
			if (performance.now() - moved > 500 && (window.scrollX !== at.x || window.scrollY !== at.y)) {
				window.scrollTo({ left: at.x, top: at.y, behavior: "instant" });
			}
			if (last instanceof HTMLElement && last.isConnected) {
				last.focus({ preventScroll: true });
				return;
			}
			// Nothing had focus: out of the frame, to nothing.
			el.tabIndex = -1;
			el.focus({ preventScroll: true });
			el.blur();
			el.removeAttribute("tabindex");
		};
		return () => {
			ac.abort();
			off();
			e.restore = null;
		};
	}, [e, store]);

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

	// The pointer and its clicks go with what the shown take applied, never ahead of it.
	const custom = click !== undefined && click !== null;
	const none = click === null;
	useEffect(() => {
		let lastT = -1;
		let lastPtr = -1;
		const spawnClick = (x: number, y: number) => {
			const host = clicks.current;
			if (!host || none) return;
			const el = document.createElement("div");
			el.className = s.click;
			el.style.transform = `translate(${x}px, ${y}px)`;
			if (custom) {
				// The node is rendered (hidden) in the clicks layer; each click gets a copy.
				const tpl = host.querySelector(":scope > [data-tape-click-template]");
				if (!tpl) return;
				el.classList.add(`${s.click}-custom`);
				el.innerHTML = tpl.innerHTML;
			}
			host.appendChild(el);
			setTimeout(() => el.remove(), clickMs);
		};
		return store.onFrame((now) => {
			const scene = e.scene;
			if (!scene || now === lastT) return;
			const track = e.track;
			const i = pointerAt(track, now);
			const el = pointer.current;
			if (el) {
				const a = track[i];
				if (!a || a[3] === 3) el.style.opacity = "0";
				else {
					// Where the last applied sample put it, never on the way to one the app hasn't had.
					const x = a[1];
					const y = a[2];
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
	}, [store, e, custom, none, clickMs]);

	return (
		<div
			ref={box}
			className={className ? `${s.box} ${className}` : s.box}
			style={{ aspectRatio: String(aspect), ...style }}
		>
			{!takes.front && (placeholder ?? <div className={s.loading} aria-hidden />)}
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
						<div
							key={id}
							ref={(box) => place(id, box)}
							className={s.take}
							{...{ [TAKE_ATTR]: id }}
							style={{
								// The shown take and any older one fading out under it stay opaque,
								// so a swap is the new one fading in over a full picture, never a dip.
								opacity: i <= takes.ids.indexOf(takes.front ?? "") ? 1 : 0,
								zIndex: id === takes.front ? 1 : 0,
								transitionDuration: `${FADE_MS}ms`,
							}}
						/>
					))}
					<div ref={clicks} className={s.clicks}>
						{click != null && (
							<div data-tape-click-template="" hidden>
								{click}
							</div>
						)}
					</div>
					{cursor !== false && (
						<div ref={pointer} className={s.pointer}>
							{cursor ?? <Pebble />}
						</div>
					)}
				</div>
			)}
			{/* Over the replay, so touch never reaches it: iOS scrolls an iframe's page despite pointer-events none. */}
			<div className={s.overlay}>{viewport && children}</div>
		</div>
	);
}
