// Input replay. The recorded pointer, buttons, keys and scrolls go into the
// app as DOM events, so what only the browser knew replays too: a menu
// opening, a field filling, a hover button showing, a sidebar expanding.
//
// Synthetic events run handlers but most default actions don't happen, so
// the ones that matter are done here by hand: focus on mousedown, text on
// keydown, caret placement, scroll positions. Pointer capture is patched,
// since a synthetic pointer can't be captured.

import type { ElementPath, SceneEvent } from "@nustackdev/tape-scene";
import { type EditKind, editText, execNative } from "./edit";
import { activeElement, focusTarget, setFocus, setModality } from "./focus";
import { setHover } from "./pseudo";

const POINTER_ID = 1;

function mods(m: number) {
	return { shiftKey: !!(m & 1), ctrlKey: !!(m & 2), altKey: !!(m & 4), metaKey: !!(m & 8) };
}

export function resolvePath(doc: Document, p: ElementPath): Element | null {
	if (p === "") return doc.scrollingElement;
	let el: Element | null = doc.documentElement;
	for (const i of p.split("/")) {
		el = el?.children[Number(i)] ?? null;
		if (!el) return null;
	}
	return el;
}

function isField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
	return (
		el instanceof HTMLTextAreaElement ||
		(el instanceof HTMLInputElement && el.selectionStart !== null)
	);
}

