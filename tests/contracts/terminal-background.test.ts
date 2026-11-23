import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
	backgroundFromColorFgBg,
	backgroundFromOsc11,
	probeTerminalBackground,
	reportTerminalColors,
	terminalBackground,
} from "../../src/core/terminal-background.js";
import { STRUCTURAL_ROLES, TEXT_ROLES } from "../../src/core/theme-roles.js";
import type { ClioToken, Rgb, ThemeBackground } from "../../src/core/theme-token-hex.js";
import { contrastRatio, paletteProjection, tokenHex } from "../../src/core/theme-token-hex.js";
import { type ColorDepth, createClioTheme, type SemanticRole } from "../../src/interactive/theme/tokens.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test("OSC 11 replies and COLORFGBG name the background", () => {
	strictEqual(backgroundFromOsc11(`${ESC}]11;rgb:2828/2c2c/3434${BEL}`), "dark");
	strictEqual(backgroundFromOsc11(`${ESC}]11;rgb:fdfd/f6f6/e3e3${ESC}\\`), "light");
	strictEqual(backgroundFromOsc11(`${ESC}]11;rgb:ff/ff/ff${BEL}`), "light");
	strictEqual(backgroundFromOsc11(`${ESC}[?62;22c`), null);
	strictEqual(backgroundFromColorFgBg("15;0"), "dark");
	strictEqual(backgroundFromColorFgBg("0;default;15"), "light");
	strictEqual(backgroundFromColorFgBg("0;7"), "light");
	strictEqual(backgroundFromColorFgBg("default"), null);
	strictEqual(backgroundFromColorFgBg(undefined), null);
});

test("CLIO_CODER_THEME overrides detection, and neutral forces the unknown palette", () => {
	strictEqual(terminalBackground({ CLIO_CODER_THEME: "light", COLORFGBG: "15;0" }), "light");
	strictEqual(terminalBackground({ CLIO_CODER_THEME: "neutral", COLORFGBG: "15;0" }), null);
	strictEqual(terminalBackground({ COLORFGBG: "15;0" }), "dark");
	strictEqual(terminalBackground({}), null);
});

