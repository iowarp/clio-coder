import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEnvelope, RunKind, RunReceipt, RunStatus, ToolCallStat } from "../dispatch/index.js";
import { verifyReceiptIntegrity } from "../dispatch/index.js";
import {
	isSessionEntry,
	type MessageEntry,
	type MessageRole,
	type ProtectedArtifactEntry,
	protectedArtifactFromSessionEntry,
	protectedArtifactStateFromSessionEntries,
	type SessionEntry,
} from "../session/index.js";
import { EVIDENCE_FILES, evidenceDirectory, findingsFile } from "./store.js";
import {
	EVIDENCE_VERSION,
	type EvidenceAuditLinkedRow,
	type EvidenceBuildResult,
	type EvidenceCleanTraceRow,
	type EvidenceFinding,
	type EvidenceLinkConfidence,
	type EvidenceOverview,
	type EvidenceProtectedArtifactsFile,
	type EvidenceRawTraceRow,
	type EvidenceReceiptFile,
	type EvidenceRunSource,
	type EvidenceTag,
	type EvidenceToolEvent,
} from "./types.js";

const MAX_TASK_CHARS = 500;
const TRANSCRIPT_TEXT_MAX_CHARS = 500;
const TOOL_PREVIEW_MAX_CHARS = 240;

export interface BuildEvidenceOptions {
	dataDir: string;
	runId?: string;
	sessionId?: string;
}

interface LinkedSessionEntry {
	sessionId: string;
	runId: string | null;
	entry: SessionEntry;
}

interface SessionLinkResult {
	entries: LinkedSessionEntry[];
	attemptedSessionIds: string[];
	missingSessionIds: string[];
	readErrors: string[];
}

interface AuditJsonRow {
	file: string;
	line: number;
	row: Record<string, unknown>;
	ts: string | null;
	auditKind: string;
	correlationId: string;
}

interface AuditLinkResult {
	rows: EvidenceAuditLinkedRow[];
	readErrors: string[];
}

interface SessionReadResult {
	entries: SessionEntry[];
	missing: boolean;
	errors: string[];
}

export async function buildEvidence(options: BuildEvidenceOptions): Promise<EvidenceBuildResult> {
	if (options.runId !== undefined && options.sessionId !== undefined) {
		throw new Error("build evidence accepts either runId or sessionId, not both");
	}
	if (options.runId === undefined && options.sessionId === undefined) {
		throw new Error("build evidence requires runId or sessionId");
	}
	const ledger = await readRunLedger(options.dataDir);
	const source =
		options.runId !== undefined
			? { kind: "run" as const, runId: options.runId }
			: { kind: "session" as const, sessionId: options.sessionId ?? "" };
	const envelopes =
		source.kind === "run"
			? ledger.filter((entry) => entry.id === source.runId)
			: ledger.filter((entry) => entry.sessionId === source.sessionId);
	if (envelopes.length === 0) {
		throw new Error(source.kind === "run" ? `run not found: ${source.runId}` : `session not found: ${source.sessionId}`);
	}
	const sorted = [...envelopes].sort(compareRuns);
	const runSources: EvidenceRunSource[] = [];
	for (const envelope of sorted) {
		const receiptResult = await readReceipt(options.dataDir, envelope);
		runSources.push({
			envelope,
			receipt: receiptResult.receipt,
			receiptError: receiptResult.error,
		});
	}

	const evidenceId =
		source.kind === "run" ? `run-${sanitizeEvidenceId(source.runId)}` : `session-${sanitizeEvidenceId(source.sessionId)}`;
	const directory = evidenceDirectory(options.dataDir, evidenceId);
	const sessionLinks = await linkSessionEntries(options.dataDir, source, runSources);
	const auditLinks = await linkAuditRows(options.dataDir, source, runSources, sessionLinks);
	const toolEventRows = toolEvents(runSources, sessionLinks, auditLinks);
	const protectedArtifacts = protectedArtifactsFile(sessionLinks);
	const findings = buildFindings(runSources, sessionLinks, auditLinks, protectedArtifacts);
	const overview = buildOverview(
		evidenceId,
		source,
		runSources,
		findings,
		sessionLinks,
		auditLinks,
		toolEventRows,
		protectedArtifacts,
	);
	await writeEvidenceFiles(
		directory,
		overview,
		runSources,
		findings,
		sessionLinks,
		auditLinks,
		toolEventRows,
		protectedArtifacts,
	);
	return { evidenceId, directory, overview, findings };
}

function buildOverview(
	evidenceId: string,
	source: EvidenceOverview["source"],
	runSources: ReadonlyArray<EvidenceRunSource>,
	findings: ReadonlyArray<EvidenceFinding>,
	sessionLinks: SessionLinkResult,
	auditLinks: AuditLinkResult,
	toolEventRows: ReadonlyArray<EvidenceToolEvent>,
	protectedArtifacts: EvidenceProtectedArtifactsFile,
): EvidenceOverview {
	const envelopes = runSources.map((item) => item.envelope);
	const receipts = runSources.flatMap((item) => (item.receipt === null ? [] : [item.receipt]));
	const toolStats = receipts.flatMap((receipt) => receipt.toolStats);
	const runIds = envelopes.map((envelope) => envelope.id).sort(compareStrings);
	const sessionIds = uniqueStrings(
		envelopes.flatMap((envelope) => (envelope.sessionId === null ? [] : [envelope.sessionId])),
	);
	const startedAt = earliest(envelopes.map((envelope) => envelope.startedAt));
	const endedAt = latest(envelopes.flatMap((envelope) => (envelope.endedAt === null ? [] : [envelope.endedAt])));
	const generatedAt = latest(
		envelopes.flatMap((envelope) => [envelope.startedAt, ...(envelope.endedAt === null ? [] : [envelope.endedAt])]),
	);
	const wallTimeMs = envelopes.reduce((total, envelope) => total + durationMs(envelope.startedAt, envelope.endedAt), 0);
	return {
		version: EVIDENCE_VERSION,
		evidenceId,
		source,
		generatedAt: generatedAt ?? startedAt ?? "1970-01-01T00:00:00.000Z",
		runIds,
		sessionId: source.kind === "session" ? source.sessionId : (sessionIds[0] ?? null),
		statuses: uniqueStrings(envelopes.map((envelope) => envelope.status)),
		startedAt,
		endedAt,
		tasks: uniqueStrings(envelopes.map((envelope) => truncateText(envelope.task, MAX_TASK_CHARS))),
		cwds: uniqueStrings(envelopes.map((envelope) => envelope.cwd)),
		agentIds: uniqueStrings(envelopes.map((envelope) => envelope.agentId)),
		endpointIds: uniqueStrings(envelopes.map((envelope) => envelope.endpointId)),
		runtimeIds: uniqueStrings(envelopes.map((envelope) => envelope.runtimeId)),
		modelIds: uniqueStrings(envelopes.map((envelope) => envelope.wireModelId)),
		totals: {
			runs: envelopes.length,
			receipts: receipts.length,
			toolCalls: receipts.reduce((total, receipt) => total + receipt.toolCalls, 0),
			toolErrors: toolStats.reduce((total, stat) => total + stat.errors, 0),
			blockedToolCalls: toolStats.reduce((total, stat) => total + stat.blocked, 0),
			sessionEntries: sessionLinks.entries.length,
			auditRows: auditLinks.rows.length,
			toolEvents: toolEventRows.length,
			linkedToolEvents: toolEventRows.filter((event) => event.source !== "receipt-aggregate").length,
			protectedArtifacts: protectedArtifacts.artifacts.length,
			tokens: receipts.reduce((total, receipt) => total + receipt.tokenCount, 0),
			costUsd: receipts.reduce((total, receipt) => total + receipt.costUsd, 0),
			wallTimeMs,
		},
		tags: uniqueTags(findings.map((finding) => finding.tag)),
		files: [...EVIDENCE_FILES],
	};
}

