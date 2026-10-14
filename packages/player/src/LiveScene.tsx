// <LiveScene>: the real app replaying a recorded session, with a cursor.
//
// A fixed size frame that is empty until the replay is on screen, so the page
// around it never shifts. It loads after first paint, and only once near the
// viewport when `lazy`. It plays while in view, pauses off screen and loops,
// the next run loading behind the last frame so the loop never goes blank.
// With reduced motion it shows the last frame, still.
//
// The app runs in an iframe at the recorded viewport size and is scaled to
// fit, so its layout is exactly the recorded one. The viewer can't reach into
// it: no pointer, not in the tab order, focus inside it is pretended. The
// cursor is drawn over it.

import { parseScene, playWindow, type Scene } from "@nustackdev/tape-scene";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { Cursor, type CursorHandle } from "./cursor";
import { type Body, isTape, TAG, TAKE_KEY, type ToParent, type ToShim } from "./protocol";

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
	/**
	 * The cursor. False for none, or your own node, drawn with its top left on
	 * the pointer tip. It sits in a box carrying `data-down="1"` while pressed,
	 * for styling a press. Sizes are in the recorded viewport's px. Default: an arrow.
	 */
	cursor?: boolean | ReactNode;
	/**
	 * Drawn at each click, centred on it, for `clickMs`. Animate it with CSS.
	 * Null for none. Default: a ripple.
	 */
	click?: ReactNode;
	/** How long a click stays drawn, ms. Default 450. */
	clickMs?: number;
	/** Replay recorded input into the app too, so local UI plays: menus, typing, hover. Default true. */
	input?: boolean;
	/**
	 * localStorage keys laid over the take's at load: the app's theme, say, to
	 * match the page around it. Apps read their storage once, as they start,
	 * so a change restarts the replay.
	 */
	storage?: Record<string, string>;
	/** Accessible description of what the scene shows. */
	label?: string;
	/** Behind the frame until it is ready. Empty by default. */
	placeholder?: ReactNode;
	className?: string;
	style?: CSSProperties;
	onReady?: () => void;
}

const FADE_MS = 400;
/** Ids for takes, unique across every scene on the page. */
let takes = 0;
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

function withStorage(scene: Scene, over: Record<string, string> | undefined): Scene {
	if (!over) return scene;
	return { ...scene, storage: { ...scene.storage, local: { ...scene.storage.local, ...over } } };
}

function prefersReducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

interface TakeProps {
	app: string;
	scene: Scene;
	storage: Record<string, string> | undefined;
	input: boolean;
	speed: number;
	hold: number;
	label: string | undefined;
	/** The clock runs and drives the cursor. */
	live: boolean;
	/** Shown. A take loading behind the live one is not. */
	on: boolean;
	visible: RefObject<boolean>;
	pointer: RefObject<CursorHandle | null>;
	/** The first frame is painted. */
	onReady: () => void;
	/** Played to the end: time to load the next run. */
	onEnd: () => void;
	/** And held there `hold` ms: time to show it. */
	onHeld: () => void;
}

/** One run of the scene in its own iframe: handshake with the shim, then tick to the end. */
function Take(props: TakeProps) {
	const { app, scene, label, live, on } = props;
	const frame = useRef<HTMLIFrameElement>(null);
	const [id] = useState(() => String(takes++));
	const ref = useRef(props);
	ref.current = props;
	/** Where this run is, for the cursor when it goes live. */
	const at = useRef<number | null>(null);

	useEffect(() => {
		const win = frame.current?.contentWindow;
		if (!win) return;
		const [start, end] = playWindow(scene);
		const still = prefersReducedMotion();
		const send = (m: Body<ToShim>) => win.postMessage({ tape: TAG, ...m }, "*");

		let t = start;
		let clock = false;
		let last = 0;
		let raf = 0;
		let finished = -1;

		const step = (ts: number) => {
			raf = requestAnimationFrame(step);
			if (!clock) return;
			const p = ref.current;
			const playing = p.live && p.visible.current && !document.hidden;
			const dt = last ? Math.min(ts - last, 100) : 0;
			last = ts;
			if (!playing) return;
			if (t < end) {
				t = Math.min(end, t + dt * p.speed);
				at.current = t;
				send({ type: "tick", t });
				p.pointer.current?.seek(t);
				return;
			}
			if (finished < 0) {
				finished = 0;
				p.onEnd();
			}
			const before = finished;
			finished += dt;
			if (before < p.hold && finished >= p.hold) p.onHeld();
		};

		const onMessage = (ev: MessageEvent) => {
			// By take, not by ev.source: WebKit sometimes gives this page as the source.
			if (!isTape<ToParent>(ev.data) || ev.data.take !== id) return;
			const m = ev.data;
			const p = ref.current;
			if (m.type === "hello")
				send({ type: "scene", scene: withStorage(scene, p.storage), input: p.input });
			else if (m.type === "open" && !clock) {
				t = Math.max(start, scene.sockets[0]?.open ?? 0);
				if (still) {
					t = end;
					send({ type: "tick", t });
					return;
				}
				clock = true;
				at.current = t;
				send({ type: "tick", t });
				if (p.live) p.pointer.current?.reset(scene, t);
			} else if (m.type === "painted") p.onReady();
		};
		window.addEventListener("message", onMessage);
		raf = requestAnimationFrame(step);
		return () => {
			window.removeEventListener("message", onMessage);
			cancelAnimationFrame(raf);
		};
	}, [scene, id]);

	// A take loaded behind the live one takes the cursor over where it stands.
	useEffect(() => {
		if (live && at.current !== null) ref.current.pointer.current?.reset(scene, at.current);
	}, [live, scene]);

	const vp = scene.meta.viewport;
	return (
		<iframe
			ref={frame}
			src={`${app}#${TAKE_KEY}=${id}`}
			title={label ?? "live scene"}
			aria-hidden
			tabIndex={-1}
			style={{
				position: "absolute",
				left: 0,
				top: 0,
				width: vp.width,
				height: vp.height,
				border: 0,
				display: "block",
				pointerEvents: "none",
				colorScheme: "normal",
				opacity: on ? 1 : 0,
				transition: `opacity ${FADE_MS}ms ease`,
			}}
		/>
	);
}

