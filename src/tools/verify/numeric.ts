/**
 * Pure tolerance math for `kind: numeric-compare` verifier checks. A check's
 * command prints a JSON object of `string -> number | number[]`; the catalog
 * names a reference file of the same shape and a tolerance. This module
 * decides pass or fail and writes the structured report; it reads no file and
 * runs nothing.
 */

export type NumericToleranceKind = "relative" | "absolute" | "ulp";

export interface NumericTolerance {
	/** |actual - expected| / |expected| must not exceed this. Zero expected passes only on exact equality. */
	relative?: number;
	/** |actual - expected| must not exceed this. */
	absolute?: number;
	/** Distance in representable doubles between actual and expected must not exceed this integer. */
	ulp?: number;
}

export type NumericValue = number | number[];
export type NumericPayload = Record<string, NumericValue>;

export type NumericFailureReason =
	| "missing-actual"
	| "missing-reference"
	| "shape-mismatch"
	| "length-mismatch"
	| "not-finite"
	| NumericToleranceKind;

export interface NumericDeviation {
	/** Array index of the worst element; absent for a scalar. */
	index?: number;
	actual: number;
	expected: number;
	absolute: number;
	/** Relative deviation, or null when it is undefined (expected is zero and actual is not). */
	relative: number | null;
	/** Distance in representable doubles, or null when either side is not finite. */
	ulp: number | null;
}

export interface NumericKeyReport {
	key: string;
	passed: boolean;
	/** The tolerances the worst element failed, in schema order; empty on pass. */
	failed: NumericFailureReason[];
	/** Worst deviation for the key, present whenever both sides had a comparable value. */
	worst?: NumericDeviation;
	/** One line a reader can act on. */
	detail: string;
}

export interface NumericCompareReport {
	kind: "numeric-compare";
	passed: boolean;
	tolerance: NumericTolerance;
	keys: NumericKeyReport[];
	/** The keys that failed, sorted; empty on pass. */
	failedKeys: string[];
	summary: string;
}

export const NUMERIC_PAYLOAD_CAPS = Object.freeze({
	keys: 4096,
	elements: 1_000_000,
});

/** True when the tolerance names at least one bound and every named bound is usable. */
export function normalizeNumericTolerance(value: unknown): NumericTolerance | Error {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new Error("tolerance must be an object with relative, absolute, or ulp");
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => key !== "relative" && key !== "absolute" && key !== "ulp");
	if (unknown.length > 0) return new Error(`tolerance has unknown field(s): ${unknown.sort().join(", ")}`);
	const tolerance: NumericTolerance = {};
	for (const kind of ["relative", "absolute"] as const) {
		if (!Object.hasOwn(record, kind)) continue;
		const bound = record[kind];
		if (typeof bound !== "number" || !Number.isFinite(bound) || bound < 0) {
			return new Error(`tolerance.${kind} must be a finite non-negative number`);
		}
		tolerance[kind] = bound;
	}
	if (Object.hasOwn(record, "ulp")) {
		const bound = record.ulp;
		if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0) {
			return new Error("tolerance.ulp must be a non-negative integer");
		}
		tolerance.ulp = bound;
	}
	if (tolerance.relative === undefined && tolerance.absolute === undefined && tolerance.ulp === undefined) {
		return new Error("tolerance must name at least one of relative, absolute, or ulp");
	}
	return tolerance;
}

const ORDERED_VIEW = new DataView(new ArrayBuffer(8));

/** A double as an integer whose ordering matches the ordering of doubles. */
function orderedBits(value: number): bigint {
	ORDERED_VIEW.setFloat64(0, value);
	const bits = ORDERED_VIEW.getBigInt64(0);
	return bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits;
}

/**
 * Distance in representable doubles between two finite numbers. Adjacent
 * doubles are 1 apart, +0 and -0 are 0 apart, and a sign crossing counts every
 * double in between. Returns Infinity when the distance exceeds the safe
 * integer range or either side is not finite.
 */
export function ulpDistance(actual: number, expected: number): number {
	if (!Number.isFinite(actual) || !Number.isFinite(expected)) return Number.POSITIVE_INFINITY;
	const distance = orderedBits(actual) - orderedBits(expected);
	const magnitude = distance < 0n ? -distance : distance;
	return magnitude > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(magnitude);
}

/** Parse command stdout or a reference file as a numeric payload, naming the fault when it is not one. */
export function parseNumericPayload(text: string, label: string): NumericPayload | Error {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return new Error(`${label} must be a JSON object of string -> number | number[]`);
	}
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length > NUMERIC_PAYLOAD_CAPS.keys)
		return new Error(`${label} exceeds the ${NUMERIC_PAYLOAD_CAPS.keys}-key cap`);
	const entries: Array<[string, number | number[]]> = [];
	let elements = 0;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") {
			entries.push([key, value]);
			elements += 1;
		} else if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
			entries.push([key, [...(value as number[])]]);
			elements += value.length;
		} else {
			return new Error(`${label}.${key} must be a number or an array of numbers`);
		}
		if (elements > NUMERIC_PAYLOAD_CAPS.elements) {
			return new Error(`${label} exceeds the ${NUMERIC_PAYLOAD_CAPS.elements}-element cap`);
		}
	}
	return Object.fromEntries(entries);
}

