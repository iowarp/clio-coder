import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCommandResult, EvalRunArtifact, EvalRunRecord } from "../eval/index.js";
import { loadEvalArtifact } from "../eval/index.js";
import { evidenceDirectory, findingsFile } from "./store.js";
import {
	EVIDENCE_VERSION,
	type EvidenceBuildResult,
	type EvidenceCleanTraceRow,
	type EvidenceEvalCommandTraceRow,
	type EvidenceEvalRawTraceRow,
	type EvidenceEvalTraceRow,
	type EvidenceFinding,
	type EvidenceOverview,
	type EvidenceProtectedArtifactsFile,
	type EvidenceReceiptFile,
	type EvidenceTag,
	type EvidenceToolEvent,
} from "./types.js";

const EVAL_EVIDENCE_FILES = [
	"overview.json",
	"transcript.md",
	"trace.raw.jsonl",
	"trace.cleaned.jsonl",
	"tool-events.jsonl",
	"audit-linked.jsonl",
	"receipt.json",
	"protected-artifacts.json",
	"eval-result.json",
	"findings.json",
	"findings.md",
] as const;

const PREVIEW_MAX_CHARS = 240;

export interface BuildEvalEvidenceOptions {
	dataDir: string;
	evalId?: string;
	artifact?: EvalRunArtifact;
}

export async function buildEvalEvidence(options: BuildEvalEvidenceOptions): Promise<EvidenceBuildResult> {
	if (options.evalId !== undefined && options.artifact !== undefined) {
		throw new Error("build eval evidence accepts either evalId or artifact, not both");
	}
	if (options.evalId === undefined && options.artifact === undefined) {
		throw new Error("build eval evidence requires evalId or artifact");
	}
	const artifact = options.artifact ?? (await loadEvalArtifact(options.dataDir, options.evalId ?? ""));
	const evidenceId = evalEvidenceId(artifact.evalId);
	const directory = evidenceDirectory(options.dataDir, evidenceId);
	const toolEventRows = evalToolEvents(artifact);
	const findings = evalFindings(artifact);
	const overview = evalOverview(evidenceId, artifact, findings, toolEventRows);
	await writeEvalEvidenceFiles(directory, artifact, overview, findings, toolEventRows);
	return { evidenceId, directory, overview, findings };
}

export function evalEvidenceId(evalId: string): string {
	return `eval-${sanitizeEvidenceId(evalId)}`;
}

function evalOverview(
	evidenceId: string,
	artifact: EvalRunArtifact,
	findings: ReadonlyArray<EvidenceFinding>,
	toolEventRows: ReadonlyArray<EvidenceToolEvent>,
): EvidenceOverview {
	return {
		version: EVIDENCE_VERSION,
		evidenceId,
		source: { kind: "eval", evalId: artifact.evalId },
		generatedAt: artifact.endedAt,
		runIds: artifact.results.map((result) => result.runId).sort(compareStrings),
		sessionId: null,
		statuses: uniqueStrings(artifact.results.map((result) => (result.pass ? "passed" : "failed"))),
		startedAt: artifact.startedAt,
		endedAt: artifact.endedAt,
		tasks: uniqueStrings(artifact.results.map((result) => result.taskId)),
		cwds: uniqueStrings(artifact.results.map((result) => result.cwd)),
		agentIds: ["eval-local"],
		endpointIds: ["local"],
		runtimeIds: ["subprocess"],
		modelIds: ["none"],
		totals: {
			runs: artifact.results.length,
			receipts: 0,
			toolCalls: toolEventRows.reduce((total, event) => total + event.count, 0),
			toolErrors: toolEventRows.reduce((total, event) => total + event.errors, 0),
			blockedToolCalls: 0,
			sessionEntries: 0,
			auditRows: 0,
			toolEvents: toolEventRows.length,
			linkedToolEvents: 0,
			protectedArtifacts: 0,
			tokens: artifact.summary.tokens,
			costUsd: artifact.summary.costUsd,
			wallTimeMs: artifact.summary.wallTimeMs,
		},
		tags: uniqueTags(findings.map((finding) => finding.tag)),
		files: [...EVAL_EVIDENCE_FILES],
	};
}

