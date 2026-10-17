// @vitest-environment happy-dom
import { installTargets } from "@nustackdev/tape-scene";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { setFocus } from "./focus";
import { allowNavigation, installGuards } from "./guard";
import { installHistory } from "./history";
import { InputPlayer } from "./input";

type Win = Window & typeof globalThis;

/** A stand-in for the Navigation API's navigate event. */
function navigate(nav: EventTarget, init: { hashChange?: boolean; type?: string; url?: string }) {
	const e = new Event("navigate", { cancelable: true });
	Object.assign(e, {
		hashChange: !!init.hashChange,
		navigationType: init.type ?? "push",
		destination: { url: init.url ?? "https://site.test/x" },
	});
	nav.dispatchEvent(e);
	return e;
}

const nav = new EventTarget();
const hashNav = vi.fn();

beforeAll(() => {
	installGuards(window as Win, { hashNav, navigation: nav });
});

describe("navigation guard", () => {
	it("cancels every navigation the frame starts, but the shim's own", () => {
		expect(navigate(nav, { type: "reload" }).defaultPrevented).toBe(true);
		expect(navigate(nav, { type: "push" }).defaultPrevented).toBe(true);
		const own = allowNavigation(() => navigate(nav, { type: "replace" }));
		expect(own.defaultPrevented).toBe(false);
	});

	it("turns a fragment navigation into a virtual one", () => {
		navigate(nav, { hashChange: true, url: "https://site.test/#two" });
		expect(hashNav).toHaveBeenCalledWith("https://site.test/#two");
	});

	it("cancels a link's default, after the app's handlers, even when one stops the event", () => {
		document.body.innerHTML = `<a id="go" href="https://elsewhere.test/">go</a><a id="stop" href="/x"><span>in</span></a>`;
		const go = document.getElementById("go") as HTMLAnchorElement;
		let seen = false;
		go.addEventListener("click", (e) => {
			// A router checks this before routing: still free when the app looks.
			seen = !e.defaultPrevented;
		});
		const a = new MouseEvent("click", { bubbles: true, cancelable: true });
		go.dispatchEvent(a);
		expect(seen).toBe(true);
		expect(a.defaultPrevented).toBe(true);

		const stop = document.getElementById("stop") as HTMLAnchorElement;
		stop.addEventListener("click", (e) => e.stopPropagation());
		const b = new MouseEvent("click", { bubbles: true, cancelable: true });
		stop.querySelector("span")?.dispatchEvent(b);
		expect(b.defaultPrevented).toBe(true);
	});

	it("leaves other clicks alone", () => {
		document.body.innerHTML = `<button id="b">b</button>`;
		const b = document.getElementById("b") as HTMLButtonElement;
		b.addEventListener("click", (e) => e.stopPropagation());
		const e = new MouseEvent("click", { bubbles: true, cancelable: true });
		b.dispatchEvent(e);
		expect(e.defaultPrevented).toBe(false);
	});

	it("cancels form submits, even when the app stops them", () => {
		document.body.innerHTML = `<form id="f" action="/post"><input name="q"></form>`;
		const f = document.getElementById("f") as HTMLFormElement;
		f.addEventListener("submit", (e) => e.stopImmediatePropagation());
		const e = new Event("submit", { bubbles: true, cancelable: true });
		f.dispatchEvent(e);
		expect(e.defaultPrevented).toBe(true);
	});

	it("opens no windows and shows no dialogs", () => {
		expect(window.open("https://elsewhere.test/")).toBeNull();
		expect(window.confirm("sure?")).toBe(false);
		expect(window.prompt("name?")).toBeNull();
		expect(() => window.alert("hi")).not.toThrow();
	});

	it("lets the replay's own input through", () => {
		document.body.innerHTML = `<button id="b">b</button>`;
		const b = document.getElementById("b") as HTMLButtonElement;
		let clicks = 0;
		b.addEventListener("click", () => clicks++);
		b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(clicks).toBe(1);
	});
});

describe("virtual history in a window", () => {
	it("moves the url the app reads, keeps its own length, and fires popstate by hand", async () => {
		const win = window as Win;
		const vh = installHistory(win, allowNavigation);
		vh.reset("/start");
		const start = vh.length;
		history.pushState({ n: 1 }, "", "/one");
		history.pushState({ n: 2 }, "", "/two");
		expect(location.pathname).toBe("/two");
		expect(history.length).toBe(start + 2);
		const pops: unknown[] = [];
		window.addEventListener("popstate", (e) => pops.push((e as PopStateEvent).state));
		history.back();
		expect(location.pathname).toBe("/two");
		await new Promise((r) => setTimeout(r, 10));
		expect(location.pathname).toBe("/one");
		expect(pops).toEqual([{ n: 1 }]);
		expect(vh.changes.map((c) => c.mode)).toEqual(["push", "push", "pop"]);
	});
});

describe("targets", () => {
	it("describes an element and checks it is the same one", () => {
		document.body.innerHTML = `<main><ul><li>one</li><li><button>Add  film</button></li></ul></main>`;
		const T = installTargets(document);
		const btn = document.querySelector("button") as HTMLButtonElement;
		const d = T.describe(btn);
		expect(d.p).toBe("1/0/0/1/0");
		expect(d.n).toBe("button");
		expect(d.h).toBeTypeOf("number");
		expect(T.resolve(d.p)).toBe(btn);
		expect(T.matches(btn, d)).toBe(true);
		// Same place, other text: not the same target.
		btn.textContent = "Remove film";
		expect(T.matches(btn, d)).toBe(false);
		// Long text says nothing about the target, so it isn't checked.
		const main = document.querySelector("main") as HTMLElement;
		const li = main.querySelector("li") as HTMLLIElement;
		li.textContent = "x".repeat(200);
		const dm = T.describe(main);
		expect(dm.h).toBeUndefined();
		expect(T.matches(main, dm)).toBe(true);
		expect(T.matches(null, dm)).toBe(false);
	});

	it("knows an element moved by an insert above it, by tag and text", () => {
		document.body.innerHTML = `<div><input id="f"></div>`;
		const T = installTargets(document);
		const field = document.getElementById("f") as HTMLInputElement;
		const d = T.describe(field);
		// The app puts something at the top of <body>: the field's path shifts.
		document.body.prepend(document.createElement("aside"));
		expect(T.matches(field, d)).toBe(false);
		expect(T.alike(field, d)).toBe(true);
		expect(T.alike(document.querySelector("aside"), d)).toBe(false);
	});

	it("resolves node paths, text nodes too", () => {
		document.body.innerHTML = `<div contenteditable="true"><p>hello <b>you</b></p></div>`;
		const T = installTargets(document);
		const text = document.querySelector("b")?.firstChild as Text;
		const p = T.nodePathOf(text);
		expect(p).not.toBeNull();
		expect(T.resolveNode(p as string)).toBe(text);
	});
});

describe("select all", () => {
	it("selects a focused field's text, and never the page", () => {
		document.body.innerHTML = `<p>page text</p><input id="i" value="hello">`;
		const T = installTargets(document);
		const input = new InputPlayer(document, true, T);
		const field = document.getElementById("i") as HTMLInputElement;
		const cmdA = { t: 0, k: "keydown", key: "a", code: "KeyA", m: 8 } as const;

		// Nothing focused: the shortcut reaches nothing it could select.
		setFocus(null);
		input.play({ ...cmdA, f: null });
		const sel = document.getSelection();
		expect(sel?.rangeCount ? sel.toString() : "").toBe("");

		setFocus(field);
		input.play({ ...cmdA, f: T.pathOf(field) });
		expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
	});
});
