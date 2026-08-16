/**
 * Claimed validations, measured against the commands the run actually ran.
 *
 * E7 grounded `mutatedPaths` against the run's own tool events. The same defect
 * lives one field over. Observed live (receipt 1yd79n91i9b0): a `verifier-report`
 * sealed `{"verdict":"pass","checks":[{"name":"npm run typecheck","passed":true,
 * "evidence":"exit 0"}]}` on a project with no `typecheck` script, from a run
 * whose complete tool list was six reads and a grep. No shell call ran at all,
 * and the receipt still carried `quality: pass`.
 *
 * `validateVerifier` derives quality from the verdict alone, and the mutation
 * validator only asks whether *some* validation command ran, not whether the
 * named one did. This module answers the narrower question, using the same
 * canonical command identity the finish-contract gate and `run-effects` use, so
 * a claim and an execution are compared under one notion of "the same check".
 *
 * Grounding is deliberately generous, twice over. A claim counts as executed
 * when the canonical form of either string appears in the other, because a
 * worker writes `"npm test (12 passing)"` for a command it genuinely ran. And
 * an unmatched claim only becomes a correctness downgrade when the run executed
 * no checking call at all; a run that ran commands the canonical detector does
 * not recognize gets `unmatched-command`, which is reported and never used to
 * take a quality label away. That distinction was bought live: a coder verified
 * its own fix with `node -e "import('./src/sum.js')..."`, real work that
 * `detectValidationCommand` does not enumerate, and calling that a fabricated
 * check would be the same false-confidence defect pointed the other way.
 *
 * Because a miss here costs a line of receipt noise rather than an open gate,
 * this module reads claims under the wider `grounding` vocabulary: read
 * verification (`git diff`), ad-hoc checks (`node -e`), and the runners the
 * strict set omits (`npx vitest`, `tsc --noEmit`). The finish contract and the
 * mutation-report validator keep the strict vocabulary, where a match is spent
 * on a gate and `git diff` must not satisfy one.
 *
 * Only passing claims are checked: a check the worker reports as failed is a
 * report against its own interest and needs no corroboration.
 */

import { parseJsonObjectPayload } from "../../core/json-payload.js";
import type { ResultContract } from "../agents/result-contract.js";
import { detectValidationCommand } from "../safety/protected-artifacts.js";

/** Contract kinds whose terminal payload carries a correctness claim to ground. */
const GROUNDED_CONTRACT_KINDS: ReadonlySet<ResultContract["kind"]> = new Set(["verifier-report", "mutation-report"]);

/** Claimed check names quoted back in one outcome detail before it is truncated. */
const UNGROUNDED_NAME_LIMIT = 4;

export interface ValidationGrounding {
	/** Passing validation claims the terminal result carried. */
	claimed: number;
	/** Claims matched to a command this run ran to a clean exit. */
	grounded: number;
	/** Claim names with no matching execution, stably ordered, bounded. */
	ungrounded: ReadonlyArray<string>;
	/**
	 * Why the unmatched claims are unmatched. `no-command-executed` means the run
	 * ran nothing that could have checked anything, which is the only basis that
	 * takes a quality label away. `unmatched-command` means it ran something the
	 * canonical detector does not enumerate, which is reported and nothing more.
	 */
	basis: "no-command-executed" | "unmatched-command";
}

export interface ValidationGroundingInput {
	contractKind: ResultContract["kind"] | null;
	/** The run's terminal assistant text, or null when none was captured. */
	output: string | null;
	/** Canonical validation commands the run ran to a clean exit. */
	executedCommands: ReadonlySet<string>;
	/** Successful shell and typed-verification calls this run made, matched or not. */
	executedCheckingCalls: number;
}

function normalize(value: string): string {
	return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * The canonical command a claim names, or its normalized text when the claim
 * is not spelled as a shell command ("typecheck", "unit tests").
 */
function claimIdentity(name: string): string {
	const detected = detectValidationCommand(name, "grounding");
	return detected.kind === "validation" ? normalize(detected.matched) : normalize(name);
}

function claimedValidationNames(output: string | null): string[] {
	if (output === null) return [];
	// Read through the shared payload reader so a fenced report that its
	// contract accepted does not silently yield no claims here.
	const parsed = parseJsonObjectPayload(output);
	if (!parsed.ok) return [];
	const record = parsed.value;
	const entries = record.checks ?? record.validations;
	if (!Array.isArray(entries)) return [];
	const names: string[] = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const check = entry as Record<string, unknown>;
		if (check.passed !== true || typeof check.name !== "string") continue;
		const name = check.name.trim();
		if (name.length > 0) names.push(name);
	}
	return names;
}

function isExecuted(name: string, executed: ReadonlySet<string>): boolean {
	const claim = claimIdentity(name);
	if (claim.length === 0) return true;
	for (const command of executed) {
		const ran = normalize(command);
		if (ran.length === 0) continue;
		if (claim.includes(ran) || ran.includes(claim)) return true;
	}
	return false;
}

/**
 * Fold a terminal result's passing validation claims against the run's executed
 * commands. Returns null when there is nothing to ground, which is every
 * contract kind that carries no correctness claim and every result that named
 * no passing check.
 */
export function groundClaimedValidations(input: ValidationGroundingInput): ValidationGrounding | null {
	if (input.contractKind === null || !GROUNDED_CONTRACT_KINDS.has(input.contractKind)) return null;
	const claims = claimedValidationNames(input.output);
	if (claims.length === 0) return null;
	const ungrounded: string[] = [];
	let grounded = 0;
	for (const name of claims) {
		if (isExecuted(name, input.executedCommands)) grounded += 1;
		else if (!ungrounded.includes(name)) ungrounded.push(name);
	}
	return {
		claimed: claims.length,
		grounded,
		ungrounded: ungrounded.slice(0, UNGROUNDED_NAME_LIMIT),
		basis: input.executedCheckingCalls > 0 ? "unmatched-command" : "no-command-executed",
	};
}

/** True when the sealed quality label may not rest on these claims. */
export function invalidatesQuality(grounding: ValidationGrounding): boolean {
	return grounding.ungrounded.length > 0 && grounding.basis === "no-command-executed";
}

/** One line naming what the run claimed and never ran, for the sealed outcome. */
export function describeUngroundedValidations(grounding: ValidationGrounding): string {
	const named = grounding.ungrounded.map((name) => JSON.stringify(name)).join(", ");
	return grounding.basis === "no-command-executed"
		? `unverifiable validation: this run claimed ${named} passed and executed no command at all (${grounding.grounded}/${grounding.claimed} claims grounded)`
		: `unmatched validation: this run claimed ${named} passed; it did run commands, but none the harness recognizes as that check (${grounding.grounded}/${grounding.claimed} claims grounded)`;
}
