export type ClioToken =
	| "accent"
	| "accentDeep"
	| "action"
	| "success"
	| "warning"
	| "error"
	| "info"
	| "reason"
	| "dim"
	| "muted"
	| "title"
	| "frame"
	| "frameStrong";

interface TokenColor {
	rgb: readonly [number, number, number];
	xterm: number;
}

const TOKENS: Record<ClioToken, TokenColor> = {
	accent: { rgb: [70, 229, 208], xterm: 80 },
	accentDeep: { rgb: [31, 183, 166], xterm: 44 },
	// Second brand color: neon orange. The token name teaches the rule: orange
	// means Clio is acting. It fires only for Clio's signature actions
	// (dispatching, queued and running fleet work, steering) and for the border
	// of a prompt that has taken the keyboard and is waiting on a decision, never
	// as decoration, and never a metric, at most one orange element per region of
	// the screen. warning stays the soft amber for actual warnings.
	action: { rgb: [255, 126, 41], xterm: 208 },
	success: { rgb: [87, 227, 137], xterm: 114 },
	warning: { rgb: [255, 180, 84], xterm: 221 },
	error: { rgb: [255, 92, 102], xterm: 203 },
	info: { rgb: [91, 168, 255], xterm: 75 },
	reason: { rgb: [157, 140, 255], xterm: 141 },
	dim: { rgb: [106, 122, 133], xterm: 59 },
	muted: { rgb: [138, 153, 164], xterm: 102 },
	title: { rgb: [70, 229, 208], xterm: 80 },
	frame: { rgb: [47, 93, 90], xterm: 23 },
	frameStrong: { rgb: [42, 171, 158], xterm: 37 },
};

export const SGR_RESET = "\u001b[0m";
export const SGR_DIM = "\u001b[2m";

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
		fgSequence: (token) => (color ? fgSequence(token, truecolor) : ""),
	};
}
