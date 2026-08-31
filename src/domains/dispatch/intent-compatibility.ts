/**
 * The one migration and refusal policy for typed dispatch intent.
 *
 * Typed intent (#155) is authoritative for policy-bearing scope (#158) and the
 * legacy prose-inference path (#159) survives beside it. Those three landed the
 * mechanism; this module owns the lifecycle question they left open: for any
 * dispatch producer, what happens when intent is omitted, partially declared,
 * carries a version this build does not speak, or contradicts another field on
 * the same request.
 *
 * Every answer here is one of three decisions, and the boundary between them is
 * the load-bearing rule:
 *
 * - `accept`: the request is unambiguous. Nothing is reported.
 * - `warn`: the request is compatible but its policy-bearing scope was resolved
 *   from something weaker than a declaration. The dispatch proceeds with the
 *   authority it would have had anyway; the warning exists so the weaker basis
 *   is visible before execution and countable afterwards.
 * - `refuse`: the request states two incompatible things about authority, or
 *   states one this build cannot interpret. The dispatch never runs.
 *
 * A `warn` may never be the difference between a narrow and a wide grant. That
 * is the invariant every rule below is written to preserve: no path through this
 * module widens read, write, or verification authority to resolve an ambiguity.
 * When the compatible reading and the declared reading disagree about what a
 * worker may touch, the answer is a refusal, never the union.
 *
 * The module is pure: no filesystem, no clock, no package-layout lookup. A
 * source checkout and an installed package classify identical input identically,
 * which is what makes the version rules verifiable rather than environmental.
 */

import { pathBoundaryCovers, resolvePathBoundary } from "../../core/path-boundary.js";
import { type DispatchIntent, isDispatchIntent } from "./intent.js";

/** The intent shape this build speaks. Bump with the `DispatchIntent` interface. */
export const DISPATCH_INTENT_VERSION = 2;

/**
 * Every intent version this build accepts. Deliberately not a range: a reader
 * that accepts "2 or newer" accepts fields it cannot interpret, and a reader
 * that accepts "2 or older" reads a v1 declaration under v2 rules. Membership in
 * this list is the whole test.
 */
export const DISPATCH_INTENT_SUPPORTED_VERSIONS: ReadonlyArray<number> = [DISPATCH_INTENT_VERSION];

export type DispatchIntentCompatibilityDecision = "accept" | "warn" | "refuse";

/**
 * Stable reason codes. These are a contract: they appear in refusal messages,
 * diagnostics, and contract tests, and callers may branch on them. Renaming one
 * is a breaking change to every surface that reports dispatch admission.
 */
export type DispatchIntentCompatibilityCode =
	/** No typed intent at all; policy-bearing scope came from legacy inference. */
	| "intent_absent_legacy_inference"
	/** Typed intent declared paths but no verification requirement. */
	| "intent_partial_verification_absent"
	/** `intent.version` names a version this build does not speak. */
	| "intent_version_unsupported"
	/** Present but not a normalized intent for a reason other than its version. */
	| "intent_malformed"
	/** Declared `intent.write_roots` and legacy `writeRoots` name different trees. */
	| "intent_write_roots_contradiction"
	/** A declared expected output lies outside every declared write root. */
	| "intent_outputs_outside_write_roots"
	/** Write roots declared on a request whose autonomy cannot write. */
	| "intent_write_without_authority"
	/** A narrowed intent reaches outside the intent it is supposed to narrow. */
	| "intent_scope_widening";

export interface DispatchIntentCompatibilityFinding {
	code: DispatchIntentCompatibilityCode;
	decision: DispatchIntentCompatibilityDecision;
	/** Operator-facing text, prefixed with the code and naming the fix. */
	message: string;
}

export interface DispatchIntentCompatibilityInput {
	/** The request's `intent` field exactly as the producer set it. */
	intent?: unknown;
	/** The request's legacy `writeRoots` field exactly as the producer set it. */
	writeRoots?: unknown;
	/** Request-level autonomy narrowing, when the producer set one. */
	autonomy?: unknown;
	/** Job cwd used to compare the two write declarations on one footing. */
	cwd?: string;
}

