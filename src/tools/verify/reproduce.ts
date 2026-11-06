/**
 * Pure schema and judgement for `kind: reproduce` verifier checks. A
 * reproduce check re-runs an analysis from pinned inputs in a clean
 * environment with a declared seed, then judges the metrics its command
 * prints against a reference file or against a second clean run. This module
 * validates the declaration, parses the metric payload, and writes the
 * report; it reads no file and runs nothing. The runner lives in
 * `reproduce-run.ts`.
 *
 * The verdict is agreement within the declared tolerance under the recorded
 * conditions. It never says the analysis is correct: a run that agrees with
 * itself or with a reference can agree on a wrong number.
 *
 * Field names in the recorded conditions follow the CLIO record shapes where
 * they overlap: an input pin carries `path`, `sha256` and `sizeBytes` like a
 * provenance edge with identity evidence, and the platform carries `os`,
 * `arch`, `pythonVersion` and `clioVersion` like an execution environment
 * record.
 */

import {
	compareNumeric,
	describeNumericRule,
	type NumericKeyReport,
	type NumericPayloadProvenance,
	type NumericReferenceProvenance,
	type NumericTolerance,
	normalizeNumericTolerance,
} from "./numeric.js";

export type ReproduceEnvironment = "worktree" | "copy";

export const REPRODUCE_ENVIRONMENTS: ReadonlyArray<ReproduceEnvironment> = ["worktree", "copy"];

export interface ReproduceInputPin {
	/** Repository-relative file path. */
	path: string;
	/** Lowercase hex SHA-256 of the file's bytes. */
	sha256: string;
}

export interface ReproduceSeed {
	/** Environment variable the command reads its seed from. */
	env: string;
	value: string;
}

/** `twice` runs the command in two clean environments and compares the runs; `reference` names a metrics file. */
export type ReproduceCompare = { mode: "twice" } | { mode: "reference"; reference: string };

export interface DeclaredReproduce {
	inputs: ReproduceInputPin[];
	/** Absent means `worktree`. */
	environment?: ReproduceEnvironment;
	seed?: ReproduceSeed;
	compare: ReproduceCompare;
	tolerance: NumericTolerance;
	/** Metric name to the exact units string the command must report beside it. */
	units?: Record<string, string>;
	/** Metric name to the exact nested-array shape; `[]` is a scalar. */
	shapes?: Record<string, number[]>;
}

