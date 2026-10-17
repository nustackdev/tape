// Nothing in the replay is selected but what it is editing. A selection
// anywhere else (a stray select all, find in page) is dropped.
//
// Not by selectionchange alone: WebKit doesn't fire it for a script selection
// over a page that is `user-select: none` (it draws none, so it sees no
// change), yet the Selection still holds the range and its text. So the
// app's own selection calls are checked as they return, selectionchange
// covers the browser's (find in page, real input), and `dropStray` is there
// for the executor to call as a backstop.

import { activeElement } from "./focus";
import { isField } from "./input";

/** The selection is collapsed, or inside what the replay is editing. */
function allowed(sel: Selection): boolean {
	if (sel.rangeCount === 0 || sel.isCollapsed) return true;
	const host = activeElement();
	if (!host) return false;
	// A field's own selection shows as an empty one around it.
	if (isField(host) && sel.toString() === "") return true;
	const { anchorNode: a, focusNode: f } = sel;
	return !!a && !!f && host.contains(a) && host.contains(f);
}

/** Drop the document's selection if it is outside what the replay is editing. */
export function dropStray(doc: Document = document): void {
	const sel = doc.getSelection();
	if (sel && !allowed(sel)) sel.removeAllRanges();
}

function after<T extends object>(proto: T, names: string[], check: (self: T) => void): void {
	for (const name of names) {
		const native = (proto as Record<string, unknown>)[name];
		if (typeof native !== "function") continue;
		Object.defineProperty(proto, name, {
			configurable: true,
			writable: true,
			value: function (this: T, ...args: unknown[]) {
				try {
					return native.apply(this, args);
				} finally {
					check(this);
				}
			},
		});
	}
}

export function installSelection(): void {
	after(
		Selection.prototype,
		["addRange", "setBaseAndExtent", "selectAllChildren", "extend", "modify"],
		(sel) => {
			if (!allowed(sel)) sel.removeAllRanges();
		},
	);
	// A range in the selection is live: moving it moves the selection.
	after(
		Range.prototype,
		[
			"setStart",
			"setEnd",
			"setStartBefore",
			"setStartAfter",
			"setEndBefore",
			"setEndAfter",
			"selectNode",
			"selectNodeContents",
		],
		(range) => {
			const sel = document.getSelection();
			if (sel && sel.rangeCount > 0 && sel.getRangeAt(0) === range) dropStray();
		},
	);
	// execCommand("selectAll") selects the page when nothing editable has the caret.
	after(Document.prototype, ["execCommand"], (doc) => dropStray(doc));
	document.addEventListener("selectionchange", () => dropStray());
}