function buildFindings(
	runSources: ReadonlyArray<EvidenceRunSource>,
	sessionLinks: SessionLinkResult,
	auditLinks: AuditLinkResult,
	protectedArtifacts: EvidenceProtectedArtifactsFile,
): EvidenceFinding[] {
	const findings: EvidenceFinding[] = [];
	for (const source of runSources) {
		if (source.receiptError !== null) {
			findings.push(finding(findings.length, "warn", "unknown", source.envelope.id, source.receiptError));
		}
		if (source.envelope.cwd.trim().length === 0) {
			findings.push(finding(findings.length, "warn", "cwd-missing", source.envelope.id, "run ledger cwd is empty"));
		}
		const receipt = source.receipt;
		const blocked = receipt?.toolStats.reduce((total, stat) => total + stat.blocked, 0) ?? 0;
		if (blocked > 0) {
			findings.push(
				finding(findings.length, "warn", "blocked-tool", source.envelope.id, `${blocked} blocked tool call(s)`),
			);
		}
		if (source.envelope.status === "stale" || source.envelope.status === "dead") {
			findings.push(
				finding(findings.length, "warn", "timeout", source.envelope.id, `run status ${source.envelope.status}`),
			);
		}
		const exitCode = receipt?.exitCode ?? source.envelope.exitCode;
		if (exitCode !== null && exitCode !== 0) {
			const tag = classifyFailure(source.envelope.task);
			findings.push(finding(findings.length, "warn", tag, source.envelope.id, `run exited with code ${exitCode}`));
		}
	}
	if (sessionLinks.entries.length > 0) {
		findings.push(
			finding(findings.length, "info", "session-linked", null, `${sessionLinks.entries.length} session entry(s) linked`),
		);
	}
	for (const sessionId of sessionLinks.missingSessionIds) {
		findings.push(
			finding(findings.length, "warn", "session-missing", null, `session entries not found for ${sessionId}`),
		);
	}
	for (const error of sessionLinks.readErrors) {
		findings.push(finding(findings.length, "warn", "session-missing", null, error));
	}
	if (auditLinks.rows.length > 0) {
		findings.push(
			finding(findings.length, "info", "audit-linked", null, `${auditLinks.rows.length} audit row(s) linked`),
		);
	}
	if (protectedArtifacts.artifacts.length > 0) {
		findings.push(
			finding(
				findings.length,
				"info",
				"protected-artifact",
				null,
				`${protectedArtifacts.artifacts.length} protected artifact(s) persisted`,
			),
		);
	}
	const bestEffortAuditRows = auditLinks.rows.filter((row) => row.confidence === "best-effort").length;
	if (bestEffortAuditRows > 0) {
		findings.push(
			finding(
				findings.length,
				"info",
				"best-effort-link",
				null,
				`${bestEffortAuditRows} audit row(s) linked with best-effort metadata`,
			),
		);
	}
	for (const error of auditLinks.readErrors) {
		findings.push(finding(findings.length, "warn", "audit-missing", null, error));
	}
	return findings;
}

function finding(
	index: number,
	severity: EvidenceFinding["severity"],
	tag: EvidenceTag,
	runId: string | null,
	message: string,
): EvidenceFinding {
	return {
		id: `finding-${String(index + 1).padStart(3, "0")}`,
		severity,
		tag,
		runId,
		message,
	};
}

function classifyFailure(task: string): EvidenceTag {
	const text = task.toLowerCase();
	if (text.includes("auth") || text.includes("api key") || text.includes("credential")) return "auth-failure";
	if (text.includes("context") && (text.includes("overflow") || text.includes("length"))) return "context-overflow";
	if (text.includes("dependency") || text.includes("module not found") || text.includes("missing package")) {
		return "missing-dependency";
	}
	if (text.includes("runtime") || text.includes("model mismatch")) return "wrong-runtime";
	if (text.includes("timeout") || text.includes("timed out")) return "timeout";
	if (text.includes("build")) return "build-failure";
	if (looksLikeValidationTask(text)) return "test-failure";
	return "unknown";
}

function looksLikeValidationTask(text: string): boolean {
	return (
		text.includes("test") ||
		text.includes("lint") ||
		text.includes("typecheck") ||
		text.includes("verify") ||
		text.includes("pytest") ||
		text.includes("ctest")
	);
}

async function writeEvidenceFiles(
	directory: string,
	overview: EvidenceOverview,
	runSources: ReadonlyArray<EvidenceRunSource>,
	findings: ReadonlyArray<EvidenceFinding>,
	sessionLinks: SessionLinkResult,
	auditLinks: AuditLinkResult,
	toolEventRows: ReadonlyArray<EvidenceToolEvent>,
	protectedArtifacts: EvidenceProtectedArtifactsFile,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeJson(join(directory, "overview.json"), overview);
	await writeFile(join(directory, "transcript.md"), renderTranscript(overview, runSources, sessionLinks), "utf8");
	await writeJsonl(join(directory, "trace.raw.jsonl"), rawTraceRows(runSources));
	await writeJsonl(join(directory, "trace.cleaned.jsonl"), cleanedTraceRows(runSources, findings, toolEventRows));
	await writeJsonl(join(directory, "tool-events.jsonl"), toolEventRows);
	await writeJsonl(join(directory, "audit-linked.jsonl"), auditLinks.rows);
	await writeJson(join(directory, "receipt.json"), receiptsFile(runSources));
	await writeJson(join(directory, "protected-artifacts.json"), protectedArtifacts);
	await writeJson(join(directory, "findings.json"), findingsFile(overview.evidenceId, [...findings]));
	await writeFile(join(directory, "findings.md"), renderFindings(findings), "utf8");
}

