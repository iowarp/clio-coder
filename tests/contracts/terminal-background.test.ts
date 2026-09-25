import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
	backgroundFromColorFgBg,
	backgroundFromOsc11,
	probeTerminalBackground,
	terminalBackground,
} from "../../src/core/terminal-background.js";
import type { ClioToken, ThemeBackground } from "../../src/core/theme-token-hex.js";
import { tokenHex } from "../../src/core/theme-token-hex.js";
import { createClioTheme } from "../../src/interactive/theme/tokens.js";

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
