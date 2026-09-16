/**
 * Pure tolerance math for `kind: numeric-compare` verifier checks. A check's
 * command prints a JSON object of `string -> number | number[]`; the catalog
 * names a reference file of the same shape and a tolerance. This module
 * decides pass or fail and writes the structured report; it reads no file and
 * runs nothing.
 *
 * The verdict is a statement about the declared tolerance only. A payload
 * that passes agrees with the reference within the named bounds; whether the
 * reference itself is scientifically right is not established by this module.
 */

export type NumericToleranceKind = "relative" | "absolute" | "ulp";

/**
 * How the named bounds combine. `all` (the default) requires every named
 * bound to hold, which is the strict conjunction; `any` passes when at least
 * one named bound holds, which is the common `|a-e| <= abs OR |a-e| <= rel*|e|`
 * formula when both are named. The two rules are not interchangeable, so the
 * report always states which one judged the payload.
 */
export type NumericToleranceCombine = "all" | "any";

/**
 * How a pair with a NaN or an infinity on either side is judged. `fail` (the
 * default) rejects every such pair as not finite. `match` accepts NaN against
 * NaN and an infinity against the same-signed infinity, and rejects every
 * other pairing.
 */
export type NumericNonFinitePolicy = "fail" | "match";

export const DEFAULT_NUMERIC_COMBINE: NumericToleranceCombine = "all";
export const DEFAULT_NUMERIC_NON_FINITE: NumericNonFinitePolicy = "fail";

/**
 * The largest admissible `ulp` bound. `ulpDistance` reports a distance past
 * the safe-integer range as Infinity, so a bound within the range judges
 * exactly: Infinity exceeds it only when the true distance does. A larger
 * bound would turn that sentinel into a spurious failure, so the normalizer
 * refuses it.
 */
export const MAX_ULP_TOLERANCE = Number.MAX_SAFE_INTEGER;

