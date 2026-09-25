import type { ClioToken } from "../../core/theme-token-hex.js";

export type { ClioToken } from "../../core/theme-token-hex.js";

interface TokenColor {
	rgb: readonly [number, number, number];
	xterm: number;
}

const TOKENS: Record<ClioToken, TokenColor> = {
	// Every hue comes from the brand: the logo's mint and cyan, iowarp.ai's
	// orange accent, steel-blue text and slate borders, and its success, warning
	// and error tones. Each is shifted into the middle luminance band (relative
	// luminance 0.16 to 0.25) because Clio cannot see whether the terminal runs
	// a dark or a light theme, and a brand pastel that glows on dark vanishes on
	// light. There every token keeps about 3:1 or better on both, except frame,
	// which recedes on dark themes as the site's border does. The xterm
	// fallbacks come from the same hue families and are picked for two-sided
	// contrast rather than nearest color.
	editor: { rgb: [9, 150, 159], xterm: 30 },
	editorDanger: { rgb: [227, 86, 86], xterm: 167 },
	editorAction: { rgb: [208, 109, 37], xterm: 166 },
	accent: { rgb: [49, 151, 137], xterm: 30 },
	accentDeep: { rgb: [24, 139, 123], xterm: 29 },
	tool: { rgb: [64, 140, 150], xterm: 66 },
	agent: { rgb: [192, 96, 31], xterm: 130 },
	// Orange means Clio is acting. It fires only for Clio's signature actions
	// (dispatching, queued and running fleet work, steering) and for the border
	// of a prompt that has taken the keyboard and is waiting on a decision, never
	// as decoration, and never a metric, at most one orange element per region of
	// the screen. warning stays amber for actual warnings.
	action: { rgb: [208, 109, 37], xterm: 166 },
	success: { rgb: [42, 156, 92], xterm: 28 },
	warning: { rgb: [170, 129, 24], xterm: 136 },
	error: { rgb: [221, 83, 83], xterm: 167 },
	info: { rgb: [74, 144, 180], xterm: 67 },
	reason: { rgb: [156, 134, 100], xterm: 137 },
	dim: { rgb: [110, 123, 133], xterm: 244 },
	muted: { rgb: [96, 128, 150], xterm: 102 },
	title: { rgb: [9, 150, 159], xterm: 30 },
	frame: { rgb: [87, 114, 135], xterm: 243 },
	frameStrong: { rgb: [9, 150, 159], xterm: 30 },
};

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
	return `\u001b[${fgCode(TOKENS[token], truecolor)}m`;
}

export function createClioTheme(options: { truecolor?: boolean; color?: boolean } = {}): ClioTheme {
	const truecolor = options.truecolor ?? detectTruecolor();
	const color = options.color ?? !colorDisabled();
	const paint = (text: string, mods: PaintMods): string => {
		const codes: string[] = [];
		if (mods.bold) codes.push("1");
		if (mods.dim) codes.push("2");
		if (mods.italic) codes.push("3");
		if (mods.underline) codes.push("4");
		if (color && mods.fg) codes.push(fgCode(TOKENS[mods.fg], truecolor));
		if (color && mods.bg) codes.push(bgCode(TOKENS[mods.bg], truecolor));
		if (codes.length === 0) return text;
		return `\u001b[${codes.join(";")}m${text}${SGR_RESET}`;
	};
	return {
		truecolor,
		paint,
		fg: (token, text) => paint(text, { fg: token }),
		bg: (token, text) => paint(text, { bg: token }),
		style: (token, text, mods = {}) => paint(text, { ...mods, fg: token }),
		fgSequence: (token) => (color ? `\u001b[${fgCode(TOKENS[token], truecolor)}m` : ""),
	};
}

/** True when `value` names one of the theme's own tokens, so it can be painted as one. */
export function isClioToken(value: string): value is ClioToken {
	return Object.hasOwn(TOKENS, value);
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
