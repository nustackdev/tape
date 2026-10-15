"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chapterAt } from "./chapter";
import { useTape, useTapeApi } from "./Root";

/** Class names, styled in tape.css. */
const s = {
	zone: "tape-scrub",
	blob: "tape-scrub-blob",
	shown: "tape-scrub-shown",
	chev: "tape-scrub-chev",
	chevL: "tape-scrub-chev-l",
	chevR: "tape-scrub-chev-r",
	inner: "tape-scrub-inner",
	title: "tape-scrub-title",
	rail: "tape-scrub-rail",
	fill: "tape-scrub-fill",
	tick: "tape-scrub-tick",
	passed: "tape-scrub-passed",
	head: "tape-scrub-head",
	play: "tape-scrub-play",
	playAway: "tape-scrub-play-away",
};

const cn = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

function Chevron({ className, left }: { className: string; left?: boolean }) {
	return (
		<svg
			className={className}
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.25"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<path d={left ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
		</svg>
	);
}

function PlayIcon() {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
			<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
		</svg>
	);
}

/** The scrubber's width: this share of the frame, within bounds, inside the edges. */
const SPAN = 0.5;
const SPAN_MIN = 200;
const SPAN_MAX = 520;
/** Kept this far inside the window's edges. */
const EDGE = 12;
/** The rail's inset inside the scrubber, each side. Matches the CSS padding. */
const INSET = 20;
/** The scrubber's height and corner radius. */
const HEIGHT = 68;
const RADIUS = 18;
/** What it grows out of: the hover pill under a mouse, a dot under a finger. */
const PILL = { w: 64, h: 40 };
const DOT = { w: 44, h: 44 };
/** Under a finger the scrubber sits this far above it, so the finger doesn't hide it. */
const LIFT_TOUCH = 76;
/** A touch opens the scrubber after this, or on sideways movement past TOUCH_PX. A scroll cancels it first. */
const TOUCH_MS = 120;
const TOUCH_PX = 5;
/** The morph, pill into scrubber and back, ms. The contents fade on CSS transitions timed to it. */
const IN_MS = 340;
const OUT_MS = 280;
const EASE_IN = "cubic-bezier(0.22, 1.2, 0.36, 1)";
/** A touch's first move mostly up or down, past this, is a page scroll: the scrub lets go. */
const SCROLL_PX = 8;
/** Keyboard: a step of the arrows, ms of the take, and how long the scrubber lingers after a key. */
const KEY_STEP = 2000;
/** With no steps to go by, the big keys (shift+arrows, PageUp/Down) move this far. */
const KEY_BIG = 10000;
const KEY_LINGER = 900;

type Phase = "closed" | "open" | "closing";

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
	radius: number;
}

