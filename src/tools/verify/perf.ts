/**
 * Pure budget math for `kind: perf-budget` verifier checks. The harness
 * measures the command's wall time; this module decides pass or fail against
 * a declared budget or a recorded baseline and writes the structured report.
 * It reads no file and runs nothing.
 */

export interface PerfBudgetSpec {
	wallTimeMs: number;
	tolerance?: { relative?: number };
}

export interface PerfBaseline {
	wallTimeMs: number;
	/** ISO time the baseline was recorded; informational. */
	recordedAt?: string;
	/** Check id the baseline was recorded for; informational. */
	check?: string;
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
}

export const PERF_BASELINE_VERSION = 1;

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

/** Parse a baseline file written by `clio-coder verifiers baseline <id>`. */
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
	if (typeof record.wallTimeMs !== "number" || !Number.isFinite(record.wallTimeMs) || record.wallTimeMs <= 0) {
		return new Error(`${label}.wallTimeMs must be a positive number of milliseconds`);
	}
	const baseline: PerfBaseline = { wallTimeMs: record.wallTimeMs };
	if (typeof record.recordedAt === "string") baseline.recordedAt = record.recordedAt;
	if (typeof record.check === "string") baseline.check = record.check;
	return baseline;
}

/** The JSON text a baseline file holds; stable key order so a re-record is a clean diff. */
export function renderPerfBaseline(input: { wallTimeMs: number; check: string; recordedAt: string }): string {
	return `${JSON.stringify(
		{ version: PERF_BASELINE_VERSION, check: input.check, wallTimeMs: input.wallTimeMs, recordedAt: input.recordedAt },
		null,
		2,
	)}\n`;
}

/**
 * Judge a measurement. A declared budget bounds the time at
 * `wallTimeMs * (1 + tolerance.relative)`; a baseline bounds it at
 * `baseline.wallTimeMs * (1 + relative)`. Measured time above the bound fails.
 */
export function evaluatePerfBudget(
	measuredMs: number,
	spec: { budget?: PerfBudgetSpec; baseline?: PerfBaseline; relative?: number },
): PerfBudgetReport | Error {
	if (!Number.isFinite(measuredMs) || measuredMs < 0)
		return new Error("measured wall time must be a non-negative number");
	let source: PerfBudgetReport["source"];
	let referenceMs: number;
	let relative: number;
	if (spec.budget !== undefined) {
		source = "budget";
		referenceMs = spec.budget.wallTimeMs;
		relative = spec.budget.tolerance?.relative ?? 0;
	} else if (spec.baseline !== undefined) {
		source = "baseline";
		referenceMs = spec.baseline.wallTimeMs;
		relative = spec.relative ?? 0;
	} else {
		return new Error("perf-budget needs a budget or a recorded baseline");
	}
	const budgetMs = referenceMs * (1 + relative);
	const ratio = Math.round((measuredMs / budgetMs) * 1000) / 1000;
	const passed = measuredMs <= budgetMs;
	const bound = `${Math.round(budgetMs)}ms (${source} ${Math.round(referenceMs)}ms${relative > 0 ? ` +${Math.round(relative * 100)}%` : ""})`;
	return {
		kind: "perf-budget",
		passed,
		measuredMs,
		budgetMs,
		ratio,
		source,
		referenceMs,
		relative,
		summary: passed
			? `perf-budget passed: measured ${Math.round(measuredMs)}ms within ${bound}, ratio ${ratio}`
			: `perf-budget failed: measured ${Math.round(measuredMs)}ms exceeds ${bound}, ratio ${ratio}`,
	};
}