function rawTraceRows(runSources: ReadonlyArray<EvidenceRunSource>): EvidenceRawTraceRow[] {
	const rows: EvidenceRawTraceRow[] = [];
	for (const source of runSources) {
		rows.push({ kind: "run-ledger", runId: source.envelope.id, envelope: source.envelope });
		if (source.receipt !== null) rows.push({ kind: "receipt", runId: source.envelope.id, receipt: source.receipt });
		else if (source.receiptError !== null) {
			rows.push({ kind: "receipt-error", runId: source.envelope.id, error: source.receiptError });
		}
	}
	return rows;
}

function cleanedTraceRows(
	runSources: ReadonlyArray<EvidenceRunSource>,
	findings: ReadonlyArray<EvidenceFinding>,
	toolEventRows: ReadonlyArray<EvidenceToolEvent>,
): EvidenceCleanTraceRow[] {
	const rows: EvidenceCleanTraceRow[] = [];
	for (const source of runSources) {
		const envelope = source.envelope;
		rows.push({
			kind: "run",
			runId: envelope.id,
			task: truncateText(envelope.task, MAX_TASK_CHARS),
			status: envelope.status,
			exitCode: source.receipt?.exitCode ?? envelope.exitCode,
			startedAt: envelope.startedAt,
			endedAt: envelope.endedAt,
			wallTimeMs: durationMs(envelope.startedAt, envelope.endedAt),
			cwd: envelope.cwd,
			agentId: envelope.agentId,
			endpointId: envelope.endpointId,
			runtimeId: envelope.runtimeId,
			wireModelId: envelope.wireModelId,
			tokenCount: source.receipt?.tokenCount ?? envelope.tokenCount,
			costUsd: source.receipt?.costUsd ?? envelope.costUsd,
		});
		for (const event of toolEventRows.filter((item) => item.runId === source.envelope.id)) {
			rows.push({ kind: "tool-summary", ...event });
		}
	}
	for (const event of toolEventRows.filter((item) => item.runId === null)) rows.push({ kind: "tool-summary", ...event });
	for (const item of findings) rows.push({ kind: "finding", ...item });
	return rows;
}

function toolEvents(
	runSources: ReadonlyArray<EvidenceRunSource>,
	sessionLinks: SessionLinkResult,
	auditLinks: AuditLinkResult,
): EvidenceToolEvent[] {
	const fromSession = sessionToolEvents(sessionLinks.entries);
	if (fromSession.length > 0) return fromSession;
	const fromAudit = auditToolEvents(auditLinks.rows);
	if (fromAudit.length > 0) return fromAudit;
	return receiptAggregateToolEvents(runSources);
}