export interface NumericTolerance {
	/** |actual - expected| / |expected| must not exceed this. Zero expected passes only on exact equality. */
	relative?: number;
	/** |actual - expected| must not exceed this. */
	absolute?: number;
	/** Distance in representable doubles between actual and expected must not exceed this integer, at most MAX_ULP_TOLERANCE. */
	ulp?: number;
	/** Combination rule for the named bounds; absent means `all`. */
	combine?: NumericToleranceCombine;
	/** Non-finite pairing policy; absent means `fail`. */
	nonFinite?: NumericNonFinitePolicy;
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

/**
 * A number as the report writes it. JSON has no spelling for NaN or the
 * infinities: `JSON.stringify` writes each as null, and null already means
 * "undefined" in a deviation (a relative deviation against zero, a ulp
 * distance to a non-finite value). So a non-finite value is written by name,
 * the protobuf JSON convention, and a serialized report reads back with every
 * distinction intact. `reportedNumberValue` restores the number.
 */
export type ReportedNumber = number | "NaN" | "Infinity" | "-Infinity";

export function reportedNumber(value: number): ReportedNumber {
	if (Number.isNaN(value)) return "NaN";
	if (value === Number.POSITIVE_INFINITY) return "Infinity";
	if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
	return value;
}

/** The number a `ReportedNumber` names. */
export function reportedNumberValue(value: ReportedNumber): number {
	return typeof value === "number" ? value : Number(value);
}

export interface NumericDeviation {
	/** Array index of the worst element; absent for a scalar. */
	index?: number;
	actual: ReportedNumber;
	expected: ReportedNumber;
	/** |actual - expected|; `"Infinity"` when the difference overflows or the pair is a mismatched non-finite. */
	absolute: ReportedNumber;
	/**
	 * Relative deviation; `"Infinity"` when the quotient overflows; null when
	 * it is undefined (expected is zero and actual is not, or the pair is a
	 * mismatched non-finite).
	 */
	relative: ReportedNumber | null;
	/** Distance in representable doubles; `"Infinity"` past the safe-integer range; null when either side is not finite. */
	ulp: ReportedNumber | null;
	/**
	 * Present when either side is not finite. `matched` means the non-finite
	 * policy accepted the pair (NaN against NaN, or same-signed infinities);
	 * the deviation fields then read zero because the rule, not arithmetic,
	 * declared the pair equal. `mismatched` keeps the infinite deviation.
	 */
	nonFinite?: "matched" | "mismatched";
}

export interface NumericKeyReport {
	key: string;
	passed: boolean;
	/** Why the key failed, in schema order; empty on pass. */
	failed: NumericFailureReason[];
	/** Named bounds the worst element satisfied; empty when nothing was comparable. */
	held: NumericToleranceKind[];
	/** Named bounds the worst element violated, listed even when `combine: any` let the key pass. */
	violated: NumericToleranceKind[];
	/**
	 * Worst deviation for the key, present whenever both sides had a comparable
	 * value. A failing element outranks a passing one with a violated bound
	 * (possible only under `combine: any`), which outranks a clean one; within
	 * a tier the largest absolute deviation is the worst. So a key that passed
	 * only by `any` names the element that needed it, not the clean element
	 * that happened to deviate most.
	 */
	worst?: NumericDeviation;
	/** One line a reader can act on. */
	detail: string;
}

/** Identity of the reference payload the judgement read. */
export interface NumericReferenceProvenance {
	/** The caller's label for the reference, for example `reference 'tests/ref.json'`. */
	source: string;
	/** The reference path when the caller supplied one; a sealed host path or a repository-relative catalog path. */
	path?: string;
	/** SHA-256 of the exact reference text. */
	sha256: string;
	bytes: number;
}

/** Identity of the payload text the judgement extracted from the command's stdout. */
export interface NumericPayloadProvenance {
	sha256: string;
	bytes: number;
}

export interface NumericCompareReport {
	kind: "numeric-compare";
	passed: boolean;
	/** The tolerance exactly as declared, defaults not filled in. */
	tolerance: NumericTolerance;
	/** The combination rule that judged the payload, default applied. */
	combine: NumericToleranceCombine;
	/** The non-finite policy that judged the payload, default applied. */
	nonFinite: NumericNonFinitePolicy;
	/** The effective rule in words, for example `all of relative<=1e-6, absolute<=1e-9 must hold; non-finite values fail`. */
	rule: string;
	keys: NumericKeyReport[];
	/** The keys that failed, sorted; empty on pass. */
	failedKeys: string[];
	summary: string;
	/** Reference identity, present when the judgement read reference text. */
	reference?: NumericReferenceProvenance;
	/** Actual payload identity, present when the judgement extracted payload text. */
	actual?: NumericPayloadProvenance;
}

export const NUMERIC_PAYLOAD_CAPS = Object.freeze({
	keys: 4096,
	elements: 1_000_000,
});

const TOLERANCE_FIELDS = new Set(["relative", "absolute", "ulp", "combine", "nonFinite"]);
const TOLERANCE_KINDS: ReadonlyArray<NumericToleranceKind> = ["relative", "absolute", "ulp"];

/** True when the tolerance names at least one bound and every named field is usable. */
export function normalizeNumericTolerance(value: unknown): NumericTolerance | Error {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new Error("tolerance must be an object with relative, absolute, or ulp");
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !TOLERANCE_FIELDS.has(key));
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
		if (bound > MAX_ULP_TOLERANCE) {
			return new Error(`tolerance.ulp must not exceed ${MAX_ULP_TOLERANCE} (Number.MAX_SAFE_INTEGER)`);
		}
		tolerance.ulp = bound;
	}
	if (tolerance.relative === undefined && tolerance.absolute === undefined && tolerance.ulp === undefined) {
		return new Error("tolerance must name at least one of relative, absolute, or ulp");
	}
	if (Object.hasOwn(record, "combine")) {
		const combine = record.combine;
		if (combine !== "all" && combine !== "any") return new Error("tolerance.combine must be all or any");
		tolerance.combine = combine;
	}
	if (Object.hasOwn(record, "nonFinite")) {
		const policy = record.nonFinite;
		if (policy !== "fail" && policy !== "match") return new Error("tolerance.nonFinite must be fail or match");
		tolerance.nonFinite = policy;
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
 * integer range or either side is not finite; every admissible bound is at
 * most MAX_ULP_TOLERANCE, so that sentinel fails a bound only when the true
 * distance does.
 */
export function ulpDistance(actual: number, expected: number): number {
	if (!Number.isFinite(actual) || !Number.isFinite(expected)) return Number.POSITIVE_INFINITY;
	const distance = orderedBits(actual) - orderedBits(expected);
	const magnitude = distance < 0n ? -distance : distance;
	return magnitude > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(magnitude);
}

/**
 * Parse command stdout or a reference file as a numeric payload, naming the
 * fault when it is not one.
 *
 * JSON has no spelling for NaN, so NaN never arrives through this parser. An
 * infinity can: `JSON.parse` turns an overflowing literal such as `1e999` into
 * `Infinity`, and a validator that prints an overflowed measurement produces
 * exactly that. The payload keeps it, and the tolerance's `nonFinite` policy
 * decides how it is judged.
 */
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

export function effectiveNumericCombine(tolerance: NumericTolerance): NumericToleranceCombine {
	return tolerance.combine ?? DEFAULT_NUMERIC_COMBINE;
}

export function effectiveNumericNonFinite(tolerance: NumericTolerance): NumericNonFinitePolicy {
	return tolerance.nonFinite ?? DEFAULT_NUMERIC_NON_FINITE;
}

/** The named bounds, in schema order. */
function namedKinds(tolerance: NumericTolerance): NumericToleranceKind[] {
	return TOLERANCE_KINDS.filter((kind) => tolerance[kind] !== undefined);
}

/** NaN pairs with NaN; an infinity pairs with the same-signed infinity; nothing else pairs. */
function nonFinitePairMatches(actual: number, expected: number): boolean {
	if (Number.isNaN(actual) && Number.isNaN(expected)) return true;
	return actual === expected && !Number.isFinite(actual);
}

/** A deviation as arithmetic produced it, before the report encodes its non-finite values by name. */
interface Deviation {
	index?: number;
	actual: number;
	expected: number;
	absolute: number;
	relative: number | null;
	ulp: number | null;
	nonFinite?: "matched" | "mismatched";
}

function reportDeviation(item: Deviation): NumericDeviation {
	return {
		...item,
		actual: reportedNumber(item.actual),
		expected: reportedNumber(item.expected),
		absolute: reportedNumber(item.absolute),
		relative: item.relative === null ? null : reportedNumber(item.relative),
		ulp: item.ulp === null ? null : reportedNumber(item.ulp),
	};
}

function deviation(
	actual: number,
	expected: number,
	index: number | undefined,
	nonFinite: NumericNonFinitePolicy,
): Deviation {
	const finite = Number.isFinite(actual) && Number.isFinite(expected);
	if (!finite) {
		const matched = nonFinite === "match" && nonFinitePairMatches(actual, expected);
		return {
			...(index !== undefined ? { index } : {}),
			actual,
			expected,
			absolute: matched ? 0 : Number.POSITIVE_INFINITY,
			relative: matched ? 0 : null,
			ulp: matched ? 0 : null,
			nonFinite: matched ? "matched" : "mismatched",
		};
	}
	const absolute = Math.abs(actual - expected);
	let relative = expected === 0 ? (absolute === 0 ? 0 : null) : absolute / Math.abs(expected);
	if (!Number.isFinite(absolute)) {
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
		ulp: ulpDistance(actual, expected),
	};
}

/** Named bounds the deviation violates, in schema order. */
function violatedTolerances(item: Deviation, tolerance: NumericTolerance): NumericToleranceKind[] {
	const failed: NumericToleranceKind[] = [];
	if (tolerance.relative !== undefined && (item.relative === null || item.relative > tolerance.relative)) {
		failed.push("relative");
	}
	if (tolerance.absolute !== undefined && item.absolute > tolerance.absolute) failed.push("absolute");
	if (tolerance.ulp !== undefined && (item.ulp === null || item.ulp > tolerance.ulp)) failed.push("ulp");
	return failed;
}

interface ElementJudgement {
	failed: NumericFailureReason[];
	held: NumericToleranceKind[];
	violated: NumericToleranceKind[];
}

/**
 * Judge one deviation under the combination rule. A mismatched non-finite
 * pair fails as not finite before any bound is consulted; a matched pair
 * passes by policy with no bound consulted at all.
 */
function judgeDeviation(
	item: Deviation,
	tolerance: NumericTolerance,
	combine: NumericToleranceCombine,
): ElementJudgement {
	if (item.nonFinite === "mismatched") return { failed: ["not-finite"], held: [], violated: [] };
	if (item.nonFinite === "matched") return { failed: [], held: [], violated: [] };
	const violated = violatedTolerances(item, tolerance);
	const held = namedKinds(tolerance).filter((kind) => !violated.includes(kind));
	const passed = combine === "all" ? violated.length === 0 : held.length > 0;
	return { failed: passed ? [] : violated, held, violated };
}

/**
 * Worst-first rank of an element's judgement: failing, then passing with a
 * violated bound (which only `combine: any` allows), then clean. Ties inside
 * a tier go to the larger absolute deviation.
 */
function severity(judgement: ElementJudgement): 0 | 1 | 2 {
	if (judgement.failed.length > 0) return 2;
	return judgement.violated.length > 0 ? 1 : 0;
}

/**
 * Six significant digits with trailing fraction zeros dropped: `1.00000` reads
 * `1`, `1.50000e-9` reads `1.5e-9`. An integer keeps every digit, so `500000`
 * never collapses to `5`.
 */
function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	const [mantissa = "", exponent] = value.toPrecision(6).split("e");
	const trimmed = mantissa.includes(".") ? mantissa.replace(/\.?0+$/u, "") : mantissa;
	return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

function describeDeviation(item: Deviation): string {
	const where = item.index === undefined ? "" : `[${item.index}]`;
	if (item.nonFinite === "matched") {
		return `${where} actual=${String(item.actual)} expected=${String(item.expected)} (non-finite values match by policy)`;
	}
	const relative = item.relative === null ? "undefined" : formatNumber(item.relative);
	const ulp = item.ulp === null ? "undefined" : String(item.ulp);
	const zeroReference =
		item.nonFinite === undefined && item.expected === 0 && item.actual !== 0
			? "; relative undefined: reference is zero"
			: "";
	return `${where} actual=${formatNumber(item.actual)} expected=${formatNumber(item.expected)} abs=${formatNumber(item.absolute)} rel=${relative} ulp=${ulp}${zeroReference}`;
}

/**
 * A declared bound, printed exactly. The shortest round-trip spelling keeps
 * every digit the catalog wrote; exponent form below 1e-3 and from 1e6 up
 * keeps `1e-6` readable instead of `0.000001`.
 */
function formatBound(value: number): string {
	if (value === 0) return "0";
	const magnitude = Math.abs(value);
	return magnitude < 1e-3 || magnitude >= 1e6 ? value.toExponential() : String(value);
}

function describeBound(kind: NumericToleranceKind, tolerance: NumericTolerance): string {
	return `${kind}<=${formatBound(tolerance[kind] ?? 0)}`;
}

/** The effective judgement rule in words, so a reader never has to infer the conjunction from the tolerance object. */
export function describeNumericRule(tolerance: NumericTolerance): string {
	const bounds = namedKinds(tolerance).map((kind) => describeBound(kind, tolerance));
	const combine = effectiveNumericCombine(tolerance);
	const clause =
		bounds.length === 1
			? `${bounds[0]} must hold`
			: combine === "all"
				? `all of ${bounds.join(", ")} must hold`
				: `any of ${bounds.join(", ")} may hold`;
	const nonFinite =
		effectiveNumericNonFinite(tolerance) === "match"
			? "NaN matches NaN and same-signed infinities match"
			: "non-finite values fail";
	return `${clause}; ${nonFinite}`;
}

function passedDetail(key: string, judgement: ElementJudgement, worst: Deviation): string {
	if (worst.nonFinite === "matched")
		return `${key}: non-finite values match by policy, worst${describeDeviation(worst)}`;
	const partial =
		judgement.violated.length > 0 ? ` by ${judgement.held.join(", ")} (${judgement.violated.join(", ")} violated)` : "";
	return `${key}: within tolerance${partial}, worst${describeDeviation(worst)}`;
}

function compareElements(
	key: string,
	actual: number[],
	expected: number[],
	tolerance: NumericTolerance,
	combine: NumericToleranceCombine,
	nonFinite: NumericNonFinitePolicy,
): NumericKeyReport {
	let worst: Deviation | undefined;
	let worstJudgement: ElementJudgement = { failed: [], held: [], violated: [] };
	for (let index = 0; index < expected.length; index += 1) {
		const item = deviation(
			actual[index] as number,
			expected[index] as number,
			expected.length === 1 && actual.length === 1 ? undefined : index,
			nonFinite,
		);
		const judgement = judgeDeviation(item, tolerance, combine);
		const rank = severity(judgement);
		const worstRank = severity(worstJudgement);
		const worse = worst === undefined || rank > worstRank || (rank === worstRank && item.absolute > worst.absolute);
		if (worse) {
			worst = item;
			worstJudgement = judgement;
		}
	}
	if (worst === undefined) {
		return { key, passed: true, failed: [], held: [], violated: [], detail: `${key}: empty array matches` };
	}
	const passed = worstJudgement.failed.length === 0;
	return {
		key,
		passed,
		failed: worstJudgement.failed,
		held: worstJudgement.held,
		violated: worstJudgement.violated,
		worst: reportDeviation(worst),
		detail: passed
			? passedDetail(key, worstJudgement, worst)
			: `${key}: failed ${worstJudgement.failed.join(", ")} at worst${describeDeviation(worst)}`,
	};
}

function structuralFailure(key: string, reason: NumericFailureReason, detail: string): NumericKeyReport {
	return { key, passed: false, failed: [reason], held: [], violated: [], detail };
}

/**
 * Compare a command's payload against the reference. Every key on either side
 * is judged: a key missing on one side fails and names the side, a scalar
 * against an array fails, arrays compare elementwise and fail on length
 * mismatch, and a NaN or infinity fails as not finite unless the tolerance's
 * `nonFinite` policy matches the pair. A comparable value passes when the
 * named bounds hold under the tolerance's `combine` rule: every bound under
 * `all` (the default), at least one under `any`.
 */
export function compareNumeric(
	actual: NumericPayload,
	reference: NumericPayload,
	tolerance: NumericTolerance,
): NumericCompareReport {
	const combine = effectiveNumericCombine(tolerance);
	const nonFinite = effectiveNumericNonFinite(tolerance);
	const keys = [...new Set([...Object.keys(reference), ...Object.keys(actual)])].sort();
	const reports: NumericKeyReport[] = [];
	for (const key of keys) {
		const got = actual[key];
		const want = reference[key];
		if (got === undefined) {
			reports.push(structuralFailure(key, "missing-actual", `${key}: missing from the command output`));
			continue;
		}
		if (want === undefined) {
			reports.push(structuralFailure(key, "missing-reference", `${key}: missing from the reference`));
			continue;
		}
		if (Array.isArray(got) !== Array.isArray(want)) {
			reports.push(
				structuralFailure(
					key,
					"shape-mismatch",
					`${key}: ${Array.isArray(got) ? "array" : "scalar"} in the command output but ${Array.isArray(want) ? "array" : "scalar"} in the reference`,
				),
			);
			continue;
		}
		const gotList = Array.isArray(got) ? got : [got];
		const wantList = Array.isArray(want) ? want : [want];
		if (gotList.length !== wantList.length) {
			reports.push(
				structuralFailure(
					key,
					"length-mismatch",
					`${key}: ${gotList.length} element(s) in the command output but ${wantList.length} in the reference`,
				),
			);
			continue;
		}
		reports.push(compareElements(key, gotList, wantList, tolerance, combine, nonFinite));
	}
	const failedKeys = reports.filter((report) => !report.passed).map((report) => report.key);
	const passed = failedKeys.length === 0;
	return {
		kind: "numeric-compare",
		passed,
		tolerance: { ...tolerance },
		combine,
		nonFinite,
		rule: describeNumericRule(tolerance),
		keys: reports,
		failedKeys,
		summary: passed
			? `numeric-compare passed: ${reports.length} key(s) within tolerance`
			: `numeric-compare failed: ${failedKeys.length} of ${reports.length} key(s) out of tolerance (${failedKeys.join(", ")})`,
	};
}

/** The report as lines for a tool result or a receipt tail. */
export function renderNumericReport(report: NumericCompareReport): string {
	const lines = [report.summary, `rule: ${report.rule}`, `tolerance: ${JSON.stringify(report.tolerance)}`];
	if (report.reference !== undefined) {
		lines.push(
			`reference: ${report.reference.path ?? report.reference.source} sha256=${report.reference.sha256.slice(0, 12)} (${report.reference.bytes}B)`,
		);
	}
	if (report.actual !== undefined) {
		lines.push(`actual: sha256=${report.actual.sha256.slice(0, 12)} (${report.actual.bytes}B)`);
	}
	for (const key of report.keys) lines.push(`- ${key.detail}`);
	return lines.join("\n");
}
