"use client";

import type { ReactNode } from "react";
import type { Chapter } from "./chapter";
import { useTape } from "./Root";

/** Class names, styled in tape.css. */
const s = {
	caption: "tape-caption",
	line: "tape-caption-line",
	num: "tape-caption-num",
	of: "tape-caption-of",
	text: "tape-caption-text",
	title: "tape-caption-title",
	note: "tape-caption-note",
};

export interface CaptionProps {
	className?: string;
	/** Render the chapter yourself; the default is its number, title and note. */
	children?: (chapter: Chapter, i: number, count: number) => ReactNode;
}

/**
 * Tape.Caption — the chapter playing, as a line of text. Anywhere inside
 * Tape.Root; it swaps with a short rise as the chapter changes. Nothing
 * without chapters.
 */
export function Caption({ className, children }: CaptionProps) {
	const chapters = useTape((t) => t.chapters);
	const i = useTape((t) => t.chapter);
	const c = chapters[i];
	if (!c) return null;
	return (
		<div className={className ? `${s.caption} ${className}` : s.caption}>
			<div key={i} className={s.line}>
				{children ? (
					children(c, i, chapters.length)
				) : (
					<>
						<span className={s.num}>
							{String(i + 1).padStart(2, "0")}
							<span className={s.of}>/{String(chapters.length).padStart(2, "0")}</span>
						</span>
						<span className={s.text}>
							<b className={s.title}>{c.title}</b>
							{c.note ? <span className={s.note}>{c.note}</span> : null}
						</span>
					</>
				)}
			</div>
		</div>
	);
}
