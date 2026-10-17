// Isolation. Whatever the app does, the replay stays in its frame: it doesn't
// navigate, open windows, block on dialogs, or react to the visitor's real
// pointer and keys. Installed before the app's first script runs, so every
// listener here is the first of its kind.

let allowed = 0;

/** Set while the replay dispatches recorded input, as opposed to the app's own script. */
export const replaying = { on: false };

/** Run `fn` with navigation allowed: the shim's own url changes. */
export function allowNavigation<T>(fn: () => T): T {
	allowed++;
	try {
		return fn();
	} finally {
		allowed--;
	}
}

/** Real input the frame must never act on. Script made events are untrusted and pass. */
export const REAL_INPUT = [
	"pointerdown",
	"pointerup",
	"pointermove",
	"pointerover",
	"pointerout",
	"pointerenter",
	"pointerleave",
	"pointercancel",
	"mousedown",
	"mouseup",
	"mousemove",
	"mouseover",
	"mouseout",
	"mouseenter",
	"mouseleave",
	"click",
	"auxclick",
	"dblclick",
	"contextmenu",
	"wheel",
	"keydown",
	"keyup",
	"keypress",
	"touchstart",
	"touchmove",
	"touchend",
	"touchcancel",
	"dragstart",
	"drop",
	// Real focus moving: the replay's focus is pretended, and its events are its own.
	"focus",
	"blur",
	"focusin",
	"focusout",
] as const;

interface NavigateEvent extends Event {
	navigationType: "push" | "replace" | "reload" | "traverse";
	hashChange: boolean;
	destination: { url: string };
}

export interface GuardOptions {
	/** The app moved to a fragment: same document, so it becomes a virtual push. */
	hashNav(url: string): void;
	/** The Navigation API object, when there is one. Defaults to the window's. */
	navigation?: EventTarget | null;
	/** Real focus came into the frame (a modal dialog, a label): the host takes it back. */
	realFocus?: () => void;
}

function define(on: object, name: string, value: unknown) {
	try {
		Object.defineProperty(on, name, { value, configurable: true, writable: true });
	} catch {}
}

function linkIn(e: Event): Element | null {
	for (const n of e.composedPath()) {
		if (n instanceof Element && n.matches("a[href], area[href]")) return n;
	}
	return null;
}

/**
 * Make `e`'s default action go, even if a handler stops it from reaching the
 * listener that would cancel it: stopping propagation cancels it too.
 */
function cancelOnStop(e: Event) {
	const stop = e.stopPropagation;
	const stopNow = e.stopImmediatePropagation;
	Object.defineProperties(e, {
		stopPropagation: {
			configurable: true,
			value(this: Event) {
				this.preventDefault();
				stop.call(this);
			},
		},
		stopImmediatePropagation: {
			configurable: true,
			value(this: Event) {
				this.preventDefault();
				stopNow.call(this);
			},
		},
	});
}

export function installGuards(win: Window & typeof globalThis, opts: GuardOptions): void {
	// Every navigation the frame starts: links, forms, location.*, reload. Cancelled at
	// the source, where the Navigation API has one.
	const nav =
		opts.navigation !== undefined
			? opts.navigation
			: ((win as unknown as { navigation?: EventTarget }).navigation ?? null);
	nav?.addEventListener("navigate", (ev) => {
		const e = ev as NavigateEvent;
		if (allowed || !e.cancelable) return;
		e.preventDefault();
		if (e.hashChange && (e.navigationType === "push" || e.navigationType === "replace")) {
			opts.hashNav(e.destination.url);
		}
	});

	// Links and forms, where there is no Navigation API, and as a second line where
	// there is. First in capture: a handler that stops the event cancels it too. Last
	// in bubble: cancelled after the app's own handlers had their say, so a router
	// that checks defaultPrevented still routes.
	for (const type of ["click", "auxclick"]) {
		win.addEventListener(type, (e) => linkIn(e) && cancelOnStop(e), true);
		win.addEventListener(type, (e) => linkIn(e) && e.preventDefault());
	}
	win.addEventListener("submit", cancelOnStop, true);
	win.addEventListener("submit", (e) => e.preventDefault());

	// A label's activation focuses its control for real. Never the browser's: for the
	// replay's own clicks the take recorded what the label passed on (the click on the
	// control, the focus); for the app's label.click() it is done here, pretended.
	win.addEventListener(
		"click",
		(e) => {
			const at = e.target instanceof Element ? e.target : null;
			const label = at?.closest("label");
			const control = label?.control;
			if (!control || control.contains(at)) return;
			e.preventDefault();
			if (replaying.on) return;
			queueMicrotask(() => {
				const checkable =
					control instanceof win.HTMLInputElement &&
					["checkbox", "radio", "button", "submit", "reset", "image", "file", "color"].includes(
						control.type,
					);
				if (checkable || control instanceof win.HTMLButtonElement) control.click();
				else control.focus();
			});
		},
		true,
	);

	// What never passes the window's listeners. A link clicked by script outside the
	// document: its click is cancelled on the link itself, first and last.
	const click = win.HTMLElement.prototype.click;
	Object.defineProperty(win.HTMLElement.prototype, "click", {
		configurable: true,
		writable: true,
		value(this: HTMLElement) {
			if (this.isConnected || !this.closest("a[href], area[href]")) return click.call(this);
			const first = (e: Event) => cancelOnStop(e);
			const last = (e: Event) => e.preventDefault();
			this.addEventListener("click", first, true);
			this.addEventListener("click", last);
			try {
				click.call(this);
			} finally {
				this.removeEventListener("click", first, true);
				this.removeEventListener("click", last);
			}
		},
	});
	// form.submit() navigates without a submit event: nothing to cancel, so it does nothing.
	// Validation would focus the field for real and show the browser's bubble: checked quietly.
	const form = win.HTMLFormElement.prototype;
	const requestSubmit = form.requestSubmit;
	define(form, "submit", () => {});
	define(form, "reportValidity", function (this: HTMLFormElement) {
		return this.checkValidity();
	});
	define(form, "requestSubmit", function (this: HTMLFormElement, submitter?: HTMLElement | null) {
		if (!this.noValidate && !this.checkValidity()) return;
		const wasNoValidate = this.noValidate;
		this.noValidate = true;
		try {
			requestSubmit.call(this, submitter);
		} finally {
			this.noValidate = wasNoValidate;
		}
	});
	for (const proto of [
		win.HTMLInputElement.prototype,
		win.HTMLSelectElement.prototype,
		win.HTMLTextAreaElement.prototype,
	]) {
		define(proto, "reportValidity", function (this: HTMLInputElement) {
			return this.checkValidity();
		});
	}

	// No windows, no dialogs. The sandbox blocks them too; this holds without it.
	define(win, "open", () => null);
	define(win, "alert", () => {});
	define(win, "confirm", () => false);
	define(win, "prompt", () => null);
	define(win, "print", () => {});

	// The visitor's real input never reaches the app: only the replay's does.
	for (const type of REAL_INPUT) {
		win.addEventListener(
			type,
			(e) => {
				if (!e.isTrusted) return;
				e.stopImmediatePropagation();
				if (e.cancelable) e.preventDefault();
				if (e.type === "focusin" || (e.type === "focus" && e.target === win)) opts.realFocus?.();
			},
			{ capture: true, passive: false },
		);
	}
}
