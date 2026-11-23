import { terminalBackground, terminalBackgroundColor, terminalColorVersion } from "../../core/terminal-background.js";
import { type ColorDepth, colorDepth } from "../../core/terminal-preferences.js";
import { adaptPalette, type ProjectedColor } from "../../core/theme-contrast.js";
import {
	DEFAULT_THEME_CONTEXT,
	isChromeRole,
	isSemanticRole,
	projectsYolo,
	type RoleState,
	resolveRole,
	roleIntensity,
	type SemanticRole,
	type ThemeContext,
} from "../../core/theme-roles.js";
import {
	hexRgb,
	OWNED_BACKGROUNDS,
	rgbXterm,
	type Sgr,
	type SgrColor,
	sgrFor,
	TERMINAL_FOREGROUND_ON_UNKNOWN,
} from "../../core/theme-sgr.js";
import {
	ANSI16,
	LEGACY_TOKEN_COLOR,
	type ClioToken as LegacyToken,
	type PaletteColor,
	paletteProjection,
	TERMINAL_PALETTE,
	type ThemeBackground,
} from "../../core/theme-token-hex.js";

export type { ColorDepth } from "../../core/terminal-preferences.js";
export * from "../../core/theme-roles.js";
export type { Sgr } from "../../core/theme-sgr.js";
export type { ThemeBackground } from "../../core/theme-token-hex.js";
/** Semantic roles plus explicit compatibility names for configured roster colors. */
export type ClioToken = SemanticRole | LegacyToken;

type TokenColor = ProjectedColor & { readonly terminalForeground?: boolean };
const PALETTES = new Map<ThemeBackground | null, Record<PaletteColor, TokenColor>>();
let palettesVersion = terminalColorVersion();
let overrides: Record<string, { dark: string; light: string }> | undefined;
let epoch = 0;
/** Moves with a skin or a terminal background change; painted-row caches key on it. */
export function skinEpoch(): number {
	return epoch + terminalColorVersion();
}
export function setPaletteSkin(palette: typeof overrides): void {
	overrides =
		palette === undefined
			? undefined
			: Object.fromEntries(Object.entries(palette).map(([name, pair]) => [name, { ...pair }]));
	PALETTES.clear();
	epoch += 1;
}
/** Any SGR sequence; built from the escape code so the source carries no control character. */
const SGR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "gu");
function palette(background: ThemeBackground | null): Record<PaletteColor, TokenColor> {
	if (palettesVersion !== terminalColorVersion()) {
		palettesVersion = terminalColorVersion();
		PALETTES.clear();
	}
	let colors = PALETTES.get(background);
	if (colors === undefined) {
		const projected = Object.fromEntries(
			(Object.keys(TERMINAL_PALETTE) as PaletteColor[]).map((name): [PaletteColor, TokenColor] => {
				const override = overrides?.[name]?.[background ?? "dark"];
				const [hex, xterm] = override === undefined ? paletteProjection(name, background) : [override, 0];
				const rgb = hexRgb(hex);
				if (override !== undefined) return [name, { rgb, xterm: rgbXterm(rgb) }];
				return [name, { rgb, xterm, terminalForeground: background === null && TERMINAL_FOREGROUND_ON_UNKNOWN.has(name) }];
			}),
		) as Record<PaletteColor, TokenColor>;
		// The reported color solves only the palette of the scheme it belongs to, so
		// a theme pinned to the other scheme keeps its declared projection.
		const reported = background !== null && background === terminalBackground() ? terminalBackgroundColor() : null;
		colors =
			reported === null || background === null
				? projected
				: adaptPalette(projected, reported, background, new Set(Object.keys(overrides ?? {}) as PaletteColor[]));
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
	readonly depth: ColorDepth;
	/** `depth === "truecolor"`, for painters that blend their own ramps. */
	readonly truecolor: boolean;
	readonly context: ThemeContext;
	paint(text: string, mods: PaintMods): string;
	/** The parameters `paint` opens with and the exact ones that close them, for spans that must not reset a row. */
	sgr(mods: PaintMods): Sgr;
	fg(token: ClioToken, text: string, state?: RoleState): string;
	bg(token: ClioToken, text: string): string;
	style(token: ClioToken, text: string, mods?: Omit<PaintMods, "fg">): string;
	fgSequence(token: ClioToken): string;
	/** Reading foreground resumes after inline resets, preserving syntax and backgrounds. */
	base(role: SemanticRole, text: string): string;
}

interface DepthOptions {
	depth?: ColorDepth;
	/** Picks 24-bit color (`true`) or indexed color (`false`) at the terminal's declared depth. */
	truecolor?: boolean;
	/** `false` paints without color; `true` paints color even where the environment declines it. */
	color?: boolean;
}

function resolveDepth(options: DepthOptions): ColorDepth {
	if (options.depth !== undefined) return options.depth;
	if (options.color === false) return "none";
	let depth = colorDepth();
	if (depth === "none" && options.color === true) {
		const term = process.env.TERM;
		depth = colorDepth({ ...process.env, NO_COLOR: "", TERM: term === "dumb" || term === "unknown" ? "" : term });
	}
	if (options.truecolor === true) return "truecolor";
	return options.truecolor === false && depth === "truecolor" ? "256" : depth;
}

/** Things the operator must act on or read as a state stay at normal intensity without color. */
const NEVER_DIM = new Set<SemanticRole>([
	"keyboardHint",
	"decisionConsequence",
	"commandHint",
	"success",
	"warning",
	"error",
	"validationError",
]);
/** Supporting and subdued text and chrome dim when there is no color; bold text never does. */
function dimsWithoutColor(token: ClioToken, state: RoleState | undefined): boolean {
	if (!isSemanticRole(token)) return ANSI16[LEGACY_TOKEN_COLOR[token]].sgr.endsWith(";2");
	if (NEVER_DIM.has(token)) return false;
	if (state !== undefined && state !== "normal") return state === "disabled";
	if (isChromeRole(token)) return true;
	const intensity = roleIntensity(token);
	return intensity === "subdued" || intensity === "supporting";
}

/** Frames, dividers and meter tracks measured 2.69 to 3.66:1 over an owned background; this step holds 4.54 or more. */
const RECEDING = new Set<PaletteColor>(["border", "divider", "meterTrack"]);

/** SGR parameter groups, so `38;2;r;g;b` stays whole while repeated attributes collapse. */
function sgrGroups(parameters: string): string[] {
	if (parameters.length === 0) return [];
	const values = parameters.split(";");
	const groups: string[] = [];
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index] ?? "";
		const size =
			value === "38" || value === "48" ? (values[index + 1] === "2" ? 5 : values[index + 1] === "5" ? 3 : 1) : 1;
		groups.push(values.slice(index, index + size).join(";"));
		index += size - 1;
	}
	return groups;
}
const joinGroups = (...lists: string[][]): string => [...new Set(lists.flat())].join(";");