export const REPRODUCE_CAPS = Object.freeze({
	inputs: 256,
	metrics: 256,
	shapeRank: 16,
	unitsBytes: 64,
	seedValueBytes: 256,
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REPRODUCE_FIELDS = new Set(["inputs", "environment", "seed", "compare", "tolerance", "units", "shapes"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

/** Fields a catalog check of kind `reproduce` may carry beyond the common ones. */
export const REPRODUCE_CATALOG_FIELDS: ReadonlyArray<string> = [...REPRODUCE_FIELDS];

/**
 * Validate the reproduce fields of one catalog check. `validatePath` is the
 * catalog's repository-relative path rule, passed in so the two never drift.
 */
export function normalizeReproduce(
	record: Record<string, unknown>,
	location: string,
	validatePath: (value: unknown, location: string) => string | Error,
): DeclaredReproduce | Error {
	const unknown = Object.keys(record).filter((key) => !REPRODUCE_FIELDS.has(key));
	if (unknown.length > 0) return new Error(`${location} has unknown reproduce field(s): ${unknown.sort().join(", ")}`);
	if (!Object.hasOwn(record, "inputs")) return new Error(`${location}.inputs is required for kind reproduce`);
	if (!Object.hasOwn(record, "compare")) return new Error(`${location}.compare is required for kind reproduce`);
	if (!Object.hasOwn(record, "tolerance")) return new Error(`${location}.tolerance is required for kind reproduce`);

	const inputsValue = record.inputs;
	if (!Array.isArray(inputsValue)) return new Error(`${location}.inputs must be an array of {path, sha256}`);
	if (inputsValue.length > REPRODUCE_CAPS.inputs) {
		return new Error(`${location}.inputs exceeds the ${REPRODUCE_CAPS.inputs}-input cap`);
	}
	const inputs: ReproduceInputPin[] = [];
	const seenPaths = new Set<string>();
	for (const [index, entry] of inputsValue.entries()) {
		const at = `${location}.inputs[${index}]`;
		if (!isRecord(entry)) return new Error(`${at} must be an object with path and sha256`);
		const extra = Object.keys(entry).filter((key) => key !== "path" && key !== "sha256");
		if (extra.length > 0) return new Error(`${at} has unknown field(s): ${extra.sort().join(", ")}`);
		const pinPath = validatePath(entry.path, `${at}.path`);
		if (pinPath instanceof Error) return pinPath;
		if (pinPath === "." || pinPath.endsWith("/")) return new Error(`${at}.path must name a file`);
		if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
			return new Error(`${at}.sha256 must be 64 lowercase hex characters`);
		}
		if (seenPaths.has(pinPath)) return new Error(`${at}.path duplicates '${pinPath}'`);
		seenPaths.add(pinPath);
		inputs.push({ path: pinPath, sha256: entry.sha256 });
	}

	const spec: DeclaredReproduce = { inputs, compare: { mode: "twice" }, tolerance: {} };

	if (Object.hasOwn(record, "environment")) {
		const environment = record.environment;
		if (typeof environment !== "string" || !(REPRODUCE_ENVIRONMENTS as ReadonlyArray<string>).includes(environment)) {
			return new Error(`${location}.environment must be one of ${REPRODUCE_ENVIRONMENTS.join(", ")}`);
		}
		spec.environment = environment as ReproduceEnvironment;
	}
	if (spec.environment === "copy" && inputs.length === 0) {
		return new Error(`${location}.inputs must name at least one file for environment copy, which copies only inputs`);
	}

	if (Object.hasOwn(record, "seed")) {
		const seed = record.seed;
		if (!isRecord(seed)) return new Error(`${location}.seed must be an object with env and value`);
		const extra = Object.keys(seed).filter((key) => key !== "env" && key !== "value");
		if (extra.length > 0) return new Error(`${location}.seed has unknown field(s): ${extra.sort().join(", ")}`);
		if (typeof seed.env !== "string" || !ENV_NAME_PATTERN.test(seed.env)) {
			return new Error(`${location}.seed.env must be an environment variable name`);
		}
		const raw = seed.value;
		const value = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
		if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
			return new Error(`${location}.seed.value must be a non-empty string or an integer`);
		}
		if (Buffer.byteLength(value, "utf8") > REPRODUCE_CAPS.seedValueBytes) {
			return new Error(`${location}.seed.value exceeds the ${REPRODUCE_CAPS.seedValueBytes}-byte cap`);
		}
		spec.seed = { env: seed.env, value };
	}

	const compare = record.compare;
	if (compare === "twice") {
		spec.compare = { mode: "twice" };
	} else if (isRecord(compare)) {
		const extra = Object.keys(compare).filter((key) => key !== "reference");
		if (extra.length > 0) return new Error(`${location}.compare has unknown field(s): ${extra.sort().join(", ")}`);
		const reference = validatePath(compare.reference, `${location}.compare.reference`);
		if (reference instanceof Error) return reference;
		spec.compare = { mode: "reference", reference };
	} else {
		return new Error(`${location}.compare must be twice or {reference: <path>}`);
	}

	const tolerance = normalizeNumericTolerance(record.tolerance);
	if (tolerance instanceof Error) return new Error(`${location}.${tolerance.message}`);
	spec.tolerance = tolerance;

	if (Object.hasOwn(record, "units")) {
		const units = record.units;
		if (!isRecord(units)) return new Error(`${location}.units must map metric names to units strings`);
		const entries = Object.entries(units);
		if (entries.length > REPRODUCE_CAPS.metrics) {
			return new Error(`${location}.units exceeds the ${REPRODUCE_CAPS.metrics}-metric cap`);
		}
		const map: Record<string, string> = {};
		for (const [metric, value] of entries) {
			if (
				typeof value !== "string" ||
				value.length === 0 ||
				hasControlCharacter(value) ||
				Buffer.byteLength(value, "utf8") > REPRODUCE_CAPS.unitsBytes
			) {
				return new Error(
					`${location}.units.${metric} must be a non-empty units string of at most ${REPRODUCE_CAPS.unitsBytes} bytes`,
				);
			}
			map[metric] = value;
		}
		spec.units = map;
	}

	if (Object.hasOwn(record, "shapes")) {
		const shapes = record.shapes;
		if (!isRecord(shapes)) return new Error(`${location}.shapes must map metric names to shape arrays`);
		const entries = Object.entries(shapes);
		if (entries.length > REPRODUCE_CAPS.metrics) {
			return new Error(`${location}.shapes exceeds the ${REPRODUCE_CAPS.metrics}-metric cap`);
		}
		const map: Record<string, number[]> = {};
		for (const [metric, value] of entries) {
			if (
				!Array.isArray(value) ||
				value.length > REPRODUCE_CAPS.shapeRank ||
				!value.every((dimension) => Number.isSafeInteger(dimension) && (dimension as number) >= 0)
			) {
				return new Error(
					`${location}.shapes.${metric} must be an array of at most ${REPRODUCE_CAPS.shapeRank} non-negative integers ([] is a scalar)`,
				);
			}
			map[metric] = [...(value as number[])];
		}
		spec.shapes = map;
	}
	return spec;
}

/** The effective environment, default applied. */
export function reproduceEnvironment(spec: DeclaredReproduce): ReproduceEnvironment {
	return spec.environment ?? "worktree";
}

/** The catalog form of a reproduce declaration, for writing it back. */
export function reproduceCatalogFields(spec: DeclaredReproduce): Record<string, unknown> {
	return {
		inputs: spec.inputs.map((input) => ({ path: input.path, sha256: input.sha256 })),
		...(spec.environment !== undefined ? { environment: spec.environment } : {}),
		...(spec.seed !== undefined ? { seed: { env: spec.seed.env, value: spec.seed.value } } : {}),
		compare: spec.compare.mode === "twice" ? "twice" : { reference: spec.compare.reference },
		tolerance: { ...spec.tolerance },
		...(spec.units !== undefined ? { units: { ...spec.units } } : {}),
		...(spec.shapes !== undefined
			? { shapes: Object.fromEntries(Object.entries(spec.shapes).map(([key, shape]) => [key, [...shape]])) }
			: {}),
	};
}

/** One metric as the command reported it: flattened values, nested shape, and units when given. */
export interface ReportedMetric {
	/** Scalar, or the row-major flattening of a rectangular nested array. */
	value: number | number[];
	/** `[]` for a scalar. */
	shape: number[];
	units?: string;
}

export type ReproducePayload = Record<string, ReportedMetric>;

const PAYLOAD_KEY_CAP = 4096;
const PAYLOAD_ELEMENT_CAP = 1_000_000;

/** Flatten a nested number array, returning its shape, or an Error naming why it is not rectangular. */
function flatten(value: unknown, label: string): { values: number[]; shape: number[] } | Error {
	if (typeof value === "number") return { values: [value], shape: [] };
	if (!Array.isArray(value)) return new Error(`${label} must be a number or a nested array of numbers`);
	if (value.length === 0) return { values: [], shape: [0] };
	const parts: Array<{ values: number[]; shape: number[] }> = [];
	for (const [index, entry] of value.entries()) {
		const part = flatten(entry, `${label}[${index}]`);
		if (part instanceof Error) return part;
		parts.push(part);
	}
	const first = parts[0]?.shape ?? [];
	for (const [index, part] of parts.entries()) {
		if (part.shape.length !== first.length || part.shape.some((dimension, at) => dimension !== first[at])) {
			return new Error(
				`${label} is ragged: element 0 has shape [${first.join(", ")}] but element ${index} has shape [${part.shape.join(", ")}]`,
			);
		}
	}
	return { values: parts.flatMap((part) => part.values), shape: [value.length, ...first] };
}

/**
 * Parse a reproduce command's stdout, or a reference file, as named metrics.
 * A metric is a number, a rectangular nested array of numbers, or an object
 * `{"value": <number or nested array>, "units": "<string>"}` that reports its
 * units beside the value.
 */
export function parseReproducePayload(text: string, label: string): ReproducePayload | Error {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) {
		return new Error(`${label} must be a JSON object of metric -> number | nested number array | {value, units}`);
	}
	const keys = Object.keys(parsed);
	if (keys.length > PAYLOAD_KEY_CAP) return new Error(`${label} exceeds the ${PAYLOAD_KEY_CAP}-key cap`);
	const payload: ReproducePayload = {};
	let elements = 0;
	for (const key of keys) {
		const raw = parsed[key];
		let units: string | undefined;
		let value: unknown = raw;
		if (isRecord(raw)) {
			const extra = Object.keys(raw).filter((field) => field !== "value" && field !== "units");
			if (extra.length > 0 || !Object.hasOwn(raw, "value")) {
				return new Error(`${label}.${key} as an object must be {"value": ..., "units": "..."}`);
			}
			if (Object.hasOwn(raw, "units")) {
				if (typeof raw.units !== "string") return new Error(`${label}.${key}.units must be a string`);
				units = raw.units;
			}
			value = raw.value;
		}
		const flat = flatten(value, `${label}.${key}`);
		if (flat instanceof Error) return flat;
		elements += Math.max(flat.values.length, 1);
		if (elements > PAYLOAD_ELEMENT_CAP) return new Error(`${label} exceeds the ${PAYLOAD_ELEMENT_CAP}-element cap`);
		payload[key] = {
			value: flat.shape.length === 0 ? (flat.values[0] as number) : flat.values,
			shape: flat.shape,
			...(units !== undefined ? { units } : {}),
		};
	}
	return payload;
}

/** Why one metric failed, in report order. */
export type ReproduceMetricFailure =
	| "missing"
	| "tolerance"
	| "shape-mismatch"
	| "units-missing"
	| "units-mismatch"
	| "shape-declared-mismatch";

export interface ReproduceUnitsVerdict {
	declared: string;
	/** Units reported by each judged payload, in run order then reference; null where none was reported. */
	reported: Array<string | null>;
	passed: boolean;
}

export interface ReproduceShapeVerdict {
	declared: number[];
	/** Shapes of each judged payload, in run order then reference; null where the metric was absent. */
	reported: Array<number[] | null>;
	passed: boolean;
}

export interface ReproduceMetricVerdict {
	metric: string;
	passed: boolean;
	failed: ReproduceMetricFailure[];
	/** The tolerance judgement for this metric, numeric-compare's own key report. */
	agreement?: NumericKeyReport;
	units?: ReproduceUnitsVerdict;
	shape?: ReproduceShapeVerdict;
	detail: string;
}

export interface ReproducePlatform {
	/** `process.platform`. */
	os: string;
	arch: string;
	/** Kernel or OS release. */
	release: string;
	nodeVersion: string;
	clioVersion: string;
	/** The interpreter argv[0] resolved to, when the command named python or python3. */
	interpreter?: string;
	/** `python --version` of that interpreter; absent when it was not a Python command or could not be read. */
	pythonVersion?: string;
}

export interface ReproduceInputRecord {
	path: string;
	sha256: string;
	sizeBytes: number;
	/** Whether git tracks the path at the recorded commit; null outside a repository. */
	tracked: boolean | null;
}

/**
 * The conditions a reproduce verdict holds under. A later reader (a claim, a
 * cost-per-outcome count) cites these fields rather than re-deriving them.
 */
export interface ReproduceConditions {
	inputs: ReproduceInputRecord[];
	environment: ReproduceEnvironment;
	/** HEAD of the repository the check ran from; null outside a repository. */
	commit: string | null;
	/**
	 * Whether tracked files in the operator's checkout matched `commit`. A
	 * worktree run executes the committed tree, so uncommitted edits to the
	 * analysis are not what this verdict judged.
	 */
	trackedTreeClean: boolean | null;
	seed: ReproduceSeed | null;
	platform: ReproducePlatform;
	/** The argv that ran, interpreter resolved. */
	argv: string[];
	/** Repository-relative directory the command ran in, inside each clean environment. */
	cwd: string;
}

export interface ReproduceRunRecord {
	exitCode: number | null;
	durationMs: number;
	/** Identity of the metrics text extracted from stdout. */
	payload?: NumericPayloadProvenance;
}

export interface ReproduceReport {
	kind: "reproduce";
	passed: boolean;
	compare: "twice" | "reference";
	/** The tolerance exactly as declared. */
	tolerance: NumericTolerance;
	/** The effective rule in words. */
	rule: string;
	conditions: ReproduceConditions;
	runs: ReproduceRunRecord[];
	/** Present for `compare: {reference}`. */
	reference?: NumericReferenceProvenance;
	metrics: ReproduceMetricVerdict[];
	failedMetrics: string[];
	summary: string;
}

function shapeText(shape: ReadonlyArray<number> | null): string {
	return shape === null ? "absent" : `[${shape.join(", ")}]`;
}

function sameShape(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
	return left.length === right.length && left.every((dimension, index) => dimension === right[index]);
}

/**
 * Judge the metrics. `actual` is the first run; `expected` is the second run
 * under `twice` or the reference under `reference`. Every metric on either
 * side is judged for agreement within the tolerance, and their nested shapes
 * must match each other. Every declared units entry must be reported, exactly,
 * by every payload that carries the metric, and every declared shape must
 * match. Units a reference file does not report are not required of it.
 */
export function judgeReproduce(input: {
	spec: DeclaredReproduce;
	actual: ReproducePayload;
	expected: ReproducePayload;
	expectedIsReference: boolean;
	conditions: ReproduceConditions;
	runs: ReproduceRunRecord[];
	reference?: NumericReferenceProvenance;
}): ReproduceReport {
	const { spec, actual, expected } = input;
	const flat = (payload: ReproducePayload) =>
		Object.fromEntries(Object.entries(payload).map(([key, metric]) => [key, metric.value]));
	const numeric = compareNumeric(flat(actual), flat(expected), spec.tolerance);
	const byKey = new Map(numeric.keys.map((key) => [key.key, key]));
	const names = [
		...new Set([
			...Object.keys(actual),
			...Object.keys(expected),
			...Object.keys(spec.units ?? {}),
			...Object.keys(spec.shapes ?? {}),
		]),
	].sort();
	const expectedLabel = input.expectedIsReference ? "reference" : "run 2";
	// numeric-compare words a deviation as actual against expected; here they are run 1 against the other side.
	const sideWords = (text: string) =>
		text.replace(/\bactual=/gu, "run1=").replace(/\bexpected=/gu, input.expectedIsReference ? "reference=" : "run2=");
	const metrics: ReproduceMetricVerdict[] = [];
	for (const metric of names) {
		const got = actual[metric];
		const want = expected[metric];
		const failed: ReproduceMetricFailure[] = [];
		const notes: string[] = [];
		if (got === undefined || want === undefined) {
			failed.push("missing");
			notes.push(
				got === undefined && want === undefined
					? "declared but reported by neither side"
					: got === undefined
						? "missing from run 1"
						: `missing from ${expectedLabel}`,
			);
		}
		const agreement = byKey.get(metric);
		if (got !== undefined && want !== undefined) {
			if (!sameShape(got.shape, want.shape)) {
				failed.push("shape-mismatch");
				notes.push(`run 1 shape ${shapeText(got.shape)} but ${expectedLabel} shape ${shapeText(want.shape)}`);
			} else if (agreement !== undefined && !agreement.passed) {
				failed.push("tolerance");
				notes.push(sideWords(agreement.detail.replace(`${metric}: `, "")));
			} else if (agreement !== undefined) {
				notes.push(sideWords(agreement.detail.replace(`${metric}: `, "")));
			}
		}
		let units: ReproduceUnitsVerdict | undefined;
		const declaredUnits = spec.units?.[metric];
		if (declaredUnits !== undefined) {
			const sides: Array<{ label: string; metric: ReportedMetric | undefined; required: boolean }> = [
				{ label: "run 1", metric: got, required: true },
				{ label: expectedLabel, metric: want, required: !input.expectedIsReference },
			];
			const reported = sides.map((side) => side.metric?.units ?? null);
			let unitsPassed = true;
			for (const side of sides) {
				if (side.metric === undefined) {
					unitsPassed = false;
					continue;
				}
				if (side.metric.units === undefined) {
					if (!side.required) continue;
					unitsPassed = false;
					if (!failed.includes("units-missing")) failed.push("units-missing");
					notes.push(`${side.label} reported no units; declared '${declaredUnits}'`);
				} else if (side.metric.units !== declaredUnits) {
					unitsPassed = false;
					if (!failed.includes("units-mismatch")) failed.push("units-mismatch");
					notes.push(`${side.label} reported units '${side.metric.units}'; declared '${declaredUnits}'`);
				}
			}
			units = { declared: declaredUnits, reported, passed: unitsPassed };
		}
		let shape: ReproduceShapeVerdict | undefined;
		const declaredShape = spec.shapes?.[metric];
		if (declaredShape !== undefined) {
			const reported = [got?.shape ?? null, want?.shape ?? null];
			const shapePassed = reported.every((entry) => entry !== null && sameShape(entry, declaredShape));
			if (!shapePassed) {
				failed.push("shape-declared-mismatch");
				notes.push(
					`declared shape ${shapeText(declaredShape)}; run 1 ${shapeText(reported[0] ?? null)}, ${expectedLabel} ${shapeText(reported[1] ?? null)}`,
				);
			}
			shape = { declared: [...declaredShape], reported, passed: shapePassed };
		}
		const passed = failed.length === 0;
		metrics.push({
			metric,
			passed,
			failed,
			...(agreement !== undefined && got !== undefined && want !== undefined ? { agreement } : {}),
			...(units !== undefined ? { units } : {}),
			...(shape !== undefined ? { shape } : {}),
			detail: `${metric}: ${passed ? "agrees" : `failed ${failed.join(", ")}`}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
		});
	}
	const failedMetrics = metrics.filter((metric) => !metric.passed).map((metric) => metric.metric);
	const passed = failedMetrics.length === 0 && metrics.length > 0;
	const against = input.expectedIsReference ? "the reference" : "a second clean run";
	return {
		kind: "reproduce",
		passed,
		compare: input.expectedIsReference ? "reference" : "twice",
		tolerance: { ...spec.tolerance },
		rule: describeNumericRule(spec.tolerance),
		conditions: input.conditions,
		runs: input.runs,
		...(input.reference !== undefined ? { reference: input.reference } : {}),
		metrics,
		failedMetrics,
		summary:
			metrics.length === 0
				? "reproduce failed: the command reported no metrics"
				: passed
					? `reproduce passed: ${metrics.length} metric(s) agree with ${against} within the declared tolerance`
					: `reproduce failed: ${failedMetrics.length} of ${metrics.length} metric(s) failed against ${against} (${failedMetrics.join(", ")})`,
	};
}

/** The report as lines for a tool result. Every recorded condition is printed. */
export function renderReproduceReport(report: ReproduceReport): string {
	const c = report.conditions;
	const platform = [
		`${c.platform.os}/${c.platform.arch} ${c.platform.release}`,
		`node ${c.platform.nodeVersion}`,
		`clio-coder ${c.platform.clioVersion}`,
		...(c.platform.interpreter !== undefined ? [`interpreter ${c.platform.interpreter}`] : []),
		...(c.platform.pythonVersion !== undefined ? [c.platform.pythonVersion] : []),
	].join(", ");
	const lines = [
		report.summary,
		`compare: ${report.compare}; rule: ${report.rule}`,
		`tolerance: ${JSON.stringify(report.tolerance)}`,
		`environment: ${c.environment}; commit: ${c.commit ?? "none"}${c.trackedTreeClean === false ? " (operator checkout has uncommitted tracked changes; the committed tree ran)" : ""}`,
		`seed: ${c.seed === null ? "none" : `${c.seed.env}=${c.seed.value}`}`,
		`platform: ${platform}`,
		`argv: ${JSON.stringify(c.argv)} in ${c.cwd}`,
		...c.inputs.map(
			(input) =>
				`input: ${input.path} sha256=${input.sha256} (${input.sizeBytes}B${input.tracked === null ? "" : input.tracked ? ", tracked" : ", untracked"})`,
		),
		...report.runs.map(
			(run, index) =>
				`run ${index + 1}: exit ${run.exitCode ?? "?"} in ${run.durationMs}ms${run.payload !== undefined ? ` payload sha256=${run.payload.sha256.slice(0, 12)} (${run.payload.bytes}B)` : ""}`,
		),
	];
	if (report.reference !== undefined) {
		lines.push(
			`reference: ${report.reference.path ?? report.reference.source} sha256=${report.reference.sha256.slice(0, 12)} (${report.reference.bytes}B)`,
		);
	}
	for (const metric of report.metrics) lines.push(`- ${metric.detail}`);
	return lines.join("\n");
}
