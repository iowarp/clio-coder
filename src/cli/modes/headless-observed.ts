import { unclassifiedAfterLastCheck } from "../../domains/dispatch/run-findings.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { validationCommandOf } from "../../domains/safety/check-classifier.js";
import { capabilityEntries, verifyFoundNoChecks } from "../../domains/safety/finish-contract.js";
import { standingDispatchRuns } from "../../domains/safety/observed-checks.js";
import type { RunEffects } from "../../domains/safety/run-effects.js";

/**
 * What the harness itself saw a headless main-agent run do, beside the model's own account of it: tool calls,
 * refusals, successful writes, and the checks that stand at the end of the run. The checks are the run-effects
 * recorder's own outcomes, the ones the sealed receipt reads, so this line never reports a pass the receipt refuses
 * (x4-1). A check the recorder does not recognise or could not attribute is absent, never invented. A passing dispatch
 * run record still standing joins them from the task board's fold over the same entries, since the recorder reads a
 * dispatch only as a write (bt-verify7a).
 * `noChecksDeclared` is set when no check stands and a `verify` call found none declared or derivable in the workspace.
 * `unclassifiedAfterLastCheck` counts the calls the check classifier could not read that ran after the oldest check
 * outcome still standing: they neither settled nor cleared it, so the line names them beside it. `unclassifiedFailed`
 * names the ones that ran and failed, standing check or not, and the count leaves them out (x8-2).
 */
export interface HeadlessObserved {
	toolCalls: number;
	refused: number;
	writes: number;
	checks: Array<{ name: string; passed: boolean }>;
	noChecksDeclared?: true;
	unclassifiedAfterLastCheck?: number;
	unclassifiedFailed?: { count: number; commands: string[] };
	/** The completion the agent declared through `finish` (fleet design 4.3); absent when it declared none. */
	completion?: "done" | "partly_done" | "not_done";
}

const NAME_LIMIT = 80;
const NAMES_SHOWN = 3;

/** The check ids the run's `verify` calls named, as the recorder files their outcomes. */
function verifyCheckIds(entries: ReadonlyArray<unknown>): Set<string> {
	const ids = new Set<string>();
	for (const entry of capabilityEntries(entries)) {
		const item = entry as { kind?: unknown; role?: unknown; payload?: { name?: unknown; args?: { check?: unknown } } };
		if (item?.kind !== "message" || item.role !== "tool_call" || item.payload?.name !== "verify") continue;
		const check = item.payload.args?.check;
		if (typeof check === "string" && check.trim().length > 0) ids.add(check.trim());
	}
	return ids;
}

export function observeHeadlessRun(input: {
	entries: ReadonlyArray<unknown>;
	start: number;
	/** The run's recorded effects: bash checks under their full command, verify checks under their id (x4-1). */
	effects: Pick<
		RunEffects,
		"validationOutcomes" | "checkOutcomes" | "unclassifiedAfterLastCheck" | "unclassifiedFailed"
	>;
	toolCalls: number;
	refused: number;
	writes: number;
	/** The run's workspace and `safety.scratchRoots`, for the dispatch run records; absent, none is read. */
	workspaceRoot?: string;
	scratchRoots?: ReadonlyArray<string>;
}): HeadlessObserved {
	const own = input.entries.slice(Math.max(0, input.start));
	const verifyChecks = input.toolCalls > 0 ? verifyCheckIds(own) : new Set<string>();
	// A verify outcome is also filed under the command it resolved to; its id names it once.
	const checks =
		input.toolCalls > 0
			? [...input.effects.checkOutcomes].flatMap(([key, passed]) =>
					input.effects.validationOutcomes.has(key)
						? [{ name: key, passed }]
						: verifyChecks.has(key)
							? [{ name: validationCommandOf("verify", { check: key }, "grounding") ?? `verify ${key}`, passed }]
							: [],
				)
			: [];
	if (input.toolCalls > 0 && input.workspaceRoot !== undefined)
		for (const run of standingDispatchRuns(input.entries, input.start, input.workspaceRoot, input.scratchRoots))
			checks.push({ name: run, passed: true });
	const noChecksDeclared = input.toolCalls > 0 && checks.length === 0 && verifyFoundNoChecks(own);
	// The receipt's own rule: the recorder lists a call only while an outcome stands, so both surfaces count one list (x6-6).
	// A red one is listed regardless and named apart, redacted as the receipt redacts it (x8-2).
	const failedCount = input.effects.unclassifiedFailed?.length ?? 0;
	const failed = unclassifiedAfterLastCheck({
		unclassifiedAfterLastCheck: [...new Set(input.effects.unclassifiedFailed ?? [])],
	});
	const unclassified = (unclassifiedAfterLastCheck(input.effects)?.count ?? 0) - failedCount;
	return {
		toolCalls: input.toolCalls,
		refused: input.refused,
		writes: input.writes,
		checks,
		...(noChecksDeclared ? { noChecksDeclared: true as const } : {}),
		...(unclassified > 0 ? { unclassifiedAfterLastCheck: unclassified } : {}),
		...(failed !== null ? { unclassifiedFailed: failed } : {}),
	};
}

function names(list: ReadonlyArray<string>, total = list.length): string {
	const shown = list.slice(0, NAMES_SHOWN).map((name) => {
		const clean = sanitizeCallTargetText(name);
		return clean.length > NAME_LIMIT ? `${clean.slice(0, NAME_LIMIT - 1)}…` : clean;
	});
	const rest = total - shown.length;
	return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** The one stderr line, or null for a run that called no tool and declared no completion. */
export function formatHeadlessObservedLine(observed: HeadlessObserved): string | null {
	if (observed.toolCalls === 0 && observed.completion === undefined) return null;
	const parts = [`${observed.toolCalls} tool call${observed.toolCalls === 1 ? "" : "s"}, ${observed.refused} refused`];
	if (observed.writes > 0) parts.push(`${observed.writes} write${observed.writes === 1 ? "" : "s"}`);
	const passed = observed.checks.filter((check) => check.passed).map((check) => check.name);
	const failed = observed.checks.filter((check) => !check.passed).map((check) => check.name);
	if (passed.length > 0) parts.push(`check${passed.length === 1 ? "" : "s"} passed: ${names(passed)}`);
	if (failed.length > 0) parts.push(`check${failed.length === 1 ? "" : "s"} failed: ${names(failed)}`);
	const red = observed.unclassifiedFailed;
	if (red !== undefined && red.count > 0)
		parts.push(`unclassified command${red.count === 1 ? "" : "s"} failed: ${names(red.commands, red.count)}`);
	const unclassified = observed.unclassifiedAfterLastCheck ?? 0;
	if (unclassified > 0)
		parts.push(`${unclassified} unclassified command${unclassified === 1 ? "" : "s"} ran after a standing check`);
	if (observed.writes > 0 && observed.checks.length === 0)
		parts.push(
			observed.noChecksDeclared ? "no checks declared in the workspace" : "no check observed after the last write",
		);
	if (observed.completion !== undefined) parts.push(`completion ${observed.completion}`);
	return `clio-coder run: observed: ${parts.join(" · ")}`;
}
