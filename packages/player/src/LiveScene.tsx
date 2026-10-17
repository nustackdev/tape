// <LiveScene>: the real app replaying a recorded session, with a cursor, in
// one tag. The same kernel as the Tape parts (Tape.Root and Tape.Frame, which
// it is made of), without the controls. Import "@nustackdev/tape-player/tape.css".
//
// A fixed size frame that is empty until the replay is on screen, so the page
// around it never shifts. It loads once near the viewport when `lazy`, plays
// while in view, pauses off screen and loops. With reduced motion it shows the
// last frame, still.

import type { Scene } from "@nustackdev/tape-scene";
import { type CSSProperties, type ReactNode, useEffect } from "react";
import { Frame } from "./Frame";
import { Root, useTape, useTapeApi } from "./Root";

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
	 * Null for none. Default: a disc.
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

/** The default arrow, tip at the top left. */
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

function reducedMotion() {
	return (
		typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
	);
}

/** Under reduced motion, the last frame. */
function StillAtEnd() {
	const api = useTapeApi();
	const range = useTape((s) => s.range);
	useEffect(() => {
		if (range && reducedMotion()) api.seek(range[1], { jump: true });
	}, [api, range]);
	return null;
}

export function LiveScene({
	app,
	scene,
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
	return (
		<Root
			scene={scene}
			app={app}
			label={label ?? "a recorded session"}
			storage={storage}
			loop={loop}
			hold={hold}
			rate={speed}
			input={input}
			eager={!lazy}
			onReady={onReady}
		>
			<StillAtEnd />
			<Frame
				aspect={aspect}
				cursor={cursor === true ? ARROW : cursor === false ? false : cursor}
				click={click}
				clickMs={clickMs}
				placeholder={placeholder ?? false}
				className={className}
				style={style}
			/>
		</Root>
	);
}
