import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { EvalRunArtifact, EvalSummary } from "./types.js";

export function renderEvalReport(artifact: EvalRunArtifact, artifactPath?: string): string {
	const lines = [
		`eval: ${artifact.evalId}`,
		`task file: ${artifact.taskFile}`,
		`repeat: ${artifact.repeat}`,
		...renderSummaryLines(artifact.summary),
	];
	if (artifactPath !== undefined) lines.splice(2, 0, `artifact: ${artifactPath}`);
	const evidenceIds = uniqueEvidenceIds(artifact);
	if (evidenceIds.length > 0) {
		const insertAt = artifactPath === undefined ? 2 : 3;
		lines.splice(insertAt, 0, `evidence: ${evidenceIds.join(", ")}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderSummaryLines(summary: EvalSummary): string[] {
	return [
		`runs: ${summary.runs}`,
		`passed: ${summary.passed}`,
		`failed: ${summary.failed}`,
		`pass rate: ${formatPercent(summary.passRate)}`,
		`tokens: ${summary.tokens}`,
		`cost USD: ${formatCost(summary.costUsd)}`,
		`wall time ms: ${summary.wallTimeMs}`,
		`receipt-backed runs: ${summary.harness.receiptCount}`,
		`tool calls: ${summary.harness.toolCalls}`,
		`retries: ${summary.harness.retries}`,
		`safety blocks: ${summary.harness.safetyBlocks}`,
		`correction latency ms: ${summary.harness.correctionLatencyMs}`,
		`validation evidence: ${summary.harness.validationEvidence}`,
		`failure classes: ${formatFailureClasses(summary)}`,
	];
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function formatCost(value: number): string {
	return value.toFixed(6);
}

function formatFailureClasses(summary: EvalSummary): string {
	if (summary.failureClasses.length === 0) return "none";
	return summary.failureClasses.map((entry) => `${entry.failureClass}=${entry.count}`).join(", ");
}

function uniqueEvidenceIds(artifact: EvalRunArtifact): string[] {
	return [
		...new Set(artifact.results.flatMap((result) => (result.evidenceId === undefined ? [] : [result.evidenceId]))),
	].sort((left, right) => left.localeCompare(right));
}

export function renderSweJsonl(artifact: EvalRunArtifact): string {
	const lines: string[] = [];
	for (const run of artifact.results) {
		const entry = {
			instance_id: run.taskId,
			model_patch: modelPatchForRun(artifact, run), // Local eval artifacts store no patch unless a linked receipt or evidence file provides one.
			model_name_or_path: artifact.evalId,
			status: run.pass ? "pass" : "fail",
			pass: run.pass,
			tokens: run.tokens,
			wall_time_ms: run.wallTimeMs,
			cost_usd: run.costUsd,
		};
		lines.push(JSON.stringify(entry));
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

type EvalResultLike = EvalRunArtifact["results"][number];

function modelPatchForRun(artifact: EvalRunArtifact, run: EvalResultLike): string {
	const embeddedPatch = patchFromUnknown(run);
	if (embeddedPatch !== undefined) return embeddedPatch;
	const linkedPatch = patchFromLinkedFiles(run, process.cwd());
	if (linkedPatch !== undefined) return linkedPatch;
	const receiptPatch = patchFromReceipt(run);
	if (receiptPatch !== undefined) return receiptPatch;
	const evidencePatch = patchFromEvidence(artifact, run);
	return evidencePatch ?? "";
}

function patchFromReceipt(run: EvalResultLike): string | undefined {
	if (run.receiptPath === undefined) return undefined;
	const receipt = readJsonIfExists(run.receiptPath);
	const direct = patchFromUnknown(receipt);
	if (direct !== undefined) return direct;
	const linkedPatch = patchFromLinkedFiles(receipt, dirname(run.receiptPath));
	if (linkedPatch !== undefined) return linkedPatch;
	const base = basename(run.receiptPath, extname(run.receiptPath));
	for (const candidate of [`${base}.patch`, `${base}.diff`, `${run.runId}.patch`, `${run.runId}.diff`]) {
		const text = readNonEmptyText(join(dirname(run.receiptPath), candidate));
		if (text !== undefined) return text;
	}
	return undefined;
}

function patchFromEvidence(artifact: EvalRunArtifact, run: EvalResultLike): string | undefined {
	for (const directory of evidenceDirectories(artifact, run)) {
		for (const candidate of [
			"model.patch",
			"model.diff",
			"model_patch.txt",
			"patch.diff",
			"patch.json",
			"receipt.json",
			"eval-result.json",
		]) {
			const path = join(directory, candidate);
			if (candidate.endsWith(".json")) {
				const patch = patchFromUnknown(readJsonIfExists(path));
				if (patch !== undefined) return patch;
				continue;
			}
			const text = readNonEmptyText(path);
			if (text !== undefined) return text;
		}
	}
	return undefined;
}

function evidenceDirectories(artifact: EvalRunArtifact, run: EvalResultLike): string[] {
	const directories: string[] = [];
	const rawRun = asRecord(run) ?? {};
	for (const field of ["evidencePath", "evidenceDirectory", "evidence_dir"]) {
		const value = stringField(rawRun, field);
		if (value !== undefined) directories.push(resolve(value));
	}
	const evidenceId = run.evidenceId;
	if (evidenceId !== undefined) {
		if (isAbsolute(evidenceId)) directories.push(evidenceId);
		if (run.receiptPath !== undefined) {
			const stateDir = dirname(dirname(run.receiptPath));
			directories.push(join(stateDir, "evidence", evidenceId));
			directories.push(join(dirname(stateDir), "data", "evidence", evidenceId));
		}
		const artifactRecord = asRecord(artifact) ?? {};
		for (const field of ["artifactPath", "path"]) {
			const path = stringField(artifactRecord, field);
			if (path !== undefined) directories.push(join(dirname(path), "..", "evidence", evidenceId));
		}
	}
	return [...new Set(directories)];
}

function patchFromLinkedFiles(value: unknown, baseDir: string): string | undefined {
	for (const patchPath of patchPathsFromUnknown(value)) {
		const target = isAbsolute(patchPath) ? patchPath : resolve(baseDir, patchPath);
		const text = readNonEmptyText(target);
		if (text !== undefined) return text;
	}
	return undefined;
}

function patchFromUnknown(value: unknown): string | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	for (const field of ["model_patch", "modelPatch", "patch", "diff", "gitDiff"]) {
		const patch = stringField(record, field);
		if (patch !== undefined && patch.trim().length > 0) return patch;
	}
	for (const field of ["evidence", "artifact", "result"]) {
		const patch = patchFromUnknown(record[field]);
		if (patch !== undefined) return patch;
	}
	return undefined;
}

function patchPathsFromUnknown(value: unknown): string[] {
	const record = asRecord(value);
	if (record === undefined) return [];
	const paths: string[] = [];
	for (const field of ["modelPatchPath", "model_patch_path", "patchPath", "patch_path", "diffPath", "diff_path"]) {
		const path = stringField(record, field);
		if (path !== undefined && path.trim().length > 0) paths.push(path);
	}
	for (const field of ["evidence", "artifact", "result"]) {
		paths.push(...patchPathsFromUnknown(record[field]));
	}
	return paths;
}

function readJsonIfExists(path: string): unknown {
	const text = readNonEmptyText(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function readNonEmptyText(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8");
		return text.trim().length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}