interface Drag {
	id: number;
	touch: boolean;
	/** The finger at the press, window px, and the frame then. */
	x0: number;
	y0: number;
	rect: DOMRect;
	/**
	 * The rail's ends and the playhead at the press, window px, and how far the
	 * pointer can go each way. Set as the scrubber opens.
	 */
	railL: number;
	railR: number;
	h0: number;
	reachL: number;
	reachR: number;
	t0: number;
	wasPlaying: boolean;
	opened: boolean;
	/** Travel so far, px. */
	dx: number;
	dy: number;
	/** Went sideways past TOUCH_PX at some point: a real scrub, never undone or given to a scroll. */
	scrubbed: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

function reduced() {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A pill of `size` centred on (x, y). */
function pillAt(x: number, y: number, size: { w: number; h: number }): Box {
	return {
		left: x - size.w / 2,
		top: y - size.h / 2,
		width: size.w,
		height: size.h,
		radius: size.h / 2,
	};
}

function frame(b: Box): Keyframe {
	return {
		left: `${b.left}px`,
		top: `${b.top}px`,
		width: `${b.width}px`,
		height: `${b.height}px`,
		borderRadius: `${b.radius}px`,
	};
}

function apply(el: HTMLElement, b: Box) {
	Object.assign(el.style, frame(b));
}

/** Where the shape is right now, mid-animation too, window px. Its own box, not scaled by its pop-in. */
function boxOf(el: HTMLElement): Box {
	const c = getComputedStyle(el);
	const n = (v: string) => parseFloat(v) || 0;
	return {
		left: n(c.left),
		top: n(c.top),
		width: n(c.width),
		height: n(c.height),
		radius: n(c.borderTopLeftRadius),
	};
}

/** From a to b by k. */
function mix(a: Box, b: Box, k: number): Box {
	const m = (x: number, y: number) => x + (y - x) * k;
	return {
		left: m(a.left, b.left),
		top: m(a.top, b.top),
		width: m(a.width, b.width),
		height: m(a.height, b.height),
		radius: m(a.radius, b.radius),
	};
}

/** Ease in-out, cubic. */
function ease(k: number) {
	return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
}

/** A time for screen readers, eg "0:21". */
function clockText(ms: number) {
	const sec = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * The part of the window you can see, in the same px as clientX/Y and
 * position: fixed. On phones that's the visual viewport: smaller while the
 * keyboard or the browser's bars are up, offset when pinch zoomed.
 */
function view() {
	const v = window.visualViewport;
	if (!v) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
	return {
		left: v.offsetLeft,
		top: v.offsetTop,
		right: v.offsetLeft + v.width,
		bottom: v.offsetTop + v.height,
	};
}

export interface ScrubberProps {
	/** Names what the frame scrubs, for screen readers. Defaults to the tape's label. */
	label?: string;
}

/**
 * Tape.Scrubber — goes inside Tape.Frame. The whole frame is one control. Over it a mouse pointer is a
 * pill with arrows both ways. Press, and the pill (a plain dot under a
 * finger) stretches into a small track, the playhead under the finger. Drag
 * sideways to move through the take; let go and it folds back where the
 * pointer is, and plays on. The track floats over the window, not the frame:
 * half a frame wide, kept inside the window's edges, above a thumb on touch,
 * so a press anywhere, corners too, reaches both ends unblocked.
 * Keyboard: arrows scrub, shift+arrows step, Home/End, Space plays and pauses.
 */
export function Scrubber({ label: name }: ScrubberProps) {
	const player = useTapeApi();
	const beats = useTape((x) => x.chapters);
	const range = useTape((x) => x.range);
	const playing = useTape((x) => x.playing);
	const active = useTape((x) => Math.max(0, x.chapter));
	// For screen readers, so to the second: no render every frame.
	const time = useTape((x) => Math.floor(x.time / 1000) * 1000);
	const tapeLabel = useTape((x) => x.label);
	const label = name ?? `Scrub through: ${tapeLabel}`;
	const zone = useRef<HTMLDivElement>(null);
	/** The one shape: the pill on hover, the scrubber while pressed. */
	const blob = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	/** Where the pointer is in the frame, and whether it is a mouse. */
	const ptr = useRef({ x: 0, y: 0, mouse: true });
	const morph = useRef<Animation | null>(null);
	const phaseRef = useRef<Phase>("closed");
	const linger = useRef<ReturnType<typeof setTimeout>>(undefined);
	/** The fold back's frame loop. */
	const fold = useRef(0);
	/** A keyboard scrub paused playback: it resumes as the scrubber goes. */
	const keyResume = useRef(false);
	/** The same, for rendering: keys holding it paused still looks like playing. */
	const [keyHeld, setKeyHeld] = useState(false);
	const holdForKeys = (on: boolean) => {
		keyResume.current = on;
		setKeyHeld(on);
	};
	const [phase, setPhaseState] = useState<Phase>("closed");
	/** The scrubber's width: its contents lay out at it while the shape grows around them. */
	const [width, setWidth] = useState(0);
	const [t, setT] = useState(0);
	/** A mouse is over the frame: the pill shows. */
	const [hover, setHover] = useState(false);
	/** What last pointed: the shape grows from a pill under a mouse, a bare dot under a finger. */
	const [mouse, setMouse] = useState(true);

	const setPhase = (p: Phase) => {
		phaseRef.current = p;
		setPhaseState(p);
	};

	useEffect(() => {
		const el = zone.current;
		// Once it is a sideways scrub, the touch is ours: the page doesn't scroll
		// under it. Until then the page may still take it as a scroll.
		const hold = (e: TouchEvent) => {
			const d = drag.current;
			if (d?.opened && d.scrubbed && e.cancelable) e.preventDefault();
		};
		// The page scrolled under a resting mouse: the frame may have moved away
		// from it. The pill comes back with the next move over the frame.
		const scrolled = () => !drag.current && setHover(false);
		el?.addEventListener("touchmove", hold, { passive: false });
		window.addEventListener("scroll", scrolled, { passive: true });
		return () => {
			el?.removeEventListener("touchmove", hold);
			window.removeEventListener("scroll", scrolled);
			clearTimeout(linger.current);
			clearTimeout(drag.current?.timer);
			cancelAnimationFrame(fold.current);
			morph.current?.cancel();
		};
	}, []);

	const [start, end] = range ?? [0, 1];
	const total = Math.max(1, end - start);
	const frac = (x: number) => Math.min(1, Math.max(0, (x - start) / total));

	/** The shape from `a` to `b`, left at `b`. */
	const tween = (a: Box, b: Box, ms: number, easing: string) => {
		const el = blob.current;
		if (!el) return;
		cancelAnimationFrame(fold.current);
		morph.current?.cancel();
		apply(el, b);
		morph.current = reduced() ? null : el.animate([frame(a), frame(b)], { duration: ms, easing });
	};

	/** The scrubber's width for a frame `fw` wide, inside the visible window. */
	const spanFor = (fw: number) => {
		const v = view();
		return Math.min(SPAN_MAX, Math.max(SPAN_MIN, fw * SPAN), v.right - v.left - EDGE * 2);
	};

	/** The scrubber's box, window px, for a press at (x, y): the playhead under x, inside the visible window. */
	const place = (x: number, y: number, fw: number, at: number, touch: boolean): Box => {
		const v = view();
		const width = spanFor(fw);
		const rail = width - INSET * 2;
		const left = Math.min(
			v.right - EDGE - width,
			Math.max(v.left + EDGE, x - INSET - frac(at) * rail),
		);
		const mid = Math.min(
			v.bottom - EDGE - HEIGHT / 2,
			Math.max(v.top + EDGE + HEIGHT / 2, touch ? y - LIFT_TOUCH : y),
		);
		return { left, top: mid - HEIGHT / 2, width, height: HEIGHT, radius: RADIUS };
	};

	/** The pill (or dot) `from` stretches into the scrubber at `to`. */
	const open = (from: Box, to: Box, at: number) => {
		setWidth(to.width);
		setT(at);
		setPhase("open");
		tween(from, to, IN_MS, EASE_IN);
	};

	/**
	 * The scrubber folds back into the pill. Frame by frame, aimed at wherever
	 * the pointer is at that frame, so a mouse moving meanwhile is met where it
	 * is, with no restart and no snap.
	 */
	const close = () => {
		const el = blob.current;
		if (!el || phaseRef.current !== "open") return;
		clearTimeout(linger.current);
		const from = boxOf(el);
		morph.current?.cancel();
		morph.current = null;
		setPhase("closing");
		if (reduced()) {
			apply(el, landing());
			setPhase("closed");
			return;
		}
		let t0 = 0;
		const step = (ts: number) => {
			if (!t0) t0 = ts;
			const k = Math.min(1, (ts - t0) / OUT_MS);
			apply(el, mix(from, landing(), ease(k)));
			if (k < 1) fold.current = requestAnimationFrame(step);
			else if (phaseRef.current === "closing") setPhase("closed");
		};
		cancelAnimationFrame(fold.current);
		fold.current = requestAnimationFrame(step);
	};

	/** Where the fold back lands: the pointer, on the visible window's edge if past it. */
	const landing = () => {
		const p = ptr.current;
		const v = view();
		const x = Math.min(v.right, Math.max(v.left, p.x));
		const y = Math.min(v.bottom, Math.max(v.top, p.y));
		return pillAt(x, y, p.mouse ? PILL : DOT);
	};

	const seek = (to: number, jump = false) => {
		const v = Math.min(end, Math.max(start, to));
		player.seek(v, { jump });
		setT(v);
	};

	/** Keep where the pointer is, window px; between presses the pill follows a mouse. */
	const track = (e: PointerEvent<HTMLDivElement>) => {
		const m = e.pointerType === "mouse";
		ptr.current = { x: e.clientX, y: e.clientY, mouse: m };
		if (m !== mouse) setMouse(m);
		// Folding back, the fold reads the pointer itself each frame.
		if (m && blob.current && phaseRef.current === "closed")
			apply(blob.current, pillAt(e.clientX, e.clientY, PILL));
	};

	// Pointer.

	const begin = (d: Drag) => {
		d.opened = true;
		// The press takes over from the keys: their linger and resume are its now.
		clearTimeout(linger.current);
		holdForKeys(false);
		player.pause();
		const to = place(d.x0, d.y0, d.rect.width, d.t0, d.touch);
		d.railL = to.left + INSET;
		d.railR = to.left + to.width - INSET;
		d.h0 = d.railL + frac(d.t0) * (d.railR - d.railL);
		// Where the pointer meets each end of the rail. Usually the rail's own
		// ends; when the rail sits past the pointer (squeezed in from a window
		// edge), the window's edge instead, so both ends stay reachable.
		const v = view();
		d.reachL = d.x0 > d.railL + 1 ? d.railL : v.left + 1;
		d.reachR = d.x0 < d.railR - 1 ? d.railR : v.right - 1;
		open(growFrom(d.x0, d.y0, d.touch), to, d.t0);
	};

	/** What a scrubber grows out of: the shape as it is if still up or folding back, else a pill (a dot under a finger) at (x, y). */
	const growFrom = (x: number, y: number, touch: boolean) =>
		phaseRef.current !== "closed" && blob.current
			? boxOf(blob.current)
			: pillAt(x, y, touch ? DOT : PILL);

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		const p = player;
		if (!range || drag.current) return;
		// Not the main button, or a macOS ctrl-click: that's the context menu.
		if (e.pointerType === "mouse" && (e.button !== 0 || e.ctrlKey)) return;
		zone.current?.setPointerCapture(e.pointerId);
		track(e);
		const rect = zone.current?.getBoundingClientRect();
		if (!rect) return;
		const d: Drag = {
			id: e.pointerId,
			touch: e.pointerType !== "mouse",
			x0: e.clientX,
			y0: e.clientY,
			rect,
			railL: 0,
			railR: 0,
			h0: 0,
			reachL: 0,
			reachR: 0,
			t0: p.time(),
			// Pressed while keys held it paused: it was playing all along.
			wasPlaying: p.playing || keyResume.current,
			opened: false,
			dx: 0,
			dy: 0,
			scrubbed: false,
		};
		drag.current = d;
		// A touch may turn out to be a page scroll: wait a moment before taking it.
		if (e.pointerType === "touch")
			d.timer = setTimeout(() => drag.current === d && begin(d), TOUCH_MS);
		else begin(d);
	};

	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		// A second finger: not ours, not even for where the fold lands.
		if (d && d.id !== e.pointerId) return;
		track(e);
		// Back after a scroll hid it: a mouse moving over the frame shows the pill again.
		if (!d && e.pointerType === "mouse" && !hover) setHover(true);
		if (!d) return;
		const dx = e.clientX - d.x0;
		d.dx = dx;
		d.dy = e.clientY - d.y0;
		if (Math.abs(dx) >= TOUCH_PX) d.scrubbed = true;
		// A touch that sets off up or down is a scroll: let it go, the page takes it.
		if (d.touch && !d.scrubbed && Math.abs(d.dy) > SCROLL_PX) {
			letGo(d, true);
			return;
		}
		if (!d.opened) {
			if (Math.abs(dx) < TOUCH_PX) return;
			clearTimeout(d.timer);
			begin(d);
		}
		seek(start + ((headAt(d, e.clientX) - d.railL) / (d.railR - d.railL)) * total);
	};

	/**
	 * The playhead for the pointer at `x`. From the press, each side maps the
	 * pointer's way to the rail's end onto the playhead's: 1:1 when the
	 * playhead starts under the pointer, a little faster or slower when the
	 * rail was squeezed in from an edge, so the two meet at the ends. No jump at
	 * the press, both ends always in reach.
	 */
	const headAt = (d: Drag, x: number) => {
		if (x >= d.x0) {
			const run = d.reachR - d.x0;
			return run > 0 ? d.h0 + (Math.min(x, d.reachR) - d.x0) * ((d.railR - d.h0) / run) : d.h0;
		}
		const run = d.x0 - d.reachL;
		return run > 0 ? d.h0 - (d.x0 - Math.max(x, d.reachL)) * ((d.h0 - d.railL) / run) : d.h0;
	};

	const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
		const d = drag.current;
		if (d && d.id === e.pointerId) letGo(d, cancelled);
	};

