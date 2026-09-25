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
	editor: "#0f9c82",
	editorDanger: "#ec3e45",
	editorAction: "#d6660f",
	accent: "#0e967f",
	accentDeep: "#0c8c76",
	action: "#d6660f",
	tool: "#4a8793",
	agent: "#c3672b",
	success: "#2b973f",
	warning: "#b17c00",
	error: "#e94146",
	info: "#3a7fe8",
	reason: "#966bce",
	dim: "#7c7c7c",
	muted: "#78828c",
	title: "#0e967f",
	frame: "#707a85",
	frameStrong: "#0f9c82",
};

/** The canonical lowercase `#rrggbb` value for one Clio theme token. */
export function tokenHex(token: ClioToken): `#${string}` {
	return TOKEN_HEX[token];
}