function receiptAggregateToolEvents(runSources: ReadonlyArray<EvidenceRunSource>): EvidenceToolEvent[] {
	const events: EvidenceToolEvent[] = [];
	for (const source of runSources) {
		const stats = source.receipt?.toolStats ?? [];
		for (const stat of [...stats].sort(compareToolStats)) {
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
	return events;
}

async function linkSessionEntries(
	dataDir: string,
	source: EvidenceOverview["source"],
	runSources: ReadonlyArray<EvidenceRunSource>,
): Promise<SessionLinkResult> {
	const attemptedSessionIds = sourceSessionIds(source, runSources);
	const result: SessionLinkResult = {
		entries: [],
		attemptedSessionIds,
		missingSessionIds: [],
		readErrors: [],
	};
	for (const sessionId of attemptedSessionIds) {
		const read = await readSessionEntriesForId(dataDir, sessionId);
		if (read.missing) {
			result.missingSessionIds.push(sessionId);
			continue;
		}
		result.readErrors.push(...read.errors);
		for (const entry of read.entries) {
			const runId = linkedRunIdForTimestamp(entry.timestamp, runSources);
			if (source.kind === "run" && runId !== source.runId) continue;
			result.entries.push({ sessionId, runId, entry });
		}
	}
	result.entries.sort(compareLinkedSessionEntries);
	return result;
}

function sourceSessionIds(source: EvidenceOverview["source"], runSources: ReadonlyArray<EvidenceRunSource>): string[] {
	if (source.kind === "session") return [source.sessionId];
	const values: string[] = [];
	for (const item of runSources) {
		if (item.envelope.sessionId !== null) values.push(item.envelope.sessionId);
		if (item.receipt?.sessionId !== null && item.receipt?.sessionId !== undefined) values.push(item.receipt.sessionId);
	}
	return uniqueStrings(values);
}

async function readSessionEntriesForId(dataDir: string, sessionId: string): Promise<SessionReadResult> {
	const root = join(dataDir, "sessions");
	let cwdHashes: string[];
	try {
		cwdHashes = await readdir(root);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { entries: [], missing: true, errors: [] };
		return { entries: [], missing: false, errors: [`session root read error: ${err.message ?? String(err)}`] };
	}
	for (const cwdHash of cwdHashes.sort(compareStrings)) {
		const currentPath = join(root, cwdHash, sessionId, "current.jsonl");
		let raw: string;
		try {
			raw = await readFile(currentPath, "utf8");
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT" || err.code === "ENOTDIR") continue;
			return { entries: [], missing: false, errors: [`${currentPath}: ${err.message ?? String(err)}`] };
		}
		return parseSessionEntries(raw, currentPath);
	}
	return { entries: [], missing: true, errors: [] };
}

function parseSessionEntries(raw: string, source: string): SessionReadResult {
	const entries: SessionEntry[] = [];
	const errors: string[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${source}:${index + 1}: invalid JSON: ${message}`);
			continue;
		}
		const entry = parseSessionEntryLine(parsed);
		if (entry !== null) entries.push(entry);
	}
	return { entries, missing: false, errors };
}

function parseSessionEntryLine(value: unknown): SessionEntry | null {
	if (isSessionEntry(value)) return value;
	if (!isRecord(value)) return null;
	const id = readOptionalString(value.id);
	const parentId = readOptionalNullableString(value.parentId);
	const at = readOptionalString(value.at);
	const kind = readOptionalMessageRole(value.kind);
	if (id === null || parentId === undefined || at === null || kind === null) return null;
	const entry: MessageEntry = {
		kind: "message",
		turnId: id,
		parentTurnId: parentId,
		timestamp: at,
		role: kind,
		payload: value.payload,
	};
	if (value.dynamicInputs !== undefined) entry.dynamicInputs = value.dynamicInputs;
	if (typeof value.renderedPromptHash === "string") entry.renderedPromptHash = value.renderedPromptHash;
	return entry;
}

function linkedRunIdForTimestamp(timestamp: string, runSources: ReadonlyArray<EvidenceRunSource>): string | null {
	const candidates = runSources
		.filter((source) => timestampInRunWindow(timestamp, source.envelope))
		.map((source) => source.envelope.id)
		.sort(compareStrings);
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function timestampInRunWindow(timestamp: string, envelope: RunEnvelope): boolean {
	const value = Date.parse(timestamp);
	const start = Date.parse(envelope.startedAt);
	const end = envelope.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(envelope.endedAt);
	if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
	return value >= start && value <= end;
}

function compareLinkedSessionEntries(a: LinkedSessionEntry, b: LinkedSessionEntry): number {
	const byTimestamp = compareStrings(a.entry.timestamp, b.entry.timestamp);
	if (byTimestamp !== 0) return byTimestamp;
	const bySession = compareStrings(a.sessionId, b.sessionId);
	if (bySession !== 0) return bySession;
	return compareStrings(a.entry.turnId, b.entry.turnId);
}

interface SessionToolCall {
	id: string;
	tool: string;
	args: unknown;
	timestamp: string;
	runId: string | null;
	sessionId: string;
}

interface SessionToolResult {
	id: string | null;
	tool: string;
	result: unknown;
	isError: boolean;
	timestamp: string;
	runId: string | null;
	sessionId: string;
}

function sessionToolEvents(entries: ReadonlyArray<LinkedSessionEntry>): EvidenceToolEvent[] {
	const calls = new Map<string, SessionToolCall>();
	const pendingIds: string[] = [];
	const pairedIds = new Set<string>();
	const events: EvidenceToolEvent[] = [];
	for (const linked of entries) {
		const entry = linked.entry;
		if (entry.kind === "bashExecution") {
			events.push({
				source: "session-entry",
				runId: linked.runId,
				sessionId: linked.sessionId,
				tool: "bash",
				count: 1,
				ok: entry.cancelled || (entry.exitCode !== null && entry.exitCode !== 0) ? 0 : 1,
				errors: entry.cancelled || (entry.exitCode !== null && entry.exitCode !== 0) ? 1 : 0,
				blocked: 0,
				totalDurationMs: 0,
				timestamp: entry.timestamp,
				linkKind: "session-bash-execution",
				confidence: "exact",
				argsPreview: truncateText(entry.command, TOOL_PREVIEW_MAX_CHARS),
				resultPreview: truncateText(entry.output, TOOL_PREVIEW_MAX_CHARS),
			});
			continue;
		}
		if (entry.kind !== "message") continue;
		if (entry.role === "tool_call") {
			const call = extractSessionToolCall(entry, linked);
			calls.set(call.id, call);
			pendingIds.push(call.id);
			continue;
		}
		if (entry.role !== "tool_result") continue;
		const result = extractSessionToolResult(entry, linked);
		const fallbackId = result.id ?? pendingIds.pop() ?? null;
		const call = fallbackId === null ? undefined : calls.get(fallbackId);
		if (fallbackId !== null) {
			const pendingIndex = pendingIds.indexOf(fallbackId);
			if (pendingIndex >= 0) pendingIds.splice(pendingIndex, 1);
			pairedIds.add(fallbackId);
		}
		const tool = call?.tool ?? result.tool;
		events.push({
			source: "session-entry",
			runId: call?.runId ?? result.runId,
			sessionId: call?.sessionId ?? result.sessionId,
			tool,
			count: 1,
			ok: result.isError ? 0 : 1,
			errors: result.isError ? 1 : 0,
			blocked: 0,
			totalDurationMs: 0,
			timestamp: call?.timestamp ?? result.timestamp,
			...(fallbackId === null ? {} : { toolCallId: fallbackId }),
			linkKind: call === undefined ? "session-tool-result" : "session-tool-call-result",
			confidence: call === undefined ? "best-effort" : "exact",
			...(call === undefined ? {} : { argsPreview: previewUnknown(call.args) }),
			resultPreview: previewUnknown(result.result),
		});
	}
	for (const call of [...calls.values()].sort(compareSessionToolCalls)) {
		if (pairedIds.has(call.id)) continue;
		events.push({
			source: "session-entry",
			runId: call.runId,
			sessionId: call.sessionId,
			tool: call.tool,
			count: 1,
			ok: 0,
			errors: 0,
			blocked: 0,
			totalDurationMs: 0,
			timestamp: call.timestamp,
			toolCallId: call.id,
			linkKind: "session-tool-call",
			confidence: "best-effort",
			argsPreview: previewUnknown(call.args),
		});
	}
	return events.sort(compareEvidenceToolEvents);
}

function extractSessionToolCall(entry: MessageEntry, linked: LinkedSessionEntry): SessionToolCall {
	const payload = payloadObject(entry.payload);
	const block = firstContentBlock(entry.payload, "toolCall");
	const fn = payloadObject(payload?.function);
	const id =
		readOptionalString(payload?.id) ??
		readOptionalString(payload?.toolCallId) ??
		readOptionalString(payload?.tool_call_id) ??
		readOptionalString(block?.id) ??
		entry.turnId;
	const tool =
		readOptionalString(payload?.name) ??
		readOptionalString(payload?.toolName) ??
		readOptionalString(payload?.tool) ??
		readOptionalString(fn?.name) ??
		readOptionalString(block?.name) ??
		"tool";
	const args =
		payload?.arguments ??
		payload?.args ??
		payload?.input ??
		parseMaybeJson(fn?.arguments) ??
		block?.arguments ??
		block?.args ??
		undefined;
	return { id, tool, args, timestamp: entry.timestamp, runId: linked.runId, sessionId: linked.sessionId };
}

function extractSessionToolResult(entry: MessageEntry, linked: LinkedSessionEntry): SessionToolResult {
	const payload = payloadObject(entry.payload);
	const contentText = extractTextFromPayload(entry.payload);
	const id =
		readOptionalString(payload?.toolCallId) ??
		readOptionalString(payload?.tool_call_id) ??
		readOptionalString(payload?.id) ??
		null;
	const tool =
		readOptionalString(payload?.toolName) ??
		readOptionalString(payload?.name) ??
		readOptionalString(payload?.tool) ??
		"tool";
	const result =
		payload?.result ??
		payload?.output ??
		payload?.out ??
		payload?.content ??
		(contentText.length > 0 ? contentText : entry.payload);
	return {
		id,
		tool,
		result,
		isError: payload?.isError === true || payload?.error === true,
		timestamp: entry.timestamp,
		runId: linked.runId,
		sessionId: linked.sessionId,
	};
}

function compareSessionToolCalls(a: SessionToolCall, b: SessionToolCall): number {
	const byTimestamp = compareStrings(a.timestamp, b.timestamp);
	if (byTimestamp !== 0) return byTimestamp;
	return compareStrings(a.id, b.id);
}

async function linkAuditRows(
	dataDir: string,
	source: EvidenceOverview["source"],
	runSources: ReadonlyArray<EvidenceRunSource>,
	sessionLinks: SessionLinkResult,
): Promise<AuditLinkResult> {
	const auditRows = await readAuditRows(dataDir);
	const rows: EvidenceAuditLinkedRow[] = [];
	const runIds = new Set(runSources.map((item) => item.envelope.id));
	const sessionIds = new Set(sessionLinks.attemptedSessionIds);
	if (source.kind === "session") sessionIds.add(source.sessionId);
	const runSessionIds = new Map(
		runSources.map((item) => [item.envelope.id, item.envelope.sessionId ?? item.receipt?.sessionId ?? null] as const),
	);
	for (const audit of auditRows.rows) {
		const directRunId = readOptionalString(audit.row.runId);
		if (directRunId !== null && runIds.has(directRunId)) {
			rows.push(
				auditLinkedRow(audit, {
					runId: directRunId,
					sessionId: readOptionalString(audit.row.sessionId) ?? runSessionIds.get(directRunId) ?? null,
					linkKind: "run-id",
					confidence: "exact",
					reasons: ["audit runId matched run ledger"],
				}),
			);
			continue;
		}
		const directSessionId = readOptionalString(audit.row.sessionId);
		if (directSessionId !== null && sessionIds.has(directSessionId)) {
			rows.push(
				auditLinkedRow(audit, {
					runId: null,
					sessionId: directSessionId,
					linkKind: "session-id",
					confidence: "exact",
					reasons: ["audit sessionId matched linked session"],
				}),
			);
			continue;
		}
		const bestEffort = bestEffortAuditLink(audit, source, runSources, sessionIds);
		if (bestEffort !== null) rows.push(auditLinkedRow(audit, bestEffort));
	}
	rows.sort(compareAuditLinkedRows);
	return { rows, readErrors: auditRows.errors };
}

async function readAuditRows(dataDir: string): Promise<{ rows: AuditJsonRow[]; errors: string[] }> {
	const root = join(dataDir, "audit");
	let files: string[];
	try {
		files = await readdir(root);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { rows: [], errors: [] };
		return { rows: [], errors: [`audit root read error: ${err.message ?? String(err)}`] };
	}
	const rows: AuditJsonRow[] = [];
	const errors: string[] = [];
	for (const file of files.filter((name) => name.endsWith(".jsonl")).sort(compareStrings)) {
		const path = join(root, file);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			errors.push(`${path}: ${err.message ?? String(err)}`);
			continue;
		}
		const lines = raw.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === undefined || line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${path}:${index + 1}: invalid JSON: ${message}`);
				continue;
			}
			if (!isRecord(parsed)) {
				errors.push(`${path}:${index + 1}: expected object`);
				continue;
			}
			const auditKind = readOptionalString(parsed.kind) ?? "tool_call";
			rows.push({
				file,
				line: index + 1,
				row: parsed,
				ts: readOptionalString(parsed.ts),
				auditKind,
				correlationId: readOptionalString(parsed.correlationId) ?? "",
			});
		}
	}
	return { rows, errors };
}

