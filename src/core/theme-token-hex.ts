/** Semantic colors shared by Clio's terminal surfaces and generated companion profiles. */
export type ClioToken =
	| "editor"
	| "editorDanger"
	| "editorAction"
	| "accent"
	| "accentDeep"
	| "action"
	| "tool"
	| "agent"
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

/** The terminal background a palette is drawn for; `null` means unknown. */
export type ThemeBackground = "dark" | "light";

type Hex = `#${string}`;

/**
 * The palette's lowercase hex projection, one column per background:
 * [unknown, dark, light]. The unknown column sits in the middle luminance band
 * so it reads on either; the dark and light columns carry the brand at the
 * strength each background allows.
 *
 * Keep this leaf free of interactive imports. Generated companion profiles
 * need the color vocabulary without becoming a second reacher of the terminal
 * renderer and splitting the instant shell's Stage 0 chunk.
 */
const TOKEN_HEX: Readonly<Record<ClioToken, readonly [Hex, Hex, Hex]>> = {
	editor: ["#09969f", "#00d4db", "#00747c"],
	editorDanger: ["#e35656", "#ff6b6b", "#c42b2b"],
	editorAction: ["#d06d25", "#ea7b2a", "#ab500e"],
	accent: ["#319789", "#49deca", "#0e7566"],
	accentDeep: ["#188b7b", "#2bb39f", "#0a5f53"],
	action: ["#d06d25", "#ea7b2a", "#ab500e"],
	tool: ["#408c96", "#6cb8c4", "#2e6a75"],
	agent: ["#c0601f", "#e08a4a", "#9c4a14"],
	success: ["#2a9c5c", "#34d399", "#1d7440"],
	warning: ["#aa8118", "#fbbf24", "#865f00"],
	error: ["#dd5353", "#f87171", "#bf3030"],
	info: ["#4a90b4", "#6aaed6", "#2d638b"],
	reason: ["#9c8664", "#cdb48e", "#76603f"],
	dim: ["#6e7b85", "#7d8b97", "#6a7680"],
	muted: ["#608096", "#9fb0bd", "#4f6474"],
	title: ["#09969f", "#00d4db", "#00747c"],
	frame: ["#577287", "#3a6d91", "#9fb3c2"],
	frameStrong: ["#09969f", "#00d4db", "#00747c"],
};

/** The canonical lowercase `#rrggbb` value for one Clio theme token on a background. */
export function tokenHex(token: ClioToken, background: ThemeBackground | null = null): Hex {
	return TOKEN_HEX[token][background === "dark" ? 1 : background === "light" ? 2 : 0];
}
