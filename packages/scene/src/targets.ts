// Targets. How an input names the element it landed on, so the replay can
// check the element is there, and is the same one, before it acts on it.
//
// Runs in the recorder's inject script too, as source text, so the recorder
// describes an element exactly the way the player checks it. Keep it
// self-contained: no imports, nothing from module scope.

import type { ElementPath, NodePath, Target } from "./index";

export interface Targets {
	/** Child indices from <html>; "" for <html> itself. */
	pathOf(el: Element): ElementPath;
	resolve(p: ElementPath): Element | null;
	/** childNodes indices from <html>, text nodes too. */
	nodePathOf(n: Node): NodePath | null;
	resolveNode(p: NodePath): Node | null;
	describe(el: Element): Target;
	/** `el` is what `t` recorded: same place, same tag, same short text. */
	matches(el: Element | null, t: Target): boolean;
	/** `el` looks like what `t` recorded, wherever it is now: same tag, same short text or field name. */
	alike(el: Element | null, t: Target): boolean;
	/** A hash of a message sent, text or bytes, the same in the recorder and the player. */
	digest(d: string | Uint8Array): number;
}

export function installTargets(doc: Document): Targets {
	const MAX_TEXT = 80;
	const hash = (s: string) => {
		// FNV-1a, 32 bit.
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	};
	const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
	/** What names a form field, where its text says nothing. */
	const naming = (el: Element) => {
		const n = el.localName;
		if (n !== "input" && n !== "textarea" && n !== "select") return null;
		const at = (k: string) => el.getAttribute(k) ?? "";
		return [at("type"), at("name"), at("id"), at("placeholder"), at("aria-label")].join("|");
	};
	const pathOf = (el: Element) => {
		const parts: number[] = [];
		let e: Element | null = el;
		while (e && e !== doc.documentElement && e.parentElement) {
			parts.unshift(Array.prototype.indexOf.call(e.parentElement.children, e));
			e = e.parentElement;
		}
		return parts.join("/");
	};
	const resolve = (p: string) => {
		let el: Element | null = doc.documentElement;
		if (p === "") return el;
		for (const i of p.split("/")) {
			el = el?.children[Number(i)] ?? null;
			if (!el) return null;
		}
		return el;
	};
	const nodePathOf = (n: Node) => {
		const parts: number[] = [];
		let c: Node | null = n;
		while (c && c !== doc.documentElement) {
			const parent: Node | null = c.parentNode;
			if (!parent) return null;
			parts.unshift(Array.prototype.indexOf.call(parent.childNodes, c));
			c = parent;
		}
		return c ? parts.join("/") : null;
	};
	const resolveNode = (p: string) => {
		let n: Node | null = doc.documentElement;
		if (p === "") return n;
		for (const i of p.split("/")) {
			n = n?.childNodes[Number(i)] ?? null;
			if (!n) return null;
		}
		return n;
	};
	type T = { p: string; n: string; h?: number; a?: number };
	const describe = (el: Element) => {
		const t: T = { p: pathOf(el), n: el.localName };
		const name = naming(el);
		if (name !== null) t.a = hash(name);
		else {
			const s = text(el);
			if (s.length <= MAX_TEXT) t.h = hash(s);
		}
		return t;
	};
	const alike = (el: Element | null, t: T) => {
		if (!el?.isConnected || el.localName !== t.n) return false;
		if (t.a !== undefined) return hash(naming(el) ?? "") === t.a;
		if (t.h === undefined) return true;
		const s = text(el);
		return s.length <= MAX_TEXT && hash(s) === t.h;
	};
	const matches = (el: Element | null, t: T) => alike(el, t) && pathOf(el as Element) === t.p;
	/** A hash of what was sent: text, or bytes. */
	const digest = (d: string | Uint8Array) => {
		if (typeof d === "string") return hash(d);
		let h = 0x811c9dc5;
		for (let i = 0; i < d.length; i++) {
			h ^= d[i] as number;
			h = Math.imul(h, 0x01000193);
		}
		return (h ^ 0xff) >>> 0;
	};
	return { pathOf, resolve, nodePathOf, resolveNode, describe, matches, alike, digest };
}
