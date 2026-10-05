/**
 * View vocabulary of operator runtime API v2. A view is bounded data: the host
 * draws it, owns wrapping, focus and keys, and maps tones to theme roles. An
 * extension never supplies a color, a control sequence or a component.
 * Bounds are in `view-limits.ts`; a view outside them is dropped whole.
 */
export type ViewTone = "neutral" | "muted" | "accent" | "brand" | "positive" | "warning" | "error" | "info";

/** A bordered box with a title is drawn as an island through the host's frame. */
export interface ViewBox {
	t: "box";
	dir?: "row" | "col";
	gap?: number;
	pad?: number;
	border?: "none" | "single" | "round";
	title?: string;
	/** Right-aligned annotation on a bordered box's title row. */
	meta?: string;
	/** Share of the free space along a row parent; a child without it takes its content width. */
	grow?: number;
	/** Fixed width in cells along a row parent. */
	width?: number;
	children: View[];
}

export interface ViewText {
	t: "text";
	text: string;
	tone?: ViewTone;
	bold?: boolean;
	dim?: boolean;
	wrap?: "wrap" | "truncate";
	align?: "left" | "center" | "right";
}

export interface ViewMarkdown {
	t: "markdown";
	text: string;
}

export interface ViewKeyValue {
	t: "kv";
	items: Array<{ label: string; value: string; tone?: ViewTone }>;
}

/** `keys` names each row for a press; without it a row answers with its index. */
export interface ViewTable {
	t: "table";
	columns: string[];
	rows: string[][];
	keys?: string[];
	action?: string;
}

export interface ViewList {
	t: "list";
	items: Array<{ key: string; label: string; detail?: string; mark?: string; tone?: ViewTone }>;
	action?: string;
}

export interface ViewSteps {
	t: "steps";
	items: Array<{ label: string; state: "done" | "active" | "todo" | "blocked" }>;
}

export interface ViewBadge {
	t: "badge";
	text: string;
	tone?: ViewTone;
}

export interface ViewBoardCard {
	key: string;
	title: string;
	detail?: string;
	badges?: Array<Omit<ViewBadge, "t">>;
	tone?: ViewTone;
}

export interface ViewBoard {
	t: "board";
	columns: Array<{ title: string; tone?: ViewTone; cards: ViewBoardCard[] }>;
	action?: string;
}

export interface ViewTreeNode {
	key: string;
	label: string;
	detail?: string;
	tone?: ViewTone;
	children?: ViewTreeNode[];
}

export interface ViewTree {
	t: "tree";
	nodes: ViewTreeNode[];
	action?: string;
}

export interface ViewProgress {
	t: "progress";
	value: number;
	max: number;
	label?: string;
	tone?: ViewTone;
}

export interface ViewSpark {
	t: "spark";
	values: number[];
	tone?: ViewTone;
}

/** `hotkey` is one digit or lowercase letter, live while the surface holds the keys. */
export interface ViewActions {
	t: "actions";
	items: Array<{ id: string; label: string; hotkey?: string; primary?: boolean }>;
}

/** Fixed-width art such as a wordmark. Lines are placed verbatim and never wrapped. */
export interface ViewArt {
	t: "art";
	lines: string[];
	tone?: ViewTone;
}

export interface ViewDivider {
	t: "divider";
}

export interface ViewSpacer {
	t: "spacer";
	size?: number;
}

export type View =
	| ViewBox
	| ViewText
	| ViewMarkdown
	| ViewKeyValue
	| ViewTable
	| ViewList
	| ViewSteps
	| ViewBoard
	| ViewTree
	| ViewProgress
	| ViewSpark
	| ViewBadge
	| ViewActions
	| ViewArt
	| ViewDivider
	| ViewSpacer;

export type ViewKind = View["t"];
