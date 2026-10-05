import { terminalBackground } from "../../core/terminal-background.js";
import { colorDisabled } from "../../core/terminal-preferences.js";
import {
	DEFAULT_THEME_CONTEXT,
	isSemanticRole,
	projectsYolo,
	type RoleState,
	resolveRole,
	type SemanticRole,
	type ThemeContext,
} from "../../core/theme-roles.js";
import {
	LEGACY_TOKEN_COLOR,
	type ClioToken as LegacyToken,
	type PaletteColor,
	paletteProjection,
	TERMINAL_PALETTE,
	type ThemeBackground,
} from "../../core/theme-token-hex.js";

export * from "../../core/theme-roles.js";
export type { ThemeBackground } from "../../core/theme-token-hex.js";
/** Semantic roles plus explicit compatibility names for configured roster colors. */
export type ClioToken = SemanticRole | LegacyToken;

interface TokenColor {
	rgb: readonly [number, number, number];
	xterm: number;
}
const PALETTES = new Map<ThemeBackground | null, Record<PaletteColor, TokenColor>>();
let overrides: Record<string, { dark: string; light: string }> | undefined;
let epoch = 0;
export function skinEpoch(): number {
	return epoch;
}
export function setPaletteSkin(palette: typeof overrides): void {
	overrides =
		palette === undefined
			? undefined
			: Object.fromEntries(Object.entries(palette).map(([name, pair]) => [name, { ...pair }]));
	PALETTES.clear();
	epoch += 1;
}
function rgbXterm(rgb: readonly number[]): number {
	const cube = (channel: number): number => Math.round((channel / 255) * 5);
	return 16 + 36 * cube(rgb[0] ?? 0) + 6 * cube(rgb[1] ?? 0) + cube(rgb[2] ?? 0);
}

/** Any SGR sequence; built from the escape code so the source carries no control character. */
const SGR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "gu");
function palette(background: ThemeBackground | null): Record<PaletteColor, TokenColor> {
	let colors = PALETTES.get(background);
	if (colors === undefined) {
		colors = Object.fromEntries(
			(Object.keys(TERMINAL_PALETTE) as PaletteColor[]).map((name): [PaletteColor, TokenColor] => {
				const override = overrides?.[name]?.[background ?? "dark"];
				const [hex, xterm] = override === undefined ? paletteProjection(name, background) : [override, 0];
				const rgb = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
				return [name, { rgb, xterm: override === undefined ? xterm : rgbXterm(rgb) }];
			}),
		) as Record<PaletteColor, TokenColor>;
		PALETTES.set(background, colors);
	}
	return colors;
}

/** Brand ramps read the same active palette as semantic painting. */
export function paletteRgb(
	color: PaletteColor,
	background: ThemeBackground | null = terminalBackground(),
): readonly [number, number, number] {
	return palette(background)[color].rgb;
}

// A synchronous render scope also reaches theme callbacks made when a selector
// was constructed. It never persists autonomy in the application-wide theme.
let renderContext: ThemeContext = DEFAULT_THEME_CONTEXT;
export function withThemeContext<T>(context: ThemeContext, render: () => T): T {
	const previous = renderContext;
	renderContext = context;
	try {
		return render();
	} finally {
		renderContext = previous;
	}
}
function tokenStyle(token: ClioToken, context: ThemeContext, state?: RoleState) {
	return isSemanticRole(token) ? resolveRole(token, context, state) : { color: LEGACY_TOKEN_COLOR[token], bold: false };
}

export const SGR_RESET = "\u001b[0m";
export const SGR_DIM = "\u001b[2m";
export const SGR_BOLD = "\u001b[1m";
/** Normal intensity: ends bold and dim together. */
export const SGR_BOLD_OFF = "\u001b[22m";
export const SGR_ITALIC = "\u001b[3m";

/** End-of-sequence default foreground, including compound reset SGRs. */
export function sgrResetsForeground(code: string): boolean {
	const values = code.slice(2, -1).split(";").map(Number);
	let reset = false;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === 0 || value === 39) reset = true;
		else if (value === 38 || value === 48 || value === 58) {
			if (value === 38) reset = false;
			index += values[index + 1] === 2 ? 4 : values[index + 1] === 5 ? 2 : 0;
		} else if (value !== undefined && ((value >= 30 && value <= 37) || (value >= 90 && value <= 97))) reset = false;
	}
	return reset;
}

export interface PaintMods {
	fg?: ClioToken;
	state?: RoleState;
	bg?: ClioToken;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
}

export interface ClioTheme {
	readonly truecolor: boolean;
	readonly context: ThemeContext;
	paint(text: string, mods: PaintMods): string;
	fg(token: ClioToken, text: string, state?: RoleState): string;
	bg(token: ClioToken, text: string): string;
	style(token: ClioToken, text: string, mods?: Omit<PaintMods, "fg">): string;
	fgSequence(token: ClioToken): string;
	/** Reading foreground resumes after inline resets, preserving syntax and backgrounds. */
	base(role: SemanticRole, text: string): string;
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
	return `\u001b[${fgCode(palette(terminalBackground())[tokenStyle(token, DEFAULT_THEME_CONTEXT).color], truecolor)}m`;
}

export function createClioTheme(
	options: { truecolor?: boolean; color?: boolean; background?: ThemeBackground | null; context?: ThemeContext } = {},
): ClioTheme {
	const truecolor = options.truecolor ?? detectTruecolor();
	const color = options.color ?? !colorDisabled();
	const background = options.background === undefined ? terminalBackground() : options.background;
	const context = () => options.context ?? renderContext;
	const colorFor = (token: ClioToken, state?: RoleState): TokenColor => {
		const scope = context();
		return palette(projectsYolo(scope) ? (background ?? "dark") : background)[tokenStyle(token, scope, state).color];
	};
	const paint = (text: string, mods: PaintMods): string => {
		const codes: string[] = [];
		if (mods.bold ?? (mods.fg ? tokenStyle(mods.fg, context(), mods.state).bold : false)) codes.push("1");
		if (mods.dim) codes.push("2");
		if (mods.italic) codes.push("3");
		if (mods.underline) codes.push("4");
		if (color && mods.fg) codes.push(fgCode(colorFor(mods.fg, mods.state), truecolor));
		if (color && mods.bg) codes.push(bgCode(colorFor(mods.bg), truecolor));
		if (codes.length === 0) return text;
		return `\u001b[${codes.join(";")}m${text}${SGR_RESET}`;
	};
	return {
		truecolor,
		get context() {
			return context();
		},
		paint,
		fg: (token, text, state) => paint(text, { fg: token, ...(state === undefined ? {} : { state }) }),
		bg: (token, text) => paint(text, { bg: token }),
		style: (token, text, mods = {}) => paint(text, { ...mods, fg: token }),
		fgSequence: (token) => (color ? `\u001b[${fgCode(colorFor(token), truecolor)}m` : ""),
		base: (role, text) => {
			if (!color || text.length === 0) return text;
			const foreground = `\u001b[${fgCode(colorFor(role), truecolor)}m`;
			return `${foreground}${text.replace(SGR_SEQUENCE, (code) => (sgrResetsForeground(code) ? `${code}${foreground}` : code))}${SGR_RESET}`;
		},
	};
}

/** True when `value` names one of the theme's own tokens, so it can be painted as one. */
export function isClioToken(value: string): value is ClioToken {
	return isSemanticRole(value) || Object.hasOwn(LEGACY_TOKEN_COLOR, value);
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
	return `\u001b[38;5;${rgbXterm([red, green, blue])}m${text}${SGR_RESET}`;
}
