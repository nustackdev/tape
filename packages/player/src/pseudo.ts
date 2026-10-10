// Hover and focus styles. A script can't put an element in :hover, and the
// replay's focus is pretended (./focus.ts), so the app's :hover and :focus
// rules are copied once with the pseudo class swapped for an attribute the
// shim sets. `(hover: hover)` media is lifted too, so a touch device viewing
// the page still sees the recorded hovers.

import { FOCUS_ATTR, FOCUS_VISIBLE_ATTR, FOCUS_WITHIN_ATTR } from "./focus";

export const HOVER_ATTR = "data-tape-hover";

const PSEUDO = /:(hover|focus-visible|focus-within|focus)(?![\w-])/;

export function rewriteRule(css: string): string {
	return css
		.replace(/\(\s*(any-)?hover\s*:\s*hover\s*\)/g, "(min-width: 0px)")
		.replace(/:hover(?![\w-])/g, `[${HOVER_ATTR}]`)
		.replace(/:focus-within(?![\w-])/g, `[${FOCUS_WITHIN_ATTR}]`)
		.replace(/:focus-visible(?![\w-])/g, `[${FOCUS_VISIBLE_ATTR}]`)
		.replace(/:focus(?![\w-])/g, `[${FOCUS_ATTR}]`);
}

/**
 * The rules under `rules` that use a pseudo class, rewritten, each inside the
 * same @layer, @media and @supports blocks and parent selectors it sat in. Only
 * those: copying a whole block would duplicate every other rule after the
 * original and change which one wins.
 */
export function pseudoRules(rules: CSSRuleList): string[] {
	const out: string[] = [];
	for (const rule of rules) {
		if (!PSEUDO.test(rule.cssText)) continue;
		if (rule instanceof CSSStyleRule) {
			if (PSEUDO.test(rule.selectorText)) {
				out.push(rewriteRule(rule.cssText));
			} else if (rule.cssRules?.length) {
				const inner = pseudoRules(rule.cssRules);
				if (inner.length) out.push(`${rule.selectorText}{${inner.join("")}}`);
			}
			continue;
		}
		const prelude =
			rule instanceof CSSLayerBlockRule
				? `@layer ${rule.name}`
				: rule instanceof CSSMediaRule
					? `@media ${rewriteRule(rule.conditionText)}`
					: rule instanceof CSSSupportsRule
						? `@supports ${rule.conditionText}`
						: null;
		if (prelude && "cssRules" in rule) {
			const inner = pseudoRules((rule as CSSGroupingRule).cssRules);
			if (inner.length) out.push(`${prelude}{${inner.join("")}}`);
		}
	}
	return out;
}

export function installPseudo(doc: Document): void {
	const done = new WeakSet<CSSStyleSheet>();
	const out = doc.createElement("style");
	out.dataset.tape = "pseudo";

	const take = (sheet: CSSStyleSheet) => {
		if (done.has(sheet) || sheet.ownerNode === out) return;
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			return; // cross origin, or not loaded yet
		}
		done.add(sheet);
		const target = out.sheet;
		if (!target) return;
		for (const text of pseudoRules(rules)) {
			try {
				target.insertRule(text, target.cssRules.length);
			} catch {
				// A rule the rewrite made invalid stays out; the rest still apply.
			}
		}
	};
	const scan = () => {
		if (!out.isConnected) doc.head.appendChild(out);
		for (const sheet of doc.styleSheets) take(sheet);
	};

	// Sheets arrive as the app loads, lazy chunks included.
	doc.addEventListener("load", (e) => e.target instanceof HTMLLinkElement && scan(), true);
	new MutationObserver(scan).observe(doc.head, { childList: true });
	scan();
}

/** Put `el` and its ancestors in hover, and nothing else. */
export function setHover(prev: Element[], el: Element | null): Element[] {
	const next: Element[] = [];
	for (let e = el; e; e = e.parentElement) next.push(e);
	const keep = new Set(next);
	for (const e of prev) if (!keep.has(e)) e.removeAttribute(HOVER_ATTR);
	for (const e of next) e.setAttribute(HOVER_ATTR, "");
	return next;
}
