/**
 * Fixed palette for the arcade easter egg, after its reference art: dark navy
 * ground, slate walls, teal bugs and player trail, orange gate bars. It is
 * deliberately independent of the active skin.
 */
export const ARCADE_PALETTE = {
	bg: "\x1b[48;2;10;18;32m",
	wall: "\x1b[38;2;52;72;96m",
	teal: "\x1b[38;2;25;182;201m",
	orange: "\x1b[38;2;232;116;42m",
	ghost: "\x1b[38;2;220;225;235m",
	bold: "\x1b[1m",
	reset: "\x1b[0m",
} as const;