function evalFindings(artifact: EvalRunArtifact): EvidenceFinding[] {
	const findings: EvidenceFinding[] = [];
	for (const result of artifact.results) {
		if (result.pass) continue;
		findings.push({
			id: `finding-${String(findings.length + 1).padStart(3, "0")}`,
			severity: "warn",
			tag: tagForEvalResult(result),
			runId: result.runId,
			message: `eval task ${result.taskId} failed with exit ${result.exitCode}${result.failureClass === undefined ? "" : ` (${result.failureClass})`}`,
		});
	}
	return findings;
}

function tagForEvalResult(result: EvalRunRecord): EvidenceTag {
	if (result.failureClass === "timeout") return "timeout";
	if (result.failureClass === "cwd_missing") return "cwd-missing";
	if (result.failureClass === "verifier_failed") return "test-failure";
	return "unknown";
}

function evalToolEvents(artifact: EvalRunArtifact): EvidenceToolEvent[] {
	const events: EvidenceToolEvent[] = [];
	for (const result of artifact.results) {
		for (const command of result.commands) {
			events.push({
				source: "eval-command",
				runId: result.runId,
				sessionId: null,
				tool: `eval.${command.phase}`,
				count: 1,
				ok: command.exitCode === 0 ? 1 : 0,
				errors: command.exitCode === 0 ? 0 : 1,
				blocked: 0,
				totalDurationMs: command.wallTimeMs,
				argsPreview: command.command,
				resultPreview: commandPreview(command),
			});
		}
	}
	return events.sort(compareEvidenceToolEvents);
}

async function writeEvalEvidenceFiles(
	directory: string,
	artifact: EvalRunArtifact,
	overview: EvidenceOverview,
	findings: ReadonlyArray<EvidenceFinding>,
	toolEventRows: ReadonlyArray<EvidenceToolEvent>,
): Promise<void> {
	const emptyProtected: EvidenceProtectedArtifactsFile = { version: EVIDENCE_VERSION, artifacts: [], events: [] };
	const emptyReceipts: EvidenceReceiptFile = { version: EVIDENCE_VERSION, receipts: [] };
	await mkdir(directory, { recursive: true });
	await writeJson(join(directory, "overview.json"), overview);
	await writeFile(join(directory, "transcript.md"), renderEvalTranscript(artifact, overview), "utf8");
	await writeJsonl(join(directory, "trace.raw.jsonl"), rawEvalTraceRows(artifact));
	await writeJsonl(join(directory, "trace.cleaned.jsonl"), cleanedEvalTraceRows(artifact, findings));
	await writeJsonl(join(directory, "tool-events.jsonl"), toolEventRows);
	await writeJsonl(join(directory, "audit-linked.jsonl"), []);
	await writeJson(join(directory, "receipt.json"), emptyReceipts);
	await writeJson(join(directory, "protected-artifacts.json"), emptyProtected);
	await writeJson(join(directory, "eval-result.json"), artifact);
	await writeJson(join(directory, "findings.json"), findingsFile(overview.evidenceId, [...findings]));
	await writeFile(join(directory, "findings.md"), renderFindings(findings), "utf8");
}

function rawEvalTraceRows(artifact: EvalRunArtifact): EvidenceEvalRawTraceRow[] {
	return artifact.results.map((result) => ({
		kind: "eval-result",
		evalId: artifact.evalId,
		runId: result.runId,
		result,
	}));
}

function cleanedEvalTraceRows(
	artifact: EvalRunArtifact,
	findings: ReadonlyArray<EvidenceFinding>,
): EvidenceCleanTraceRow[] {
	const rows: EvidenceCleanTraceRow[] = [];
	for (const result of artifact.results) {
		rows.push(evalTraceRow(artifact.evalId, result));
		for (const command of result.commands) rows.push(evalCommandTraceRow(artifact.evalId, result, command));
	}
	for (const finding of findings) rows.push({ kind: "finding", ...finding });
	return rows;
}

