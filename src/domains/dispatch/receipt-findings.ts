/**
 * Cheap, pure findings classifier for the durable receipt summary. It maps
 * outcome, outcomeDetail, exitCode, toolStats, and toolActivity from the receipt
 * draft and ledger envelope to a conservative subset of the EvidenceTag taxonomy.
 *
 * This is deliberately NOT buildEvidence. The forensic aggregator reads the
 * persisted receipt, so calling it at record time would create a cycle. This
 * classifier only inspects in-memory draft fields, emits a tag only when the
 * data justifies it, and keeps the result JSON-clean (stably ordered tag array,
 * boolean firstPassSuccess, finite findingCount) so the v3 integrity digest can
 * fold it without hitting a non-finite or undefined value.
 */

import { createHash } from "node:crypto";
import { type EvidenceTag, FAILURE_CAUSE_TAG_ORDER, FAILURE_CAUSE_TAGS } from "../evidence/index.js";
import type {
	RunEnvelope,
	RunReceiptDraft,
	RunReceiptFindingsSummary,
	RunReceiptQuality,
	RunReceiptResultContractFact,
	RunReceiptTypedValidationFact,
	RunReceiptVerification,
} from "./types.js";

function lower(value: string | null | undefined): string {
	return (value ?? "").toLowerCase();
}

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

export interface CreateRunReceiptQualityInput {
	responseSchema?: Record<string, unknown>;
	runtimeEnforceable: boolean;
	enforcementPassed: boolean | null;
	typedValidations?: ReadonlyArray<RunReceiptTypedValidationFact>;
	resultContract?: RunReceiptResultContractFact | null;
}

/**
 * `verify` is Clio's typed verifier tool. Its sealed aggregate records the
 * tool identity and pass/fail result; generic process exit and shell commands
 * never enter this channel.
 */
