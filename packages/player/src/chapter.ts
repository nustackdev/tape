/**
 * A chapter of a take: what it shows from `t` on. Config, not part of the
 * recording, so the same take can be cut and told differently per page.
 */
export interface Chapter {
	/** Where it starts, ms of the take. Runs to the next chapter, the last to the end. */
	t: number;
	/** What happens, a bare verb phrase. */
	title: string;
	/** What follows from it, a line. */
	note?: string;
}

/** The chapter playing at `t`, or -1 with none. */
export function chapterAt(chapters: readonly Chapter[], t: number) {
	let i = chapters.length ? 0 : -1;
	chapters.forEach((c, j) => {
		if (t >= c.t) i = j;
	});
	return i;
}

/**
 * How far through the chapters `t` is, 0 to chapters.length: the chapter it
 * is in plus how much of it has played. The take runs from `from` to `to`.
 */
export function progressAt(chapters: readonly Chapter[], t: number, from: number, to: number) {
	const i = chapterAt(chapters, t);
	const c = chapters[i];
	if (!c) return 0;
	const a = Math.max(c.t, from);
	const b = chapters[i + 1]?.t ?? to;
	return b > a ? i + Math.min(1, Math.max(0, (t - a) / (b - a))) : i + 1;
}