function finding(
	code: DispatchIntentCompatibilityCode,
	decision: DispatchIntentCompatibilityDecision,
	detail: string,
): DispatchIntentCompatibilityFinding {
	return { code, decision, message: `${code}: ${detail}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredVersion(value: Record<string, unknown>): number | null {
	return typeof value.version === "number" && Number.isInteger(value.version) ? value.version : null;
}

/** Whether an intent-shaped value carries a version this build can interpret. */
export function isSupportedDispatchIntentVersion(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const version = declaredVersion(value);
	return version !== null && DISPATCH_INTENT_SUPPORTED_VERSIONS.includes(version);
}

function versionFinding(value: Record<string, unknown>): DispatchIntentCompatibilityFinding {
	const version = declaredVersion(value);
	const supported = DISPATCH_INTENT_SUPPORTED_VERSIONS.join(", ");
	if (version === null) {
		return finding(
			"intent_version_unsupported",
			"refuse",
			`intent carries no integer version; this build speaks dispatch intent version ${supported}. Re-declare the intent through the dispatch tool rather than replaying a stored object.`,
		);
	}
	return finding(
		"intent_version_unsupported",
		"refuse",
		`intent declares version ${version}; this build speaks dispatch intent version ${supported}. A stored plan or spec at another version is refused rather than migrated: re-declare read_roots, write_roots, relevant_paths, expected_outputs, and verification on a fresh dispatch call.`,
	);
}

function legacyWriteRoots(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const roots = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return roots.length === value.length ? roots : null;
}

function writeRootsContradiction(
	intent: DispatchIntent,
	writeRoots: ReadonlyArray<string>,
	cwd: string,
): DispatchIntentCompatibilityFinding | null {
	const resolve = (roots: ReadonlyArray<string>): string =>
		JSON.stringify([...new Set(roots.map((root) => resolvePathBoundary(cwd, root)))].sort());
	if (resolve(writeRoots) === resolve(intent.writeRoots)) return null;
	return finding(
		"intent_write_roots_contradiction",
		"refuse",
		`legacy writeRoots [${[...writeRoots].sort().join(", ")}] and intent.write_roots [${intent.writeRoots.join(", ")}] name different trees. Neither the union nor the legacy field wins: drop writeRoots and declare the exact write scope once in intent.write_roots.`,
	);
}

function outputsOutsideWriteRoots(intent: DispatchIntent): DispatchIntentCompatibilityFinding | null {
	if (intent.writeRoots.length === 0 || intent.expectedOutputs.length === 0) return null;
	const outside = intent.expectedOutputs.filter((output) => !pathBoundaryCovers(intent.writeRoots, output));
	if (outside.length === 0) return null;
	return finding(
		"intent_outputs_outside_write_roots",
		"refuse",
		`expected_outputs [${outside.join(", ")}] lie outside intent.write_roots [${intent.writeRoots.join(", ")}]. The write boundary would block exactly the outputs the task is required to produce, so add each output's root to write_roots or drop the output from the declaration.`,
	);
}

function writeWithoutAuthority(intent: DispatchIntent, autonomy: unknown): DispatchIntentCompatibilityFinding | null {
	if (intent.writeRoots.length === 0 || autonomy !== "read-only") return null;
	return finding(
		"intent_write_without_authority",
		"refuse",
		`intent.write_roots [${intent.writeRoots.join(", ")}] was declared on a read-only request. A read-only worker cannot be granted the declared trees and the declaration cannot be silently dropped, because dropping it would leave the request claiming a write scope nothing enforces. Declare write_roots only on a writing request.`,
	);
}

/**
 * Classify one dispatch request's intent against the compatibility rules.
 *
 * Findings are returned in a stable order: version and shape first (a value this
 * build cannot read makes every later question meaningless), then the
 * contradictions between intent and its neighbouring fields, then the
 * lower-confidence notices. Callers treat any `refuse` as terminal.
 */
export function classifyDispatchIntentCompatibility(
	input: DispatchIntentCompatibilityInput,
): DispatchIntentCompatibilityFinding[] {
	const findings: DispatchIntentCompatibilityFinding[] = [];
	if (input.intent === undefined) {
		findings.push(
			finding(
				"intent_absent_legacy_inference",
				"warn",
				"no typed intent was declared, so policy-bearing scope was resolved from legacy writeRoots plus path-like task and briefing tokens. Inferred paths select project rules and worker context only; they never widen write or verification authority. Declare intent.read_roots, intent.write_roots, and intent.relevant_paths to make the scope exact.",
			),
		);
		return findings;
	}
	if (!isRecord(input.intent)) {
		findings.push(
			finding(
				"intent_malformed",
				"refuse",
				"intent must be an object carrying normalized read_roots, write_roots, relevant_paths, expected_outputs, and verification.",
			),
		);
		return findings;
	}
	if (!isSupportedDispatchIntentVersion(input.intent)) {
		findings.push(versionFinding(input.intent));
		return findings;
	}
	if (!isDispatchIntent(input.intent)) {
		findings.push(
			finding(
				"intent_malformed",
				"refuse",
				`intent declares supported version ${DISPATCH_INTENT_VERSION} but is not a normalized intent: path lists must be deduplicated and sorted, pathProvenance must match the declared fields exactly, and every verification entry must name a declared check with an integer timeout. Re-declare it through the dispatch tool rather than hand-building the normalized object.`,
			),
		);
		return findings;
	}
	const intent = input.intent;
	const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
	const legacy = input.writeRoots === undefined ? null : legacyWriteRoots(input.writeRoots);
	if (legacy !== null && legacy.length > 0 && intent.writeRoots.length > 0) {
		const contradiction = writeRootsContradiction(intent, legacy, cwd);
		if (contradiction !== null) findings.push(contradiction);
	}
	const outputs = outputsOutsideWriteRoots(intent);
	if (outputs !== null) findings.push(outputs);
	const authority = writeWithoutAuthority(intent, input.autonomy);
	if (authority !== null) findings.push(authority);
	if (intent.verification.length === 0 && (intent.writeRoots.length > 0 || intent.expectedOutputs.length > 0)) {
		findings.push(
			finding(
				"intent_partial_verification_absent",
				"warn",
				"intent declares work that changes the tree but no verification requirement, so nothing the orchestrator runs proves the change is sound. Add intent.verification entries naming declared check ids from package scripts or .clio-coder/verifiers.yaml.",
			),
		);
	}
	return findings;
}