interface AuditLinkFields {
	runId: string | null;
	sessionId: string | null;
	linkKind: string;
	confidence: EvidenceLinkConfidence;
	reasons: string[];
	candidateRunIds?: string[];
}

function auditLinkedRow(audit: AuditJsonRow, fields: AuditLinkFields): EvidenceAuditLinkedRow {
	return {
		kind: "audit-linked",
		auditKind: audit.auditKind,
		ts: audit.ts,
		runId: fields.runId,
		sessionId: fields.sessionId,
		linkKind: fields.linkKind,
		confidence: fields.confidence,
		reasons: fields.reasons,
		...(fields.candidateRunIds === undefined ? {} : { candidateRunIds: fields.candidateRunIds }),
		row: audit.row,
	};
}

function bestEffortAuditLink(
	audit: AuditJsonRow,
	source: EvidenceOverview["source"],
	runSources: ReadonlyArray<EvidenceRunSource>,
	sessionIds: ReadonlySet<string>,
): AuditLinkFields | null {
	if (audit.auditKind !== "tool_call") return null;
	const tool = readOptionalString(audit.row.tool);
	if (tool === null || audit.ts === null) return null;
	const candidates = runSources.filter((item) => {
		if (!timestampInRunWindow(audit.ts ?? "", item.envelope)) return false;
		const tools = receiptToolNames(item);
		return tools.size === 0 || tools.has(tool);
	});
	if (candidates.length === 1) {
		const candidate = candidates[0];
		if (candidate === undefined) return null;
		return {
			runId: candidate.envelope.id,
			sessionId:
				candidate.envelope.sessionId ??
				candidate.receipt?.sessionId ??
				(source.kind === "session" ? source.sessionId : null),
			linkKind: "timestamp-tool",
			confidence: "best-effort",
			reasons: ["audit timestamp fell within one run window", "audit tool matched receipt metadata"],
		};
	}
	if (source.kind === "session" && candidates.length > 1) {
		return {
			runId: null,
			sessionId: source.sessionId,
			linkKind: "ambiguous-timestamp-tool",
			confidence: "best-effort",
			reasons: ["audit timestamp and tool matched multiple runs in this session"],
			candidateRunIds: candidates.map((item) => item.envelope.id).sort(compareStrings),
		};
	}
	if (source.kind === "session" && sessionIds.has(source.sessionId)) {
		const sessionSpan = sessionTimeSpan(runSources);
		if (sessionSpan !== null && timestampInSpan(audit.ts, sessionSpan)) {
			return {
				runId: null,
				sessionId: source.sessionId,
				linkKind: "session-timestamp-tool",
				confidence: "best-effort",
				reasons: ["audit timestamp fell within the session run span", "audit tool metadata was present"],
			};
		}
	}
	return null;
}

