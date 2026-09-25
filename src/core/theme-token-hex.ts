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
	editor: "#9acbb6",
	editorDanger: "#e08278",
	editorAction: "#d7a16f",
	accent: "#79b29b",
	accentDeep: "#5f9687",
	action: "#bd8862",
	tool: "#87aaa0",
	agent: "#af7959",
	success: "#8eb99b",
	warning: "#d5b46f",
	error: "#d28b87",
	info: "#9bb9b1",
	reason: "#bca993",
	dim: "#78817e",
	muted: "#9ba6a1",
	title: "#8ebfae",
	frame: "#466a61",
	frameStrong: "#73a895",
};

/** The canonical lowercase `#rrggbb` value for one Clio theme token. */
export function tokenHex(token: ClioToken): `#${string}` {
	return TOKEN_HEX[token];
}
