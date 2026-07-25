import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEnvelope, RunReceipt, ToolCallStat } from "../dispatch/index.js";
import { readGateDecisionArtifactsForRunIds } from "../dispatch/index.js";
import { redactArtifactForStorage } from "../eval/artifacts/redact.js";
import type { EvalCommandResult, EvalRunArtifact, EvalRunRecord } from "../eval/index.js";
import { loadEvalArtifact } from "../eval/index.js";
import { evidenceDirectory, findingsFile } from "./store.js";
import {
	EVIDENCE_VERSION,
	type EvidenceAuditLinkedRow,
	type EvidenceBuildResult,
	type EvidenceCleanTraceRow,
	type EvidenceEvalCommandTraceRow,
	type EvidenceEvalRawTraceRow,
	type EvidenceEvalTraceRow,
	type EvidenceFinding,
	type EvidenceGateDecisionsFile,
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
	"gate-decisions.json",
	"protected-artifacts.json",
	"eval-result.json",
	"findings.json",
	"findings.md",
] as const;

const PREVIEW_MAX_CHARS = 240;

export interface BuildEvalEvidenceOptions {
	dataDir: string;
	stateDir?: string;
	evalId?: string;
	artifact?: EvalRunArtifact;
	/**
	 * Extra file names the caller writes into the bundle directory after the
	 * build (for example a per-eval `skill-eval.json` detail sidecar). They are
	 * appended to `overview.files` so a consumer enumerating the overview learns
	 * they exist; the caller is still responsible for writing them.
	 */
	sidecars?: ReadonlyArray<string>;
}