/** Set a field's value the way typing does, so frameworks tracking it see a change. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, v: string, data: string | null) {
	const proto =
		el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, v);
	el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
}

function caretAt(doc: Document, x: number, y: number) {
	const sel = doc.getSelection();
	if (!sel) return;
	const range = doc.caretRangeFromPoint?.(x, y);
	if (range) {
		sel.removeAllRanges();
		sel.addRange(range);
		return;
	}
	const pos = (
		doc as Document & {
			caretPositionFromPoint?: (
				x: number,
				y: number,
			) => { offsetNode: Node; offset: number } | null;
		}
	).caretPositionFromPoint?.(x, y);
	if (pos) sel.collapse(pos.offsetNode, pos.offset);
}

export class InputPlayer {
	private hovered: Element[] = [];
	private under: Element | null = null;
	private captured: Element | null = null;
	private buttons = 0;
	private x = -1;
	private y = -1;

	/**
	 * @param chars the take recorded keypress, the character step. Without it
	 * (older takes) text goes in on keydown.
	 */
	constructor(
		private doc: Document,
		private chars: boolean,
	) {
		const self = this;
		const proto = Element.prototype;
		proto.setPointerCapture = function (this: Element) {
			self.captured = this;
		};
		proto.releasePointerCapture = function (this: Element) {
			if (self.captured === this) self.captured = null;
		};
		proto.hasPointerCapture = function (this: Element) {
			return self.captured === this;
		};
	}

	private pointerInit(x: number, y: number, extra: MouseEventInit = {}): PointerEventInit {
		return {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: x,
			clientY: y,
			screenX: x,
			screenY: y,
			buttons: this.buttons,
			pointerId: POINTER_ID,
			pointerType: "mouse",
			isPrimary: true,
			view: this.doc.defaultView,
			...extra,
		};
	}

	/** Hit test again where the pointer stands: like a browser, hover follows the page changing under it. */
	hover() {
		if (this.x >= 0) this.move(this.x, this.y);
	}

	/** The pointer is at x, y now. Only an actual move fires pointermove. */
	move(x: number, y: number) {
		const moved = x !== this.x || y !== this.y;
		this.x = x;
		this.y = y;
		const el = this.doc.elementFromPoint(x, y);
		if (el !== this.under) {
			const init = this.pointerInit(x, y, { relatedTarget: el });
			const from = this.under;
			if (from?.isConnected) {
				from.dispatchEvent(new PointerEvent("pointerout", init));
				from.dispatchEvent(new MouseEvent("mouseout", init));
			}
			for (const e of this.hovered) {
				if (el && e.contains(el)) break;
				if (!e.isConnected) continue;
				e.dispatchEvent(new PointerEvent("pointerleave", { ...init, bubbles: false }));
				e.dispatchEvent(new MouseEvent("mouseleave", { ...init, bubbles: false }));
			}
			if (el) {
				const into = this.pointerInit(x, y, { relatedTarget: from });
				el.dispatchEvent(new PointerEvent("pointerover", into));
				el.dispatchEvent(new MouseEvent("mouseover", into));
				const entered: Element[] = [];
				for (
					let e: Element | null = el;
					e && !(from?.isConnected && e.contains(from));
					e = e.parentElement
				)
					entered.unshift(e);
				for (const e of entered) {
					e.dispatchEvent(new PointerEvent("pointerenter", { ...into, bubbles: false }));
					e.dispatchEvent(new MouseEvent("mouseenter", { ...into, bubbles: false }));
				}
			}
			this.under = el;
			this.hovered = setHover(this.hovered, el);
		}
		if (!moved) return;
		const target = this.captured?.isConnected ? this.captured : el;
		if (target) {
			const init = this.pointerInit(x, y);
			target.dispatchEvent(new PointerEvent("pointermove", init));
			target.dispatchEvent(new MouseEvent("mousemove", init));
		}
	}

	play(e: SceneEvent) {
		const doc = this.doc;
		switch (e.k) {
			case "down":
			case "up":
			case "click":
			case "dblclick":
			case "contextmenu": {
				this.move(e.x, e.y);
				const hit = doc.elementFromPoint(e.x, e.y);
				const at = (e.k === "up" && this.captured?.isConnected ? this.captured : hit) ?? doc.body;
				const extra = { button: e.b, ...mods(e.m) };
				if (e.k === "down") {
					setModality(false);
					this.buttons |= 1 << e.b;
					// As in a browser: a cancelled pointerdown means no mouse events and no focus change.
					const down =
						at.dispatchEvent(new PointerEvent("pointerdown", this.pointerInit(e.x, e.y, extra))) &&
						at.dispatchEvent(new MouseEvent("mousedown", this.pointerInit(e.x, e.y, extra)));
					// A mousedown nobody prevented moves focus and puts the caret where it landed.
					if (down) {
						const f = focusTarget(hit);
						setFocus(f);
						if (f instanceof HTMLElement && f.isContentEditable) caretAt(doc, e.x, e.y);
					}
				} else if (e.k === "up") {
					this.buttons &= ~(1 << e.b);
					if (at.dispatchEvent(new PointerEvent("pointerup", this.pointerInit(e.x, e.y, extra)))) {
						at.dispatchEvent(new MouseEvent("mouseup", this.pointerInit(e.x, e.y, extra)));
					}
					this.captured = null;
				} else if (e.k === "contextmenu") {
					at.dispatchEvent(new MouseEvent("contextmenu", this.pointerInit(e.x, e.y, extra)));
				} else {
					// A synthetic click still activates links, buttons, checkboxes and labels.
					const detail = e.k === "dblclick" ? 2 : 1;
					at.dispatchEvent(new MouseEvent(e.k, this.pointerInit(e.x, e.y, { ...extra, detail })));
				}
				return;
			}
			case "keydown":
			case "keypress":
			case "keyup": {
				// Typing into a field doesn't make the next focus "keyboard"; Tab and friends do.
				if (
					e.k === "keydown" &&
					e.key.length > 1 &&
					!["Shift", "Backspace", "Enter"].includes(e.key)
				) {
					setModality(true);
				}
				const target = activeElement() ?? doc.body;
				const init: KeyboardEventInit = {
					key: e.key,
					code: e.code,
					repeat: !!e.rep,
					bubbles: true,
					cancelable: true,
					composed: true,
					...mods(e.m),
				};
				const go = target.dispatchEvent(new KeyboardEvent(e.k, init));
				if (!go) return;
				if (e.m & (2 | 4 | 8)) {
					// Of the shortcuts, only select all edits what the replay shows; copy and paste reach nothing.
					if (e.k === "keydown" && !(e.m & 4) && e.key.toLowerCase() === "a") {
						this.selectAll(activeElement() ?? doc.body);
					}
					return;
				}
				// The text goes where focus is now: a keydown handler may have moved it, and in a
				// browser the key then types into the new place. Text goes in on the character
				// step, deleting on keydown. Takes from before keypress was recorded do it all on keydown.
				const deletes = e.key === "Backspace" || e.key === "Delete";
				if (e.k === "keypress" || (e.k === "keydown" && (deletes || !this.chars))) {
					this.edit(activeElement() ?? doc.body, e.key);
				}
				return;
			}
			case "scroll": {
				const el = resolvePath(doc, e.p);
				if (el) {
					el.scrollLeft = e.x;
					el.scrollTop = e.y;
				}
				return;
			}
			case "value": {
				const el = resolvePath(doc, e.p);
				if (isField(el) && el.value !== e.v) setValue(el, e.v, null);
				return;
			}
		}
	}

	/** Cmd/Ctrl+A nobody handled: the field's text, the editing host's content, or the page. */
	private selectAll(target: Element) {
		if (isField(target)) {
			target.select();
			return;
		}
		const sel = this.doc.getSelection();
		if (!sel) return;
		if (target instanceof HTMLElement && target.isContentEditable) {
			let host = target;
			while (host.parentElement?.isContentEditable) host = host.parentElement;
			sel.selectAllChildren(host);
			return;
		}
		sel.selectAllChildren(this.doc.body);
	}

	/** What the browser does for a key nobody handled. */
	private edit(target: Element, key: string) {
		const doc = this.doc;
		const text = key.length === 1 ? key : key === "Enter" ? "\n" : null;
		if (isField(target)) {
			const start = target.selectionStart ?? target.value.length;
			const end = target.selectionEnd ?? start;
			if (text === "\n" && target instanceof HTMLInputElement) {
				target.form?.requestSubmit();
				return;
			}
			let v = target.value;
			let caret = start;
			if (text !== null) {
				v = v.slice(0, start) + text + v.slice(end);
				caret = start + text.length;
			} else if (key === "Backspace") {
				const from = start === end ? Math.max(0, start - 1) : start;
				v = v.slice(0, from) + v.slice(end);
				caret = from;
			} else if (key === "Delete") {
				v = v.slice(0, start) + v.slice(start === end ? end + 1 : end);
			} else return;
			setValue(target, v, text);
			target.setSelectionRange(caret, caret);
			return;
		}
		if (target instanceof HTMLElement && target.isContentEditable) {
			const [kind, cmd]: [EditKind, string] | [null, null] =
				text === "\n"
					? ["insertParagraph", "insertParagraph"]
					: text !== null
						? ["insertText", "insertText"]
						: key === "Backspace"
							? ["deleteContentBackward", "delete"]
							: key === "Delete"
								? ["deleteContentForward", "forwardDelete"]
								: [null, null];
			if (!kind) return;
			const data = kind === "insertText" ? text : null;
			editText(doc, kind, data, () => execNative(doc, cmd, data ?? undefined));
		}
	}
}
