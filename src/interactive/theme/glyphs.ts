export const GLYPH = {
	// Clio wordmark, shown in the welcome and dashboard headers. `agent` still
	// aliases it as the chat reply prefix until slice 4 flips the reply glyph.
	brand: ">C_",
	agent: ">C_",
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
