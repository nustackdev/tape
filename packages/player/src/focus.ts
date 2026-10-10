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
	Object.defineProperty(Document.prototype, "activeElement", {
		configurable: true,
		get(this: Document) {
			return activeElement() ?? this.body;
		},
	});
	// The app is always "focused": nothing in it should idle because the page around it has focus.
	Document.prototype.hasFocus = () => true;
}