function receiptToolNames(source: EvidenceRunSource): Set<string> {
	return new Set((source.receipt?.toolStats ?? []).map((stat) => stat.tool));
}

function sessionTimeSpan(runSources: ReadonlyArray<EvidenceRunSource>): { start: string; end: string | null } | null {
	const starts = runSources.map((source) => source.envelope.startedAt);
	if (starts.length === 0) return null;
	return {
		start: earliest(starts) ?? starts[0] ?? "1970-01-01T00:00:00.000Z",
		end: latest(runSources.flatMap((source) => (source.envelope.endedAt === null ? [] : [source.envelope.endedAt]))),
	};
}

function timestampInSpan(timestamp: string, span: { start: string; end: string | null }): boolean {
	const value = Date.parse(timestamp);
	const start = Date.parse(span.start);
	const end = span.end === null ? Number.POSITIVE_INFINITY : Date.parse(span.end);
	if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
	return value >= start && value <= end;
}

function auditToolEvents(rows: ReadonlyArray<EvidenceAuditLinkedRow>): EvidenceToolEvent[] {
	const events: EvidenceToolEvent[] = [];
	for (const row of rows) {
		if (row.auditKind !== "tool_call") continue;
		const tool = readOptionalString(row.row.tool);
		if (tool === null) continue;
		const decision = readOptionalString(row.row.decision);
		const event: EvidenceToolEvent = {
			source: "audit-row",
			runId: row.runId,
			sessionId: row.sessionId,
			tool,
			count: 1,
			ok: decision === "allowed" ? 1 : 0,
			errors: 0,
			blocked: decision === "blocked" ? 1 : 0,
			totalDurationMs: 0,
			linkKind: row.linkKind,
			confidence: row.confidence,
		};
		if (row.ts !== null) event.timestamp = row.ts;
		if (decision !== null) event.decision = decision;
		const actionClass = readOptionalString(row.row.actionClass);
		if (actionClass !== null) event.actionClass = actionClass;
		events.push(event);
	}
	return events.sort(compareEvidenceToolEvents);
}

function compareAuditLinkedRows(a: EvidenceAuditLinkedRow, b: EvidenceAuditLinkedRow): number {
	const byTs = compareNullableStrings(a.ts, b.ts);
	if (byTs !== 0) return byTs;
	const byKind = compareStrings(a.auditKind, b.auditKind);
	if (byKind !== 0) return byKind;
	const aCorrelation = readOptionalString(a.row.correlationId) ?? "";
	const bCorrelation = readOptionalString(b.row.correlationId) ?? "";
	if (aCorrelation !== bCorrelation) return compareStrings(aCorrelation, bCorrelation);
	return JSON.stringify(a.row).localeCompare(JSON.stringify(b.row));
}

function receiptsFile(runSources: ReadonlyArray<EvidenceRunSource>): EvidenceReceiptFile {
	return {
		version: EVIDENCE_VERSION,
		receipts: runSources.flatMap((source) => (source.receipt === null ? [] : [source.receipt])),
	};
}

function protectedArtifactsFile(sessionLinks: SessionLinkResult): EvidenceProtectedArtifactsFile {
	const state = protectedArtifactStateFromSessionEntries(sessionLinks.entries.map((linked) => linked.entry));
	const events = sessionLinks.entries
		.filter((linked): linked is LinkedSessionEntry & { entry: ProtectedArtifactEntry } => {
			return linked.entry.kind === "protectedArtifact";
		})
		.map((linked) => {
			const event: EvidenceProtectedArtifactsFile["events"][number] = {
				kind: "protected-artifact",
				sessionId: linked.sessionId,
				runId: linked.runId,
				timestamp: linked.entry.timestamp,
				turnId: linked.entry.turnId,
				parentTurnId: linked.entry.parentTurnId,
				action: linked.entry.action,
				artifact: protectedArtifactFromSessionEntry(linked.entry),
			};
			if (linked.entry.toolName !== undefined) event.toolName = linked.entry.toolName;
			if (linked.entry.toolCallId !== undefined) event.toolCallId = linked.entry.toolCallId;
			if (linked.entry.runId !== undefined) event.sourceRunId = linked.entry.runId;
			if (linked.entry.correlationId !== undefined) event.correlationId = linked.entry.correlationId;
			return event;
		})
		.sort(compareProtectedArtifactEvents);
	return {
		version: EVIDENCE_VERSION,
		artifacts: state.artifacts,
		events,
	};
}

function compareProtectedArtifactEvents(
	left: EvidenceProtectedArtifactsFile["events"][number],
	right: EvidenceProtectedArtifactsFile["events"][number],
): number {
	return (
		compareStrings(left.timestamp, right.timestamp) ||
		compareStrings(left.sessionId, right.sessionId) ||
		compareStrings(left.turnId, right.turnId) ||
		compareStrings(left.artifact.path, right.artifact.path)
	);
}

