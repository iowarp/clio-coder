import type { ResultContract } from "../agents/result-contract.js";
import { mutationReportChecks } from "../agents/result-contract.js";

const DECLARED_CHECK_DETAIL_MAX_CHARS = 120;

export interface MergeGateInput {
	/** Quality sealed on the receipt's result contract fact, if any. */
	quality: string | undefined;
	/** Host verification status, undefined when no check was configured. */
	hostStatus: string | undefined;
	contract: ResultContract | null;
	/** The worker's captured final answer. */
	output: string | null;
	branch: string;
}

function boundedCheck(check: string): string {
	// Worker prose lands in a receipt detail and a terminal line, so control
	// characters collapse to spaces and the length is capped.
	const flat = check.replace(/[\p{Cc}\s]+/gu, " ").trim();
	return flat.length <= DECLARED_CHECK_DETAIL_MAX_CHARS
		? flat
		: `${flat.slice(0, DECLARED_CHECK_DETAIL_MAX_CHARS - 1)}…`;
}

/**
 * Decide whether a succeeded merge-mode task worktree is kept off the
 * operator's branch. Returns the receipt detail when it is withheld, null when
 * it may merge. Two reports withhold: one listing a failing validation, and one
 * that asked for a check it did not run (`declaredChecks`) without any passing
 * validation, unless host verification passed. The second case merged a
 * left-pad change onto a red main (flywheel 31jukrioe38d).
 */
export function mergeWithheldDetail(input: MergeGateInput): string | null {
	if (input.hostStatus === "verified") return null;
	const preserved = (condition: string) =>
		`its work is committed on the preserved branch ${input.branch}, and \`git merge ${input.branch}\` applies it ${condition}`;
	if (input.quality === "fail") {
		return `merge withheld: the worker's own report lists a failing validation; ${preserved("if that failure was already there")}`;
	}
	if (input.contract === null) return null;
	const reported = mutationReportChecks(input.contract, input.output);
	const first = reported.declaredChecks[0];
	if (first === undefined || reported.validationPassed) return null;
	return `merge withheld: the worker asked for a check the host did not run (${boundedCheck(first)}); ${preserved("once that check passes")}`;
}
