/**
 * Pure budget math for `kind: perf-budget` verifier checks. The harness
 * measures the command's wall time; this module decides pass or fail against
 * a declared budget or a recorded baseline and writes the structured report.
 * It reads no file and runs nothing; the one impure function here,
 * {@link capturePerfEnvironment}, reads the host description so a baseline
 * can say where it was measured.
 *
 * A wall-time verdict is a statement about this machine at this moment. The
 * report carries the baseline's recorded environment beside the current one
 * and names every field that differs, because a baseline recorded on a
 * different CPU says little about a regression here. The comparison is
 * informational: it never changes pass or fail.
 */

import { arch, cpus, hostname, platform, totalmem } from "node:os";

export interface PerfBudgetSpec {
	wallTimeMs: number;
	tolerance?: { relative?: number };
}

/** The host a baseline was recorded on, as far as Node can describe it. */
export interface PerfEnvironment {
	hostname: string;
	platform: string;
	arch: string;
	cpuModel: string;
	cpuCount: number;
	totalMemoryBytes: number;
	nodeVersion: string;
}

export type PerfEnvironmentField = keyof PerfEnvironment;

const PERF_ENVIRONMENT_FIELDS: ReadonlyArray<PerfEnvironmentField> = [
	"hostname",
	"platform",
	"arch",
	"cpuModel",
	"cpuCount",
	"totalMemoryBytes",
	"nodeVersion",
];

export interface PerfBaseline {
	wallTimeMs: number;
	/** ISO time the baseline was recorded; informational. */
	recordedAt?: string;
	/** Check id the baseline was recorded for; informational. */
	check?: string;
	/** Host the baseline was recorded on; absent on version 1 files. */
	environment?: PerfEnvironment;
}

/** Identity of the baseline file a judgement read. */
export interface PerfBaselineProvenance {
	path: string;
	/** SHA-256 of the exact baseline text. */
	sha256: string;
	bytes: number;
	recordedAt?: string;
	check?: string;
}

/** Baseline host beside the judging host, with the fields that differ named. */
export interface PerfEnvironmentComparison {
	/** Null when the baseline file recorded no environment (a version 1 file). */
	baseline: PerfEnvironment | null;
	current: PerfEnvironment;
	differing: PerfEnvironmentField[];
}

export interface PerfBudgetReport {
	kind: "perf-budget";
	passed: boolean;
	measuredMs: number;
	/** The effective bound the measurement was judged against, tolerance applied. */
	budgetMs: number;
	/** measuredMs / budgetMs, rounded to three decimals. */
	ratio: number;
	source: "budget" | "baseline";
	/** The declared or recorded figure before tolerance. */
	referenceMs: number;
	relative: number;
	summary: string;
	/** Present for a baseline judgement when the judging host was captured. Informational only. */
	environment?: PerfEnvironmentComparison;
	/** Present when the judgement read a baseline file. */
	baseline?: PerfBaselineProvenance;
}

/** The version this build writes. Version 1 files, which record no environment, still load. */
export const PERF_BASELINE_VERSION = 2;
const SUPPORTED_BASELINE_VERSIONS: ReadonlyArray<number> = [1, PERF_BASELINE_VERSION];

export function normalizePerfBudget(value: unknown): PerfBudgetSpec | Error {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new Error("budget must be an object with wallTimeMs");
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => key !== "wallTimeMs" && key !== "tolerance");
	if (unknown.length > 0) return new Error(`budget has unknown field(s): ${unknown.sort().join(", ")}`);
	if (typeof record.wallTimeMs !== "number" || !Number.isFinite(record.wallTimeMs) || record.wallTimeMs <= 0) {
		return new Error("budget.wallTimeMs must be a positive number of milliseconds");
	}
	const spec: PerfBudgetSpec = { wallTimeMs: record.wallTimeMs };
	if (Object.hasOwn(record, "tolerance")) {
		const tolerance = normalizePerfTolerance(record.tolerance, "budget.tolerance");
		if (tolerance instanceof Error) return tolerance;
		spec.tolerance = tolerance;
	}
	return spec;
}

