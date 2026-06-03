export type ClioToken =
	| "accent"
	| "accentDeep"
	| "success"
	| "warning"
	| "error"
	| "info"
	| "reason"
	| "loop"
	| "dim"
	| "muted"
	| "title"
	| "frame";

interface TokenColor {
	rgb: readonly [number, number, number];
	xterm: number;
}

const TOKENS: Record<ClioToken, TokenColor> = {
	accent: { rgb: [70, 229, 208], xterm: 80 },
	accentDeep: { rgb: [31, 183, 166], xterm: 44 },
	success: { rgb: [87, 227, 137], xterm: 114 },
	warning: { rgb: [255, 180, 84], xterm: 221 },
	error: { rgb: [255, 92, 102], xterm: 203 },
	info: { rgb: [91, 168, 255], xterm: 75 },
	reason: { rgb: [157, 140, 255], xterm: 141 },
	loop: { rgb: [255, 122, 198], xterm: 207 },
	dim: { rgb: [106, 122, 133], xterm: 59 },
	muted: { rgb: [138, 153, 164], xterm: 102 },
	title: { rgb: [70, 229, 208], xterm: 80 },
	frame: { rgb: [47, 93, 90], xterm: 23 },
};

export const SGR_RESET = "\u001b[0m";
export const SGR_BOLD = "\u001b[1m";
export const SGR_DIM = "\u001b[2m";
export const SGR_ITALIC = "\u001b[3m";
export const SGR_UNDERLINE = "\u001b[4m";

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

export function detectTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
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
	return `\u001b[${fgCode(TOKENS[token], truecolor)}m`;
}

export function createClioTheme(options: { truecolor?: boolean } = {}): ClioTheme {
	const truecolor = options.truecolor ?? detectTruecolor();
	const paint = (text: string, mods: PaintMods): string => {
		const codes: string[] = [];
		if (mods.bold) codes.push("1");
		if (mods.dim) codes.push("2");
		if (mods.italic) codes.push("3");
		if (mods.underline) codes.push("4");
		if (mods.fg) codes.push(fgCode(TOKENS[mods.fg], truecolor));
		if (mods.bg) codes.push(bgCode(TOKENS[mods.bg], truecolor));
		if (codes.length === 0) return text;
		return `\u001b[${codes.join(";")}m${text}${SGR_RESET}`;
	};
	return {
		truecolor,
		paint,
		fg: (token, text) => paint(text, { fg: token }),
		bg: (token, text) => paint(text, { bg: token }),
		style: (token, text, mods = {}) => paint(text, { ...mods, fg: token }),
		fgSequence: (token) => fgSequence(token, truecolor),
	};
}