interface EvalLinkedRuns {
	runSources: Array<{ envelope: RunEnvelope; receipt: RunReceipt | null }>;
	sessionEntries: number;
	auditRows: EvidenceAuditLinkedRow[];
	toolEvents: EvidenceToolEvent[];
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
	const linkedRuns =
		options.stateDir === undefined ? emptyEvalLinkedRuns() : await linkEvalRuns(options.stateDir, artifact);
	const toolEventRows = [...evalToolEvents(artifact), ...linkedRuns.toolEvents].sort(compareEvidenceToolEvents);
	const findings = evalFindings(artifact);
	const overview = evalOverview(evidenceId, artifact, findings, toolEventRows, linkedRuns, options.sidecars);
	const gateDecisions: EvidenceGateDecisionsFile = {
		version: EVIDENCE_VERSION,
		evidenceId,
		decisions:
			options.stateDir === undefined
				? []
				: readGateDecisionArtifactsForRunIds(
						new Set(linkedRuns.runSources.map((source) => source.envelope.id)),
						options.stateDir,
					).map((entry) => entry.artifact),
	};
	await writeEvalEvidenceFiles(directory, artifact, overview, findings, toolEventRows, linkedRuns, gateDecisions);
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
	linkedRuns: EvalLinkedRuns,
	sidecars: ReadonlyArray<string> = [],
): EvidenceOverview {
	const envelopes = linkedRuns.runSources.map((source) => source.envelope);
	const receipts = linkedRuns.runSources.flatMap((source) => (source.receipt === null ? [] : [source.receipt]));
	const receiptToolStats = receipts.flatMap((receipt) => receipt.toolStats);
	const linkedToolEvents = linkedRuns.toolEvents.length;
	return {
		version: EVIDENCE_VERSION,
		evidenceId,
		source: { kind: "eval", evalId: artifact.evalId },
		generatedAt: artifact.endedAt,
		runIds:
			envelopes.length > 0
				? uniqueStrings(envelopes.map((envelope) => envelope.id))
				: artifact.results.map((result) => result.runId).sort(compareStrings),
		sessionId:
			uniqueStrings(envelopes.flatMap((envelope) => (envelope.sessionId === null ? [] : [envelope.sessionId])))[0] ?? null,
		statuses:
			envelopes.length > 0
				? uniqueStrings(envelopes.map((envelope) => envelope.status))
				: uniqueStrings(artifact.results.map((result) => (result.pass ? "passed" : "failed"))),
		startedAt: artifact.startedAt,
		endedAt: artifact.endedAt,
		tasks: uniqueStrings(artifact.results.map((result) => result.taskId)),
		cwds: uniqueStrings(artifact.results.map((result) => result.cwd)),
		agentIds: envelopes.length > 0 ? uniqueStrings(envelopes.map((envelope) => envelope.agentId)) : ["eval-local"],
		targetIds: envelopes.length > 0 ? uniqueStrings(envelopes.map((envelope) => envelope.targetId)) : ["local"],
		runtimeIds: envelopes.length > 0 ? uniqueStrings(envelopes.map((envelope) => envelope.runtimeId)) : ["local"],
		modelIds: envelopes.length > 0 ? uniqueStrings(envelopes.map((envelope) => envelope.wireModelId)) : ["none"],
		totals: {
			runs: envelopes.length > 0 ? envelopes.length : artifact.results.length,
			receipts: Math.max(artifact.summary.harness.receiptCount, receipts.length),
			toolCalls: Math.max(
				artifact.summary.harness.toolCalls,
				receipts.reduce((total, receipt) => total + receipt.toolCalls, 0),
				toolEventRows.reduce((total, event) => total + event.count, 0),
			),
			toolErrors: Math.max(
				receiptToolStats.reduce((total, stat) => total + stat.errors, 0),
				toolEventRows.reduce((total, event) => total + event.errors, 0),
			),
			blockedToolCalls: Math.max(
				artifact.summary.harness.safetyBlocks,
				receiptToolStats.reduce((total, stat) => total + stat.blocked, 0),
			),
			sessionEntries: linkedRuns.sessionEntries,
			auditRows: linkedRuns.auditRows.length,
			toolEvents: toolEventRows.length,
			linkedToolEvents,
			protectedArtifacts: 0,
			tokens: Math.max(
				artifact.summary.tokens,
				receipts.reduce((total, receipt) => total + receipt.tokenCount, 0),
			),
			costUsd: Math.max(
				artifact.summary.costUsd,
				receipts.reduce((total, receipt) => total + receipt.costUsd, 0),
			),
			wallTimeMs: artifact.summary.wallTimeMs,
		},
		tags: uniqueTags(findings.map((finding) => finding.tag)),
		files: [...EVAL_EVIDENCE_FILES, ...sidecars],
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
	linkedRuns: EvalLinkedRuns,
	gateDecisions: EvidenceGateDecisionsFile,
): Promise<void> {
	const emptyProtected: EvidenceProtectedArtifactsFile = { version: EVIDENCE_VERSION, artifacts: [], events: [] };
	const receiptsFile: EvidenceReceiptFile = {
		version: EVIDENCE_VERSION,
		receipts: linkedRuns.runSources.flatMap((source) => (source.receipt === null ? [] : [source.receipt])),
	};
	const redactedArtifact = redactArtifactForStorage(artifact);
	await mkdir(directory, { recursive: true });
	await writeJson(join(directory, "overview.json"), overview);
	await writeFile(join(directory, "transcript.md"), renderEvalTranscript(redactedArtifact, overview), "utf8");
	await writeJsonl(join(directory, "trace.raw.jsonl"), rawEvalTraceRows(redactedArtifact));
	await writeJsonl(join(directory, "trace.cleaned.jsonl"), cleanedEvalTraceRows(redactedArtifact, findings));
	await writeJsonl(join(directory, "tool-events.jsonl"), redactArtifactForStorage(toolEventRows));
	await writeJsonl(join(directory, "audit-linked.jsonl"), linkedRuns.auditRows);
	await writeJson(join(directory, "receipt.json"), receiptsFile);
	await writeJson(join(directory, "gate-decisions.json"), gateDecisions);
	await writeJson(join(directory, "protected-artifacts.json"), emptyProtected);
	await writeJson(join(directory, "eval-result.json"), redactedArtifact);
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
		`- receipt-backed runs: ${artifact.summary.harness.receiptCount}`,
		`- tool calls: ${artifact.summary.harness.toolCalls}`,
		`- retries: ${artifact.summary.harness.retries}`,
		`- safety blocks: ${artifact.summary.harness.safetyBlocks}`,
		`- correction latency ms: ${artifact.summary.harness.correctionLatencyMs}`,
		`- validation evidence: ${artifact.summary.harness.validationEvidence}`,
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

function emptyEvalLinkedRuns(): EvalLinkedRuns {
	return { runSources: [], sessionEntries: 0, auditRows: [], toolEvents: [] };
}

async function linkEvalRuns(stateDir: string, artifact: EvalRunArtifact): Promise<EvalLinkedRuns> {
	const envelopes = (await readRunLedger(stateDir)).filter((envelope) => evalRunMatches(artifact, envelope));
	if (envelopes.length === 0) return emptyEvalLinkedRuns();
	const runSources: EvalLinkedRuns["runSources"] = [];
	for (const envelope of envelopes.sort(compareRunEnvelopes)) {
		runSources.push({ envelope, receipt: await readReceiptForRun(stateDir, envelope) });
	}
	const runIds = new Set(runSources.map((source) => source.envelope.id));
	const sessionIds = uniqueStrings(
		runSources.flatMap((source) => (source.envelope.sessionId === null ? [] : [source.envelope.sessionId])),
	);
	const sessionEntries = await countSessionEntries(stateDir, sessionIds);
	const auditRows = await linkedEvalAuditRows(stateDir, runIds, artifact);
	const toolEvents = linkedRunToolEvents(runSources);
	return { runSources, sessionEntries, auditRows, toolEvents };
}

async function readRunLedger(stateDir: string): Promise<RunEnvelope[]> {
	try {
		const raw = await readFile(join(stateDir, "runs.json"), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed.filter(isRecord) as unknown as RunEnvelope[]) : [];
	} catch {
		return [];
	}
}

function evalRunMatches(artifact: EvalRunArtifact, envelope: RunEnvelope): boolean {
	// Time windows and cwd are merely co-location hints. They are never evidence
	// links: only an exact durable run identity may enter the legacy evidence
	// renderer. Current v3 routing evidence further requires assignment and
	// terminal-receipt-digest linkage in its own strict artifact reader.
	return artifact.results.some((result) => result.runId === envelope.id);
}

async function readReceiptForRun(stateDir: string, envelope: RunEnvelope): Promise<RunReceipt | null> {
	const path = envelope.receiptPath ?? join(stateDir, "receipts", `${envelope.id}.json`);
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return isRecord(parsed) ? (parsed as unknown as RunReceipt) : null;
	} catch {
		return null;
	}
}

async function countSessionEntries(stateDir: string, sessionIds: ReadonlyArray<string>): Promise<number> {
	let count = 0;
	for (const sessionId of sessionIds) {
		const path = await findSessionLedgerPath(stateDir, sessionId);
		if (path === null) continue;
		try {
			const raw = await readFile(path, "utf8");
			count += raw
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.filter((line) => {
					try {
						const parsed = JSON.parse(line) as unknown;
						return isRecord(parsed) && parsed.type !== "session";
					} catch {
						return false;
					}
				}).length;
		} catch {
			// Best-effort count only.
		}
	}
	return count;
}

async function findSessionLedgerPath(stateDir: string, sessionId: string): Promise<string | null> {
	const root = join(stateDir, "sessions");
	let cwdHashes: string[];
	try {
		cwdHashes = await readdir(root);
	} catch {
		return null;
	}
	for (const cwdHash of cwdHashes) {
		const path = join(root, cwdHash, sessionId, "current.jsonl");
		try {
			await readFile(path, "utf8");
			return path;
		} catch {
			// Try the next cwd hash.
		}
	}
	return null;
}

async function linkedEvalAuditRows(
	stateDir: string,
	runIds: ReadonlySet<string>,
	artifact: EvalRunArtifact,
): Promise<EvidenceAuditLinkedRow[]> {
	const root = join(stateDir, "audit");
	let files: string[];
	try {
		files = await readdir(root);
	} catch {
		return [];
	}
	const rows: EvidenceAuditLinkedRow[] = [];
	for (const file of files.filter((name) => name.endsWith(".jsonl")).sort(compareStrings)) {
		const raw = await readFile(join(root, file), "utf8").catch(() => "");
		const lines = raw.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			const directRunId = typeof parsed.runId === "string" ? parsed.runId : null;
			if (directRunId !== null && runIds.has(directRunId)) {
				rows.push(evalAuditRow(parsed, directRunId, "run-id", "exact", ["audit runId matched nested eval run"]));
				continue;
			}
			const ts = typeof parsed.ts === "string" ? parsed.ts : null;
			if (ts !== null && timestampInEvalWindow(ts, artifact)) {
				rows.push(evalAuditRow(parsed, null, "eval-window", "best-effort", ["audit timestamp fell within eval window"]));
			}
		}
	}
	return rows.sort(compareAuditRows);
}

