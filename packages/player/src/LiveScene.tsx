// <LiveScene>: the real app replaying a recorded session, with a cursor.
//
// A fixed size frame that is empty until the replay is on screen, so the page
// around it never shifts. It loads after first paint, and only once near the
// viewport when `lazy`. It plays while in view, pauses off screen and loops.
// With reduced motion it shows the last frame, still.
//
// The app runs in an iframe at the recorded viewport size and is scaled to
// fit, so its layout is exactly the recorded one. The iframe is inert: it
// never takes the pointer or focus. The cursor is drawn over it.

import { parseScene, playWindow, type Scene } from "@nustackdev/tape-scene";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Cursor, type CursorHandle } from "./cursor";
import { type Body, isTape, TAG, type ToParent, type ToShim } from "./protocol";

export interface LiveSceneProps {
	/** Url of the bundle's index.html, as `tape bundle` wrote it. */
	app: string;
	/** Url of a scene.json, or the scene itself. */
	scene: string | Scene;
	/** Frame width / height. Fixed up front so nothing shifts. Default 16 / 10. */
	aspect?: number;
	/** Load only once near the viewport. Default true. */
	lazy?: boolean;
	loop?: boolean;
	/** Pause at the end before looping, ms. Default 2500. */
	hold?: number;
	speed?: number;
	cursor?: boolean;
	/** Accessible description of what the scene shows. */
	label?: string;
	/** Behind the frame until it is ready. Empty by default. */
	placeholder?: ReactNode;
	className?: string;
	style?: CSSProperties;
	onReady?: () => void;
}

const FADE_MS = 400;
const scenes = new Map<string, Promise<Scene>>();

function loadScene(src: string | Scene): Promise<Scene> {
	if (typeof src !== "string") return Promise.resolve(parseScene(src));
	let p = scenes.get(src);
	if (!p) {
		p = fetch(src)
			.then((r) => {
				if (!r.ok) throw new Error(`tape: ${src} ${r.status}`);
				return r.text();
			})
			.then(parseScene);
		p.catch(() => scenes.delete(src));
		scenes.set(src, p);
	}
	return p;
}

function prefersReducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function LiveScene({
	app,
	scene: sceneSrc,
	aspect = 16 / 10,
	lazy = true,
	loop = true,
	hold = 2500,
	speed = 1,
	cursor = true,
	label,
	placeholder,
	className,
	style,
	onReady,
}: LiveSceneProps) {
	const box = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const pointer = useRef<CursorHandle>(null);
	const [active, setActive] = useState(false);
	const [scene, setScene] = useState<Scene | null>(null);
	const [run, setRun] = useState(0);
	const [shown, setShown] = useState(false);
	const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });
	const visible = useRef(false);
	const onReadyRef = useRef(onReady);
	onReadyRef.current = onReady;

	// Start after first paint; with `lazy`, once near the viewport. Track visibility for play/pause.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		let idle = 0;
		const start = () => {
			const ric = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
			idle = ric(() => setActive(true)) as number;
		};
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					visible.current = e.isIntersecting;
					if (e.isIntersecting && lazy) start();
				}
			},
			{ rootMargin: "200px" },
		);
		io.observe(el);
		if (!lazy) start();
		return () => {
			io.disconnect();
			(window.cancelIdleCallback ?? window.clearTimeout)(idle);
		};
	}, [lazy]);

	useEffect(() => {
		if (!active) return;
		let dead = false;
		loadScene(sceneSrc).then(
			(s) => !dead && setScene(s),
			(err) => console.error(err),
		);
		return () => {
			dead = true;
		};
	}, [active, sceneSrc]);

	// Scale the recorded viewport to fit the frame, centered.
	useEffect(() => {
		const el = box.current;
		if (!el || !scene) return;
		const { width, height } = scene.meta.viewport;
		const ro = new ResizeObserver(() => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			const scale = Math.min(w / width, h / height);
			setFit({ scale, x: (w - width * scale) / 2, y: (h - height * scale) / 2 });
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [scene]);

	// One run: handshake with the shim, then tick until the end, then loop.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the loop on purpose
	useEffect(() => {
		const win = frame.current?.contentWindow;
		if (!scene || !win) return;
		const [start, end] = playWindow(scene);
		const still = prefersReducedMotion();
		const send = (m: Body<ToShim>) => win.postMessage({ tape: TAG, ...m }, "*");

		let t = start;
		let clock = false;
		let last = 0;
		let raf = 0;
		let finishedAt = 0;
		let restart = 0;

		const step = (ts: number) => {
			raf = requestAnimationFrame(step);
			if (!clock) return;
			const playing = visible.current && !document.hidden;
			const dt = last ? Math.min(ts - last, 100) : 0;
			last = ts;
			if (!playing) return;
			if (t < end) {
				t = Math.min(end, t + dt * speed);
				send({ type: "tick", t });
				pointer.current?.seek(t);
				return;
			}
			finishedAt += dt;
			if (loop && finishedAt >= hold && !restart) {
				setShown(false);
				restart = window.setTimeout(() => setRun((r) => r + 1), FADE_MS);
			}
		};

		const onMessage = (ev: MessageEvent) => {
			if (ev.source !== win || !isTape<ToParent>(ev.data)) return;
			const m = ev.data;
			if (m.type === "hello") send({ type: "scene", scene });
			else if (m.type === "open" && !clock) {
				t = Math.max(start, scene.sockets[0]?.open ?? 0);
				if (still) {
					t = end;
					send({ type: "tick", t });
					return;
				}
				clock = true;
				send({ type: "tick", t });
				pointer.current?.reset(scene, t);
			} else if (m.type === "painted") {
				setShown(true);
				onReadyRef.current?.();
			}
		};
		window.addEventListener("message", onMessage);
		raf = requestAnimationFrame(step);
		return () => {
			window.removeEventListener("message", onMessage);
			cancelAnimationFrame(raf);
			clearTimeout(restart);
		};
	}, [scene, run, loop, hold, speed]);

	const vp = scene?.meta.viewport;
	return (
		<div
			ref={box}
			className={className}
			role="img"
			aria-label={label}
			style={{ position: "relative", overflow: "hidden", aspectRatio: String(aspect), ...style }}
		>
			{placeholder}
			{active && scene && vp && (
				<div
					style={{
						position: "absolute",
						left: 0,
						top: 0,
						width: vp.width,
						height: vp.height,
						transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
						transformOrigin: "0 0",
						opacity: shown && fit.scale > 0 ? 1 : 0,
						transition: `opacity ${FADE_MS}ms ease`,
					}}
				>
					<iframe
						key={run}
						ref={frame}
						src={app}
						title={label ?? "live scene"}
						aria-hidden
						tabIndex={-1}
						inert
						style={{
							width: vp.width,
							height: vp.height,
							border: 0,
							display: "block",
							pointerEvents: "none",
							colorScheme: "normal",
						}}
					/>
					{cursor && !prefersReducedMotion() && <Cursor ref={pointer} />}
				</div>
			)}
		</div>
	);
}
