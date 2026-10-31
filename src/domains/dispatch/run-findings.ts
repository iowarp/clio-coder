/**
 * A run's result quality and verification facts, derived from its in-memory draft at settlement. The run's findings
 * are its assessment's, journaled as evidence.assessed (src/domains/evidence/assessment.ts, #434).
 */

import { createHash } from "node:crypto";
import type {
	RunResultContractFact,
	RunResultDraft,
	RunResultQuality,
	RunResultTypedValidationFact,
	RunResultVerification,
} from "./types.js";

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("response schema digest requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => {
				if (record[key] === undefined) throw new Error("response schema digest cannot contain undefined");
				return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
			})
			.join(",")}}`;
	}
	throw new Error(`response schema digest cannot represent ${typeof value}`);
}

function canonicalResponseSchemaDigest(schema: Record<string, unknown>): string {
	return createHash("sha256").update(canonicalJson(schema), "utf8").digest("hex");
}

export interface CreateRunResultQualityInput {
	responseSchema?: Record<string, unknown>;
	runtimeEnforceable: boolean;
	enforcementPassed: boolean | null;
	typedValidations?: ReadonlyArray<RunResultTypedValidationFact>;
	resultContract?: RunResultContractFact | null;
}

/**
 * `verify` is Clio's typed verifier tool. Its sealed aggregate records the
 * tool identity and pass/fail result; generic process exit and shell commands
 * never enter this channel.
 */
function typedValidationFactsFromToolStats(
	toolStats: ReadonlyArray<Pick<RunResultDraft["toolStats"][number], "tool" | "count" | "ok" | "errors" | "blocked">>,
): RunResultTypedValidationFact[] {
	return toolStats
		.filter((stat) => stat.tool === "verify" && stat.count > stat.blocked)
		.map((stat) => ({
			sourceId: "tool:verify",
			validatorDigest: createHash("sha256").update(canonicalJson(stat), "utf8").digest("hex"),
			passed: stat.ok === stat.count - stat.blocked && stat.errors === 0,
		}));
}

/**
 * One finished `verify` call, in the order the run finished them. `check` is
 * the call's {@link verifyCheckIdentity}, or null when the finish could not be
 * tied to the arguments of its start. `outcome` is null when the finish named
 * no outcome this build recognizes.
 */
export interface VerifyCallOutcome {
	check: string | null;
	outcome: "ok" | "error" | "blocked" | null;
}

/**
 * Argument fields that change what a `verify` call checks. `timeout_ms` and
 * `max_output_bytes` only bound the same check, so a retry with more time is
 * still that check. `args` narrows a script (`test` against one file) and
 * `browser` weakens a frontend check, so either one makes a different check:
 * a narrower pass must never clear a wider failure.
 */
const VERIFY_IDENTITY_FIELDS = ["check", "path", "cwd", "browser"] as const;

function verifyScriptArgs(value: unknown): unknown {
	// The tool accepts `args` as a JSON-encoded array from weak models
	// (`prepareVerifyArguments`), so both spellings must name one check.
	if (typeof value !== "string") return value;
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : value;
	} catch {
		// A malformed string is still a distinct argument; keying on it as given
		// keeps it apart from every other spelling.
		return value;
	}
}

/**
 * The canonical identity of the check one `verify` call ran, read from the
 * call's own arguments. Two calls with the same identity ran the same check,
 * so the later one's outcome supersedes the earlier one's. Null when the
 * arguments are not an object or cannot be represented.
 */
export function verifyCheckIdentity(args: unknown): string | null {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
	const record = args as Record<string, unknown>;
	const identity: Record<string, unknown> = {};
	for (const field of VERIFY_IDENTITY_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value.trim().length > 0) identity[field] = value.trim();
	}
	const scriptArgs = verifyScriptArgs(record.args);
	if (scriptArgs !== undefined && !(Array.isArray(scriptArgs) && scriptArgs.length === 0)) identity.args = scriptArgs;
	try {
		return canonicalJson(identity);
	} catch {
		// A value canonical JSON refuses cannot name a check; the call falls back
		// to the conservative per-tool aggregate instead.
		return null;
	}
}

function typedVerifyFact(
	check: string | null,
	outcomes: ReadonlyArray<string | null>,
	passed: boolean,
): RunResultTypedValidationFact {
	const evidence = { tool: "verify", check, outcomes };
	return {
		sourceId: "tool:verify",
		validatorDigest: createHash("sha256").update(canonicalJson(evidence), "utf8").digest("hex"),
		passed,
	};
}

/**
 * Typed validation facts for `verify`, one per check the run ran. A check's
 * latest executed outcome decides it: an earlier failure the run fixed and
 * re-ran clean seals as passed, and a pass the run later broke seals as failed
 *. A blocked attempt never ran the check, so it supersedes nothing,
 * and a check with only blocked calls seals no validation fact.
 *
 * Calls that cannot be tied to a check share one fact that passes only when
 * every such call passed. When no call can be tied to a check, the result is
 * the per-tool aggregate, excluding checks whose calls were all blocked.
 */
export function typedValidationFactsFromVerifyCalls(
	toolStats: ReadonlyArray<Pick<RunResultDraft["toolStats"][number], "tool" | "count" | "ok" | "errors" | "blocked">>,
	calls: ReadonlyArray<VerifyCallOutcome>,
): RunResultTypedValidationFact[] {
	if (!calls.some((call) => call.check !== null && call.outcome !== null)) {
		return typedValidationFactsFromToolStats(toolStats);
	}
	const byCheck = new Map<string, Array<"ok" | "error">>();
	const unattributed: Array<string | null> = [];
	for (const call of calls) {
		if (call.outcome === "blocked") continue;
		if (call.check === null || call.outcome === null) {
			unattributed.push(call.outcome);
			continue;
		}
		const outcomes = byCheck.get(call.check) ?? [];
		outcomes.push(call.outcome);
		byCheck.set(call.check, outcomes);
	}
	const facts: RunResultTypedValidationFact[] = [];
	for (const [check, outcomes] of byCheck) {
		facts.push(typedVerifyFact(check, outcomes, outcomes.at(-1) === "ok"));
	}
	if (unattributed.length > 0) {
		facts.push(
			typedVerifyFact(
				null,
				unattributed,
				unattributed.every((outcome) => outcome === "ok"),
			),
		);
	}
	return facts;
}

/** Create the required, JSON-clean quality block for one receipt finalization. */
export function createRunResultQuality(input: CreateRunResultQualityInput): RunResultQuality {
	const schemaDigest = input.responseSchema === undefined ? null : canonicalResponseSchemaDigest(input.responseSchema);
	return {
		version: 1,
		typedValidations: [...(input.typedValidations ?? [])]
			.map((fact) => ({ ...fact }))
			.sort(
				(left, right) =>
					left.sourceId.localeCompare(right.sourceId) || left.validatorDigest.localeCompare(right.validatorDigest),
			),
		responseSchema: {
			sourceId: schemaDigest === null ? null : `dispatch.response-schema:${schemaDigest}`,
			schemaDigest,
			runtimeEnforceable: input.responseSchema === undefined ? false : input.runtimeEnforceable,
			enforcementPassed: input.responseSchema === undefined ? null : input.enforcementPassed,
		},
		resultContract: input.resultContract ?? null,
	};
}

const VALIDATION_TOOL_NEEDLES = [
	"pytest",
	"ctest",
	"jest",
	"vitest",
	"test",
	"lint",
	"typecheck",
	"check",
	"ci",
	"validate",
	"verify",
] as const;

function isValidationTool(tool: string): boolean {
	const name = tool.toLowerCase();
	return VALIDATION_TOOL_NEEDLES.some((needle) => name.includes(needle));
}

/** A validation tool the run was observed to call, whatever it answered. */
function ranValidationTool(draft: Pick<RunResultDraft, "toolStats">): boolean {
	return draft.toolStats.some((stat) => stat.count > 0 && isValidationTool(stat.tool));
}

/**
 * Whether some validation tool passed. `verify` answers through its typed
 * facts when the receipt has them, because the per-tool aggregate cannot tell
 * a check the run fixed and re-ran from one it left failing. Other
 * validation tools carry no check identity, so their aggregate still decides.
 */
function hasPassingValidation(
	toolStats: RunResultDraft["toolStats"],
	typedValidations: ReadonlyArray<RunResultTypedValidationFact> | undefined,
): boolean {
	const verifyFacts = (typedValidations ?? []).filter((fact) => fact.sourceId === "tool:verify");
	return toolStats.some((stat) => {
		if (!isValidationTool(stat.tool)) return false;
		if (stat.tool === "verify" && verifyFacts.length > 0) return verifyFacts.every((fact) => fact.passed);
		return stat.ok > 0 && stat.errors === 0;
	});
}

/**
 * Derive the receipt's descriptive evidence-confidence marker without
 * changing execution semantics. ACP agents may validate externally, so lack
 * of Clio-observed validation is unknown rather than a negative assertion.
 * Pass the receipt's typed validations so the marker agrees with them.
 */
export function deriveRunVerification(
	draft: Pick<RunResultDraft, "toolStats"> & { typedValidations?: ReadonlyArray<RunResultTypedValidationFact> },
	context: { capabilityClass?: string | null; acpDelegation?: boolean } = {},
): RunResultVerification {
	if (context.capabilityClass === "read-only") {
		return { state: "not_applicable", basis: "read-only-agent" };
	}
	if (hasPassingValidation(draft.toolStats, draft.typedValidations)) {
		return { state: "verified", basis: "validation-tool" };
	}
	// The basis names the claimant that answered and the state carries its
	// verdict (glossary: grounded is "observed to run and pass, named by its
	// claimant"). A validation tool that ran and failed was still observed, so
	// reporting `no-validation-tool` contradicted the receipt's own typed
	// validations. It also outranks the ACP basis, which exists for a
	// peer whose validation Clio could not see.
	if (ranValidationTool(draft)) {
		return { state: "unverified", basis: "validation-tool" };
	}
	if (context.acpDelegation === true) {
		return { state: "unknown", basis: "acp-external-unobserved" };
	}
	return { state: "unverified", basis: "no-validation-tool" };
}

/**
 * Evidence confidence when no sealed receipt can be read: the run has none, or
 * its integrity check failed, so nothing it claims may be reported as verified.
 */
export const UNVERIFIABLE_RUN_VERIFICATION: RunResultVerification = {
	state: "unknown",
	basis: "result-unavailable",
};