/** Every terminal refusal in a classification, in reporting order. */
export function dispatchIntentRefusals(
	findings: ReadonlyArray<DispatchIntentCompatibilityFinding>,
): DispatchIntentCompatibilityFinding[] {
	return findings.filter((entry) => entry.decision === "refuse");
}

/**
 * Whether a narrowed intent stays inside the intent it narrows.
 *
 * Batch tasks, agent profiles, and fleet contracts may all restate scope more
 * tightly than the call that contains them. Narrowing is monotonic: a per-task
 * declaration may shrink the ceiling and may never reach outside it. Read scope
 * is checked against reads plus writes because a declared write root is
 * necessarily readable; write scope is checked against writes alone.
 */
export function dispatchIntentScopeWidening(
	ceiling: Pick<DispatchIntent, "readRoots" | "writeRoots" | "relevantPaths">,
	narrowed: Pick<DispatchIntent, "readRoots" | "writeRoots" | "relevantPaths">,
): DispatchIntentCompatibilityFinding | null {
	const ceilings = {
		readRoots: [...ceiling.readRoots, ...ceiling.writeRoots],
		writeRoots: [...ceiling.writeRoots],
		relevantPaths: [...ceiling.readRoots, ...ceiling.writeRoots, ...ceiling.relevantPaths],
	} as const;
	for (const field of ["readRoots", "writeRoots", "relevantPaths"] as const) {
		const outside = narrowed[field].find((candidate) => !pathBoundaryCovers(ceilings[field], candidate));
		if (outside === undefined) continue;
		return finding(
			"intent_scope_widening",
			"refuse",
			`${field} entry '${outside}' is outside the enclosing intent ceiling [${ceilings[field].join(", ") || "empty"}]. A narrower scope may shrink the ceiling and never reach outside it; add the path to the enclosing declaration or drop it here.`,
		);
	}
	return null;
}

/**
 * The retirement criterion for the legacy inference fallback.
 *
 * `pathScope.mode` is sealed on every receipt, so the share of dispatches still
 * resolving policy-bearing scope from prose is measurable from evidence rather
 * than estimated. Removal stays a separate, explicit issue; this is the gate
 * that issue has to clear before it can be opened.
 */
export const DISPATCH_INTENT_RETIREMENT_MAX_LEGACY_SHARE = 0.02;

/** Receipts below this count cannot decide the criterion either way. */
export const DISPATCH_INTENT_RETIREMENT_MIN_SAMPLE = 200;

export interface DispatchIntentAdoption {
	/** Receipts carrying a resolved path scope; receipts without one are not evidence. */
	measured: number;
	declared: number;
	legacyInferred: number;
	/** `null` when nothing was measured, so an empty window never reads as full adoption. */
	legacyShare: number | null;
	/** True only when the sample is large enough and the legacy share is at or under the bound. */
	retirementReady: boolean;
}

/**
 * Measure typed-intent adoption from sealed receipts.
 *
 * Reads only `pathScope.mode`. No task text, briefing prose, or declared path
 * ever enters the aggregate, so the measurement is safe to report from a fleet
 * whose receipts this caller may count but must not quote.
 */
export function dispatchIntentAdoption(
	receipts: ReadonlyArray<{ pathScope?: { mode: "declared" | "legacy-inferred" } }>,
): DispatchIntentAdoption {
	let declared = 0;
	let legacyInferred = 0;
	for (const receipt of receipts) {
		if (receipt.pathScope === undefined) continue;
		if (receipt.pathScope.mode === "declared") declared += 1;
		else legacyInferred += 1;
	}
	const measured = declared + legacyInferred;
	const legacyShare = measured === 0 ? null : legacyInferred / measured;
	return {
		measured,
		declared,
		legacyInferred,
		legacyShare,
		retirementReady:
			measured >= DISPATCH_INTENT_RETIREMENT_MIN_SAMPLE &&
			legacyShare !== null &&
			legacyShare <= DISPATCH_INTENT_RETIREMENT_MAX_LEGACY_SHARE,
	};
}
