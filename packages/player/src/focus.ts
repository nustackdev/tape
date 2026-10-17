// Virtual focus. Real focus inside the iframe would pull focus off the page
// around it, and handing it back blurs the app, which closes its menus. So
// inside the replay focus is pretended: focus() and blur() are patched,
// document.activeElement reports the pretend one, and the focus events fire
// by hand. Text still goes in without real focus, selection is enough.
//
// :focus styles follow through `data-tape-focus` (see ./pseudo.ts), and
// :focus-visible through `data-tape-focus-visible`, set the way browsers
// decide it: always for text entry, after the keyboard, and for a focus the
// app moves by script when the focus it left was showing.

export const FOCUS_ATTR = "data-tape-focus";
export const FOCUS_VISIBLE_ATTR = "data-tape-focus-visible";
export const FOCUS_WITHIN_ATTR = "data-tape-focus-within";

let current: Element | null = null;
let keyboard = false;

/** The last input was a key (true) or the pointer (false). */
export function setModality(fromKeyboard: boolean): void {
	keyboard = fromKeyboard;
}

function showsFocus(el: Element): boolean {
	if (keyboard) return true;
	if (el instanceof HTMLElement && el.isContentEditable) return true;
	if (el instanceof HTMLTextAreaElement) return true;
	return el instanceof HTMLInputElement && el.selectionStart !== null;
}

export function activeElement(): Element | null {
	return current?.isConnected ? current : null;
}

function chain(el: Element | null): Element[] {
	const out: Element[] = [];
	for (let e = el; e; e = e.parentElement) out.push(e);
	return out;
}

/**
 * Where a browser puts the caret focusing `host`: inside its first block, at
 * the start of its first text. Not before the first block: text typed there
 * lands outside any paragraph, and Firefox makes it a paragraph of its own.
 */
function firstCaret(host: HTMLElement): [Node, number] {
	let n: Node = host;
	for (let c = n.firstChild; c; c = n.firstChild) {
		if (c instanceof HTMLBRElement) break;
		if (c instanceof HTMLElement && !c.isContentEditable) break;
		if (!(c instanceof HTMLElement) && !(c instanceof Text)) break;
		n = c;
	}
	return [n, 0];
}

export function setFocus(el: Element | null, byScript = false): void {
	if (el && !el.isConnected) el = null;
	if (el === activeElement()) return;
	const old = activeElement();
	const wasVisible = !!old?.hasAttribute(FOCUS_VISIBLE_ATTR);
	current = el;
	if (old) {
		old.removeAttribute(FOCUS_ATTR);
		old.removeAttribute(FOCUS_VISIBLE_ATTR);
		for (const e of chain(old)) e.removeAttribute(FOCUS_WITHIN_ATTR);
		old.dispatchEvent(new FocusEvent("blur", { relatedTarget: el }));
		old.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: el }));
	}
	if (el) {
		// Focusing an editable moves the selection into it, as a browser does, unless it is in there already.
		if (el instanceof HTMLElement && el.isContentEditable) {
			const sel = el.ownerDocument.getSelection();
			if (sel && !(sel.anchorNode && el.contains(sel.anchorNode))) sel.collapse(...firstCaret(el));
		}
		el.setAttribute(FOCUS_ATTR, "");
		if (showsFocus(el) || (byScript && wasVisible)) el.setAttribute(FOCUS_VISIBLE_ATTR, "");
		for (const e of chain(el)) e.setAttribute(FOCUS_WITHIN_ATTR, "");
		el.dispatchEvent(new FocusEvent("focus", { relatedTarget: old }));
		el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: old }));
	}
}

/** What a mousedown on `el` would focus: the closest focusable ancestor, or nothing. */
export function focusTarget(el: Element | null): Element | null {
	for (let e = el; e; e = e.parentElement) {
		if (!(e instanceof HTMLElement) && !(e instanceof SVGElement)) continue;
		if (e instanceof HTMLElement && e.isContentEditable) {
			// The editing host, not the paragraph inside it.
			let host: HTMLElement = e;
			while (host.parentElement?.isContentEditable) host = host.parentElement;
			return host;
		}
		if (
			e.matches(
				"input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]",
			)
		) {
			return e;
		}
	}
	return null;
}