function renderTranscript(
	overview: EvidenceOverview,
	runSources: ReadonlyArray<EvidenceRunSource>,
	sessionLinks: SessionLinkResult,
): string {
	const lines = [
		`# Evidence ${overview.evidenceId}`,
		"",
		`Source: ${formatEvidenceSource(overview.source)}`,
		`Generated at: ${overview.generatedAt}`,
		"",
		"## Runs",
	];
	for (const source of runSources) {
		const envelope = source.envelope;
		const exitCode = source.receipt?.exitCode ?? envelope.exitCode;
		lines.push(
			`- ${envelope.id} status=${envelope.status} exit=${exitCode ?? "?"} agent=${envelope.agentId} target=${envelope.endpointId}`,
		);
		lines.push(`  task: ${truncateText(envelope.task, MAX_TASK_CHARS)}`);
	}
	if (sessionLinks.entries.length > 0) {
		lines.push("", "## Linked Session Transcript");
		for (const linked of sessionLinks.entries) {
			lines.push(...renderSessionTranscriptEntry(linked));
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function formatEvidenceSource(source: EvidenceOverview["source"]): string {
	if (source.kind === "run") return `run ${source.runId}`;
	if (source.kind === "session") return `session ${source.sessionId}`;
	return `eval ${source.evalId}`;
}

function renderSessionTranscriptEntry(linked: LinkedSessionEntry): string[] {
	const entry = linked.entry;
	const prefix = `- ${entry.timestamp} session=${linked.sessionId}${linked.runId === null ? "" : ` run=${linked.runId}`}`;
	if (entry.kind === "message") {
		if (entry.role === "tool_call") {
			const call = extractSessionToolCall(entry, linked);
			return [`${prefix} tool_call ${call.tool} id=${call.id} args=${previewUnknown(call.args)}`];
		}
		if (entry.role === "tool_result") {
			const result = extractSessionToolResult(entry, linked);
			const id = result.id === null ? "" : ` id=${result.id}`;
			const error = result.isError ? " error=true" : "";
			return [`${prefix} tool_result ${result.tool}${id}${error}: ${previewUnknown(result.result)}`];
		}
		const text = collapseWhitespace(extractTextFromPayload(entry.payload));
		const rendered = text.length > 0 ? truncateText(text, TRANSCRIPT_TEXT_MAX_CHARS) : previewUnknown(entry.payload);
		return [`${prefix} ${entry.role}: ${rendered}`];
	}
	if (entry.kind === "bashExecution") {
		const status = entry.cancelled ? "cancelled" : entry.exitCode === null ? "exit=?" : `exit=${entry.exitCode}`;
		return [
			`${prefix} bash ${status}: $ ${truncateText(entry.command, TRANSCRIPT_TEXT_MAX_CHARS)}`,
			`  output: ${previewUnknown(entry.output)}`,
		];
	}
	if (entry.kind === "branchSummary")
		return [`${prefix} branchSummary: ${truncateText(entry.summary, TRANSCRIPT_TEXT_MAX_CHARS)}`];
	if (entry.kind === "compactionSummary")
		return [`${prefix} compactionSummary: ${truncateText(entry.summary, TRANSCRIPT_TEXT_MAX_CHARS)}`];
	if (entry.kind === "modelChange") return [`${prefix} modelChange: ${entry.provider}/${entry.modelId}`];
	if (entry.kind === "thinkingLevelChange") return [`${prefix} thinkingLevelChange: ${entry.thinkingLevel}`];
	if (entry.kind === "fileEntry") return [`${prefix} file ${entry.operation}: ${entry.path}`];
	if (entry.kind === "sessionInfo") {
		const label = entry.name ?? (entry.label === undefined ? "" : entry.label);
		return label.length === 0 ? [`${prefix} sessionInfo`] : [`${prefix} sessionInfo: ${truncateText(label, 120)}`];
	}
	if (entry.kind === "protectedArtifact") {
		const artifact = protectedArtifactFromSessionEntry(entry);
		const tool = entry.toolName === undefined ? "" : ` tool=${entry.toolName}`;
		const validation =
			artifact.validationCommand === undefined
				? ""
				: ` validation=${artifact.validationCommand}${artifact.validationExitCode === undefined ? "" : ` exit=${artifact.validationExitCode}`}`;
		return [
			`${prefix} protectedArtifact protect:${tool} ${artifact.path} source=${artifact.source}${validation} reason=${truncateText(artifact.reason, 120)}`,
		];
	}
	if (entry.kind === "custom") return [`${prefix} custom:${entry.customType} ${previewUnknown(entry.data)}`];
	const _exhaustive: never = entry;
	return [`${prefix} ${String(_exhaustive)}`];
}

function renderFindings(findings: ReadonlyArray<EvidenceFinding>): string {
	if (findings.length === 0) return "# Findings\n\nNo findings.\n";
	const lines = ["# Findings", ""];
	for (const item of findings) {
		const run = item.runId === null ? "" : ` run=${item.runId}`;
		lines.push(`- ${item.id} [${item.severity}] ${item.tag}${run}: ${item.message}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

async function readRunLedger(dataDir: string): Promise<RunEnvelope[]> {
	const target = join(dataDir, "state", "runs.json");
	let raw: string;
	try {
		raw = await readFile(target, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") throw new Error("run ledger not found");
		throw error;
	}
	const parsed = parseJson(raw, target);
	if (!Array.isArray(parsed)) throw new Error(`${target}: expected array`);
	return parsed.map((entry, index) => parseRunEnvelope(entry, `${target}[${index}]`));
}

async function readReceipt(
	dataDir: string,
	envelope: RunEnvelope,
): Promise<{ receipt: RunReceipt | null; error: string | null }> {
	const receiptPath = envelope.receiptPath ?? join(dataDir, "receipts", `${envelope.id}.json`);
	let raw: string;
	try {
		raw = await readFile(receiptPath, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { receipt: null, error: "receipt file not found" };
		return { receipt: null, error: `receipt read error: ${err.message ?? String(err)}` };
	}
	const parsed = parseJson(raw, receiptPath);
	const receipt = parseRunReceipt(parsed, receiptPath);
	const integrity = verifyReceiptIntegrity(receipt, envelope);
	if (!integrity.ok) return { receipt, error: `receipt integrity: ${integrity.reason}` };
	return { receipt, error: null };
}

function parseRunEnvelope(value: unknown, source: string): RunEnvelope {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	const reasoningTokenCount = readOptionalNumber(value, source, "reasoningTokenCount");
	return {
		id: readString(value, source, "id"),
		agentId: readString(value, source, "agentId"),
		task: readString(value, source, "task"),
		endpointId: readString(value, source, "endpointId"),
		wireModelId: readString(value, source, "wireModelId"),
		runtimeId: readString(value, source, "runtimeId"),
		runtimeKind: readRunKind(value, source, "runtimeKind"),
		startedAt: readString(value, source, "startedAt"),
		endedAt: readNullableString(value, source, "endedAt"),
		status: readRunStatus(value, source, "status"),
		exitCode: readNullableNumber(value, source, "exitCode"),
		pid: readNullableNumber(value, source, "pid"),
		heartbeatAt: readNullableString(value, source, "heartbeatAt"),
		receiptPath: readNullableString(value, source, "receiptPath"),
		sessionId: readNullableString(value, source, "sessionId"),
		cwd: readString(value, source, "cwd"),
		tokenCount: readNumber(value, source, "tokenCount"),
		...(reasoningTokenCount !== undefined ? { reasoningTokenCount } : {}),
		costUsd: readNumber(value, source, "costUsd"),
	};
}

function parseRunReceipt(value: unknown, source: string): RunReceipt {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	const integrity = value.integrity;
	if (!isRecord(integrity)) throw new Error(`${source}.integrity: expected object`);
	const reasoningTokenCount = readOptionalNumber(value, source, "reasoningTokenCount");
	return {
		runId: readString(value, source, "runId"),
		agentId: readString(value, source, "agentId"),
		task: readString(value, source, "task"),
		endpointId: readString(value, source, "endpointId"),
		wireModelId: readString(value, source, "wireModelId"),
		runtimeId: readString(value, source, "runtimeId"),
		runtimeKind: readRunKind(value, source, "runtimeKind"),
		startedAt: readString(value, source, "startedAt"),
		endedAt: readString(value, source, "endedAt"),
		exitCode: readNumber(value, source, "exitCode"),
		tokenCount: readNumber(value, source, "tokenCount"),
		...(reasoningTokenCount !== undefined ? { reasoningTokenCount } : {}),
		costUsd: readNumber(value, source, "costUsd"),
		compiledPromptHash: readNullableString(value, source, "compiledPromptHash"),
		staticCompositionHash: readNullableString(value, source, "staticCompositionHash"),
		clioVersion: readString(value, source, "clioVersion"),
		piMonoVersion: readString(value, source, "piMonoVersion"),
		platform: readString(value, source, "platform"),
		nodeVersion: readString(value, source, "nodeVersion"),
		toolCalls: readNumber(value, source, "toolCalls"),
		toolStats: readToolStats(value, source, "toolStats"),
		sessionId: readNullableString(value, source, "sessionId"),
		integrity: {
			version: readNumber(integrity, `${source}.integrity`, "version") as 1,
			algorithm: readString(integrity, `${source}.integrity`, "algorithm") as "sha256",
			digest: readString(integrity, `${source}.integrity`, "digest"),
		},
	};
}

function readToolStats(record: Record<string, unknown>, source: string, field: string): ToolCallStat[] {
	const value = record[field];
	if (!Array.isArray(value)) throw new Error(`${source}.${field}: expected array`);
	return value.map((entry, index) => {
		const itemSource = `${source}.${field}[${index}]`;
		if (!isRecord(entry)) throw new Error(`${itemSource}: expected object`);
		return {
			tool: readString(entry, itemSource, "tool"),
			count: readNumber(entry, itemSource, "count"),
			ok: readNumber(entry, itemSource, "ok"),
			errors: readNumber(entry, itemSource, "errors"),
			blocked: readNumber(entry, itemSource, "blocked"),
			totalDurationMs: readNumber(entry, itemSource, "totalDurationMs"),
		};
	});
}

function readRunKind(record: Record<string, unknown>, source: string, field: string): RunKind {
	const value = readString(record, source, field);
	if (value !== "http" && value !== "subprocess" && value !== "sdk") {
		throw new Error(`${source}.${field}: expected http, subprocess, or sdk`);
	}
	return value;
}

function readRunStatus(record: Record<string, unknown>, source: string, field: string): RunStatus {
	const value = readString(record, source, field);
	if (
		value !== "queued" &&
		value !== "running" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "interrupted" &&
		value !== "stale" &&
		value !== "dead"
	) {
		throw new Error(`${source}.${field}: unexpected status`);
	}
	return value;
}

function readString(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readNullableString(record: Record<string, unknown>, source: string, field: string): string | null {
	const value = record[field];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`${source}.${field}: expected string or null`);
	return value;
}

function readNumber(record: Record<string, unknown>, source: string, field: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${field}: expected number`);
	return value;
}

function readOptionalNumber(record: Record<string, unknown>, source: string, field: string): number | undefined {
	if (!(field in record)) return undefined;
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${field}: expected number`);
	return value;
}

function readNullableNumber(record: Record<string, unknown>, source: string, field: string): number | null {
	const value = record[field];
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`${source}.${field}: expected number or null`);
	return value;
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value === "string") return value;
	return undefined;
}

const MESSAGE_ROLES: ReadonlySet<MessageRole> = new Set([
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"system",
	"checkpoint",
]);

function readOptionalMessageRole(value: unknown): MessageRole | null {
	if (typeof value !== "string") return null;
	return MESSAGE_ROLES.has(value as MessageRole) ? (value as MessageRole) : null;
}

function parseJson(raw: string, source: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${source}: invalid JSON: ${message}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
	return isRecord(payload) ? payload : null;
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (trimmed.length === 0) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function firstContentBlock(payload: unknown, type: string): Record<string, unknown> | null {
	const obj = payloadObject(payload);
	const content = obj?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === type) return block;
	}
	return null;
}

function extractTextFromPayload(payload: unknown): string {
	if (typeof payload === "string") return payload;
	const obj = payloadObject(payload);
	if (obj === null) return "";
	if (typeof obj.text === "string") return obj.text;
	if (Array.isArray(obj.content)) {
		const parts: string[] = [];
		for (const block of obj.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		return parts.join("\n");
	}
	return "";
}

function previewUnknown(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return truncateText(collapseWhitespace(value), TOOL_PREVIEW_MAX_CHARS);
	try {
		const text = JSON.stringify(value);
		return text === undefined ? "" : truncateText(collapseWhitespace(text), TOOL_PREVIEW_MAX_CHARS);
	} catch {
		return truncateText(collapseWhitespace(String(value)), TOOL_PREVIEW_MAX_CHARS);
	}
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, rows: ReadonlyArray<unknown>): Promise<void> {
	await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length === 0 ? "" : "\n"), "utf8");
}

function durationMs(startedAt: string, endedAt: string | null): number {
	if (endedAt === null) return 0;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
	return end - start;
}

function earliest(values: ReadonlyArray<string>): string | null {
	if (values.length === 0) return null;
	return [...values].sort(compareStrings)[0] ?? null;
}

function latest(values: ReadonlyArray<string>): string | null {
	if (values.length === 0) return null;
	return [...values].sort(compareStrings).at(-1) ?? null;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function uniqueTags(values: ReadonlyArray<EvidenceTag>): EvidenceTag[] {
	return [...new Set(values)].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function compareNullableStrings(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return compareStrings(a, b);
}

function compareRuns(a: RunEnvelope, b: RunEnvelope): number {
	const byStart = compareStrings(a.startedAt, b.startedAt);
	if (byStart !== 0) return byStart;
	return compareStrings(a.id, b.id);
}

function compareToolStats(a: ToolCallStat, b: ToolCallStat): number {
	return compareStrings(a.tool, b.tool);
}

function compareEvidenceToolEvents(a: EvidenceToolEvent, b: EvidenceToolEvent): number {
	const byTimestamp = compareNullableStrings(a.timestamp ?? null, b.timestamp ?? null);
	if (byTimestamp !== 0) return byTimestamp;
	const byRun = compareNullableStrings(a.runId, b.runId);
	if (byRun !== 0) return byRun;
	const bySession = compareNullableStrings(a.sessionId, b.sessionId);
	if (bySession !== 0) return bySession;
	const byTool = compareStrings(a.tool, b.tool);
	if (byTool !== 0) return byTool;
	return compareNullableStrings(a.toolCallId ?? null, b.toolCallId ?? null);
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}

function sanitizeEvidenceId(value: string): string {
	const clean = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean.length === 0 ? "unknown" : clean;
}
