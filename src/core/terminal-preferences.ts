/** Nonempty NO_COLOR or a terminal declaring no capabilities disables color. */
export function colorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.NO_COLOR?.length ?? 0) > 0 || env.TERM === "dumb" || env.TERM === "unknown";
}

/** How many colors CLIO Coder may paint with. `none` keeps bold, dim, underline and inverse only. */
export type ColorDepth = "truecolor" | "256" | "16" | "none";

const SIXTEEN_COLOR_TERMS = new Set(["linux", "ansi", "xterm-color", "cons25"]);

/** The color capability the terminal declares, detected the same way for every surface; `none` wins over every hint. */
export function colorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
	if (colorDisabled(env)) return "none";
	const colorTerm = (env.COLORTERM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();
	if ([colorTerm, term].some((value) => value.includes("truecolor") || value.includes("24bit"))) return "truecolor";
	if (SIXTEEN_COLOR_TERMS.has(term) || term.endsWith("-16color") || term.startsWith("vt")) return "16";
	return "256";
}

/** Explicit ASCII UI glyphs, or a terminal with no declared glyph capabilities. */
export function asciiOnly(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.CLIO_CODER_ASCII === "1" || env.TERM === "dumb" || env.TERM === "unknown";
}

/** Shared by every terminal animation; static labels still convey active work. */
export function motionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env.CLIO_CODER_REDUCE_MOTION !== "1" && env.CLIO_CODER_SCREEN_READER !== "1" && !asciiOnly(env) && !colorDisabled(env)
	);
}

/** Font coverage cannot be inferred from TERM, SSH, or color support. */
export function nerdFontEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.CLIO_CODER_NERD_FONT === "1" && env.CLIO_CODER_SCREEN_READER !== "1" && !asciiOnly(env);
}
