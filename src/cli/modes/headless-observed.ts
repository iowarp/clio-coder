import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { verifyFoundNoChecks } from "../../domains/safety/finish-contract.js";
import { standingChecksFrom } from "../../domains/safety/observed-checks.js";

/**
 * What the harness itself saw a headless main-agent run do, beside the model's own account of it: tool calls,
 * refusals, successful writes, and the checks that stand at the end of the run's own stretch of the session.
 * It reads only what the tools recorded; a check the fold does not recognise is absent, never invented.
 * `noChecksDeclared` is set when no check stands and a `verify` call found none declared or derivable in the workspace.
 */
export interface HeadlessObserved {
	toolCalls: number;
	refused: number;
	writes: number;
	checks: Array<{ name: string; passed: boolean }>;
	noChecksDeclared?: true;
}

const NAME_LIMIT = 80;
const NAMES_SHOWN = 3;

export function observeHeadlessRun(input: {
	entries: ReadonlyArray<unknown>;
	start: number;
	workspaceRoot: string;
	toolCalls: number;
	refused: number;
	writes: number;
}): HeadlessObserved {
	const checks =
		input.toolCalls > 0
			? standingChecksFrom(input.entries, Math.max(0, input.start), input.workspaceRoot).map((check) => ({
					name: check.name,
					passed: check.passed,
				}))
			: [];
	const noChecksDeclared =
		input.toolCalls > 0 && checks.length === 0 && verifyFoundNoChecks(input.entries.slice(Math.max(0, input.start)));
	return {
		toolCalls: input.toolCalls,
		refused: input.refused,
		writes: input.writes,
		checks,
		...(noChecksDeclared ? { noChecksDeclared: true as const } : {}),
	};
}

function names(list: ReadonlyArray<string>): string {
	const shown = list.slice(0, NAMES_SHOWN).map((name) => {
		const clean = sanitizeCallTargetText(name);
		return clean.length > NAME_LIMIT ? `${clean.slice(0, NAME_LIMIT - 1)}…` : clean;
	});
	const rest = list.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** The one stderr line, or null for a run that called no tool. */
export function formatHeadlessObservedLine(observed: HeadlessObserved): string | null {
	if (observed.toolCalls === 0) return null;
	const parts = [`${observed.toolCalls} tool call${observed.toolCalls === 1 ? "" : "s"}, ${observed.refused} refused`];
	if (observed.writes > 0) parts.push(`${observed.writes} write${observed.writes === 1 ? "" : "s"}`);
	const passed = observed.checks.filter((check) => check.passed).map((check) => check.name);
	const failed = observed.checks.filter((check) => !check.passed).map((check) => check.name);
	if (passed.length > 0) parts.push(`check${passed.length === 1 ? "" : "s"} passed: ${names(passed)}`);
	if (failed.length > 0) parts.push(`check${failed.length === 1 ? "" : "s"} failed: ${names(failed)}`);
	if (observed.writes > 0 && observed.checks.length === 0)
		parts.push(
			observed.noChecksDeclared ? "no checks declared in the workspace" : "no check observed after the last write",
		);
	return `clio-coder run: observed: ${parts.join(" · ")}`;
}