function evalTraceRow(evalId: string, result: EvalRunRecord): EvidenceEvalTraceRow {
	return {
		kind: "eval-result",
		evalId,
		runId: result.runId,
		taskId: result.taskId,
		pass: result.pass,
		exitCode: result.exitCode,
		failureClass: result.failureClass ?? null,
		wallTimeMs: result.wallTimeMs,
		tokens: result.tokens,
		costUsd: result.costUsd,
		cwd: result.cwd,
		tags: result.tags,
		evidenceId: result.evidenceId ?? null,
	};
}

function evalCommandTraceRow(
	evalId: string,
	result: EvalRunRecord,
	command: EvalCommandResult,
): EvidenceEvalCommandTraceRow {
	return {
		kind: "eval-command",
		evalId,
		runId: result.runId,
		taskId: result.taskId,
		phase: command.phase,
		index: command.index,
		command: command.command,
		exitCode: command.exitCode,
		timedOut: command.timedOut,
		wallTimeMs: command.wallTimeMs,
	};
}

function renderEvalTranscript(artifact: EvalRunArtifact, overview: EvidenceOverview): string {
	const lines = [
		`# Evidence ${overview.evidenceId}`,
		"",
		`Source: eval ${artifact.evalId}`,
		`Generated at: ${overview.generatedAt}`,
		`Task file: ${artifact.taskFile}`,
		"",
		"## Eval Summary",
		`- runs: ${artifact.summary.runs}`,
		`- passed: ${artifact.summary.passed}`,
		`- failed: ${artifact.summary.failed}`,
		`- pass rate: ${(artifact.summary.passRate * 100).toFixed(2)}%`,
		`- tokens: ${artifact.summary.tokens}`,
		`- cost USD: ${artifact.summary.costUsd.toFixed(6)}`,
		`- wall time ms: ${artifact.summary.wallTimeMs}`,
		"",
		"## Results",
	];
	for (const result of artifact.results) {
		lines.push(
			`- ${result.runId} task=${result.taskId} pass=${String(result.pass)} exit=${result.exitCode} wall=${result.wallTimeMs}ms`,
		);
		if (result.failureClass !== undefined) lines.push(`  failure: ${result.failureClass}`);
		for (const command of result.commands) {
			lines.push(
				`  ${command.phase}[${command.index}] exit=${command.exitCode} timeout=${String(command.timedOut)} ${command.command}`,
			);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function renderFindings(findings: ReadonlyArray<EvidenceFinding>): string {
	if (findings.length === 0) return "No findings.\n";
	const lines = ["# Findings", ""];
	for (const finding of findings) {
		lines.push(`- ${finding.id} [${finding.severity}] ${finding.tag}: ${finding.message}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, rows: ReadonlyArray<unknown>): Promise<void> {
	await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

function commandPreview(command: EvalCommandResult): string {
	const text = command.stderr.length > 0 ? command.stderr : command.stdout;
	return truncateText(text, PREVIEW_MAX_CHARS);
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function uniqueTags(values: ReadonlyArray<EvidenceTag>): EvidenceTag[] {
	return [...new Set(values)].sort(compareStrings);
}

function compareEvidenceToolEvents(a: EvidenceToolEvent, b: EvidenceToolEvent): number {
	const byRun = compareNullableStrings(a.runId, b.runId);
	if (byRun !== 0) return byRun;
	const byTool = compareStrings(a.tool, b.tool);
	if (byTool !== 0) return byTool;
	const byArgs = compareNullableStrings(a.argsPreview ?? null, b.argsPreview ?? null);
	if (byArgs !== 0) return byArgs;
	return compareNullableStrings(a.resultPreview ?? null, b.resultPreview ?? null);
}

function compareNullableStrings(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	return compareStrings(a, b);
}

function sanitizeEvidenceId(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized.length === 0 ? "unknown" : sanitized;
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}
