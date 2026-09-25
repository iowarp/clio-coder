import { terminalBackground } from "../../core/terminal-background.js";
import type { ClioToken, ThemeBackground } from "../../core/theme-token-hex.js";
import { tokenHex } from "../../core/theme-token-hex.js";

export type { ClioToken, ThemeBackground } from "../../core/theme-token-hex.js";

interface TokenColor {
	rgb: readonly [number, number, number];
	xterm: number;
}

/**
 * xterm-256 fallbacks per background, [unknown, dark, light], beside the hex
 * columns in core/theme-token-hex.ts. The unknown column favors two-sided
 * contrast, with 36 and 37 keeping the logo's mint and cyan apart.
 */
const XTERM: Record<ClioToken, readonly [number, number, number]> = {
	editor: [37, 44, 30],
	editorDanger: [167, 203, 160],
	editorAction: [166, 208, 130],
	accent: [36, 79, 29],
	accentDeep: [29, 36, 23],
	tool: [66, 73, 66],
	agent: [130, 173, 94],
	// Orange means Clio is acting. It fires only for Clio's signature actions
	// (dispatching, queued and running fleet work, steering) and for the border
	// of a prompt that has taken the keyboard and is waiting on a decision, never
	// as decoration, and never a metric, at most one orange element per region of
	// the screen. warning stays amber for actual warnings.
	action: [166, 208, 130],
	success: [28, 42, 28],
	warning: [136, 220, 136],
	error: [167, 210, 124],
	info: [67, 74, 24],
	reason: [137, 180, 101],
	dim: [244, 245, 243],
	muted: [102, 248, 241],
	title: [37, 44, 30],
	frame: [243, 24, 250],
	frameStrong: [37, 44, 30],
};

const PALETTES = new Map<ThemeBackground | null, Record<ClioToken, TokenColor>>();

function palette(background: ThemeBackground | null): Record<ClioToken, TokenColor> {
	let colors = PALETTES.get(background);
	if (colors === undefined) {
		const column = background === "dark" ? 1 : background === "light" ? 2 : 0;
		const entries = (Object.keys(XTERM) as ClioToken[]).map((token): [ClioToken, TokenColor] => {
			const hex = tokenHex(token, background);
			const rgb = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
			return [token, { rgb, xterm: XTERM[token][column] }];
		});
		colors = Object.fromEntries(entries) as Record<ClioToken, TokenColor>;
		PALETTES.set(background, colors);
	}
	return colors;
}

export const SGR_RESET = "\u001b[0m";
export const SGR_DIM = "\u001b[2m";
export const SGR_BOLD = "\u001b[1m";
/** Normal intensity: ends bold and dim together. */
export const SGR_BOLD_OFF = "\u001b[22m";
export const SGR_ITALIC = "\u001b[3m";

export interface PaintMods {
	fg?: ClioToken;
	bg?: ClioToken;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
}

export interface ClioTheme {
	readonly truecolor: boolean;
	paint(text: string, mods: PaintMods): string;
	fg(token: ClioToken, text: string): string;
	bg(token: ClioToken, text: string): string;
	style(token: ClioToken, text: string, mods?: Omit<PaintMods, "fg">): string;
	fgSequence(token: ClioToken): string;
}

/**
 * The NO_COLOR convention: set and non-empty means emit no color, whatever the
 * value is. Clio was ignoring it entirely. A session launched with NO_COLOR=1
 * still wrote 961 non-reset SGR sequences in its first three seconds, most of
 * them 24-bit foregrounds, which is exactly what the variable exists to stop.
 *
 * Only color is dropped. Bold, dim, italic, and underline carry structure
 * rather than color and are what a monochrome terminal has left to read the
 * interface with, so they stay.
 */
function colorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.NO_COLOR;
	return typeof raw === "string" && raw.length > 0;
}

function detectTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
	const colorTerm = (env.COLORTERM ?? "").toLowerCase();
	if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return true;
	const term = (env.TERM ?? "").toLowerCase();
	return term.includes("truecolor") || term.includes("24bit");
}

function fgCode(color: TokenColor, truecolor: boolean): string {
	return truecolor ? `38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}` : `38;5;${color.xterm}`;
}

function bgCode(color: TokenColor, truecolor: boolean): string {
	return truecolor ? `48;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}` : `48;5;${color.xterm}`;
}

export function fgSequence(token: ClioToken, truecolor: boolean = detectTruecolor()): string {
	if (colorDisabled()) return "";
	return `\u001b[${fgCode(palette(terminalBackground())[token], truecolor)}m`;
}

export function createClioTheme(
	options: { truecolor?: boolean; color?: boolean; background?: ThemeBackground | null } = {},
): ClioTheme {
	const truecolor = options.truecolor ?? detectTruecolor();
	const color = options.color ?? !colorDisabled();
	const colors = palette(options.background === undefined ? terminalBackground() : options.background);
	const paint = (text: string, mods: PaintMods): string => {
		const codes: string[] = [];
		if (mods.bold) codes.push("1");
		if (mods.dim) codes.push("2");
		if (mods.italic) codes.push("3");
		if (mods.underline) codes.push("4");
		if (color && mods.fg) codes.push(fgCode(colors[mods.fg], truecolor));
		if (color && mods.bg) codes.push(bgCode(colors[mods.bg], truecolor));
		if (codes.length === 0) return text;
		return `\u001b[${codes.join(";")}m${text}${SGR_RESET}`;
	};
	return {
		truecolor,
		paint,
		fg: (token, text) => paint(text, { fg: token }),
		bg: (token, text) => paint(text, { bg: token }),
		style: (token, text, mods = {}) => paint(text, { ...mods, fg: token }),
		fgSequence: (token) => (color ? `\u001b[${fgCode(colors[token], truecolor)}m` : ""),
	};
}

/** True when `value` names one of the theme's own tokens, so it can be painted as one. */
export function isClioToken(value: string): value is ClioToken {
	return Object.hasOwn(XTERM, value);
}

const HEX_COLOR = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/u;

/**
 * Paint text in a configured `#rrggbb` color.
 *
 * A council roster member may carry one. A roster color is the operator's own
 * choice rather than a token from the palette, which is why a literal color
 * reaches the screen here and nowhere else. Returns the text unchanged when
 * color is disabled or the value is not a six-digit hex color, so a caller can
 * fall back to a token without inspecting the string twice. A terminal without
 * truecolor gets the nearest color in the 6x6x6 xterm cube.
 */
export function paintHex(text: string, hex: string, options: { truecolor?: boolean; color?: boolean } = {}): string {
	const match = HEX_COLOR.exec(hex);
	if (match === null) return text;
	if (!(options.color ?? !colorDisabled())) return text;
	const truecolor = options.truecolor ?? detectTruecolor();
	const red = Number.parseInt(match[1] ?? "0", 16);
	const green = Number.parseInt(match[2] ?? "0", 16);
	const blue = Number.parseInt(match[3] ?? "0", 16);
	if (truecolor) return `\u001b[38;2;${red};${green};${blue}m${text}${SGR_RESET}`;
	const cube = (channel: number): number => Math.round((channel / 255) * 5);
	return `\u001b[38;5;${16 + 36 * cube(red) + 6 * cube(green) + cube(blue)}m${text}${SGR_RESET}`;
}
