/** Semantic colors shared by Clio's terminal surfaces and generated companion profiles. */
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

/**
 * The palette's lowercase hex projection.
 *
 * Keep this leaf free of interactive imports. Generated companion profiles
 * need the color vocabulary without becoming a second reacher of the terminal
 * renderer and splitting the instant shell's Stage 0 chunk.
 */
const TOKEN_HEX: Readonly<Record<ClioToken, `#${string}`>> = {
	accent: "#46e5d0",
	accentDeep: "#1fb7a6",
	action: "#ff7e29",
	success: "#57e389",
	warning: "#ffb454",
	error: "#ff5c66",
	info: "#5ba8ff",
	reason: "#9d8cff",
	dim: "#6a7a85",
	muted: "#8a99a4",
	title: "#46e5d0",
	frame: "#2f5d5a",
	frameStrong: "#2aab9e",
};

/** The canonical lowercase `#rrggbb` value for one Clio theme token. */
export function tokenHex(token: ClioToken): `#${string}` {
	return TOKEN_HEX[token];
}
