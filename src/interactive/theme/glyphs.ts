export const GLYPH = {
	agent: "◈",
	user: "›",
	toolHeader: "▸",
	running: "●",
	ok: "✓",
	error: "✗",
	cancelled: "⊘",
	thinkOn: "◆",
	thinkOff: "◇",
	up: "↑",
	down: "↓",
	rail: "│",
	barFull: "█",
	barEmpty: "░",
	info: "ℹ",
	warn: "⚠",
} as const;

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

export function spinnerFrame(tick: number): string {
	const index = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}