function typedValidationFactsFromToolStats(
	toolStats: ReadonlyArray<Pick<RunReceiptDraft["toolStats"][number], "tool" | "count" | "ok" | "errors" | "blocked">>,
): RunReceiptTypedValidationFact[] {
	return toolStats
		.filter((stat) => stat.tool === "verify" && stat.count > 0)
		.map((stat) => ({
			sourceId: "tool:verify",
			validatorDigest: createHash("sha256").update(canonicalJson(stat), "utf8").digest("hex"),
			passed: stat.ok === stat.count && stat.errors === 0 && stat.blocked === 0,
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
 * a narrower pass must never clear a wider failure (BT-017).
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
): RunReceiptTypedValidationFact {
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
 * (BT-017). A blocked attempt never ran the check, so it supersedes nothing,
 * and a check with no executed call was never observed to pass.
 *
 * Calls that cannot be tied to a check share one fact that passes only when
 * every such call passed. When no call can be tied to a check, the result is
 * exactly the per-tool aggregate earlier builds sealed.
 */
export function typedValidationFactsFromVerifyCalls(
	toolStats: ReadonlyArray<Pick<RunReceiptDraft["toolStats"][number], "tool" | "count" | "ok" | "errors" | "blocked">>,
	calls: ReadonlyArray<VerifyCallOutcome>,
): RunReceiptTypedValidationFact[] {
	if (!calls.some((call) => call.check !== null && call.outcome !== null)) {
		return typedValidationFactsFromToolStats(toolStats);
	}
	const byCheck = new Map<string, Array<"ok" | "error" | "blocked">>();
	const unattributed: Array<string | null> = [];
	for (const call of calls) {
		if (call.check === null || call.outcome === null) {
			unattributed.push(call.outcome);
			continue;
		}
		const outcomes = byCheck.get(call.check) ?? [];
		outcomes.push(call.outcome);
		byCheck.set(call.check, outcomes);
	}
	const facts: RunReceiptTypedValidationFact[] = [];
	for (const [check, outcomes] of byCheck) {
		const executed = outcomes.filter((outcome) => outcome !== "blocked");
		facts.push(typedVerifyFact(check, outcomes, executed.at(-1) === "ok"));
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
export function createRunReceiptQuality(input: CreateRunReceiptQualityInput): RunReceiptQuality {
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

function toolNamesLower(draft: RunReceiptDraft): string[] {
	return draft.toolStats.map((stat) => stat.tool.toLowerCase());
}

function anyToolMatches(toolNames: string[], needles: readonly string[]): boolean {
	return toolNames.some((name) => needles.some((needle) => name.includes(needle)));
}

function blockedCount(draft: RunReceiptDraft): number {
	const fromStats = draft.toolStats.reduce((total, stat) => total + stat.blocked, 0);
	const fromActivity = draft.toolActivity?.blocked ?? 0;
	return Math.max(fromStats, fromActivity);
}

const TEST_TOOL_NEEDLES = ["pytest", "ctest", "jest", "vitest", "test", "lint", "typecheck"] as const;
const BUILD_TOOL_NEEDLES = ["build", "compile", "make", "cmake", "cargo", "gradle", "ninja", "tsc"] as const;
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

/**
 * Emit the conservative failure-cause tags justified by the draft + envelope.
 * Only signals that are unambiguous in the available data produce a tag.
 */
function classifyTags(draft: RunReceiptDraft, envelope: RunEnvelope): Set<EvidenceTag> {
	const tags = new Set<EvidenceTag>();
	const outcome = draft.outcome ?? envelope.outcome ?? null;
	const detail = lower(draft.outcomeDetail ?? envelope.outcomeDetail);
	const failureText = `${lower(draft.failureMessage)} ${detail}`;
	const exitCode = draft.exitCode;
	const nonzeroExit = Number.isFinite(exitCode) && exitCode !== 0;
	const toolNames = toolNamesLower(draft);

	// Timeout: an explicit timed_out/stalled outcome, or timeout language in the
	// detail/failure text.
	if (outcome === "timed_out" || outcome === "stalled") {
		tags.add("timeout");
	} else if (failureText.includes("timed out") || failureText.includes("timeout")) {
		tags.add("timeout");
	}

	// Auth failure: credential/api-key/auth language in the failure text.
	if (
		failureText.includes("auth") ||
		failureText.includes("api key") ||
		failureText.includes("credential") ||
		failureText.includes("unauthorized")
	) {
		tags.add("auth-failure");
	}

	// Missing dependency: explicit dependency/module-not-found language.
	if (
		failureText.includes("module not found") ||
		failureText.includes("missing package") ||
		failureText.includes("missing dependency")
	) {
		tags.add("missing-dependency");
	}

	// Blocked tool: any blocked attempt recorded in stats or activity totals.
	if (blockedCount(draft) > 0) {
		tags.add("blocked-tool");
	}

	// Build/test failure: a nonzero exit paired with a build/test command in the
	// tool stats. Build takes precedence when both appear, matching the forensic
	// classifier's ordering.
	if (nonzeroExit) {
		if (anyToolMatches(toolNames, BUILD_TOOL_NEEDLES)) {
			tags.add("build-failure");
		} else if (anyToolMatches(toolNames, TEST_TOOL_NEEDLES)) {
			tags.add("test-failure");
		}
	}

	return tags;
}

function isValidationTool(tool: string): boolean {
	const name = tool.toLowerCase();
	return VALIDATION_TOOL_NEEDLES.some((needle) => name.includes(needle));
}

/** A validation tool the run was observed to call, whatever it answered. */
function ranValidationTool(draft: Pick<RunReceiptDraft, "toolStats">): boolean {
	return draft.toolStats.some((stat) => stat.count > 0 && isValidationTool(stat.tool));
}

function hasValidationEvidence(draft: Pick<RunReceiptDraft, "toolStats">): boolean {
	return draft.toolStats.some((stat) => {
		if (stat.ok <= 0 || stat.errors > 0) return false;
		return isValidationTool(stat.tool);
	});
}

/**
 * Whether some validation tool passed. `verify` answers through its typed
 * facts when the receipt has them, because the per-tool aggregate cannot tell
 * a check the run fixed and re-ran from one it left failing (BT-017). Other
 * validation tools carry no check identity, so their aggregate still decides.
 */
function hasPassingValidation(
	toolStats: RunReceiptDraft["toolStats"],
	typedValidations: ReadonlyArray<RunReceiptTypedValidationFact> | undefined,
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
export function deriveReceiptVerification(
	draft: Pick<RunReceiptDraft, "toolStats"> & { typedValidations?: ReadonlyArray<RunReceiptTypedValidationFact> },
	context: { capabilityClass?: string | null; acpDelegation?: boolean } = {},
): RunReceiptVerification {
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
	// validations (BT-012). It also outranks the ACP basis, which exists for a
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
export const UNVERIFIABLE_RECEIPT_VERIFICATION: RunReceiptVerification = {
	state: "unknown",
	basis: "receipt-unavailable",
};

/**
 * Compute the durable findings summary for a receipt draft. Pure and cheap:
 * inspects only in-memory fields, never reads disk or calls buildEvidence.
 *
 * firstPassSuccess (per spec section 7) requires a succeeded outcome, zero
 * dispatch retries (lineage.attempt === 0), a cheap positive validation signal
 * in the receipt stats, and no failure-cause tag. Absent draft lineage falls
 * back to the envelope before treating the run as attempt 0.
 */
export function computeReceiptFindingsSummary(
	draft: RunReceiptDraft,
	envelope: RunEnvelope,
): RunReceiptFindingsSummary {
	const detected = classifyTags(draft, envelope);
	const tags = FAILURE_CAUSE_TAG_ORDER.filter((tag) => detected.has(tag));

	const outcome = draft.outcome ?? envelope.outcome ?? null;
	const attempt = draft.lineage?.attempt ?? envelope.lineage?.attempt ?? 0;
	const hasFailureCause = tags.some((tag) => FAILURE_CAUSE_TAGS.has(tag));
	const firstPassSuccess = outcome === "succeeded" && attempt === 0 && hasValidationEvidence(draft) && !hasFailureCause;

	return {
		tags,
		firstPassSuccess,
		findingCount: tags.length,
	};
}
