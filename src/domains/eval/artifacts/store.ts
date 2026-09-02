import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../../../core/safe-id.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { EvalArtifactV4, EvalTokenAccountingV4 } from "../schema/artifact.js";
import { assertEvalBehaviorReferencesVerdictV1, parseEvalBehaviorVerdictV1 } from "../schema/behavioral.js";
import { parseEvalBehaviorMetricsV1 } from "../schema/behavioral-metrics.js";
import { parseEvalExecutionEnvelopeV1, parseEvalExecutionMatrixDimensionsV1 } from "../schema/execution-envelope.js";
import { parseEvalServingConfigurationV1 } from "../schema/serving.js";
import { parseEvalVerdictEnvelopeV1 } from "../schema/verdict.js";
import { evalRoot } from "../store.js";
import { redactArtifactForStorage } from "./redact.js";

// This is the documented location (docs/architecture/artifact-versions.md's
// Eval Artifact row): <dataDir>/evals/<evalId>.json, flat. The legacy version-1
// shape skills-eval writes lives at evalRoot()/skills-eval/ instead
// (store.ts's evalArtifactPath) so the two writers can never resolve to the
// same file for the same id.
function evalArtifactPathV4(dataDir: string, evalId: string): string {
	assertSafeId(evalId, "eval");
	return join(evalRoot(dataDir), `${evalId}.json`);
}

export async function writeEvalArtifactV4(dataDir: string, artifact: EvalArtifactV4, out?: string): Promise<string> {
	const path =
		out === undefined
			? evalArtifactPathV4(dataDir, artifact.evalId)
			: out.endsWith(".json")
				? out
				: join(out, `${artifact.evalId}.json`);
	safeResourceWrite(path, `${JSON.stringify(redactArtifactForStorage(artifact), null, 2)}\n`, { encoding: "utf8" });
	return path;
}

/**
 * Read only the current explicit-link artifact format; retired shapes are
 * rejected. An id with no artifact under the store root is named as such: the
 * caller supplied an id, not a path, so the path node:fs would have quoted is
 * not the thing they can correct.
 */
export async function loadEvalArtifactV4(dataDir: string, evalId: string): Promise<EvalArtifactV4> {
	let raw: string;
	try {
		raw = await readFile(evalArtifactPathV4(dataDir, evalId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`eval artifact not found: ${evalId}`);
		throw error;
	}
	return parseEvalArtifactV4(JSON.parse(raw) as unknown, evalId);
}

export function parseEvalArtifactV4(value: unknown, source: string): EvalArtifactV4 {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.version !== 4) throw new Error(`${source}.version: expected current version 4`);
	const summary = asRecord(value.summary, `${source}.summary`);
	const matrix = asRecord(value.matrix, `${source}.matrix`);
	const suite = asRecord(value.suite, `${source}.suite`);
	const servingConfiguration =
		value.servingConfiguration === undefined
			? undefined
			: parseEvalServingConfigurationV1(value.servingConfiguration, `${source}.servingConfiguration`);
	const aggregates =
		value.aggregates === undefined
			? undefined
			: (readArray(value, source, "aggregates") as NonNullable<EvalArtifactV4["aggregates"]>);
	const clioCoder = asRecord(value.clioCoder ?? value.clio, `${source}.clioCoder`);
	return {
		version: 4,
		evalId: readString(value, source, "evalId"),
		suite: { id: readString(suite, `${source}.suite`, "id"), hash: readString(suite, `${source}.suite`, "hash") },
		clioCoder: {
			version: readString(clioCoder, `${source}.clioCoder`, "version"),
			commit: readNullableString(clioCoder, `${source}.clioCoder`, "commit"),
			entry: readString(clioCoder, `${source}.clioCoder`, "entry"),
		},
		environment: {
			platform: readString(asRecord(value.environment, `${source}.environment`), `${source}.environment`, "platform"),
			node: readString(asRecord(value.environment, `${source}.environment`), `${source}.environment`, "node"),
		},
		matrix: {
			target: readString(matrix, `${source}.matrix`, "target"),
			model: readNullableString(matrix, `${source}.matrix`, "model"),
			thinking: readNullableString(matrix, `${source}.matrix`, "thinking"),
			...(matrix.dimensions === undefined
				? {}
				: { dimensions: parseEvalExecutionMatrixDimensionsV1(matrix.dimensions, `${source}.matrix.dimensions`) }),
		},
		...(servingConfiguration === undefined ? {} : { servingConfiguration }),
		summary: {
			runs: readNumber(summary, `${source}.summary`, "runs"),
			passed: readNumber(summary, `${source}.summary`, "passed"),
			failed: readNumber(summary, `${source}.summary`, "failed"),
			passRate: readNumber(summary, `${source}.summary`, "passRate"),
			tokens: parseTokenAccounting(summary.tokens, `${source}.summary.tokens`),
			wallTimeMs: readNumber(summary, `${source}.summary`, "wallTimeMs"),
		},
		...(aggregates === undefined ? {} : { aggregates }),
		results: readArray(value, source, "results").map((entry, index) => parseResult(entry, `${source}.results[${index}]`)),
	};
}

/**
 * An unmeasured artifact must carry no counts. Reading counts beside
 * `measured: false` is a contradiction rather than a value to prefer, so it is
 * refused instead of being resolved silently.
 */