interface Slot {
	id: number;
	storage: Record<string, string> | undefined;
	ready: boolean;
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
	click,
	clickMs = 450,
	input = true,
	storage,
	label,
	placeholder,
	className,
	style,
	onReady,
}: LiveSceneProps) {
	const box = useRef<HTMLDivElement>(null);
	const pointer = useRef<CursorHandle>(null);
	const [active, setActive] = useState(false);
	const [scene, setScene] = useState<Scene | null>(null);
	const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });
	const visible = useRef(false);
	const onReadyRef = useRef(onReady);
	onReadyRef.current = onReady;
	const storageRef = useRef(storage);
	storageRef.current = storage;
	const storageKey = JSON.stringify(storage ?? {});
	const firstStorage = useRef(storageKey);

	// The live run, and the next one loading behind it once the live one ends.
	// The next is shown over the last frame of the live one when it has painted,
	// so a loop never goes blank.
	const ids = useRef(1);
	const [slots, setSlots] = useState<Slot[]>(() => [{ id: 0, storage, ready: false }]);
	const [front, setFront] = useState(0);
	const [held, setHeld] = useState(false);

	const queue = (hand: boolean) => {
		const id = ids.current++;
		setSlots((s) => [
			...s.filter((x) => x.id === front),
			{ id, storage: storageRef.current, ready: false },
		]);
		if (hand) setHeld(true);
	};

	// New storage: a fresh run, shown as soon as it has painted.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a change of storage matters
	useEffect(() => {
		if (storageKey === firstStorage.current) return;
		firstStorage.current = storageKey;
		queue(true);
	}, [storageKey]);

	const last = slots[slots.length - 1];
	const next = last && last.id !== front ? last : undefined;
	useEffect(() => {
		if (!next?.ready || !held) return;
		setFront(next.id);
		setHeld(false);
	}, [next?.ready, next?.id, held]);

	// The old run goes once the new one has faded in over it.
	useEffect(() => {
		const id = window.setTimeout(
			() =>
				setSlots((s) =>
					s.slice(
						Math.max(
							0,
							s.findIndex((x) => x.id === front),
						),
					),
				),
			FADE_MS,
		);
		return () => clearTimeout(id);
	}, [front]);

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
						opacity: fit.scale > 0 ? 1 : 0,
					}}
				>
					{slots.map((slot, i) => (
						<Take
							key={slot.id}
							app={app}
							scene={scene}
							storage={slot.storage}
							input={input}
							speed={speed}
							hold={hold}
							label={label}
							live={slot.id === front}
							// The one underneath stays up while the next fades in over it.
							on={slot.ready && (slot.id === front || i === 0)}
							visible={visible}
							pointer={pointer}
							onReady={() => {
								setSlots((s) => s.map((x) => (x.id === slot.id ? { ...x, ready: true } : x)));
								if (slot.id === 0) onReadyRef.current?.();
							}}
							onEnd={() => {
								if (loop && slot.id === front && !next) queue(false);
							}}
							onHeld={() => {
								if (slot.id === front) setHeld(true);
							}}
						/>
					))}
					{cursor !== false && !prefersReducedMotion() && (
						<Cursor
							ref={pointer}
							arrow={cursor === true ? undefined : cursor}
							click={click}
							clickMs={clickMs}
						/>
					)}
				</div>
			)}
			{/* Over the replay, so touch never reaches it: iOS scrolls an iframe's page despite pointer-events none. A swipe here scrolls the page around. */}
			<div style={{ position: "absolute", inset: 0 }} />
		</div>
	);
}