	/** The press ends. A touch the page took as a scroll before any scrubbing undoes itself. */
	const letGo = (d: Drag, cancelled: boolean) => {
		drag.current = null;
		clearTimeout(d.timer);
		if (!d.opened) return;
		if (cancelled && d.touch && !d.scrubbed) seek(d.t0);
		// Let go at the end, it holds there before looping, rather than restarting at once.
		if (d.wasPlaying) player.play({ rewind: false });
		close();
	};

	// Keyboard: the frame is a slider over the take.

	/** The keys went quiet: fold away, and play on if they paused it. */
	const closeKeys = () => {
		if (keyResume.current) player.play({ rewind: false });
		holdForKeys(false);
		close();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const p = player;
		if (!range) return;
		// Mid drag the pointer has it.
		if (drag.current) {
			if (e.key !== "Tab") e.preventDefault();
			return;
		}
		const now = p.time();
		const i = chapterAt(beats, now);
		let to: number;
		let jump = true;
		// By step when there are steps, else by KEY_BIG.
		const here = beats[i];
		const back = () =>
			here ? (beats[now - here.t > 1200 ? i : Math.max(0, i - 1)]?.t ?? start) : now - KEY_BIG;
		const fwd = () => (beats.length ? (beats[i + 1]?.t ?? end) : now + KEY_BIG);
		switch (e.key) {
			case "ArrowLeft":
				to = e.shiftKey ? back() : now - KEY_STEP;
				jump = e.shiftKey;
				break;
			case "ArrowRight":
				to = e.shiftKey ? fwd() : now + KEY_STEP;
				jump = e.shiftKey;
				break;
			case "PageUp":
				to = back();
				break;
			case "PageDown":
				to = fwd();
				break;
			case "Home":
				to = start;
				break;
			case "End":
				to = end;
				break;
			case " ":
			case "Enter": {
				e.preventDefault();
				// Held down, the key repeats: one press, one toggle.
				if (e.repeat) return;
				// Toggle what it looks like: keys holding it paused count as playing.
				const on = p.playing || keyResume.current;
				holdForKeys(false);
				if (on) p.pause();
				else p.play();
				if (phaseRef.current === "open") {
					clearTimeout(linger.current);
					close();
				}
				return;
			}
			default:
				return;
		}
		e.preventDefault();
		if (phaseRef.current !== "open") {
			// Held still while the keys move it, so the playhead shows where it is.
			if (p.playing) {
				p.pause();
				holdForKeys(true);
			}
			const r = zone.current?.getBoundingClientRect();
			if (!r) return;
			if (hover && ptr.current.mouse) {
				// A mouse rests over the frame: grow from its pill, fold back to it.
				const { x, y } = ptr.current;
				open(growFrom(x, y, false), place(x, y, r.width, now, false), now);
			} else {
				// No pointer to grow from: a pill at the frame's bottom middle, where it folds back to.
				const x = r.left + r.width / 2;
				const y = r.bottom - 14 - HEIGHT / 2;
				ptr.current = { x, y, mouse: true };
				setMouse(true);
				open(growFrom(x, y, false), place(x, y, r.width, now, false), now);
			}
		}
		seek(to, jump);
		clearTimeout(linger.current);
		linger.current = setTimeout(closeKeys, KEY_LINGER);
	};

