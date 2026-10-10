// Text editing in an editable, done by hand. The replay's focus is pretended
// (./focus.ts), so the browser's own editor isn't really in play, and running
// it anyway (execCommand) has a cost: Firefox scrolls the caret into view
// after every edit, unfocused or not, and carries that scroll up to the page
// around the replay, whatever its origin or css. So typing does what a
// browser's default action does, by hand: beforeinput, the DOM change if
// nobody cancelled it, input. Editors that watch the DOM (ProseMirror) read
// the change as they read native typing; editors that handle beforeinput
// themselves cancel it and do their own.
//
// Only what stays inside one text run is done here. Deleting across a block
// edge or a paragraph break goes to execCommand, as rare as it is in a take.

export type EditKind =
	| "insertText"
	| "deleteContentBackward"
	| "deleteContentForward"
	| "insertParagraph";

function editingHost(n: Node | null): HTMLElement | null {
	let el = n instanceof Element ? n : (n?.parentElement ?? null);
	if (!(el instanceof HTMLElement) || !el.isContentEditable) return null;
	while (el.parentElement?.isContentEditable) el = el.parentElement;
	return el as HTMLElement;
}

/** How many code units the character ending (or starting) at `i` takes. */
function charLen(s: string, i: number, back: boolean): number {
	const at = back ? i - 2 : i;
	const hi = s.charCodeAt(at);
	const lo = s.charCodeAt(at + 1);
	return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1;
}

/** An element left with nothing in it collapses; browsers keep a <br> there, so does this. */
function keepLine(doc: Document, t: Text) {
	const p = t.parentElement;
	if (t.data === "" && p && p.textContent === "" && !p.querySelector("br")) {
		p.appendChild(doc.createElement("br"));
	}
}

/** The change as a function, or null when it is not one done by hand. */
function plan(doc: Document, sel: Selection, kind: EditKind, data: string): (() => void) | null {
	if (kind === "insertParagraph" || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!range.collapsed) {
		return () => {
			range.deleteContents();
			sel.collapse(range.startContainer, range.startOffset);
			if (kind === "insertText") insert(doc, sel, data);
		};
	}
	if (kind === "insertText") return () => insert(doc, sel, data);
	const node = range.startContainer;
	const at = range.startOffset;
	if (!(node instanceof Text)) return null;
	if (kind === "deleteContentBackward") {
		if (at === 0) return null;
		return () => {
			const n = charLen(node.data, at, true);
			node.deleteData(at - n, n);
			sel.collapse(node, at - n);
			keepLine(doc, node);
		};
	}
	if (at >= node.length) return null;
	return () => {
		node.deleteData(at, charLen(node.data, at, false));
		sel.collapse(node, at);
		keepLine(doc, node);
	};
}

function insert(doc: Document, sel: Selection, text: string) {
	const range = sel.getRangeAt(0);
	let node = range.startContainer;
	let at = range.startOffset;
	if (!(node instanceof Text)) {
		// Between children: into the text run just before, or a new one.
		const before = node.childNodes[at - 1];
		if (before instanceof Text) {
			node = before;
			at = before.length;
		} else {
			const t = doc.createTextNode("");
			node.insertBefore(t, node.childNodes[at] ?? null);
			node = t;
			at = 0;
		}
	}
	const t = node as Text;
	t.insertData(at, text);
	sel.collapse(t, at + text.length);
}

/**
 * Edit at the selection in an editable, as typing would. `fromScript`: the
 * app called execCommand, which fires input but no beforeinput. False when
 * there is no editable at the selection.
 */
export function editText(
	doc: Document,
	kind: EditKind,
	data: string | null,
	native: () => boolean,
	fromScript = false,
): boolean {
	const sel = doc.getSelection();
	const host = editingHost(sel?.anchorNode ?? null);
	if (!sel || !host) return false;
	const change = plan(doc, sel, kind, data ?? "");
	if (!change) return native();
	const init = { bubbles: true, composed: true, inputType: kind, data };
	if (
		!fromScript &&
		!host.dispatchEvent(new InputEvent("beforeinput", { ...init, cancelable: true }))
	) {
		return true;
	}
	change();
	host.dispatchEvent(new InputEvent("input", init));
	return true;
}

let exec = Document.prototype.execCommand;

/** execCommand as it was before the patch below, for what is not done by hand. */
export function execNative(doc: Document, cmd: string, value?: string): boolean {
	return exec.call(doc, cmd, false, value);
}

/** The app's own execCommand for text goes the same way. */
export function installEdit(): void {
	exec = Document.prototype.execCommand;
	const kinds: Record<string, EditKind> = {
		inserttext: "insertText",
		delete: "deleteContentBackward",
		forwarddelete: "deleteContentForward",
	};
	Document.prototype.execCommand = function (
		this: Document,
		cmd: string,
		ui?: boolean,
		value?: string,
	) {
		const native = () => exec.call(this, cmd, ui, value);
		const kind = kinds[cmd.toLowerCase()];
		if (!kind || !editingHost(this.getSelection()?.anchorNode ?? null)) return native();
		return editText(this, kind, kind === "insertText" ? (value ?? "") : null, native, true);
	};
}
