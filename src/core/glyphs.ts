import { asciiOnly } from "./terminal-preferences.js";

/**
 * CLIO Coder's chrome glyphs. The table lives in core so the pane process, which cannot import
 * `src/interactive`, draws the same vocabulary as the TUI. ASCII mode is a promise about this chrome only: a path,
 * a command, a task or an answer is printed byte for byte in every mode.
 */
const UNICODE_GLYPHS = {
	// Clio wordmark, shown in the welcome and dashboard headers only.
	brand: ">C_",
	// Agent voice glyph for the chat reply prefix. It renders in accent on a
	// normal turn and error red on a failed one. The `>C_` wordmark is no longer
	// the reply prefix; it survives only in the two headers above.
	agent: "✦",
	user: "›",
	// Operator input in the transcript. Every row of a prompt carries the bar in
	// the gutter, so a multi-line prompt reads as one block that is plainly the
	// operator's and never as the agent's first sentence.
	userBar: "▌",
	// Selection focus marker for list overlays. It is deliberately distinct from
	// the tool ledger's toolHeader so a focused row never reads as a tool line.
	cursor: "❯",
	// The lane that owns the keys on a multi-lane surface: this and its rule read without colour.
	laneOwner: "▶",
	laneRule: "━",
	// Where a lane's cursor would be while another lane owns the keys.
	laneCurrent: "›",
	// Action rows carry their class in the gutter: `▸` observes or searches,
	// `§` consults Clio's knowledge, `±` changes files, `$` executes, `↗`
	// reaches the network, `◆` delegates, `?` asks the operator and `⇢` calls a
	// capability outside Clio. The shape alone tells the acts apart.
	toolHeader: "▸",
	classKnowledge: "§",
	classMutate: "±",
	classExecute: "$",
	classNetwork: "↗",
	classInteraction: "?",
	classExternal: "⇢",
	running: "●",
	queued: "◌",
	// Retired: an emoji-presentation glyph drawn two cells wide. The unit `tok/s` says it; empty until callers drop it.
	speed: "",
	ok: "✓",
	error: "✗",
	cancelled: "⊘",
	// The tip or lane the operator is on. Filled diamonds belong to model-started work.
	active: "◉",
	// A setting changed from its default. Hollow diamonds belong to operator-started work.
	scoped: "*",
	up: "↑",
	down: "↓",
	rail: "│",
	rule: "─",
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	dot: "·",
	// The fact separator between two facts on one row, so ASCII mode can replace it.
	sep: "·",
	innerDivider: "╌",
	barFull: "█",
	barEmpty: "░",
	contextFull: "▰",
	contextFree: "▱",
	// Autocompact reserve cells: held-back headroom is neither used nor free,
	// so it carries its own glyph and never reads as filled when only color is
	// lost. The medium-shade block is single-width in the same fonts that carry
	// the barFull/barEmpty fallbacks.
	contextReserve: "▒",
	// One-row history, lowest to highest: one cell per level.
	spark: "▁▂▃▄▅▆▇█",
	// One mark for an estimated quantity.
	estimate: "≈",
	// One mark for a lower bound.
	atLeast: "≥",
	info: "i",
	warn: "!",
	warnInline: "!",
	phaseWaiting: "◔",
	phaseThinking: "◐",
	// Nerd Font nf-fa-brain: a full, symmetric two-hemisphere monochrome glyph.
	// Opt-in only; the composer uses ordinary dots unless font support is declared.
	brain: "\uEE9C",
	phaseWriting: "◑",
	// A tool call made by a worker: the hollow form of the tool gutter `▸`.
	phaseTool: "▹",
	// A wait on the operator. U+2016 is in every monospace font and has no emoji fallback.
	phaseBlocked: "‖",
	// A turn that a schedule started, not the operator or the model.
	scheduled: "◷",
	phaseRetry: "↻",
	phaseCompact: "≡",
	phaseDispatch: "⇲",
	// Marks a run that Clio started for itself (a shadow worker or an internal
	// harness run) so internal activity reads as a sub-process of the current
	// turn. It replaces the old `sh:`/`in:` agent-name prefixes; the two
	// audiences are told apart by tone, not by a second glyph.
	subProcess: "↳",
	// Who asked for a dispatched run. Hollow is the operator's own (/run,
	// /delegate); filled is one the model started by calling a dispatch tool.
	// The transcript block, the board row, and the footer count share the pair,
	// so a running ◇ anywhere is work the operator started themselves.
	workerHuman: "◇",
	workerAgent: "◆",
	// A run neither the operator nor the model asked for: wiki documenting, a
	// bootstrap scout, a judge. It stays off the transcript entirely, so the
	// board is the only surface that shows it and it gets the quietest mark
	// that still holds the origin column.
	workerInternal: "·",
	ellipsis: "…",
	// A model picked recently, in the model picker's mark column.
	recent: "↺",
	// Quota and resource meters: consumed and remaining cells. Heavier than the
	// frame's own line so a meter never reads as a border.
	meterFull: "━",
	meterEmpty: "─",
	// The rest of a code line that wrapped: the row above it continues here.
	codeWrap: "↪",
	// A sequence or next step: dashboard page order, a key chord's second key.
	next: "→",
	// A count of the same thing repeated: a worker's repeated call, a helper kind.
	times: "×",
	favorite: "★",
} as const;

/**
 * Written out entry by entry, never spread from the Unicode table, so every value is ASCII bytes by construction
 * and a new Unicode entry fails to compile until it has an ASCII form. Blocked (`=`) differs from warning (`!`).
 */
const ASCII_GLYPHS: { readonly [K in keyof typeof UNICODE_GLYPHS]: string } = {
	brand: ">C_",
	agent: "*",
	user: ">",
	userBar: "|",
	cursor: ">",
	laneOwner: ">",
	laneRule: "-",
	laneCurrent: ">",
	toolHeader: ">",
	classKnowledge: "K",
	classMutate: "+",
	classExecute: "$",
	classNetwork: "N",
	classInteraction: "?",
	classExternal: "E",
	running: "@",
	queued: "o",
	speed: "",
	ok: "+",
	error: "x",
	cancelled: "-",
	active: "@",
	scoped: "*",
	up: "^",
	down: "v",
	rail: "|",
	rule: "-",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	dot: ".",
	sep: "|",
	innerDivider: "-",
	barFull: "#",
	barEmpty: ".",
	contextFull: "#",
	contextFree: ".",
	contextReserve: ":",
	spark: ".:-=+*#@",
	estimate: "~",
	atLeast: ">=",
	info: "i",
	warn: "!",
	warnInline: "!",
	phaseWaiting: "o",
	phaseThinking: "?",
	brain: "?",
	phaseWriting: ">",
	phaseTool: ">",
	phaseBlocked: "=",
	scheduled: "t",
	phaseRetry: "r",
	phaseCompact: "c",
	phaseDispatch: "D",
	subProcess: ">",
	workerHuman: "o",
	workerAgent: "*",
	workerInternal: ".",
	ellipsis: "~",
	recent: "r",
	meterFull: "#",
	meterEmpty: "-",
	codeWrap: ">",
	next: ">",
	times: "x",
	favorite: "*",
};

/** One glyph vocabulary for the process; cards never select their own fallback. */
export const GLYPH = asciiOnly() ? ASCII_GLYPHS : UNICODE_GLYPHS;
