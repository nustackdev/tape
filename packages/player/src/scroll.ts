// Scrolling stays inside the replay. A same origin iframe's scrollIntoView
// scrolls the page around it too, so the app bringing a cell into view would
// pull the viewer's page to the frame, again on every call. Here it scrolls
// the app's own scroll containers and its viewport, as it would in its own
// tab, and stops there.

type Align = ScrollLogicalPosition;

/** How far a container scrolls to show [start, end] within [vStart, vEnd]. */
function delta(mode: Align, start: number, end: number, vStart: number, vEnd: number): number {
	if (mode === "start") return start - vStart;
	if (mode === "end") return end - vEnd;
	if (mode === "center") return (start + end) / 2 - (vStart + vEnd) / 2;
	if (start >= vStart && end <= vEnd) return 0;
	// Nearest: the closer edge, or the start when it is bigger than the view.
	return start < vStart === end - start <= vEnd - vStart ? start - vStart : end - vEnd;
}

function scrolls(el: Element, doc: Document): boolean {
	if (el === doc.scrollingElement) return true;
	const s = getComputedStyle(el);
	const can = (o: string) => o === "auto" || o === "scroll" || o === "hidden" || o === "overlay";
	return (
		(can(s.overflowY) && el.scrollHeight > el.clientHeight) ||
		(can(s.overflowX) && el.scrollWidth > el.clientWidth)
	);
}

/** `ifNeeded`: leave a container alone when the element is in its view already. */
export function scrollIntoDoc(
	el: Element,
	arg?: boolean | ScrollIntoViewOptions,
	ifNeeded = false,
): void {
	const doc = el.ownerDocument;
	const o: ScrollIntoViewOptions =
		typeof arg === "object" ? arg : { block: arg === false ? "end" : "start" };
	const block = o.block ?? "start";
	const inline = o.inline ?? "nearest";
	let { left, top, right, bottom } = el.getBoundingClientRect();
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (!scrolls(p, doc)) continue;
		let vl: number;
		let vt: number;
		if (p === doc.scrollingElement) {
			vl = 0;
			vt = 0;
		} else {
			const b = p.getBoundingClientRect();
			vl = b.left + p.clientLeft;
			vt = b.top + p.clientTop;
		}
		const vr = vl + p.clientWidth;
		const vb = vt + p.clientHeight;
		const seen = ifNeeded && left >= vl && right <= vr && top >= vt && bottom <= vb;
		const dx = seen ? 0 : delta(inline, left, right, vl, vr);
		const dy = seen ? 0 : delta(block, top, bottom, vt, vb);
		const x = Math.max(0, Math.min(p.scrollLeft + dx, p.scrollWidth - p.clientWidth));
		const y = Math.max(0, Math.min(p.scrollTop + dy, p.scrollHeight - p.clientHeight));
		const mx = x - p.scrollLeft;
		const my = y - p.scrollTop;
		if (mx || my) p.scrollTo({ left: x, top: y, behavior: o.behavior });
		left -= mx;
		right -= mx;
		top -= my;
		bottom -= my;
		if (p === doc.scrollingElement) break;
	}
}

export function installScroll(): void {
	holdPageOnEdit();
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		writable: true,
		value(this: Element, arg?: boolean | ScrollIntoViewOptions) {
			scrollIntoDoc(this, arg);
		},
	});
	// Chrome's older form: center, only when out of view.
	Object.defineProperty(Element.prototype, "scrollIntoViewIfNeeded", {
		configurable: true,
		writable: true,
		value(this: Element, center = true) {
			const at = center ? "center" : "nearest";
			scrollIntoDoc(this, { block: at, inline: at }, true);
		},
	});
}

/**
 * A backstop for the edits still left to the browser's editor (./edit.ts does
 * the common ones by hand). Firefox scrolls the caret into view after every
 * edit, even in an unfocused frame, and carries it up to the page whatever
 * the frame's origin or the page's css. So each execCommand notes where the
 * page stands and puts it back in the page's scroll events for the next two
 * frames. Late by a frame in a real window, so a jolt rather than a jump,
 * which is why typing doesn't come this way. A viewer scrolling right then
 * (wheel, touch, keys, a pointer held down) wins. A page the replay can't
 * reach (cross origin) is left alone.
 */
function holdPageOnEdit(): void {
	let page: Window;
	try {
		if (window.parent === window) return;
		void window.parent.scrollY;
		page = window.parent;
	} catch {
		return;
	}
	let held: { x: number; y: number } | null = null;
	let viewer = false;
	let down = false;
	const mark = () => {
		viewer = true;
	};
	for (const type of ["wheel", "touchmove", "keydown"]) {
		page.addEventListener(type, mark, { capture: true, passive: true });
	}
	page.addEventListener(
		"pointerdown",
		() => {
			down = true;
			viewer = true;
		},
		{ capture: true, passive: true },
	);
	page.addEventListener(
		"pointerup",
		() => {
			down = false;
		},
		{ capture: true, passive: true },
	);
	page.addEventListener(
		"scroll",
		() => {
			if (!held || viewer || down) return;
			if (page.scrollX !== held.x || page.scrollY !== held.y) {
				page.scrollTo({ left: held.x, top: held.y, behavior: "instant" });
			}
		},
		{ capture: true, passive: true },
	);
	const hold = () => {
		if (held) return;
		held = { x: page.scrollX, y: page.scrollY };
		viewer = false;
		page.requestAnimationFrame(() =>
			page.requestAnimationFrame(() => {
				held = null;
			}),
		);
	};
	const exec = Document.prototype.execCommand;
	Document.prototype.execCommand = function (
		this: Document,
		...args: Parameters<Document["execCommand"]>
	) {
		hold();
		return exec.apply(this, args);
	};
}