	const at = chapterAt(beats, t);
	const pos = frac(t);
	const scrubbing = phase === "open";
	// What the slider says. While it plays on its own, it moves only step by
	// step, so a focused screen reader isn't read a new time every second.
	const steady = beats[active]
		? beats[active].t
		: start + Math.floor((time - start) / KEY_BIG) * KEY_BIG;
	const said = scrubbing ? t : playing ? Math.max(start, steady) : time;
	const saidStep = beats[scrubbing ? at : active]?.title;

	return (
		<>
			<div
				ref={zone}
				className={s.zone}
				role="slider"
				tabIndex={0}
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(frac(said) * 100)}
				aria-valuetext={
					saidStep ? `${clockText(said - start)}, ${saidStep}` : clockText(said - start)
				}
				onPointerDown={onPointerDown}
				onPointerEnter={(e) => {
					if (drag.current && drag.current.id !== e.pointerId) return;
					track(e);
					if (e.pointerType === "mouse") setHover(true);
				}}
				onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
				onContextMenu={(e) => drag.current && e.preventDefault()}
				onPointerMove={onPointerMove}
				onPointerUp={(e) => finish(e, false)}
				onPointerCancel={(e) => finish(e, true)}
				onLostPointerCapture={(e) => finish(e, false)}
				onKeyDown={onKeyDown}
				onBlur={() => !drag.current && phaseRef.current === "open" && closeKeys()}
			>
				{/* Over the window, not the frame: nothing in the page clips or blocks it. */}
				{createPortal(
					<div
						ref={blob}
						className={cn(s.blob, (phase !== "closed" || hover) && s.shown)}
						data-phase={phase}
						data-hover={hover && phase === "closed" ? "" : undefined}
						aria-hidden
					>
						{/* The pill's arrows, mouse only: they ride out to the ends as it stretches, then give way. */}
						{mouse && (
							<>
								<Chevron className={cn(s.chev, s.chevL)} left />
								<Chevron className={cn(s.chev, s.chevR)} />
							</>
						)}

						{phase !== "closed" && (
							<div className={s.inner} style={{ width, height: HEIGHT }}>
								{beats[at] && (
									<span key={at} className={s.title}>
										<b>{at + 1}</b>
										{beats[at]?.title}
									</span>
								)}
								<div className={s.rail}>
									<span className={s.fill} style={{ transform: `scaleX(${pos})` }} />
									{beats.map((b, i) => (
										<i
											key={b.title}
											className={cn(s.tick, i <= at && s.passed)}
											style={{ left: `${frac(b.t) * 100}%` }}
										/>
									))}
									<i className={cn(s.tick, pos >= 1 && s.passed)} style={{ left: "100%" }} />
									<span className={s.head} style={{ left: `${pos * 100}%` }} />
								</div>
							</div>
						)}
					</div>,
					document.body,
				)}
			</div>

			{/*
      Beside the slider, not in it: a control of its own, with the native
      pointer. There whenever it is paused as the viewer sees it, so Tab finds
      it straight away; out of sight while the scrubber is up.
    */}
			{!playing && !keyHeld && range && (
				<button
					type="button"
					className={cn(s.play, phase !== "closed" && s.playAway)}
					aria-label="Play"
					onClick={(e) => {
						// It goes as it plays: keep focus in the frame, not lost to the page.
						if (document.activeElement === e.currentTarget)
							zone.current?.focus({ preventScroll: true });
						player.play();
					}}
				>
					<PlayIcon />
				</button>
			)}
		</>
	);
}
