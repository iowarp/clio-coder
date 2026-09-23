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
	// --ink-subtle is a LARGE_TEXT token on purpose: it clears 3:1 but not 4.5:1
	// in light, so it belongs on >=16px text or decoration. Axe caught it at 12px
	// on .tool-number once already; reach for --ink-muted in a dense row.
	["--ink-subtle", "--paper", LARGE_TEXT],
	["--ink-subtle", "--surface", LARGE_TEXT],
	["--accent", "--paper", TEXT],
	["--accent", "--surface", TEXT],
	["--on-accent", "--accent-strong", TEXT],
	["--line-strong", "--paper", NON_TEXT],
	["--line-strong", "--surface", NON_TEXT],
	["--line-strong", "--surface-sunken", NON_TEXT],
	["--focus", "--paper", NON_TEXT],
	["--focus", "--surface", NON_TEXT],
	["--focus", "--surface-sunken", NON_TEXT],
	...TONES.flatMap((t) => [
		[`--status-${t}-fg`, "--paper", TEXT],
		[`--status-${t}-fg`, `--status-${t}-tint`, TEXT],
		[`--status-${t}-line`, "--paper", NON_TEXT],
	]),
	["--reason-fg", "--paper", TEXT],
	["--reason-fg", "--reason-tint", TEXT],
	["--action-fg", "--paper", TEXT],
	["--action-fg", "--action-tint", TEXT],
	["--action-line", "--paper", NON_TEXT],
	["--code-ink", "--code-paper", TEXT],
	["--code-ink", "--code-surface", TEXT],
	["--code-ink-muted", "--code-paper", TEXT],
	["--code-ink-muted", "--code-surface", TEXT],
	["--code-gutter", "--code-paper", NON_TEXT],
];

const tokensUrl = new URL("../client/design/tokens.css", import.meta.url);
const css = await readFile(tokensUrl, "utf8");
const block = (selector) => {
	const start = css.indexOf(selector);
	if (start < 0) throw new Error(`Missing ${selector} in tokens.css`);
	const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi)].map((m) => [m[1], m[2]]));
};

const light = block(":root {");
const dark = { ...light, ...block(':root[data-theme="dark"] {') };
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
if (failed > 0) {
	console.error(`${failed} contrast failures.`);
	process.exit(1);
}
console.log(`Contrast floor holds across ${CHECKS.length * 2} pairs.`);
