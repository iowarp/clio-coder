import { readFileSync } from "node:fs";
import type { EvalArtifactV4 } from "../schema/artifact.js";

export const EVAL_BASELINE_SCHEMA_V1 = "clio-coder.eval.baseline.v1";

export type EvalBaselineValue = number | string | boolean | null;

export interface EvalBaselineFileV1 {
	schema: typeof EVAL_BASELINE_SCHEMA_V1;
	suite: string;
	recordedAt: string;
	clioCoder: { version: string; commit: string | null };
	/** The metric keys this baseline pins, copied from the suite at record time. */
	pin: string[];
	/** Pinned values keyed by task id, then by metric key. */
	tasks: Record<string, Record<string, EvalBaselineValue>>;
}

export type EvalBaselineFindingKind =
	/** A pinned metric resolved to a different value than the recorded one. */
	| "changed"
	/** The baseline records this task but the run produced no result for it. */
	| "missing"
	/** The run produced this task but the baseline does not record it. */
	| "new"
	/** The task ran but a pinned metric was absent from its result. */
	| "unmeasured"
	/** Repeats of one task disagreed on a pinned metric, so no single value can be pinned. */
	| "nondeterministic";

export interface EvalBaselineFinding {
	kind: EvalBaselineFindingKind;
	taskId: string;
	/** Absent for whole-task findings ("missing", "new"). */
	metric?: string;
	recorded?: EvalBaselineValue;
	actual?: EvalBaselineValue;
	/** Every distinct value seen across repeats, for "nondeterministic". */
	observed?: EvalBaselineValue[];
}

export interface EvalBaselineCheckResult {
	pass: boolean;
	/** Findings that fail the check: changed, missing, unmeasured, nondeterministic. */
	failures: EvalBaselineFinding[];
	/** Tasks present in the run but not the baseline. Reported, never fatal. */
	notices: EvalBaselineFinding[];
	/** Tasks whose every pinned metric matched. */
	matched: number;
	/** True when the suite's pin list no longer matches the recorded one. */
	pinDrift: boolean;
}

export class EvalBaselineFileError extends Error {
	constructor(path: string, detail: string) {
		super(`invalid eval baseline ${path}: ${detail}`);
		this.name = "EvalBaselineFileError";
	}
}

export function loadEvalBaselineFile(path: string): EvalBaselineFileV1 {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new EvalBaselineFileError(
				path,
				"not recorded yet; run `clio-coder eval baseline record --suite <suite.yaml>`",
			);
		}
		throw new EvalBaselineFileError(path, error instanceof Error ? error.message : String(error));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new EvalBaselineFileError(path, error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(parsed)) throw new EvalBaselineFileError(path, "expected object");
	if (parsed.schema !== EVAL_BASELINE_SCHEMA_V1) {
		throw new EvalBaselineFileError(path, `expected schema ${EVAL_BASELINE_SCHEMA_V1}`);
	}
	if (typeof parsed.suite !== "string" || parsed.suite.length === 0) {
		throw new EvalBaselineFileError(path, "suite must be a non-empty string");
	}
	if (!isRecord(parsed.tasks)) throw new EvalBaselineFileError(path, "tasks must be an object");
	const tasks: Record<string, Record<string, EvalBaselineValue>> = {};
	for (const [taskId, entry] of Object.entries(parsed.tasks)) {
		if (!isRecord(entry)) throw new EvalBaselineFileError(path, `tasks.${taskId} must be an object`);
		const metrics: Record<string, EvalBaselineValue> = {};
		for (const [metric, value] of Object.entries(entry)) {
			if (!isBaselineValue(value)) {
				throw new EvalBaselineFileError(path, `tasks.${taskId}.${metric} must be a number, string, boolean, or null`);
			}
			metrics[metric] = value;
		}
		tasks[taskId] = metrics;
	}
	return {
		schema: EVAL_BASELINE_SCHEMA_V1,
		suite: parsed.suite,
		recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
		clioCoder: readProvenance(parsed.clioCoder),
		pin: Array.isArray(parsed.pin) ? parsed.pin.filter((entry): entry is string => typeof entry === "string") : [],
		tasks,
	};
}

/**
 * Reduce an artifact to one pinned value per task and metric. Repeats of the
 * same task must agree: a metric that differs across repeats is not a property
 * of the harness, it is noise, and pinning either reading would make the next
 * check fail for a reason nobody can act on. Disagreement is reported instead.
 */
export function buildEvalBaseline(
	artifact: EvalArtifactV4,
	pin: ReadonlyArray<string>,
): { tasks: Record<string, Record<string, EvalBaselineValue>>; findings: EvalBaselineFinding[] } {
	const findings: EvalBaselineFinding[] = [];
	const tasks: Record<string, Record<string, EvalBaselineValue>> = {};
	for (const [taskId, observations] of observationsByTask(artifact, pin)) {
		const metrics: Record<string, EvalBaselineValue> = {};
		for (const metric of pin) {
			const seen = observations.get(metric) ?? [];
			if (seen.length === 0) {
				findings.push({ kind: "unmeasured", taskId, metric });
				continue;
			}
			const distinct = distinctValues(seen);
			if (distinct.length > 1) {
				findings.push({ kind: "nondeterministic", taskId, metric, observed: distinct });
				continue;
			}
			metrics[metric] = distinct[0] ?? null;
		}
		tasks[taskId] = metrics;
	}
	return { tasks: sortedTasks(tasks), findings };
}

