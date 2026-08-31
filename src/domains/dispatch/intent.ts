import path from "node:path";
import { normalizePathBoundaryEntry, PATH_BOUNDARY_MAX_ENTRIES, PathBoundaryError } from "../../core/path-boundary.js";
import { type DispatchPathProvenanceEntry, declaredIntentPathProvenance } from "./path-scope.js";

export const DISPATCH_INTENT_PATH_LIST_CAP = PATH_BOUNDARY_MAX_ENTRIES;
export const DISPATCH_INTENT_PATH_ENTRY_BYTES_CAP = 512;
export const DISPATCH_INTENT_VERIFICATION_CAP = 8;
export const DISPATCH_INTENT_TIMEOUT_MIN_MS = 1_000;

export interface DispatchIntentVerification {
	check: string;
	timeoutMs: number;
}

export interface DispatchIntent {
	version: 2;
	readRoots: string[];
	writeRoots: string[];
	relevantPaths: string[];
	/** Integrity-sealed source and confidence for every policy-bearing path. */
	pathProvenance: DispatchPathProvenanceEntry[];
	expectedOutputs: string[];
	verification: DispatchIntentVerification[];
}

export interface DispatchIntentCheckBound {
	id: string;
	timeoutMs: number;
}

export type DispatchIntentNormalizationResult =
	| { ok: true; intent: DispatchIntent }
	| { ok: false; reason: string; message: string };

/**
 * `version` is accepted on raw model-facing intent so a caller replaying a
 * declaration it was shown can echo the version back. It is validated, never
 * trusted: an unsupported value is a terminal refusal rather than a field the
 * normalizer quietly overwrites with the version this build speaks.
 */
