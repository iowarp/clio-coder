import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../../../core/safe-id.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { EvalArtifactV2 } from "../schema/artifact.js";
import { evalRoot, loadEvalArtifact } from "../store.js";
import type { EvalRunArtifact } from "../types.js";
import { redactArtifactForStorage } from "./redact.js";

export type LoadedEvalArtifactAny = EvalArtifactV2 | EvalRunArtifact;

export function evalArtifactPathV2(dataDir: string, evalId: string): string {
	assertSafeId(evalId, "eval");
	return join(evalRoot(dataDir), `${evalId}.json`);
}

export async function writeEvalArtifactV2(dataDir: string, artifact: EvalArtifactV2, out?: string): Promise<string> {
	const path =
		out === undefined
			? evalArtifactPathV2(dataDir, artifact.evalId)
			: out.endsWith(".json")
				? out
				: join(out, `${artifact.evalId}.json`);
	safeResourceWrite(path, `${JSON.stringify(redactArtifactForStorage(artifact), null, 2)}\n`, { encoding: "utf8" });
	return path;
}

export async function loadEvalArtifactAny(dataDir: string, evalId: string): Promise<LoadedEvalArtifactAny> {
	const raw = await readFile(evalArtifactPathV2(dataDir, evalId), "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	if (parsed.version === 2) return parseEvalArtifactV2(parsed, evalId);
	return loadEvalArtifact(dataDir, evalId);
}

export function parseEvalArtifactV2(value: unknown, source: string): EvalArtifactV2 {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.version !== 2) throw new Error(`${source}.version: expected 2`);
	const summary = asRecord(value.summary, `${source}.summary`);
	const tokens = asRecord(summary.tokens, `${source}.summary.tokens`);
	const matrix = asRecord(value.matrix, `${source}.matrix`);
	const suite = asRecord(value.suite, `${source}.suite`);
	return {
		version: 2,
		evalId: readString(value, source, "evalId"),
		suite: { id: readString(suite, `${source}.suite`, "id"), hash: readString(suite, `${source}.suite`, "hash") },
		clio: {
			version: readString(asRecord(value.clio, `${source}.clio`), `${source}.clio`, "version"),
			commit: readNullableString(asRecord(value.clio, `${source}.clio`), `${source}.clio`, "commit"),
			entry: readString(asRecord(value.clio, `${source}.clio`), `${source}.clio`, "entry"),
		},
		environment: {
			platform: readString(asRecord(value.environment, `${source}.environment`), `${source}.environment`, "platform"),
			node: readString(asRecord(value.environment, `${source}.environment`), `${source}.environment`, "node"),
		},
		matrix: {
			target: readString(matrix, `${source}.matrix`, "target"),
			model: readNullableString(matrix, `${source}.matrix`, "model"),
			thinking: readNullableString(matrix, `${source}.matrix`, "thinking"),
		},
		summary: {
			runs: readNumber(summary, `${source}.summary`, "runs"),
			passed: readNumber(summary, `${source}.summary`, "passed"),
			failed: readNumber(summary, `${source}.summary`, "failed"),
			passRate: readNumber(summary, `${source}.summary`, "passRate"),
			tokens: {
				input: readNumber(tokens, `${source}.summary.tokens`, "input"),
				output: readNumber(tokens, `${source}.summary.tokens`, "output"),
				total: readNumber(tokens, `${source}.summary.tokens`, "total"),
				cacheRead: readNumber(tokens, `${source}.summary.tokens`, "cacheRead"),
				cacheWrite: readNumber(tokens, `${source}.summary.tokens`, "cacheWrite"),
			},
			wallTimeMs: readNumber(summary, `${source}.summary`, "wallTimeMs"),
		},
		results: readArray(value, source, "results").map((entry, index) => parseResult(entry, `${source}.results[${index}]`)),
	};
}

function parseResult(value: unknown, source: string): EvalArtifactV2["results"][number] {
	const record = asRecord(value, source);
	return {
		taskId: readString(record, source, "taskId"),
		repeatIndex: readNumber(record, source, "repeatIndex"),
		pass: readBoolean(record, source, "pass"),
		failureClass: readNullableString(record, source, "failureClass"),
		metrics: asRecord(record.metrics, `${source}.metrics`) as Record<string, number | string | boolean | null>,
		artifacts: asRecord(record.artifacts, `${source}.artifacts`) as Record<string, string | string[] | null>,
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