export function installFocus(): void {
	const focus = function (this: Element) {
		setFocus(this, true);
	};
	const blur = function (this: Element) {
		if (activeElement() === this) setFocus(null);
	};
	for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
		Object.defineProperty(proto, "focus", { value: focus, configurable: true, writable: true });
		Object.defineProperty(proto, "blur", { value: blur, configurable: true, writable: true });
	}
	// select() focuses the field for real, which would pull the frame into focus: the
	// page's caret and keys would go to it, and browsers scroll the page to its caret.
	for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
		Object.defineProperty(proto, "select", {
			configurable: true,
			writable: true,
			value(this: HTMLInputElement | HTMLTextAreaElement) {
				setFocus(this, true);
				try {
					this.setSelectionRange(0, this.value.length);
				} catch {
					// A type with no text selection (number, email): focus is all select() shows.
				}
			},
		});
	}
	// autofocus would focus for real, and scroll the page around the frame to it:
	// the attribute goes as the element arrives, and the focus is pretended.
	const autofocus = (el: Element) => {
		el.removeAttribute("autofocus");
		queueMicrotask(() => el.isConnected && setFocus(el, true));
	};
	// Set by script, it never reaches the element: the browser acts on it as it is set.
	const later = (el: Element) => queueMicrotask(() => el.isConnected && setFocus(el, true));
	for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
		Object.defineProperty(proto, "autofocus", {
			configurable: true,
			get: () => false,
			set(this: Element, on: boolean) {
				if (on) later(this);
			},
		});
	}
	// Parsed from html: taken out of the markup first, the elements focused pretended.
	const inner = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
	const parsed = (html: string, put: (clean: string) => void, root: () => ParentNode) => {
		if (!/autofocus/i.test(html) || !inner?.set) return put(html);
		const t = document.createElement("template");
		inner.set.call(t, html);
		const marked = [...t.content.querySelectorAll("[autofocus]")];
		for (const el of marked) el.setAttribute("data-tape-autofocus", "");
		for (const el of marked) el.removeAttribute("autofocus");
		put(t.innerHTML);
		for (const el of root().querySelectorAll("[data-tape-autofocus]")) {
			el.removeAttribute("data-tape-autofocus");
			later(el);
		}
	};
	if (inner?.set) {
		const set = inner.set;
		Object.defineProperty(Element.prototype, "innerHTML", {
			...inner,
			set(this: Element, html: string) {
				parsed(
					String(html),
					(clean) => set.call(this, clean),
					() => this,
				);
			},
		});
	}
	const adjacent = Element.prototype.insertAdjacentHTML;
	Element.prototype.insertAdjacentHTML = function (
		this: Element,
		where: InsertPosition,
		html: string,
	) {
		parsed(
			String(html),
			(clean) => adjacent.call(this, where, clean),
			() => this.parentNode ?? this,
		);
	};
	const setAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
		if (name.length === 9 && name.toLowerCase() === "autofocus") {
			later(this);
			return;
		}
		setAttribute.call(this, name, value);
	};
	new MutationObserver((records) => {
		for (const r of records) {
			if (r.type === "attributes" && r.target instanceof Element) {
				if (r.target.hasAttribute("autofocus")) autofocus(r.target);
				continue;
			}
			for (const n of r.addedNodes) {
				if (!(n instanceof Element)) continue;
				if (n.hasAttribute("autofocus")) autofocus(n);
				for (const c of n.querySelectorAll("[autofocus]")) autofocus(c);
			}
		}
	}).observe(document, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["autofocus"],
	});
	// A modal dialog focuses inside itself for real (the host takes focus back); the
	// replay's focus goes where the browser's would.
	const showModal = HTMLDialogElement.prototype.showModal;
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		writable: true,
		value(this: HTMLDialogElement) {
			// Inert while it opens: the dialog focusing steps skip an inert dialog.
			const inert = this.inert;
			this.inert = true;
			try {
				showModal.call(this);
			} finally {
				this.inert = inert;
			}
			const inside = this.querySelector(
				"[autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]",
			);
			setFocus(inside ?? this, true);
		},
	});
	Object.defineProperty(Document.prototype, "activeElement", {
		configurable: true,
		get(this: Document) {
			return activeElement() ?? this.body;
		},
	});
	// The app is always "focused": nothing in it should idle because the page around it has focus.
	Document.prototype.hasFocus = () => true;
}