export function checkEvalBaseline(
	artifact: EvalArtifactV4,
	baseline: EvalBaselineFileV1,
	pin: ReadonlyArray<string>,
): EvalBaselineCheckResult {
	const failures: EvalBaselineFinding[] = [];
	const notices: EvalBaselineFinding[] = [];
	let matched = 0;
	const observed = observationsByTask(artifact, pin);
	for (const [taskId, recorded] of Object.entries(baseline.tasks)) {
		const observations = observed.get(taskId);
		if (observations === undefined) {
			failures.push({ kind: "missing", taskId });
			continue;
		}
		let clean = true;
		for (const metric of pin) {
			const seen = observations.get(metric) ?? [];
			if (seen.length === 0) {
				failures.push({ kind: "unmeasured", taskId, metric, recorded: recorded[metric] ?? null });
				clean = false;
				continue;
			}
			const distinct = distinctValues(seen);
			if (distinct.length > 1) {
				failures.push({ kind: "nondeterministic", taskId, metric, recorded: recorded[metric] ?? null, observed: distinct });
				clean = false;
				continue;
			}
			const actual = distinct[0] ?? null;
			if (!(metric in recorded)) {
				failures.push({ kind: "unmeasured", taskId, metric, actual });
				clean = false;
				continue;
			}
			if (actual !== recorded[metric]) {
				failures.push({ kind: "changed", taskId, metric, recorded: recorded[metric] ?? null, actual });
				clean = false;
			}
		}
		if (clean) matched += 1;
	}
	for (const taskId of observed.keys()) {
		if (taskId in baseline.tasks) continue;
		notices.push({ kind: "new", taskId });
	}
	const pinDrift = baseline.pin.length > 0 && !sameStrings(baseline.pin, pin);
	return { pass: failures.length === 0, failures, notices, matched, pinDrift };
}

export function renderEvalBaselineFinding(finding: EvalBaselineFinding): string {
	const at = finding.metric === undefined ? finding.taskId : `${finding.taskId} ${finding.metric}`;
	switch (finding.kind) {
		case "changed":
			return `  ${at}: ${JSON.stringify(finding.recorded)} -> ${JSON.stringify(finding.actual)}\n`;
		case "missing":
			return `  ${at}: recorded in baseline, absent from this run\n`;
		case "new":
			return `  ${at}: ran but not recorded; re-record to pin it\n`;
		case "unmeasured":
			return `  ${at}: pinned metric not reported by this run\n`;
		case "nondeterministic":
			return `  ${at}: repeats disagree ${JSON.stringify(finding.observed)}\n`;
	}
}

/**
 * Stable, diff-friendly serialization: sorted keys, tab indent and a trailing
 * newline, so a recorded value moving shows as one changed line. The pin list
 * is written on one line because the repository formatter collapses short
 * arrays, and a file the formatter rewrites is a file nobody can re-record
 * without a lint failure.
 */
export function serializeEvalBaseline(file: EvalBaselineFileV1): string {
	const head = JSON.stringify(
		{ schema: file.schema, suite: file.suite, recordedAt: file.recordedAt, clioCoder: file.clioCoder },
		null,
		"\t",
	)
		.split("\n")
		.slice(0, -1);
	const body = JSON.stringify({ tasks: sortedTasks(file.tasks) }, null, "\t")
		.split("\n")
		.slice(1);
	const pin = `\t"pin": [${file.pin.map((key) => JSON.stringify(key)).join(", ")}],`;
	return `${[...head.slice(0, -1), `${head.at(-1) ?? ""},`, pin, ...body].join("\n")}\n`;
}

function observationsByTask(
	artifact: EvalArtifactV4,
	pin: ReadonlyArray<string>,
): Map<string, Map<string, EvalBaselineValue[]>> {
	const byTask = new Map<string, Map<string, EvalBaselineValue[]>>();
	for (const result of artifact.results) {
		let metrics = byTask.get(result.taskId);
		if (metrics === undefined) {
			metrics = new Map();
			byTask.set(result.taskId, metrics);
		}
		for (const metric of pin) {
			const value = result.metrics[metric];
			if (value === undefined) continue;
			const bucket = metrics.get(metric) ?? [];
			bucket.push(value);
			metrics.set(metric, bucket);
		}
	}
	return byTask;
}

function distinctValues(values: ReadonlyArray<EvalBaselineValue>): EvalBaselineValue[] {
	const seen: EvalBaselineValue[] = [];
	for (const value of values) if (!seen.includes(value)) seen.push(value);
	return seen;
}

function sortedTasks(
	tasks: Readonly<Record<string, Record<string, EvalBaselineValue>>>,
): Record<string, Record<string, EvalBaselineValue>> {
	const out: Record<string, Record<string, EvalBaselineValue>> = {};
	for (const taskId of Object.keys(tasks).sort()) {
		const metrics = tasks[taskId] ?? {};
		const sorted: Record<string, EvalBaselineValue> = {};
		for (const metric of Object.keys(metrics).sort()) sorted[metric] = metrics[metric] ?? null;
		out[taskId] = sorted;
	}
	return out;
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	const a = [...left].sort();
	const b = [...right].sort();
	return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function readProvenance(value: unknown): { version: string; commit: string | null } {
	if (!isRecord(value)) return { version: "unknown", commit: null };
	return {
		version: typeof value.version === "string" ? value.version : "unknown",
		commit: typeof value.commit === "string" ? value.commit : null,
	};
}

function isBaselineValue(value: unknown): value is EvalBaselineValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
