export const TURN_CONTROL_BLOCK_MAX_CHARS = 4000;

function line(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Keep complete findings and lines, including when an individual finding exceeds the whole budget. */
function block(opening: string[], findings: string[], closing: string[]): string {
	const kept = [...findings];
	while (kept.length > 0 && [...opening, ...kept, ...closing].join("\n").length > TURN_CONTROL_BLOCK_MAX_CHARS)
		kept.pop();
	const lines = [...opening, ...kept, ...closing];
	while (lines.length > 0 && lines.join("\n").length > TURN_CONTROL_BLOCK_MAX_CHARS) lines.pop();
	return lines.join("\n");
}

export function orientationQuestion(operatorText: string, _breadth: "repository" | "area", maxScouts: number): string {
	const text = Array.from(line(operatorText)).slice(0, 300).join("");
	return `Orient a newcomer to this repository for the request: "${text}".\nReport purpose, top-level layout, entry points, build and test commands, key boundaries or\ninvariants, and where the request's subject lives if it names one. Cite paths. If independent\nareas need separate investigation, return a split of at most ${maxScouts} subtasks.`;
}

export interface OrientationBlockInput {
	runId: string;
	receiptDigest: string;
	findings: ReadonlyArray<{ claim: string; path?: string; line?: number }>;
	ungrounded: ReadonlyArray<string>;
	toolCalls: number;
	budget: number;
	split: number | null;
	groundingLine?: string;
}

export function renderOrientationBlock(input: OrientationBlockInput): string {
	return block(
		[
			`[Orientation] Clio ran Scout before this turn (run ${line(input.runId)}, receipt ${line(input.receiptDigest).slice(0, 12)}) for repository orientation; do not dispatch Scout again for this orientation.`,
			"Findings (cited):",
		],
		input.findings.map(
			(finding) =>
				`- ${line(finding.claim)}${finding.path ? ` (${line(finding.path)}${finding.line !== undefined ? `:${finding.line}` : ""})` : ""}`,
		),
		[
			`Ungrounded leads: ${input.ungrounded.length > 0 ? input.ungrounded.map(line).join("; ") : "none"}`,
			`Limitations: ${input.toolCalls}/${input.budget} tool calls; split: ${input.split === null ? "none" : `${input.split} scouts`}${input.groundingLine ? `; ${line(input.groundingLine)}` : ""}`,
			"Answer the user from these findings. Use focused reads only for specific facts still missing.",
		],
	);
}

export function renderOrientationUnavailable(runId: string, outcome: string): string {
	return block(
		[
			`[Orientation] Scout run ${line(runId)} ended ${line(outcome)}; orientation is unavailable. Proceed with the user's request.`,
		],
		[],
		[],
	);
}

export interface DirectionBlockInput {
	cwd: string;
	git: { branch: string; modified: number; untracked: number; recent: ReadonlyArray<string> } | null;
	tree: ReadonlyArray<string>;
	codemap: string | null;
}

export function renderDirectionBlock(input: DirectionBlockInput): string {
	return block(
		[
			"[Direction] The user asked for direction and no task is established. Read-only workspace observations, run by Clio:",
		],
		[
			`cwd: ${line(input.cwd)}`,
			input.git
				? `git: branch ${line(input.git.branch)}; ${input.git.modified} modified, ${input.git.untracked} untracked; recent: ${input.git.recent.slice(0, 3).map(line).join("; ")}`
				: "git: none",
			`tree: ${input.tree.slice(0, 40).map(line).join(", ")}`,
			`codemap: ${input.codemap === null ? "none" : line(input.codemap)}`,
		],
		[
			"Offer two or three concrete next steps grounded in these observations. Ask one consequential question only if a real choice is visible. Do not edit, run checks, install, activate skills, or dispatch.",
		],
	);
}

export function renderCollectedBlock(rendered: string): string {
	return block(
		[
			"[Collected]",
			"These detached runs finished and Clio collected them; their sealed receipts are the durable record. Use these results for synthesis and do not call monitor to collect them again.",
			"",
		],
		rendered.split(/\r?\n/),
		[],
	);
}
