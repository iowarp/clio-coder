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

/**
 * The palette's lowercase hex projection.
 *
 * Keep this leaf free of interactive imports. Generated companion profiles
 * need the color vocabulary without becoming a second reacher of the terminal
 * renderer and splitting the instant shell's Stage 0 chunk.
 */
const TOKEN_HEX: Readonly<Record<ClioToken, `#${string}`>> = {
	editor: "#09969f",
	editorDanger: "#e35656",
	editorAction: "#d06d25",
	accent: "#319789",
	accentDeep: "#188b7b",
	action: "#d06d25",
	tool: "#408c96",
	agent: "#c0601f",
	success: "#2a9c5c",
	warning: "#aa8118",
	error: "#dd5353",
	info: "#4a90b4",
	reason: "#9c8664",
	dim: "#6e7b85",
	muted: "#608096",
	title: "#319789",
	frame: "#577287",
	frameStrong: "#09969f",
};

/** The canonical lowercase `#rrggbb` value for one Clio theme token. */
export function tokenHex(token: ClioToken): `#${string}` {
	return TOKEN_HEX[token];
}
