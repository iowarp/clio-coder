import path from "node:path";

export const DISPATCH_INTENT_PATH_LIST_CAP = 32;
export const DISPATCH_INTENT_PATH_ENTRY_BYTES_CAP = 512;
export const DISPATCH_INTENT_VERIFICATION_CAP = 8;
export const DISPATCH_INTENT_TIMEOUT_MIN_MS = 1_000;

export interface DispatchIntentVerification {
	check: string;
	timeoutMs: number;
}

export interface DispatchIntent {
	version: 1;
	readRoots: string[];
	writeRoots: string[];
	relevantPaths: string[];
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

const RAW_FIELDS = new Set(["read_roots", "write_roots", "relevant_paths", "expected_outputs", "verification"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function fail(reason: string, message: string): DispatchIntentNormalizationResult {
	return { ok: false, reason, message };
}

function normalizePathEntry(value: unknown, field: string, index: number): string | DispatchIntentNormalizationResult {
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

function normalizePathList(value: unknown, field: string): string[] | DispatchIntentNormalizationResult {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return fail("intent_path_malformed", `${field} must be an array`);
	if (value.length > DISPATCH_INTENT_PATH_LIST_CAP) {
		return fail("intent_path_over_cap", `${field} exceeds the ${DISPATCH_INTENT_PATH_LIST_CAP}-entry cap`);
	}
	const normalized: string[] = [];
	for (const [index, entry] of value.entries()) {
		const result = normalizePathEntry(entry, field, index);
		if (typeof result !== "string") return result;
		normalized.push(result);
	}
	return [...new Set(normalized)].sort(compareCodepoints);
}

export function isDispatchIntent(value: unknown): value is DispatchIntent {
	if (!isRecord(value) || value.version !== 1) return false;
	for (const field of ["readRoots", "writeRoots", "relevantPaths", "expectedOutputs"] as const) {
		if (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) return false;
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

export function normalizeDispatchIntent(
	raw: unknown,
	checks: ReadonlyMap<string, DispatchIntentCheckBound>,
): DispatchIntentNormalizationResult {
	if (!isRecord(raw)) return fail("intent_malformed", "intent must be an object");
	const unknown = Object.keys(raw)
		.filter((key) => !RAW_FIELDS.has(key))
		.sort(compareCodepoints);
	if (unknown.length > 0) return fail("intent_malformed", `intent contains unknown field '${unknown[0]}'`);
	const readRoots = normalizePathList(raw.read_roots, "intent.read_roots");
	if (!Array.isArray(readRoots)) return readRoots;
	const writeRoots = normalizePathList(raw.write_roots, "intent.write_roots");
	if (!Array.isArray(writeRoots)) return writeRoots;
	const relevantPaths = normalizePathList(raw.relevant_paths, "intent.relevant_paths");
	if (!Array.isArray(relevantPaths)) return relevantPaths;
	const expectedOutputs = normalizePathList(raw.expected_outputs, "intent.expected_outputs");
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
		intent: { version: 1, readRoots, writeRoots, relevantPaths, expectedOutputs, verification },
	};
}
