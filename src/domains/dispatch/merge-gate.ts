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

export function boundedCheck(check: string): string {
	// Worker prose lands in a receipt detail and a terminal line, so control
	// characters collapse to spaces and the length is capped.
	const flat = check.replace(/[\p{Cc}\s]+/gu, " ").trim();
	return flat.length <= DECLARED_CHECK_DETAIL_MAX_CHARS
		? flat
		: `${flat.slice(0, DECLARED_CHECK_DETAIL_MAX_CHARS - 1)}…`;
}

/** Why a merge is held and the condition under which the preserved branch is still safe to merge. */
export interface MergeGateVerdict {
	/** The failing or unrun check, as a clause: what the operator is being asked to overlook. */
	reason: string;
	/** Completes "`git merge <branch>` applies it ...". */
	appliesWhen: string;
}

/**
 * Decide whether a succeeded merge-mode task worktree is kept off the
 * operator's branch. Returns the verdict when it is withheld, null when it may
 * merge. Two reports withhold: one listing a failing validation, and one that
 * asked for a check it did not run (`declaredChecks`) without any passing
 * validation, unless host verification passed. The second case merged a
 * left-pad change onto a red main (flywheel 31jukrioe38d).
 */
export function mergeGateVerdict(input: MergeGateInput): MergeGateVerdict | null {
	if (input.hostStatus === "verified") return null;
	if (input.quality === "fail") {
		return {
			reason: "the worker's own report lists a failing validation",
			appliesWhen: "if that failure was already there",
		};
	}
	if (input.contract === null) return null;
	const reported = mutationReportChecks(input.contract, input.output);
	const first = reported.declaredChecks[0];
	if (first === undefined || reported.validationPassed) return null;
	return {
		reason: `the worker asked for a check the host did not run (${boundedCheck(first)})`,
		appliesWhen: "once that check passes",
	};
}

/** The receipt detail for a withheld merge, or null when the merge may proceed. */
export function mergeWithheldDetail(input: MergeGateInput): string | null {
	const verdict = mergeGateVerdict(input);
	if (verdict === null) return null;
	return `merge withheld: ${verdict.reason}; its work is committed on the preserved branch ${input.branch}, and \`git merge ${input.branch}\` applies it ${verdict.appliesWhen}`;
}
