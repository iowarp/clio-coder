/** Semantic colors shared by Clio's terminal surfaces and generated companion profiles. */
export type ClioToken =
	| "editor"
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

/**
 * The palette's lowercase hex projection.
 *
 * Keep this leaf free of interactive imports. Generated companion profiles
 * need the color vocabulary without becoming a second reacher of the terminal
 * renderer and splitting the instant shell's Stage 0 chunk.
 */
const TOKEN_HEX: Readonly<Record<ClioToken, `#${string}`>> = {
	editor: "#40ffde",
	accent: "#53b1a4",
	accentDeep: "#3e9389",
	action: "#d99b62",
	tool: "#6fada5",
	agent: "#cf905b",
	success: "#77b891",
	warning: "#d3b06b",
	error: "#db8289",
	info: "#80a7ce",
	reason: "#af9bc9",
	dim: "#6a7a85",
	muted: "#8a99a4",
	title: "#72b8ad",
	frame: "#2f5d5a",
	frameStrong: "#2aab9e",
};

/** The canonical lowercase `#rrggbb` value for one Clio theme token. */
export function tokenHex(token: ClioToken): `#${string}` {
	return TOKEN_HEX[token];
}