function evalAuditRow(
	row: Record<string, unknown>,
	runId: string | null,
	linkKind: string,
	confidence: "exact" | "best-effort",
	reasons: string[],
): EvidenceAuditLinkedRow {
	return {
		kind: "audit-linked",
		auditKind: typeof row.kind === "string" ? row.kind : "tool_call",
		ts: typeof row.ts === "string" ? row.ts : null,
		runId,
		sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
		linkKind,
		confidence,
		reasons,
		row,
	};
}

function linkedRunToolEvents(
	runSources: ReadonlyArray<{ envelope: RunEnvelope; receipt: RunReceipt | null }>,
): EvidenceToolEvent[] {
	const events: EvidenceToolEvent[] = [];
	for (const source of runSources) {
		for (const stat of [...(source.receipt?.toolStats ?? [])].sort(compareToolStats)) {
			events.push({
				source: "receipt-aggregate",
				runId: source.envelope.id,
				sessionId: source.envelope.sessionId,
				tool: stat.tool,
				count: stat.count,
				ok: stat.ok,
				errors: stat.errors,
				blocked: stat.blocked,
				totalDurationMs: stat.totalDurationMs,
			});
		}
	}
	return events.sort(compareEvidenceToolEvents);
}

function timestampInEvalWindow(timestamp: string, artifact: EvalRunArtifact): boolean {
	const value = Date.parse(timestamp);
	const start = Date.parse(artifact.startedAt);
	const end = Date.parse(artifact.endedAt);
	return Number.isFinite(value) && Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end;
}

function compareRunEnvelopes(a: RunEnvelope, b: RunEnvelope): number {
	return compareStrings(a.startedAt, b.startedAt) || compareStrings(a.id, b.id);
}

function compareAuditRows(a: EvidenceAuditLinkedRow, b: EvidenceAuditLinkedRow): number {
	return (
		compareNullableStrings(a.ts, b.ts) ||
		compareNullableStrings(a.runId, b.runId) ||
		JSON.stringify(a.row).localeCompare(JSON.stringify(b.row))
	);
}

function compareToolStats(a: ToolCallStat, b: ToolCallStat): number {
	return compareStrings(a.tool, b.tool);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
