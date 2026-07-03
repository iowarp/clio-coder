export const GLYPH = {
	// Clio wordmark, shown in the welcome and dashboard headers only.
	brand: ">C_",
	// Agent voice glyph for the chat reply prefix. It renders in accent on a
	// normal turn and error red on a failed one. The `>C_` wordmark is no longer
	// the reply prefix; it survives only in the two headers above.
	agent: "✦",
	user: "›",
	// Selection focus marker for list overlays. Its value flips to "❯" in slice
	// 9; until then it stays "▸" so the refactor renders byte-identically.
	cursor: "▸",
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
} as const;

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

export function spinnerFrame(tick: number): string {
	const index = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}