function deviation(actual: number, expected: number, index?: number): NumericDeviation {
	const finite = Number.isFinite(actual) && Number.isFinite(expected);
	const absolute = finite ? Math.abs(actual - expected) : Number.POSITIVE_INFINITY;
	let relative = !finite ? null : expected === 0 ? (absolute === 0 ? 0 : null) : absolute / Math.abs(expected);
	if (finite && !Number.isFinite(absolute)) {
		// Finite subtraction overflows only across signs, where division first
		// is safe. Keep subtraction first for nearby values to preserve precision.
		relative = Math.abs(actual / expected - 1);
	}
	return {
		...(index !== undefined ? { index } : {}),
		actual,
		expected,
		absolute,
		relative,
		ulp: finite ? ulpDistance(actual, expected) : null,
	};
}

/** Tolerances the deviation violates, in schema order. Every named tolerance must hold. */
function violatedTolerances(item: NumericDeviation, tolerance: NumericTolerance): NumericToleranceKind[] {
	const failed: NumericToleranceKind[] = [];
	if (tolerance.relative !== undefined && (item.relative === null || item.relative > tolerance.relative)) {
		failed.push("relative");
	}
	if (tolerance.absolute !== undefined && item.absolute > tolerance.absolute) failed.push("absolute");
	if (tolerance.ulp !== undefined && (item.ulp === null || item.ulp > tolerance.ulp)) failed.push("ulp");
	return failed;
}

function formatNumber(value: number): string {
	return Number.isFinite(value) ? value.toPrecision(6).replace(/\.?0+(e|$)/u, "$1") : String(value);
}

function describeDeviation(item: NumericDeviation): string {
	const where = item.index === undefined ? "" : `[${item.index}]`;
	const relative = item.relative === null ? "undefined" : formatNumber(item.relative);
	const ulp = item.ulp === null ? "undefined" : String(item.ulp);
	return `${where} actual=${formatNumber(item.actual)} expected=${formatNumber(item.expected)} abs=${formatNumber(item.absolute)} rel=${relative} ulp=${ulp}`;
}

function compareElements(
	key: string,
	actual: number[],
	expected: number[],
	tolerance: NumericTolerance,
): NumericKeyReport {
	let worst: NumericDeviation | undefined;
	let worstFailed: NumericFailureReason[] = [];
	for (let index = 0; index < expected.length; index += 1) {
		const item = deviation(
			actual[index] as number,
			expected[index] as number,
			expected.length === 1 && actual.length === 1 ? undefined : index,
		);
		const failed: NumericFailureReason[] =
			!Number.isFinite(item.actual) || !Number.isFinite(item.expected)
				? ["not-finite"]
				: violatedTolerances(item, tolerance);
		const worse =
			worst === undefined ||
			(failed.length > 0 && worstFailed.length === 0) ||
			(failed.length > 0 === worstFailed.length > 0 && item.absolute > worst.absolute);
		if (worse) {
			worst = item;
			worstFailed = failed;
		}
	}
	if (worst === undefined) return { key, passed: true, failed: [], detail: `${key}: empty array matches` };
	const passed = worstFailed.length === 0;
	return {
		key,
		passed,
		failed: worstFailed,
		worst,
		detail: passed
			? `${key}: within tolerance, worst${describeDeviation(worst)}`
			: `${key}: failed ${worstFailed.join(", ")} at worst${describeDeviation(worst)}`,
	};
}

/**
 * Compare a command's payload against the reference. Every key on either side
 * is judged: a key missing on one side fails and names the side, a scalar
 * against an array fails, arrays compare elementwise and fail on length
 * mismatch, and any NaN or infinity fails as not finite. A value passes only
 * when it satisfies every tolerance the catalog named.
 */
export function compareNumeric(
	actual: NumericPayload,
	reference: NumericPayload,
	tolerance: NumericTolerance,
): NumericCompareReport {
	const keys = [...new Set([...Object.keys(reference), ...Object.keys(actual)])].sort();
	const reports: NumericKeyReport[] = [];
	for (const key of keys) {
		const got = actual[key];
		const want = reference[key];
		if (got === undefined) {
			reports.push({ key, passed: false, failed: ["missing-actual"], detail: `${key}: missing from the command output` });
			continue;
		}
		if (want === undefined) {
			reports.push({ key, passed: false, failed: ["missing-reference"], detail: `${key}: missing from the reference` });
			continue;
		}
		if (Array.isArray(got) !== Array.isArray(want)) {
			reports.push({
				key,
				passed: false,
				failed: ["shape-mismatch"],
				detail: `${key}: ${Array.isArray(got) ? "array" : "scalar"} in the command output but ${Array.isArray(want) ? "array" : "scalar"} in the reference`,
			});
			continue;
		}
		const gotList = Array.isArray(got) ? got : [got];
		const wantList = Array.isArray(want) ? want : [want];
		if (gotList.length !== wantList.length) {
			reports.push({
				key,
				passed: false,
				failed: ["length-mismatch"],
				detail: `${key}: ${gotList.length} element(s) in the command output but ${wantList.length} in the reference`,
			});
			continue;
		}
		reports.push(compareElements(key, gotList, wantList, tolerance));
	}
	const failedKeys = reports.filter((report) => !report.passed).map((report) => report.key);
	const passed = failedKeys.length === 0;
	return {
		kind: "numeric-compare",
		passed,
		tolerance: { ...tolerance },
		keys: reports,
		failedKeys,
		summary: passed
			? `numeric-compare passed: ${reports.length} key(s) within tolerance`
			: `numeric-compare failed: ${failedKeys.length} of ${reports.length} key(s) out of tolerance (${failedKeys.join(", ")})`,
	};
}

/** The report as lines for a tool result or a receipt tail. */
export function renderNumericReport(report: NumericCompareReport): string {
	const lines = [report.summary, `tolerance: ${JSON.stringify(report.tolerance)}`];
	for (const key of report.keys) lines.push(`- ${key.detail}`);
	return lines.join("\n");
}