const RAW_FIELDS = new Set([
	"version",
	"read_roots",
	"write_roots",
	"relevant_paths",
	"expected_outputs",
	"verification",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function fail(reason: string, message: string): DispatchIntentNormalizationResult {
	return { ok: false, reason, message };
}

function checkedPathText(value: unknown, field: string, index: number): string | DispatchIntentNormalizationResult {
	if (typeof value !== "string" || value.trim().length === 0) {
		return fail("intent_path_malformed", `${field}[${index}] must be a non-empty repository-relative POSIX path`);
	}
	const trimmed = value.trim();
	if (Buffer.byteLength(trimmed, "utf8") > DISPATCH_INTENT_PATH_ENTRY_BYTES_CAP) {
		return fail(
			"intent_path_over_cap",
			`${field}[${index}] exceeds the ${DISPATCH_INTENT_PATH_ENTRY_BYTES_CAP}-byte cap`,
		);
	}
	return trimmed;
}

function normalizeScopePathEntry(
	value: unknown,
	field: string,
	index: number,
): string | DispatchIntentNormalizationResult {
	const checked = checkedPathText(value, field, index);
	if (typeof checked !== "string") return checked;
	try {
		return normalizePathBoundaryEntry(checked);
	} catch (error) {
		if (error instanceof PathBoundaryError) {
			if (error.code === "absolute") {
				return fail("intent_path_absolute", `${field}[${index}] must be a repository-relative POSIX path`);
			}
			if (error.code === "parent") {
				return fail("intent_path_escapes_root", `${field}[${index}] escapes the repository root`);
			}
		}
		return fail(
			"intent_path_malformed",
			`${field}[${index}] does not follow the repository path boundary grammar: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function normalizeExpectedOutputEntry(
	value: unknown,
	field: string,
	index: number,
): string | DispatchIntentNormalizationResult {
	const checked = checkedPathText(value, field, index);
	if (typeof checked !== "string") return checked;
	const trimmed = checked;
	if (trimmed.includes("\\") || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
		return fail("intent_path_absolute", `${field}[${index}] must be a repository-relative POSIX path`);
	}
	const normalized = path.posix.normalize(trimmed.replace(/^\.\//u, "").replace(/\/{2,}/gu, "/"));
	if (normalized === "." || normalized.length === 0) {
		return fail("intent_path_malformed", `${field}[${index}] must not normalize to an empty path`);
	}
	if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
		return fail("intent_path_escapes_root", `${field}[${index}] escapes the repository root`);
	}
	return normalized;
}

function normalizePathList(
	value: unknown,
	field: string,
	normalizeEntry: (
		value: unknown,
		field: string,
		index: number,
	) => string | DispatchIntentNormalizationResult = normalizeScopePathEntry,
): string[] | DispatchIntentNormalizationResult {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return fail("intent_path_malformed", `${field} must be an array`);
	if (value.length > DISPATCH_INTENT_PATH_LIST_CAP) {
		return fail("intent_path_over_cap", `${field} exceeds the ${DISPATCH_INTENT_PATH_LIST_CAP}-entry cap`);
	}
	const normalized: string[] = [];
	for (const [index, entry] of value.entries()) {
		const result = normalizeEntry(entry, field, index);
		if (typeof result !== "string") return result;
		normalized.push(result);
	}
	return [...new Set(normalized)].sort(compareCodepoints);
}

/**
 * Build typed intent from paths a non-model producer already holds.
 *
 * Fleet contracts, CLI entry points, and extensions declare repository-relative
 * scope in their own artifacts long before a dispatch request exists. Without
 * this they hand the request nothing, and the scope resolver falls back to
 * reading path-like tokens out of the rendered prompt, which is the exact
 * ambiguity typed intent removes. The paths go through the same normalization,
 * caps, and provenance construction as a model-facing declaration, so a
 * producer cannot mint an intent shape the dispatch tool could not.
 *
 * Verification and expected outputs are deliberately not accepted here.
 * A declared check id has to be resolved against the project's verification
 * catalog before it means anything, and that resolution belongs to the
 * admission controller that owns the catalog, not to a scope builder.
 */
export function declaredScopeIntent(input: {
	readRoots?: ReadonlyArray<string>;
	writeRoots?: ReadonlyArray<string>;
	relevantPaths?: ReadonlyArray<string>;
}): DispatchIntentNormalizationResult {
	const readRoots = normalizePathList(input.readRoots, "intent.read_roots");
	if (!Array.isArray(readRoots)) return readRoots;
	const writeRoots = normalizePathList(input.writeRoots, "intent.write_roots");
	if (!Array.isArray(writeRoots)) return writeRoots;
	const relevantPaths = normalizePathList(input.relevantPaths, "intent.relevant_paths");
	if (!Array.isArray(relevantPaths)) return relevantPaths;
	return {
		ok: true,
		intent: {
			version: 2,
			readRoots,
			writeRoots,
			relevantPaths,
			pathProvenance: declaredIntentPathProvenance({ readRoots, writeRoots, relevantPaths }),
			expectedOutputs: [],
			verification: [],
		},
	};
}

export function isDispatchIntent(value: unknown): value is DispatchIntent {
	if (!isRecord(value) || value.version !== 2) return false;
	for (const field of ["readRoots", "writeRoots", "relevantPaths", "expectedOutputs"] as const) {
		if (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) return false;
	}
	const readRoots = value.readRoots as string[];
	const writeRoots = value.writeRoots as string[];
	const relevantPaths = value.relevantPaths as string[];
	if (
		!Array.isArray(value.pathProvenance) ||
		JSON.stringify(value.pathProvenance) !==
			JSON.stringify(
				declaredIntentPathProvenance({
					readRoots,
					writeRoots,
					relevantPaths,
				}),
			)
	) {
		return false;
	}
	return (
		Array.isArray(value.verification) &&
		value.verification.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.check === "string" &&
				entry.check.length > 0 &&
				typeof entry.timeoutMs === "number" &&
				Number.isInteger(entry.timeoutMs) &&
				entry.timeoutMs >= DISPATCH_INTENT_TIMEOUT_MIN_MS,
		)
	);
}

/**
 * Project a declared intent onto a run that may not write.
 *
 * Council members, reviewers, judges, and any other read-only expansion of a
 * caller's single task inherit the caller's declared scope. Inheriting
 * `writeRoots` verbatim would leave the request claiming a write scope the run's
 * autonomy makes unenforceable, so the write roots become read roots: the same
 * trees, strictly less authority. Nothing is added, so the projection can only
 * narrow. Returns the input unchanged when there is no write scope to demote.
 */
export function narrowDispatchIntentToReadOnly(intent: DispatchIntent): DispatchIntent {
	if (intent.writeRoots.length === 0) return intent;
	const readRoots = [...new Set([...intent.readRoots, ...intent.writeRoots])].sort(compareCodepoints);
	return {
		version: 2,
		readRoots,
		writeRoots: [],
		relevantPaths: [...intent.relevantPaths],
		pathProvenance: declaredIntentPathProvenance({ readRoots, writeRoots: [], relevantPaths: intent.relevantPaths }),
		expectedOutputs: [...intent.expectedOutputs],
		verification: intent.verification.map((entry) => ({ ...entry })),
	};
}

export function normalizeDispatchIntent(
	raw: unknown,
	checks: ReadonlyMap<string, DispatchIntentCheckBound>,
): DispatchIntentNormalizationResult {
	if (!isRecord(raw)) return fail("intent_malformed", "intent must be an object");
	const unknown = Object.keys(raw)
		.filter((key) => !RAW_FIELDS.has(key))
		.sort(compareCodepoints);
	if (unknown.length > 0) return fail("intent_malformed", `intent contains unknown field '${unknown[0]}'`);
	if (raw.version !== undefined && raw.version !== 2) {
		return fail(
			"intent_version_unsupported",
			`intent declares version ${JSON.stringify(raw.version)}; this build speaks dispatch intent version 2. A declaration at another version is refused rather than migrated: restate read_roots, write_roots, relevant_paths, expected_outputs, and verification under version 2`,
		);
	}
	const readRoots = normalizePathList(raw.read_roots, "intent.read_roots");
	if (!Array.isArray(readRoots)) return readRoots;
	const writeRoots = normalizePathList(raw.write_roots, "intent.write_roots");
	if (!Array.isArray(writeRoots)) return writeRoots;
	const relevantPaths = normalizePathList(raw.relevant_paths, "intent.relevant_paths");
	if (!Array.isArray(relevantPaths)) return relevantPaths;
	const expectedOutputs = normalizePathList(
		raw.expected_outputs,
		"intent.expected_outputs",
		normalizeExpectedOutputEntry,
	);
	if (!Array.isArray(expectedOutputs)) return expectedOutputs;
	const rawVerification = raw.verification ?? [];
	if (!Array.isArray(rawVerification)) {
		return fail("verification_malformed", "intent.verification must be an array");
	}
	if (rawVerification.length > DISPATCH_INTENT_VERIFICATION_CAP) {
		return fail("verification_over_cap", `intent.verification exceeds the ${DISPATCH_INTENT_VERIFICATION_CAP}-entry cap`);
	}
	const verification: DispatchIntentVerification[] = [];
	for (const [index, entry] of rawVerification.entries()) {
		if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "check" && key !== "timeout_ms")) {
			return fail("verification_malformed", `intent.verification[${index}] must contain check and optional timeout_ms`);
		}
		if (typeof entry.check !== "string" || entry.check.trim().length === 0) {
			return fail("verification_malformed", `intent.verification[${index}].check must be a non-empty declared id`);
		}
		const check = entry.check.trim();
		const declared = checks.get(check);
		if (declared === undefined) {
			return fail(
				"verification_check_undeclared",
				`verification check '${check}' is undeclared; add a package.json verification script or .clio-coder/verifiers.yaml entry`,
			);
		}
		if (
			entry.timeout_ms !== undefined &&
			(typeof entry.timeout_ms !== "number" || !Number.isInteger(entry.timeout_ms) || entry.timeout_ms <= 0)
		) {
			return fail("verification_malformed", `intent.verification[${index}].timeout_ms must be a positive integer`);
		}
		const requested = typeof entry.timeout_ms === "number" ? entry.timeout_ms : declared.timeoutMs;
		verification.push({
			check,
			timeoutMs: Math.min(declared.timeoutMs, Math.max(DISPATCH_INTENT_TIMEOUT_MIN_MS, requested)),
		});
	}
	return {
		ok: true,
		intent: {
			version: 2,
			readRoots,
			writeRoots,
			relevantPaths,
			pathProvenance: declaredIntentPathProvenance({ readRoots, writeRoots, relevantPaths }),
			expectedOutputs,
			verification,
		},
	};
}