class FakeTty extends EventEmitter {
	isTTY = true;
	isRaw = false;
	written: string[] = [];
	unshifted: string[] = [];
	setRawMode(raw: boolean): this {
		this.isRaw = raw;
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
	unshift(chunk: Buffer): void {
		this.unshifted.push(chunk.toString());
	}
	write(text: string): boolean {
		this.written.push(text);
		// The terminal answers OSC 11 then DA1, with a key the operator typed between.
		queueMicrotask(() => this.emit("data", Buffer.from(`${ESC}]11;rgb:1e1e/1e1e/1e1e${BEL}x${ESC}[?62;22c`)));
		return true;
	}
}

test("the startup probe reads the reply, restores the terminal and hands typed keys back", async () => {
	const tty = new FakeTty();
	const background = await probeTerminalBackground({
		stdin: tty as unknown as NodeJS.ReadStream,
		stdout: tty as unknown as NodeJS.WriteStream,
		env: {},
	});
	strictEqual(background, "dark");
	strictEqual(tty.isRaw, false, "raw mode is restored");
	deepStrictEqual(tty.unshifted, ["x"], "only the typed key goes back to stdin");
	ok(tty.written[0]?.includes("]11;?"), "the probe asks for the background");
	strictEqual(await probeTerminalBackground({ env: { NO_COLOR: "1" } }), null, "NO_COLOR skips the probe");
});

const TOKENS: ClioToken[] = [
	"editor",
	"editorDanger",
	"editorAction",
	"accent",
	"accentDeep",
	"action",
	"tool",
	"agent",
	"success",
	"warning",
	"error",
	"info",
	"reason",
	"dim",
	"muted",
	"title",
];

function luminance(hex: string): number {
	const channel = (at: number): number => {
		const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

// Theme backgrounds each palette is drawn for. Frames are left out: they are
// meant to recede. Absolute tolerance 0.05 on the WCAG ratio.
const BACKGROUNDS: Record<ThemeBackground, string[]> = {
	dark: ["#000000", "#0d1117", "#1e1e1e", "#282c34", "#002b36", "#1e1e2e"],
	light: ["#ffffff", "#fdf6e3", "#fafafa", "#eff1f5", "#f6f8fa"],
};

test("every text token holds 4:1 on the backgrounds its palette is drawn for", () => {
	for (const [background, grounds] of Object.entries(BACKGROUNDS) as Array<[ThemeBackground, string[]]>) {
		for (const token of TOKENS) {
			const worst = Math.min(...grounds.map((ground) => contrast(tokenHex(token, background), ground)));
			ok(worst >= 4 - 0.05, `${background} ${token} ${tokenHex(token, background)} is ${worst.toFixed(2)}:1`);
		}
	}
});

test("the theme paints the palette of the background it is created for", () => {
	const hex = tokenHex("accent", "dark");
	const rgb = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";");
	const painted = createClioTheme({ truecolor: true, color: true, background: "dark" }).fg("accent", "x");
	ok(painted.includes(`38;2;${rgb}m`), painted);
	const neutral = createClioTheme({ truecolor: true, color: true, background: null }).fg("accent", "x");
	ok(!neutral.includes(`38;2;${rgb}m`), "the unknown background keeps the mid-luminance palette");
});

// W0-2 (spec 2.10): every role as a foreground on the default and each owned background, truecolor and indexed, for
// dark, light and unknown. Text holds 4.5:1 and marks 3:1 on a known background; an unknown one holds 3.5:1.
test("the contrast matrix holds every role on the default and owned backgrounds at both depths", () => {
	// The matrix measures the declared projections, so the color the probe above reported is forgotten first.
	reportTerminalColors({ scheme: "dark" });
	reportTerminalColors({ scheme: "light" });
	const cube = [0, 95, 135, 175, 215, 255];
	const xterm = (n: number): Rgb =>
		n >= 232
			? [8 + (n - 232) * 10, 8 + (n - 232) * 10, 8 + (n - 232) * 10]
			: [cube[Math.floor((n - 16) / 36)] ?? 0, cube[Math.floor((n - 16) / 6) % 6] ?? 0, cube[(n - 16) % 6] ?? 0];
	const colors = (open: string): { fg?: Rgb; bg?: Rgb } => {
		const found: { fg?: Rgb; bg?: Rgb } = {};
		for (const [, kind, mode, a, b, c] of open.matchAll(/([34])8;(2;(\d+);(\d+);(\d+)|5;(\d+))/gu)) {
			const parts = mode?.split(";").map(Number) ?? [];
			const value: Rgb = parts[0] === 2 ? [Number(a), Number(b), Number(c)] : xterm(parts[1] ?? 16);
			found[kind === "3" ? "fg" : "bg"] = value;
		}
		return found;
	};
	const hex = (value: string): Rgb =>
		[1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as unknown as Rgb;
	const grounds: Record<"dark" | "light" | "unknown", Rgb[]> = {
		dark: ["#000000", "#1e1e1e"].map(hex),
		light: ["#ffffff", "#fdf6e3"].map(hex),
		unknown: ["#000000", "#ffffff", "#1e1e1e", "#fdf6e3"].map(hex),
	};
	const owned = ["raisedSurface", "selectionBackground", "composerSurface"] as const;
	const pairs = new Set<string>([...owned, "selectionBadge", "onSelection"]);
	const syntax = new Set(["syntaxKeyword", "syntaxKey", "syntaxString", "syntaxLiteral", "syntaxComment"]);
	const roles = [...Object.keys(TEXT_ROLES), ...Object.keys(STRUCTURAL_ROLES)].filter((role) => !pairs.has(role));
	for (const scheme of ["dark", "light", "unknown"] as const) {
		const background = scheme === "unknown" ? null : scheme;
		for (const depth of ["truecolor", "256"] satisfies ColorDepth[]) {
			const plain = createClioTheme({ depth, background });
			const yolo = createClioTheme({ depth, background, context: { surface: "composer", mode: "yolo" } });
			for (const role of roles as SemanticRole[]) {
				const mark = Object.hasOwn(STRUCTURAL_ROLES, role) && !syntax.has(role);
				const floor = scheme === "unknown" ? 3.5 : mark ? 3 : 4.5;
				// The terminal's own foreground (SGR 39) is the one color certain to read and is not measured.
				const fg = colors(plain.sgr({ fg: role }).open).fg;
				for (const ground of fg === undefined ? [] : grounds[scheme]) {
					const ratio = contrastRatio(fg as Rgb, ground);
					ok(ratio >= floor, `${scheme} ${depth} ${role} on the default ${ground}: ${ratio.toFixed(2)}`);
				}
				if (scheme === "unknown") continue;
				for (const surface of owned) {
					const pair = colors((surface === "composerSurface" ? yolo : plain).sgr({ fg: role, bg: surface }).open);
					if (pair.fg === undefined || pair.bg === undefined) continue;
					const ratio = contrastRatio(pair.fg, pair.bg);
					ok(ratio >= (mark ? 3 : 4.5), `${scheme} ${depth} ${role} on ${surface}: ${ratio.toFixed(2)}`);
				}
			}
			const badge = plain.sgr({ fg: "onSelection", bg: "selectionBadge", bold: true });
			if (scheme === "unknown") strictEqual(badge.open, "1;7", "an unknown background paints the badge inverse");
			else {
				const pair = colors(badge.open);
				ok(contrastRatio(pair.fg as Rgb, pair.bg as Rgb) >= 4.5, `${scheme} ${depth} badge pair`);
			}
		}
	}
	// The two light indexed entries that measured 3.92 to 4.21 on #fdf6e3 and paper #f3eee4.
	for (const color of ["successSupporting", "errorSupporting"] as const) {
		for (const ground of ["#fdf6e3", "#f3eee4"]) {
			const ratio = contrastRatio(xterm(paletteProjection(color, "light")[1]), hex(ground));
			ok(ratio >= 4.5, `light indexed ${color} on ${ground}: ${ratio.toFixed(2)}`);
		}
	}
});
