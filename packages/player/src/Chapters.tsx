"use client";

import { useEffect, useRef } from "react";
import { useTape, useTapeApi, useTapeStore } from "./Root";

/** Class names, styled in tape.css. */
const s = {
	root: "tape-chapters",
	track: "tape-chapters-track",
	fill: "tape-chapters-fill",
	hits: "tape-chapters-hits",
	hit: "tape-chapters-hit",
};

/** A move of the fill bigger than this share of the take is a jump: it glides there. */
const JUMP = 0.02;
/** The glide, as tape.css has it. */
const GLIDE_MS = 420;

/** Half a cut's width, px. */
const CUT = 1.5;

/** A mask that is solid but for a gap at each of `at`, % along. */
function cuts(at: number[]) {
	const stops = ["#000 0"];
	for (const p of at)
		stops.push(
			`#000 calc(${p}% - ${CUT}px)`,
			`transparent calc(${p}% - ${CUT}px)`,
			`transparent calc(${p}% + ${CUT}px)`,
			`#000 calc(${p}% + ${CUT}px)`,
		);
	return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export interface ChaptersProps {
	className?: string;
}

/**
 * Tape.Chapters — the take as a timeline cut into its chapters, each as long
 * as it plays, the cuts see-through. One fill runs along it with the clock, so a jump either way
 * glides as one line. Click a chapter to play from its start. Nothing
 * without chapters.
 */
export function Chapters({ className }: ChaptersProps) {
	const store = useTapeStore();
	const api = useTapeApi();
	const chapters = useTape((t) => t.chapters);
	const range = useTape((t) => t.range);
	const active = useTape((t) => t.chapter);
	const fill = useRef<HTMLSpanElement>(null);

	// The fill moves every frame: straight to the element, no render.
	useEffect(() => {
		if (!range) return;
		const [a, b] = range;
		let last = -1;
		let glide: ReturnType<typeof setTimeout> | undefined;
		const off = store.onFrame(() => {
			const el = fill.current;
			if (!el) return;
			const k = Math.min(1, Math.max(0, (store.engine.shown - a) / Math.max(1, b - a)));
			if (k === last) return;
			if (last >= 0 && Math.abs(k - last) > JUMP) {
				el.dataset.jump = "";
				clearTimeout(glide);
				glide = setTimeout(() => delete el.dataset.jump, GLIDE_MS);
			}
			last = k;
			el.style.transform = `scaleX(${k})`;
		});
		return () => {
			off();
			clearTimeout(glide);
		};
	}, [store, range]);

	if (!chapters.length) return null;
	const [a, b] = range ?? [0, 1];
	const span = Math.max(1, b - a);
	const at = (t: number) => Math.min(1, Math.max(0, (t - a) / span)) * 100;

	return (
		<div className={className ? `${s.root} ${className}` : s.root}>
			{/* The cuts between chapters are holes in the track, so whatever is behind shows through. */}
			<div
				className={s.track}
				style={range ? { maskImage: cuts(chapters.slice(1).map((c) => at(c.t))) } : undefined}
			>
				<span ref={fill} className={s.fill} />
			</div>
			{range && (
				<ol className={s.hits}>
					{chapters.map((c, i) => {
						const from = at(Math.max(c.t, a));
						const next = chapters[i + 1];
						const to = next ? at(next.t) : 100;
						return (
							<li key={c.t} style={{ left: `${from}%`, width: `${to - from}%` }}>
								<button
									type="button"
									className={s.hit}
									data-active={i === active || undefined}
									aria-current={i === active ? "step" : undefined}
									aria-label={`Chapter ${i + 1}: ${c.title}`}
									title={c.title}
									onClick={() => api.chapter(i)}
								/>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