export function normalizePerfTolerance(value: unknown, location: string): { relative?: number } | Error {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new Error(`${location} must be an object with relative`);
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => key !== "relative");
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.sort().join(", ")}`);
	if (!Object.hasOwn(record, "relative")) return {};
	if (typeof record.relative !== "number" || !Number.isFinite(record.relative) || record.relative < 0) {
		return new Error(`${location}.relative must be a finite non-negative number`);
	}
	return { relative: record.relative };
}

/** Describe the host this process runs on. */
export function capturePerfEnvironment(): PerfEnvironment {
	const processors = cpus();
	return {
		hostname: hostname(),
		platform: platform(),
		arch: arch(),
		cpuModel: processors[0]?.model.trim() ?? "unknown",
		cpuCount: processors.length,
		totalMemoryBytes: totalmem(),
		nodeVersion: process.version,
	};
}

function parsePerfEnvironment(value: unknown, label: string): PerfEnvironment | Error {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new Error(`${label} must be an object describing the recording host`);
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !(PERF_ENVIRONMENT_FIELDS as ReadonlyArray<string>).includes(key));
	if (unknown.length > 0) return new Error(`${label} has unknown field(s): ${unknown.sort().join(", ")}`);
	for (const field of ["hostname", "platform", "arch", "cpuModel", "nodeVersion"] as const) {
		if (typeof record[field] !== "string") return new Error(`${label}.${field} must be a string`);
	}
	if (typeof record.cpuCount !== "number" || !Number.isInteger(record.cpuCount) || record.cpuCount < 0) {
		return new Error(`${label}.cpuCount must be a non-negative integer`);
	}
	if (
		typeof record.totalMemoryBytes !== "number" ||
		!Number.isFinite(record.totalMemoryBytes) ||
		record.totalMemoryBytes < 0
	) {
		return new Error(`${label}.totalMemoryBytes must be a non-negative number`);
	}
	return {
		hostname: record.hostname as string,
		platform: record.platform as string,
		arch: record.arch as string,
		cpuModel: record.cpuModel as string,
		cpuCount: record.cpuCount,
		totalMemoryBytes: record.totalMemoryBytes,
		nodeVersion: record.nodeVersion as string,
	};
}

/**
 * Parse a baseline file written by `clio-coder verifiers baseline <id>`. A
 * version 1 file (or one without a version) carries no environment; a version
 * 2 file carries the recording host.
 */
export function parsePerfBaseline(text: string, label: string): PerfBaseline | Error {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return new Error(`${label} must be a JSON object with wallTimeMs`);
	}
	const record = parsed as Record<string, unknown>;
	if (Object.hasOwn(record, "version")) {
		if (typeof record.version !== "number" || !SUPPORTED_BASELINE_VERSIONS.includes(record.version)) {
			return new Error(`${label}.version must be one of ${SUPPORTED_BASELINE_VERSIONS.join(", ")}`);
		}
	}
	if (typeof record.wallTimeMs !== "number" || !Number.isFinite(record.wallTimeMs) || record.wallTimeMs <= 0) {
		return new Error(`${label}.wallTimeMs must be a positive number of milliseconds`);
	}
	const baseline: PerfBaseline = { wallTimeMs: record.wallTimeMs };
	if (typeof record.recordedAt === "string") baseline.recordedAt = record.recordedAt;
	if (typeof record.check === "string") baseline.check = record.check;
	if (Object.hasOwn(record, "environment") && record.environment !== undefined) {
		const environment = parsePerfEnvironment(record.environment, `${label}.environment`);
		if (environment instanceof Error) return environment;
		baseline.environment = environment;
	}
	return baseline;
}

/** The JSON text a baseline file holds; stable key order so a re-record is a clean diff. */
export function renderPerfBaseline(input: {
	wallTimeMs: number;
	check: string;
	recordedAt: string;
	environment: PerfEnvironment;
}): string {
	return `${JSON.stringify(
		{
			version: PERF_BASELINE_VERSION,
			check: input.check,
			wallTimeMs: input.wallTimeMs,
			recordedAt: input.recordedAt,
			environment: {
				hostname: input.environment.hostname,
				platform: input.environment.platform,
				arch: input.environment.arch,
				cpuModel: input.environment.cpuModel,
				cpuCount: input.environment.cpuCount,
				totalMemoryBytes: input.environment.totalMemoryBytes,
				nodeVersion: input.environment.nodeVersion,
			},
		},
		null,
		2,
	)}\n`;
}

/** Name every field on which the judging host differs from the recording host. */
export function comparePerfEnvironments(
	baseline: PerfEnvironment | undefined,
	current: PerfEnvironment,
): PerfEnvironmentComparison {
	if (baseline === undefined) return { baseline: null, current, differing: [] };
	const differing = PERF_ENVIRONMENT_FIELDS.filter((field) => baseline[field] !== current[field]);
	return { baseline, current, differing };
}

/**
 * Judge a measurement. A declared budget bounds the time at
 * `wallTimeMs * (1 + tolerance.relative)`; a baseline bounds it at
 * `baseline.wallTimeMs * (1 + relative)`. Measured time above the bound fails.
 * When `environment` names the judging host and the judgement uses a
 * baseline, the report compares the two hosts; a difference is reported and
 * never changes the verdict.
 */
export function evaluatePerfBudget(
	measuredMs: number,
	spec: { budget?: PerfBudgetSpec; baseline?: PerfBaseline; relative?: number; environment?: PerfEnvironment },
): PerfBudgetReport | Error {
	if (!Number.isFinite(measuredMs) || measuredMs < 0)
		return new Error("measured wall time must be a non-negative number");
	let source: PerfBudgetReport["source"];
	let referenceMs: number;
	let relative: number;
	let comparison: PerfEnvironmentComparison | undefined;
	if (spec.budget !== undefined) {
		source = "budget";
		referenceMs = spec.budget.wallTimeMs;
		relative = spec.budget.tolerance?.relative ?? 0;
	} else if (spec.baseline !== undefined) {
		source = "baseline";
		referenceMs = spec.baseline.wallTimeMs;
		relative = spec.relative ?? 0;
		if (spec.environment !== undefined) comparison = comparePerfEnvironments(spec.baseline.environment, spec.environment);
	} else {
		return new Error("perf-budget needs a budget or a recorded baseline");
	}
	const budgetMs = referenceMs * (1 + relative);
	const ratio = Math.round((measuredMs / budgetMs) * 1000) / 1000;
	const passed = measuredMs <= budgetMs;
	const bound = `${Math.round(budgetMs)}ms (${source} ${Math.round(referenceMs)}ms${relative > 0 ? ` +${Math.round(relative * 100)}%` : ""})`;
	const verdict = passed
		? `perf-budget passed: measured ${Math.round(measuredMs)}ms within ${bound}, ratio ${ratio}`
		: `perf-budget failed: measured ${Math.round(measuredMs)}ms exceeds ${bound}, ratio ${ratio}`;
	const environmentNote =
		comparison === undefined
			? ""
			: comparison.baseline === null
				? "; baseline records no environment"
				: comparison.differing.length > 0
					? `; environment differs: ${comparison.differing.join(", ")}`
					: "";
	return {
		kind: "perf-budget",
		passed,
		measuredMs,
		budgetMs,
		ratio,
		source,
		referenceMs,
		relative,
		summary: `${verdict}${environmentNote}`,
		...(comparison !== undefined ? { environment: comparison } : {}),
	};
}
