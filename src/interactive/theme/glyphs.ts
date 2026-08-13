export const GLYPH = {
	// Clio wordmark, shown in the welcome and dashboard headers only.
	brand: ">C_",
	// Agent voice glyph for the chat reply prefix. It renders in accent on a
	// normal turn and error red on a failed one. The `>C_` wordmark is no longer
	// the reply prefix; it survives only in the two headers above.
	agent: "✦",
	user: "›",
	// Selection focus marker for list overlays. It is deliberately distinct from
	// the tool ledger's toolHeader so a focused row never reads as a tool line.
	cursor: "❯",
	toolHeader: "▸",
	running: "●",
	queued: "◌",
	speed: "⚡",
	ok: "✓",
	error: "✗",
	cancelled: "⊘",
	active: "◆",
	scoped: "◇",
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
	info: "ℹ",
	warn: "⚠",
	warnInline: "!",
	phaseWaiting: "◔",
	phaseThinking: "◐",
	phaseWriting: "◑",
	phaseTool: "⚙",
	phaseBlocked: "⏸",
	phaseRetry: "↻",
	phaseCompact: "♻",
	phaseDispatch: "⇲",
	ellipsis: "…",
	favorite: "★",
} as const;

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

export function spinnerFrame(tick: number): string {
	const index = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}
