import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { capabilityEntries, verifyFoundNoChecks } from "../../domains/safety/finish-contract.js";
import { type RunEffects, validationCommandOf } from "../../domains/safety/run-effects.js";

/**
 * What the harness itself saw a headless main-agent run do, beside the model's own account of it: tool calls,
 * refusals, successful writes, and the checks that stand at the end of the run. The checks are the run-effects
 * recorder's own outcomes, the ones the sealed receipt reads, so this line never reports a pass the receipt refuses
 * (x4-1). A check the recorder does not recognise or could not attribute is absent, never invented.
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
	effects: Pick<RunEffects, "validationOutcomes" | "checkOutcomes">;
	toolCalls: number;
	refused: number;
	writes: number;
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
	const noChecksDeclared = input.toolCalls > 0 && checks.length === 0 && verifyFoundNoChecks(own);
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