/** An intensity reset ends a dim that `base` must then resume. */
function sgrResetsIntensity(code: string): boolean {
	const parameters = code.slice(2, -1);
	return parameters === "" || sgrGroups(parameters).some((group) => group === "0" || group === "22");
}

function named(colors: Record<PaletteColor, TokenColor>, name: PaletteColor): SgrColor {
	return { ...colors[name], name };
}

export function fgSequence(token: ClioToken, depth: ColorDepth = colorDepth()): string {
	const background = terminalBackground();
	const color = named(palette(background), tokenStyle(token, DEFAULT_THEME_CONTEXT).color);
	const { open } = sgrFor({ fg: color }, depth, background);
	return open.length > 0 ? `\u001b[${open}m` : "";
}

export function createClioTheme(
	options: DepthOptions & { background?: ThemeBackground | null; context?: ThemeContext } = {},
): ClioTheme {
	const depth = resolveDepth(options);
	// Shared themes outlive a light and dark switch, so a theme with no pinned
	// background reads the live one, once per reported change.
	let followed = options.background === undefined ? terminalBackground() : options.background;
	let followedVersion = terminalColorVersion();
	const currentBackground = (): ThemeBackground | null => {
		if (options.background === undefined && followedVersion !== terminalColorVersion()) {
			followedVersion = terminalColorVersion();
			followed = terminalBackground();
		}
		return followed;
	};
	const context = () => options.context ?? renderContext;
	/** The background the palette is projected for: a declared composer surface always has one. */
	const projectedBackground = (): ThemeBackground | null => {
		const background = currentBackground();
		return projectsYolo(context()) ? (background ?? "dark") : background;
	};
	const colorFor = (token: ClioToken, state?: RoleState, overOwned = false): SgrColor => {
		const scope = context();
		let name = tokenStyle(token, scope, state).color;
		if ((overOwned || projectsYolo(scope)) && RECEDING.has(name)) name = "neutralSubdued";
		return named(palette(projectedBackground()), name);
	};
	const sgr = (mods: PaintMods): Sgr => {
		const bold = mods.bold ?? (mods.fg === undefined ? false : tokenStyle(mods.fg, context(), mods.state).bold);
		const dim =
			mods.dim === true || (depth === "none" && !bold && mods.fg !== undefined && dimsWithoutColor(mods.fg, mods.state));
		const bg = mods.bg === undefined ? undefined : colorFor(mods.bg);
		const overOwned = bg?.name !== undefined && OWNED_BACKGROUNDS.has(bg.name);
		const pair = sgrFor(
			{
				...(mods.fg === undefined ? {} : { fg: colorFor(mods.fg, mods.state, overOwned) }),
				...(bg === undefined ? {} : { bg }),
			},
			depth,
			projectedBackground(),
		);
		const open = [bold ? "1" : "", dim ? "2" : "", mods.italic ? "3" : "", mods.underline ? "4" : ""].filter(Boolean);
		const close = [bold || dim ? "22" : "", mods.italic ? "23" : "", mods.underline ? "24" : ""].filter(Boolean);
		return { open: joinGroups(open, sgrGroups(pair.open)), close: joinGroups(sgrGroups(pair.close), close) };
	};
	const paint = (text: string, mods: PaintMods): string => {
		const { open } = sgr(mods);
		return open.length === 0 ? text : `\u001b[${open}m${text}${SGR_RESET}`;
	};
	const fgOpen = (token: ClioToken): string => {
		const { open } = sgrFor({ fg: colorFor(token) }, depth, projectedBackground());
		return open.length > 0 ? `\u001b[${open}m` : "";
	};
	return {
		depth,
		truecolor: depth === "truecolor",
		get context() {
			return context();
		},
		paint,
		sgr,
		fg: (token, text, state) => paint(text, { fg: token, ...(state === undefined ? {} : { state }) }),
		bg: (token, text) => paint(text, { bg: token }),
		style: (token, text, mods = {}) => paint(text, { ...mods, fg: token }),
		fgSequence: fgOpen,
		base: (role, text) => {
			if (text.length === 0) return text;
			// Without color a quiet role's dim is its place on the ladder, resumed after an inner intensity reset.
			if (depth === "none") {
				if (!dimsWithoutColor(role, undefined)) return text;
				const resumed = text.replace(SGR_SEQUENCE, (code) => (sgrResetsIntensity(code) ? `${code}${SGR_DIM}` : code));
				return `${SGR_DIM}${resumed}${SGR_RESET}`;
			}
			const foreground = fgOpen(role);
			const dims = foreground.endsWith(";2m");
			const resumed = text.replace(SGR_SEQUENCE, (code) =>
				sgrResetsForeground(code) || (dims && sgrResetsIntensity(code)) ? `${code}${foreground}` : code,
			);
			return `${foreground}${resumed}${SGR_RESET}`;
		},
	};
}

/** True when `value` names one of the theme's own tokens, so it can be painted as one. */
export function isClioToken(value: string): value is ClioToken {
	return isSemanticRole(value) || Object.hasOwn(LEGACY_TOKEN_COLOR, value);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;

/**
 * Paint text in a configured `#rrggbb` color.
 *
 * A council roster member may carry one. A roster color is the operator's own
 * choice rather than a token from the palette, which is why a literal color
 * reaches the screen here and nowhere else. Returns the text unchanged when
 * color is disabled or the value is not a six-digit hex color, so a caller can
 * fall back to a token without inspecting the string twice. Indexed color gets
 * the nearest entry in the 6x6x6 xterm cube, and a 16-color terminal the
 * nearest ANSI hue.
 */
export function paintHex(text: string, hex: string, options: Omit<DepthOptions, "depth"> = {}): string {
	if (!HEX_COLOR.test(hex)) return text;
	const rgb = hexRgb(hex);
	const { open } = sgrFor({ fg: { rgb, xterm: rgbXterm(rgb) } }, resolveDepth(options), terminalBackground());
	return open.length === 0 ? text : `\u001b[${open}m${text}${SGR_RESET}`;
}
