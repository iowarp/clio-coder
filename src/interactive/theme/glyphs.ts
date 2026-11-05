import { motionEnabled } from "../../core/terminal-preferences.js";

export const GLYPH = {
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
	speed: "⚡",
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
	info: "i",
	warn: "!",
	warnInline: "!",
	phaseWaiting: "◔",
	phaseThinking: "◐",
	// Nerd Font nf-fa-brain: a full, symmetric two-hemisphere monochrome glyph.
	// Opt-in only; the composer uses ordinary dots unless font support is declared.
	brain: "\uEE9C",
	phaseWriting: "◑",
	phaseTool: "⚙",
	phaseBlocked: "⏸",
	// A turn that a schedule started, not the operator or the model.
	scheduled: "◷",
	phaseRetry: "↻",
	phaseCompact: "♻",
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

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

/** Shared presentation snapshot cadence. Routine progress marks remain static. */
export const ANIMATION_STEP_MS = 120;
export const ATTENTION_STEP_MS = 480;

export function animationStep(nowMs: number): number {
	return Math.floor(nowMs / ANIMATION_STEP_MS);
}

/** Routine progress stays steady; only a pending human decision opts into motion. */
export function spinnerFrame(tick: number, attention = false): string {
	if (!attention || !motionEnabled()) return GLYPH.running;
	const index = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

export function attentionCue(nowMs: number, animate = true): string {
	if (!animate) return GLYPH.running;
	return spinnerFrame(Math.floor(nowMs / ATTENTION_STEP_MS), true);
}
