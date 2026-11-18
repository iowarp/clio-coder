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
 * The answer is either nothing or a refusal. A request is refused when it states
 * two incompatible things about authority, or states one this build cannot
 * interpret, and the dispatch never runs. Omitted or partial intent is not
 * reported here: it never widens authority, so it cannot change admission.
 *
 * Every rule below is written to preserve one invariant: no path through this
 * module widens read, write, or verification authority to resolve an ambiguity.
 * When the compatible reading and the declared reading disagree about what a
 * worker may touch, the answer is a refusal, never the union.
 *
 * The module is pure: no filesystem, no clock, no package-layout lookup. A
 * source checkout and an installed package classify identical input identically,
 * which is what makes the version rules verifiable rather than environmental.
 */

import { pathBoundaryCovers, resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import { admissionDiagnostic } from "./admission-diagnostic.js";
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

/**
 * Stable reason codes. These are a contract: they appear in refusal messages,
 * diagnostics, and contract tests, and callers may branch on them. Renaming one
 * is a breaking change to every surface that reports dispatch admission.
 */
export type DispatchIntentCompatibilityCode =
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
	decision: "refuse";
	/** Operator-facing text, prefixed with the code and naming the fix. */
	message: string;
}

export interface DispatchIntentCompatibilityInput {
	/** The request's `intent` field exactly as the producer set it. */
	intent?: unknown;
	/** The request's legacy `writeRoots` field exactly as the producer set it. */
	writeRoots?: unknown;
	/** Request-level read-only restriction, when the producer set one. */
	readOnly?: unknown;
	/** Job cwd used to compare the two write declarations on one footing. */
	cwd?: string;
}

function finding(code: DispatchIntentCompatibilityCode, detail: string): DispatchIntentCompatibilityFinding {
	return { code, decision: "refuse", message: admissionDiagnostic(`${code}: ${detail}`) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredVersion(value: Record<string, unknown>): number | null {
	return typeof value.version === "number" && Number.isInteger(value.version) ? value.version : null;
}

/** Whether an intent-shaped value carries a version this build can interpret. */
function isSupportedDispatchIntentVersion(value: unknown): boolean {
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
			`intent carries no integer version; this build speaks dispatch intent version ${supported}. Re-declare the intent through the dispatch tool rather than replaying a stored object.`,
		);
	}
	return finding(
		"intent_version_unsupported",
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
		`legacy writeRoots [${[...writeRoots].sort().join(", ")}] and intent.write_roots [${intent.writeRoots.join(", ")}] name different trees. Neither the union nor the legacy field wins: drop writeRoots and declare the exact write scope once in intent.write_roots.`,
	);
}

function outputsOutsideWriteRoots(intent: DispatchIntent): DispatchIntentCompatibilityFinding | null {
	if (intent.writeRoots.length === 0 || intent.expectedOutputs.length === 0) return null;
	const outside = intent.expectedOutputs.filter((output) => !writeRootsCover(intent.writeRoots, output));
	if (outside.length === 0) return null;
	return finding(
		"intent_outputs_outside_write_roots",
		`expected_outputs [${outside.join(", ")}] lie outside intent.write_roots [${intent.writeRoots.join(", ")}]. The write boundary would block exactly the outputs the task is required to produce, so correct expected_outputs to the actual file paths within the authorized write_roots. expected_outputs are file paths, never actions such as commit or the repository marker ".". The host commits worktree tasks; the worker only edits and reports.`,
	);
}

function writeWithoutAuthority(intent: DispatchIntent, readOnly: unknown): DispatchIntentCompatibilityFinding | null {
	if (intent.writeRoots.length === 0 || readOnly !== true) return null;
	return finding(
		"intent_write_without_authority",
		`intent.write_roots [${intent.writeRoots.join(", ")}] was declared on a read-only request. A read-only worker cannot be granted the declared trees and the declaration cannot be silently dropped, because dropping it would leave the request claiming a write scope nothing enforces. Declare write_roots only on a writing request.`,
	);
}

/**
 * Every refusal of one dispatch request's intent under the compatibility rules.
 *
 * Refusals are returned in a stable order: version and shape first (a value this
 * build cannot read makes every later question meaningless), then the
 * contradictions between intent and its neighbouring fields. Callers treat any
 * refusal as terminal; an omitted intent has none.
 */
export function classifyDispatchIntentCompatibility(
	input: DispatchIntentCompatibilityInput,
): DispatchIntentCompatibilityFinding[] {
	const findings: DispatchIntentCompatibilityFinding[] = [];
	if (input.intent === undefined) return findings;
	if (!isRecord(input.intent)) {
		findings.push(
			finding(
				"intent_malformed",
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
	const authority = writeWithoutAuthority(intent, input.readOnly);
	if (authority !== null) findings.push(authority);
	return findings;
}

/**
 * Whether a narrowed intent stays inside the intent it narrows.
 *
 * Batch tasks, agent profiles, and playbooks may all restate scope more
 * tightly than the call that contains them. Narrowing is monotonic: a per-task
 * declaration may shrink the ceiling and may never reach outside it. Read scope
 * is checked against reads plus writes because a declared write root is
 * necessarily readable; write scope is checked against writes alone, and an
 * enclosing intent without write roots bounds writes only by the workspace.
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
		// An enclosing intent that declares no write roots puts no write boundary
		// on the worker: it writes anywhere under its cwd. Its write ceiling is
		// that workspace, not empty, so declaring roots there confines the worker.
		// Normalization already refuses roots that are absolute or escape the
		// repository (F-C12).
		if (field === "writeRoots" && ceiling.writeRoots.length === 0) continue;
		const outside = narrowed[field].find(
			(candidate) => !pathBoundaryCovers(ceilings[field], candidate) && !writeRootsCover(ceiling.writeRoots, candidate),
		);
		if (outside === undefined) continue;
		return finding(
			"intent_scope_widening",
			`${field} entry '${outside}' is outside the enclosing intent ceiling [${ceilings[field].join(", ") || "empty"}]. A narrower scope may shrink the ceiling and never reach outside it; add the path to the enclosing declaration or drop it here.`,
		);
	}
	return null;
}