function parseTokenAccounting(value: unknown, source: string): EvalTokenAccountingV4 {
	const record = asRecord(value, source);
	const measured = readBoolean(record, source, "measured");
	const runs = readNumber(record, source, "runs");
	const measuredRuns = readNumber(record, source, "measuredRuns");
	const countFields = ["input", "output", "total", "cacheRead", "cacheWrite"] as const;
	if (!measured) {
		if (measuredRuns !== 0) throw new Error(`${source}.measuredRuns: expected 0 when unmeasured`);
		const present = countFields.filter((field) => field in record);
		if (present.length > 0) throw new Error(`${source}: unmeasured accounting carries no counts (${present.join(", ")})`);
		return { measured: false, runs, measuredRuns: 0 };
	}
	if (measuredRuns <= 0) throw new Error(`${source}.measuredRuns: expected a positive count when measured`);
	return {
		measured: true,
		runs,
		measuredRuns,
		input: readNumber(record, source, "input"),
		output: readNumber(record, source, "output"),
		total: readNumber(record, source, "total"),
		cacheRead: readNumber(record, source, "cacheRead"),
		cacheWrite: readNumber(record, source, "cacheWrite"),
	};
}

function parseResult(value: unknown, source: string): EvalArtifactV4["results"][number] {
	const record = asRecord(value, source);
	const target = asRecord(record.target, `${source}.target`);
	const verdict =
		record.verdict === undefined ? undefined : parseEvalVerdictEnvelopeV1(record.verdict, `${source}.verdict`);
	const behavioral =
		record.behavioral === undefined ? undefined : parseEvalBehaviorVerdictV1(record.behavioral, `${source}.behavioral`);
	const behavioralMetrics =
		record.behavioralMetrics === undefined
			? undefined
			: parseEvalBehaviorMetricsV1(record.behavioralMetrics, `${source}.behavioralMetrics`);
	const executionEnvelope =
		record.executionEnvelope === undefined
			? undefined
			: parseEvalExecutionEnvelopeV1(record.executionEnvelope, `${source}.executionEnvelope`);
	if (behavioral !== undefined && verdict === undefined) {
		throw new Error(`${source}.behavioral: sibling document requires a verdict`);
	}
	if (behavioral !== undefined && verdict !== undefined) {
		assertEvalBehaviorReferencesVerdictV1(behavioral, verdict, `${source}.behavioral`);
	}
	if (behavioralMetrics !== undefined) {
		if (behavioral === undefined) throw new Error(`${source}.behavioralMetrics: requires a behavioral verdict`);
		if (behavioralMetrics.scenarioId !== readString(record, source, "taskId")) {
			throw new Error(`${source}.behavioralMetrics.scenarioId: conflicts with result taskId`);
		}
		if (
			behavioralMetrics.target.id !== readString(target, `${source}.target`, "id") ||
			behavioralMetrics.target.model !== readNullableString(target, `${source}.target`, "model")
		) {
			throw new Error(`${source}.behavioralMetrics.target: conflicts with result target`);
		}
	}
	if (executionEnvelope !== undefined) {
		if (behavioral === undefined) throw new Error(`${source}.executionEnvelope: requires a behavioral verdict`);
		if (
			executionEnvelope.target !== readString(target, `${source}.target`, "id") ||
			executionEnvelope.corpus.id !== behavioral.corpus.id ||
			executionEnvelope.corpus.version !== behavioral.corpus.version
		) {
			throw new Error(`${source}.executionEnvelope: conflicts with result target or behavioral corpus`);
		}
	}
	return {
		assignmentId: readNullableString(record, source, "assignmentId"),
		terminalReceiptDigest: readNullableDigest(record, source, "terminalReceiptDigest"),
		taskId: readString(record, source, "taskId"),
		repeatIndex: readNumber(record, source, "repeatIndex"),
		target: {
			id: readString(target, `${source}.target`, "id"),
			model: readNullableString(target, `${source}.target`, "model"),
			thinking: readNullableString(target, `${source}.target`, "thinking"),
		},
		pass: readBoolean(record, source, "pass"),
		failureClass: readNullableString(record, source, "failureClass"),
		metrics: asRecord(record.metrics, `${source}.metrics`) as Record<string, number | string | boolean | null>,
		artifacts: asRecord(record.artifacts, `${source}.artifacts`) as Record<string, string | string[] | null>,
		...(verdict === undefined ? {} : { verdict }),
		...(behavioral === undefined ? {} : { behavioral }),
		...(behavioralMetrics === undefined ? {} : { behavioralMetrics }),
		...(executionEnvelope === undefined ? {} : { executionEnvelope }),
	};
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
	if (isRecord(value)) return value;
	throw new Error(`${source}: expected object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readNullableString(record: Record<string, unknown>, source: string, field: string): string | null {
	const value = record[field];
	if (value === null) return null;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string or null`);
	return value;
}

function readNullableDigest(record: Record<string, unknown>, source: string, field: string): string | null {
	const value = readNullableString(record, source, field);
	if (value !== null && !/^[0-9a-f]{64}$/u.test(value))
		throw new Error(`${source}.${field}: expected sha256 digest or null`);
	return value;
}

function readNumber(record: Record<string, unknown>, source: string, field: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${field}: expected number`);
	return value;
}

function readBoolean(record: Record<string, unknown>, source: string, field: string): boolean {
	const value = record[field];
	if (typeof value !== "boolean") throw new Error(`${source}.${field}: expected boolean`);
	return value;
}

function readArray(record: Record<string, unknown>, source: string, field: string): unknown[] {
	const value = record[field];
	if (!Array.isArray(value)) throw new Error(`${source}.${field}: expected array`);
	return value;
}
