// Makes the token contract executable. A design document that nothing checks
// drifts from its own stylesheet, which is how a 2.86:1 focus ring shipped.
import { readFile } from "node:fs/promises";

const channel = (c) => {
	const v = c / 255;
	return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
	let h = hex.replace("#", "");
	if (h.length === 3) h = [...h].map((x) => x + x).join("");
	const r = Number.parseInt(h.slice(0, 2), 16);
	const g = Number.parseInt(h.slice(2, 4), 16);
	const b = Number.parseInt(h.slice(4, 6), 16);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

/** WCAG 2.2: 4.5:1 for body text (1.4.3), 3:1 for large text, non-text boundaries and focus indicators (1.4.11). */
const TEXT = 4.5;
const LARGE_TEXT = 3;
const NON_TEXT = 3;
const TONES = ["neutral", "running", "success", "warn", "fail", "unverified"];
const CHECKS = [
	["--ink", "--paper", TEXT],
	["--ink", "--surface", TEXT],
	["--ink", "--surface-sunken", TEXT],
	["--ink-strong", "--paper", TEXT],
	["--ink-muted", "--paper", TEXT],
	["--ink-muted", "--surface", TEXT],
	["--ink-muted", "--surface-sunken", TEXT],
	["--ink", "--well", TEXT],
	["--ink-muted", "--well", TEXT],
	["--accent", "--well", TEXT],
	// --ink-subtle is a LARGE_TEXT token on purpose: it clears 3:1 but not 4.5:1
	// in light, so it belongs on >=16px text or decoration. Axe caught it at 12px
	// on .tool-number once already; reach for --ink-muted in a dense row.
	["--ink-subtle", "--paper", LARGE_TEXT],
	["--ink-subtle", "--surface", LARGE_TEXT],
	["--accent", "--paper", TEXT],
	["--accent", "--surface", TEXT],
	["--on-accent", "--accent-strong", TEXT],
	["--on-accent", "--accent", TEXT],
	["--on-primary", "--primary-fill", TEXT],
	["--primary-fill", "--paper", NON_TEXT],
	["--ink", "--selection", TEXT],
	["--accent", "--overlay", TEXT],
	["--ink-muted", "--overlay", TEXT],
	["--line-strong", "--overlay", NON_TEXT],
	["--line-strong", "--paper", NON_TEXT],
	["--line-strong", "--surface", NON_TEXT],
	["--line-strong", "--surface-sunken", NON_TEXT],
	["--focus", "--paper", NON_TEXT],
	["--focus", "--surface", NON_TEXT],
	["--focus", "--surface-sunken", NON_TEXT],
	...TONES.flatMap((t) => [
		[`--status-${t}-fg`, "--paper", TEXT],
		[`--status-${t}-fg`, "--surface-sunken", TEXT],
		[`--status-${t}-fg`, `--status-${t}-tint`, TEXT],
		[`--status-${t}-line`, "--paper", NON_TEXT],
	]),
	["--reason-fg", "--paper", TEXT],
	["--reason-fg", "--reason-tint", TEXT],
	["--action-fg", "--paper", TEXT],
	["--action-fg", "--action-tint", TEXT],
	["--action-line", "--paper", NON_TEXT],
	// The setup wizard's stage is black in both themes; its ink and brand roles must clear the same bars.
	["--stage-ink", "--stage-black", TEXT],
	["--stage-ink-muted", "--stage-black", TEXT],
	["--stage-accent", "--stage-black", TEXT],
	["--stage-secondary", "--stage-black", TEXT],
	["--code-ink", "--code-paper", TEXT],
	["--code-ink", "--code-surface", TEXT],
	["--code-ink-muted", "--code-paper", TEXT],
	["--code-ink-muted", "--code-surface", TEXT],
	["--code-gutter", "--code-paper", NON_TEXT],
	...["comment", "punctuation", "keyword", "string", "number", "function", "property", "deleted", "inserted"].flatMap(
		(kind) => [
			[`--syntax-${kind}`, "--code-paper", TEXT],
			[`--syntax-${kind}`, "--code-surface", TEXT],
		],
	),
];

const tokensUrl = new URL("../client/design/tokens.css", import.meta.url);
const css = await readFile(tokensUrl, "utf8");
const brand = await readFile(new URL("../client/design/brand.css", import.meta.url), "utf8");
const block = (selector, source = css) => {
	const start = source.indexOf(selector);
	if (start < 0) throw new Error(`Missing ${selector} in tokens.css`);
	const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi)].map((m) => [m[1], m[2]]));
};

const light = { ...block(":root {", brand), ...block(":root {") };
const dark = { ...light, ...block(':root[data-theme="dark"] {', brand), ...block(':root[data-theme="dark"] {') };
// The dark palette is written twice, once for an explicit choice and once for the system preference,
// because CSS cannot share one declaration block between a selector and a media query. The copies
// must agree, or a reader's theme would depend on how they chose it.
const systemDark = (() => {
	const start = css.indexOf("@media (prefers-color-scheme: dark)");
	if (start < 0) throw new Error("Missing the prefers-color-scheme block in tokens.css");
	const body = css.slice(
		css.indexOf("{", css.indexOf(":root", start)) + 1,
		css.indexOf("}", css.indexOf(":root", start)),
	);
	return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi)].map((m) => [m[1], m[2]]));
})();
const explicitDark = block(':root[data-theme="dark"] {');
const brandSystemDark = block(':root:not([data-theme="light"]) {', brand);
for (const [key, value] of Object.entries(block(':root[data-theme="dark"] {', brand)))
	if (brandSystemDark[key] !== value) throw new Error(`Canonical dark role disagrees: ${key}`);
for (const key of new Set([...Object.keys(explicitDark), ...Object.keys(systemDark)]))
	if (explicitDark[key] !== systemDark[key]) {
		console.error(`dark: ${key} is ${explicitDark[key]} when chosen and ${systemDark[key]} from the system preference`);
		process.exitCode = 1;
	}
const verbose = process.argv.includes("--verbose");
let failed = 0;
for (const [theme, tokens] of [
	["light", light],
	["dark", dark],
]) {
	for (const [fg, bg, min] of CHECKS) {
		const a = tokens[fg];
		const b = tokens[bg];
		if (!a || !b) {
			console.error(`${theme}: undefined token in ${fg} on ${bg}`);
			failed += 1;
			continue;
		}
		const value = ratio(a, b);
		if (value < min) {
			console.error(`${theme}: ${fg} on ${bg} = ${value.toFixed(2)}:1 (needs ${min}:1)`);
			failed += 1;
		} else if (verbose) {
			console.log(`${theme}: ${fg} on ${bg} = ${value.toFixed(2)}:1 (needs ${min}:1)`);
		}
	}
}
if (failed > 0 || process.exitCode) {
	console.error(failed > 0 ? `${failed} contrast failures.` : "The two dark palettes disagree.");
	process.exit(1);
}
console.log(`Contrast floor holds across ${CHECKS.length * 2} pairs.`);
