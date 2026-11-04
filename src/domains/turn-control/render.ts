export const TURN_CONTROL_BLOCK_MAX_CHARS = 4000;

/** Keep complete lines, including when an individual line exceeds the whole budget. */
function block(opening: string[], findings: string[]): string {
	const kept = [...findings];
	while (kept.length > 0 && [...opening, ...kept].join("\n").length > TURN_CONTROL_BLOCK_MAX_CHARS) kept.pop();
	const lines = [...opening, ...kept];
	while (lines.length > 0 && lines.join("\n").length > TURN_CONTROL_BLOCK_MAX_CHARS) lines.pop();
	return lines.join("\n");
}

export function renderCollectedBlock(rendered: string): string {
	return block(
		[
			"[Collected]",
			"These detached runs finished and Clio collected them; their sealed run records are the durable record. Use these results for synthesis and do not call monitor to collect them again.",
			"",
		],
		rendered.split(/\r?\n/),
	);
}
