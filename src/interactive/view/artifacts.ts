import { createReadStream, readFileSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { isReceiptIntegrity, verifyReceiptIntegrity } from "../../domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../../domains/dispatch/types.js";
import { evidenceDirectory, inspectEvidence, listEvidenceOverviews } from "../../domains/evidence/store.js";
import { formatTrustSummaryLine, trustStateWord } from "../../domains/evidence/trust-projection.js";
import {
	inspectRunReceiptTrustStatus,
	type ReceiptIntegrityOutcome,
	retiredReceiptIntegrity,
	retiredReceiptIntegrityReason,
	TRUST_STATUS_AXES,
	type TrustStatusAxis,
} from "../../domains/evidence/trust-status.js";
import type { EvidenceFinding, EvidenceOverview, EvidenceSource } from "../../domains/evidence/types.js";
import { type AccountabilitySummary, readAccountabilitySummary } from "../../domains/observability/index.js";
import type {
	BashExecutionEntry,
	MessageEntry,
	ProtectedArtifactEntry,
	SessionEntry,
	TaskLedgerEntry,
	TaskLedgerGoal,
	TaskLedgerValidationEvidence,
} from "../../domains/session/entries.js";
import {
	type AuditJsonRow,
	type AuditReadResult,
	readAuditRows,
	type SessionMeta,
} from "../../domains/session/index.js";
import {
	getPromptManifestFilePath,
	readPromptCompileManifest,
	type SessionPromptCompileRecord,
} from "../../domains/session/prompt-manifest.js";
import { foldSessionArtifacts, resolveSessionArtifactPath } from "../../domains/session/session-artifacts.js";
import { filterEntriesToActivePath } from "../../domains/session/tree/active-path.js";
import { formatUsd } from "../footer/widgets.js";
import { formatFooterTokens } from "../footer-panel.js";
import { clockLocal } from "../format-time.js";
import { abbreviateModelId } from "../theme/index.js";

export type ViewArtifactCategory =
	| "accountability"
	| "evidence"
	| "receipt"
	| "dispatch"
	| "task-ledger"
	| "workspace"
	| "tool-output"
	| "protected-artifact"
	| "compaction"
	| "prompt-manifest"
	| "audit";
export type ViewArtifactFormat = "markdown" | "text" | "json";

export interface ViewArtifactLoadResult {
	lines: string[];
	format: ViewArtifactFormat;
}

export interface ViewArtifact {
	id: string;
	category: ViewArtifactCategory;
	title: string;
	timestamp: number;
	sizeBytes?: number | undefined;
	/** Absolute backing path when one exists. Session-entry artifacts point at current.jsonl. */
	path?: string | undefined;
	description?: string;
	runId?: string;
	sessionId?: string;
	correlationId?: string;
	toolName?: string;
	searchText?: readonly string[];
	load(): Promise<ViewArtifactLoadResult>;
	verify?(): Promise<ViewArtifactVerification>;
}

export interface ArtifactProvider {
	category: ViewArtifactCategory;
	list(): Promise<ViewArtifact[]>;
}

export interface ArtifactProviderDeps {
	stateDir: string;
	dataDir?: string | undefined;
	dispatch?: Pick<DispatchContract, "listRuns" | "getRun"> | undefined;
	sessionMeta?: SessionMeta | null | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
}

export const VIEW_ARTIFACT_CATEGORIES: readonly ViewArtifactCategory[] = [
	"accountability",
	"evidence",
	"receipt",
	"dispatch",
	"task-ledger",
	"workspace",
	"tool-output",
	"protected-artifact",
	"compaction",
	"prompt-manifest",
	"audit",
] as const;

/** Cap on failure-cause tags rendered in the accountability artifact. */
const ACCOUNTABILITY_TOP_CAUSES = 8;

export const VIEW_ARTIFACT_LINE_CAP = 50_000;
const JSON_PRETTY_MAX_BYTES = 10 * 1024 * 1024;

export type ReceiptVerifyResult = ReceiptIntegrityOutcome;

export interface ReceiptVerificationCheck {
	name: string;
	ok: boolean;
	evidence: string;
}

export type ReceiptVerificationReport = ReceiptIntegrityOutcome & {
	receiptPath: string;
	sealedDigest: string | null;
	trustSummary: string | null;
	compromised: boolean;
	checks: ReceiptVerificationCheck[];
};

/**
 * What a verify action reports. `retired` marks a seal this build does not
 * verify because its integrity version was retired: not a pass, and not the
 * failure a tampered receipt reports.
 */
export type ViewArtifactVerification = { ok: true; detail: string } | { ok: false; detail: string; retired?: true };

const RECEIPT_REQUIRED_KEYS = [
	"runId",
	"agentId",
	"task",
	"targetId",
	"wireModelId",
	"runtimeId",
	"runtimeKind",
	"startedAt",
	"endedAt",
	"exitCode",
	"tokenCount",
	"costUsd",
	"compiledPromptHash",
	"staticCompositionHash",
	"clioVersion",
	"piMonoVersion",
	"platform",
	"nodeVersion",
	"toolCalls",
	"toolStats",
	"sessionId",
	"integrity",
] as const;

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso8601(value: unknown): value is string {
	return typeof value === "string" && ISO_8601_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function parseTime(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatLocalTime(value: string | null | undefined): string {
	const timestamp = parseTime(value);
	return timestamp <= 0 ? "unknown time" : clockLocal(timestamp);
}

function safeTitle(value: string, fallback: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function shortValue(value: string, maxLength = 12): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (trimmed.length <= maxLength) return trimmed;
	return trimmed.slice(0, maxLength);
}

function formatList(values: ReadonlyArray<string>, fallback = "none"): string {
	const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
	return cleaned.length > 0 ? cleaned.join(", ") : fallback;
}

function formatOptionalString(value: string | null | undefined, fallback = "none"): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function formatDurationMs(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "unknown";
	if (value < 1000) return `${Math.round(value)}ms`;
	const seconds = value / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return `${minutes}m ${remainder}s`;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function maybeSizeBytes(path: string): number | undefined {
	try {
		const info = statSync(path);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
}

function sessionCurrentPath(stateDir: string, meta: SessionMeta | null | undefined): string | undefined {
	if (!meta) return undefined;
	return join(stateDir, "sessions", meta.cwdHash, meta.id, "current.jsonl");
}

function protectedArtifactPath(path: string): string | undefined {
	return isAbsolute(path) ? path : undefined;
}

export function receiptFilePath(stateDir: string, runId: string): string {
	return join(stateDir, "receipts", `${runId}.json`);
}

export function runLedgerPath(stateDir: string): string {
	return join(stateDir, "runs.json");
}

function readRunLedger(stateDir: string): RunEnvelope[] {
	try {
		const raw = readFileSync(runLedgerPath(stateDir), "utf8").trim();
		if (raw.length === 0) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed.filter(isRecord) as unknown as RunEnvelope[]) : [];
	} catch {
		return [];
	}
}

function listRunEnvelopes(deps: ArtifactProviderDeps): RunEnvelope[] {
	// The in-process dispatch ledger only sees runs created by this process.
	// A headless `clio-coder run` in another process writes runs.json and receipts/
	// directly, so every listing re-reads the disk ledger and merges runs the
	// in-memory mirror has not hydrated.
	let fromMemory: RunEnvelope[] = [];
	try {
		fromMemory = [...(deps.dispatch?.listRuns() ?? [])];
	} catch {
		fromMemory = [];
	}
	const seen = new Set(fromMemory.map((env) => env.id));
	const fromDisk = readRunLedger(deps.stateDir).filter((env) => !seen.has(env.id));
	return [...fromMemory, ...fromDisk];
}

function validateToolStats(value: unknown): ReceiptVerifyResult {
	if (!Array.isArray(value)) {
		return { ok: false, reason: `toolStats not an array: ${String(value)}` };
	}
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (!isRecord(entry)) {
			return { ok: false, reason: `toolStats[${i}] not an object` };
		}
		if (!isNonEmptyString(entry.tool)) {
			return { ok: false, reason: `toolStats[${i}].tool invalid: ${String(entry.tool)}` };
		}
		for (const key of ["count", "ok", "errors", "blocked"] as const) {
			if (!isNonNegativeInteger(entry[key])) {
				return { ok: false, reason: `toolStats[${i}].${key} invalid: ${String(entry[key])}` };
			}
		}
		if (!isNonNegativeFiniteNumber(entry.totalDurationMs)) {
			return { ok: false, reason: `toolStats[${i}].totalDurationMs invalid: ${String(entry.totalDurationMs)}` };
		}
	}
	return { ok: true };
}

type ReadLedgerResult = { ok: true; envelope: RunEnvelope } | { ok: false; reason: string };

/**
 * The canonical trust line for a receipt the integrity verifier just accepted:
 * the same file and ledger row, projected through the shared boundary so the
 * receipt view spells its verdict exactly as the board and the CLI do.
 */
export function receiptTrustDetail(stateDir: string, runId: string): string {
	try {
		const receipt = JSON.parse(readFileSync(receiptFilePath(stateDir, runId), "utf8")) as RunReceipt;
		const ledger = readRunEnvelope(stateDir, runId);
		return formatTrustSummaryLine(inspectRunReceiptTrustStatus(receipt, ledger.ok ? ledger.envelope : null).status);
	} catch {
		return "integrity verified; trust status unreadable";
	}
}

function readRunEnvelope(stateDir: string, runId: string): ReadLedgerResult {
	const runs = readRunLedger(stateDir);
	for (const entry of runs) {
		if (entry.id === runId) return { ok: true, envelope: entry };
	}
	return { ok: false, reason: runs.length === 0 ? "run ledger not found" : "run not found in ledger" };
}

export function verifyReceiptFile(stateDir: string, runId: string): ReceiptVerifyResult {
	const target = receiptFilePath(stateDir, runId);
	let raw: string;
	try {
		raw = readFileSync(target, "utf8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return { ok: false, reason: "receipt file not found" };
		return { ok: false, reason: `read error: ${e.message ?? String(e)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `invalid json: ${(err as Error).message}` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, reason: "receipt is not an object" };
	}
	const r = parsed;
	for (const key of RECEIPT_REQUIRED_KEYS) {
		if (!(key in r)) return { ok: false, reason: `missing field: ${key}` };
	}
	if (!isNonEmptyString(r.runId)) {
		return { ok: false, reason: `runId invalid: ${String(r.runId)}` };
	}
	if (r.runId !== runId) {
		return { ok: false, reason: `runId mismatch: file has ${String(r.runId)}` };
	}
	if (!isNonEmptyString(r.agentId)) {
		return { ok: false, reason: `agentId invalid: ${String(r.agentId)}` };
	}
	if (!isNonEmptyString(r.task)) {
		return { ok: false, reason: `task invalid: ${String(r.task)}` };
	}
	if (!isNonEmptyString(r.targetId)) {
		return { ok: false, reason: `targetId invalid: ${String(r.targetId)}` };
	}
	if (!isNonEmptyString(r.wireModelId)) {
		return { ok: false, reason: `wireModelId invalid: ${String(r.wireModelId)}` };
	}
	if (!isNonEmptyString(r.runtimeId)) {
		return { ok: false, reason: `runtimeId invalid: ${String(r.runtimeId)}` };
	}
	if (
		r.runtimeKind !== "http" &&
		r.runtimeKind !== "sdk" &&
		r.runtimeKind !== "subprocess" &&
		r.runtimeKind !== "acp-delegation"
	) {
		return { ok: false, reason: `runtimeKind invalid: ${String(r.runtimeKind)}` };
	}
	const exitCode = r.exitCode;
	if (typeof exitCode !== "number" || !(exitCode === 0 || exitCode === 1 || exitCode === 2)) {
		return { ok: false, reason: `exitCode out of range: ${String(exitCode)}` };
	}
	const tokenCount = r.tokenCount;
	if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) {
		return { ok: false, reason: `tokenCount out of range: ${String(tokenCount)}` };
	}
	for (const key of ["inputTokenCount", "outputTokenCount", "cacheReadTokenCount", "cacheWriteTokenCount"] as const) {
		if (key in r && !isNonNegativeFiniteNumber(r[key])) {
			return { ok: false, reason: `${key} out of range: ${String(r[key])}` };
		}
	}
	const costUsd = r.costUsd;
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
		return { ok: false, reason: `costUsd out of range: ${String(costUsd)}` };
	}
	if ("reasoningTokenCount" in r && !isNonNegativeFiniteNumber(r.reasoningTokenCount)) {
		return { ok: false, reason: `reasoningTokenCount out of range: ${String(r.reasoningTokenCount)}` };
	}
	if (!isIso8601(r.startedAt)) {
		return { ok: false, reason: `startedAt not ISO-8601: ${String(r.startedAt)}` };
	}
	if (!isIso8601(r.endedAt)) {
		return { ok: false, reason: `endedAt not ISO-8601: ${String(r.endedAt)}` };
	}
	if (typeof r.clioVersion !== "string" || r.clioVersion.length === 0) {
		return { ok: false, reason: "clioVersion empty" };
	}
	if (!isNonEmptyString(r.piMonoVersion)) {
		return { ok: false, reason: `piMonoVersion invalid: ${String(r.piMonoVersion)}` };
	}
	if (!isNonEmptyString(r.platform)) {
		return { ok: false, reason: `platform invalid: ${String(r.platform)}` };
	}
	if (!isNonEmptyString(r.nodeVersion)) {
		return { ok: false, reason: `nodeVersion invalid: ${String(r.nodeVersion)}` };
	}
	if (typeof r.toolCalls !== "number" || !Number.isInteger(r.toolCalls) || r.toolCalls < 0) {
		return { ok: false, reason: `toolCalls out of range: ${String(r.toolCalls)}` };
	}
	const toolStatsCheck = validateToolStats(r.toolStats);
	if (!toolStatsCheck.ok) return toolStatsCheck;
	if (!isNullableString(r.compiledPromptHash)) {
		return { ok: false, reason: `compiledPromptHash invalid: ${String(r.compiledPromptHash)}` };
	}
	if (!isNullableString(r.staticCompositionHash)) {
		return { ok: false, reason: `staticCompositionHash invalid: ${String(r.staticCompositionHash)}` };
	}
	if (!isNullableString(r.sessionId)) {
		return { ok: false, reason: `sessionId invalid: ${String(r.sessionId)}` };
	}
	// A retired seal is diagnosed ahead of the shape check, which would
	// otherwise report the older version as an invalid integrity block.
	const retired = retiredReceiptIntegrity(r.integrity);
	if (retired !== null) return { ok: false, reason: retiredReceiptIntegrityReason(retired), retired };
	if (!isReceiptIntegrity(r.integrity)) {
		return { ok: false, reason: "integrity invalid" };
	}
	const ledger = readRunEnvelope(stateDir, runId);
	if (!ledger.ok) return ledger;
	return verifyReceiptIntegrity(r as unknown as RunReceipt, ledger.envelope);
}

const RECEIPT_FILE_FAILURE = /^(?:receipt file not found|read error:)/u;
const RECEIPT_CONTRACT_FAILURE =
	/^(?:invalid json:|receipt is not an object|missing field:|runId invalid:|runId mismatch:|agentId invalid:|task invalid:|targetId invalid:|wireModelId invalid:|runtimeId invalid:|runtimeKind invalid:|exitCode out of range:|tokenCount out of range:|inputTokenCount out of range:|outputTokenCount out of range:|cacheReadTokenCount out of range:|cacheWriteTokenCount out of range:|costUsd out of range:|reasoningTokenCount out of range:|startedAt not ISO-8601:|endedAt not ISO-8601:|clioVersion empty|piMonoVersion invalid:|platform invalid:|nodeVersion invalid:|toolCalls out of range:|toolStats\[|compiledPromptHash invalid:|staticCompositionHash invalid:|sessionId invalid:|integrity invalid|execution role invalid|routing intent invalid|route decision invalid)/u;
const LEDGER_FAILURE = /^(?:run ledger not found|run not found in ledger|ledger mismatch:)/u;

function receiptIntegrityDigest(value: unknown): string | null {
	if (!isRecord(value) || value.algorithm !== "sha256" || !isNonEmptyString(value.digest)) return null;
	return `sha256:${value.digest}`;
}

function trustCheckEvidence(status: ReturnType<typeof inspectRunReceiptTrustStatus>["status"], axis: string): string {
	const entry = status[axis as keyof typeof status];
	if (typeof entry !== "object" || entry === null || !("state" in entry)) return "canonical trust projection";
	if (entry.state === "absent") return `reason=${entry.reason}`;
	const refs = entry.artifacts.map((artifact) => `${artifact.kind}:${artifact.id}`);
	return refs.length > 0 ? refs.join(", ") : `${entry.authority.kind}:${entry.authority.id}`;
}

function compromisedTrustAxes(status: ReturnType<typeof inspectRunReceiptTrustStatus>["status"]): TrustStatusAxis[] {
	return TRUST_STATUS_AXES.filter((axis) => {
		const state = status[axis].state;
		if (axis === "artifactIntegrity") return state === "failed";
		if (axis === "validationGrounding") return state === "failed" || state === "ungrounded";
		if (axis === "independentReview") return state === "failed" || state === "not_independent";
		if (axis === "contextProvenance") return state === "invalid";
		if (axis === "autonomyEnforcement") return state === "bypassed";
		return false;
	});
}

/** Actionable `/view verify` report without changing the low-level verifier contract. */
export function verifyReceiptFileReport(stateDir: string, runId: string): ReceiptVerificationReport {
	const receiptPath = receiptFilePath(stateDir, runId);
	const result = verifyReceiptFile(stateDir, runId);
	let receipt: RunReceipt | null = null;
	try {
		receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RunReceipt;
	} catch {
		// The verifier's named file or JSON check below retains the actionable error.
	}
	const sealedDigest = receiptIntegrityDigest(receipt?.integrity);
	const ledger = readRunEnvelope(stateDir, runId);
	const inspection = receipt === null ? null : inspectRunReceiptTrustStatus(receipt, ledger.ok ? ledger.envelope : null);
	const trustSummary = inspection === null ? null : formatTrustSummaryLine(inspection.status);
	const compromiseAxes = inspection === null ? [] : compromisedTrustAxes(inspection.status);
	const checks: ReceiptVerificationCheck[] = [];

	if (!result.ok && RECEIPT_FILE_FAILURE.test(result.reason)) {
		checks.push({ name: "receipt file", ok: false, evidence: `${receiptPath}: ${result.reason}` });
	} else {
		checks.push({ name: "receipt file", ok: true, evidence: receiptPath });
		if (!result.ok && (RECEIPT_CONTRACT_FAILURE.test(result.reason) || result.retired !== undefined)) {
			checks.push({ name: "receipt contract", ok: false, evidence: result.reason });
		} else {
			checks.push({
				name: "receipt contract",
				ok: true,
				evidence: `current integrity v${receipt?.integrity.version ?? "unknown"}`,
			});
			if (!result.ok && LEDGER_FAILURE.test(result.reason)) {
				checks.push({ name: "run ledger", ok: false, evidence: result.reason });
			} else {
				checks.push({ name: "run ledger", ok: true, evidence: `run ${runId} fields match` });
				checks.push({
					name: "sealed digest",
					ok: result.ok,
					evidence: result.ok ? `${sealedDigest ?? "digest unavailable"} matches receipt and ledger` : result.reason,
				});
			}
		}
	}

	if (inspection !== null) {
		for (const axis of compromiseAxes) {
			checks.push({
				name: `trust ${axis}`,
				ok: false,
				evidence: `${trustStateWord(axis, inspection.status[axis].state)}; ${trustCheckEvidence(inspection.status, axis)}`,
			});
		}
	}

	return {
		...result,
		receiptPath,
		sealedDigest,
		trustSummary,
		compromised: compromiseAxes.length > 0,
		checks,
	};
}

function pushCapped(lines: string[], line: string, maxLines: number): boolean {
	if (lines.length >= maxLines) return false;
	lines.push(line);
	return lines.length < maxLines;
}

async function readTextFileLinesCapped(
	path: string,
	maxLines = VIEW_ARTIFACT_LINE_CAP,
): Promise<{ lines: string[]; truncated: boolean }> {
	const lines: string[] = [];
	let pending = "";
	let truncated = false;
	const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
	outer: for await (const chunk of stream) {
		pending += chunk;
		for (;;) {
			const nextBreak = pending.indexOf("\n");
			if (nextBreak < 0) break;
			const line = pending.slice(0, nextBreak).replace(/\r$/, "");
			pending = pending.slice(nextBreak + 1);
			if (!pushCapped(lines, line, maxLines)) {
				truncated = true;
				stream.destroy();
				break outer;
			}
		}
	}
	if (!truncated && pending.length > 0 && !pushCapped(lines, pending.replace(/\r$/, ""), maxLines)) {
		truncated = true;
	}
	if (truncated) {
		lines.push(`[truncated, open file directly: ${path}]`);
	}
	return { lines, truncated };
}

function splitLinesCapped(text: string, path?: string, maxLines = VIEW_ARTIFACT_LINE_CAP): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines), `[truncated, open file directly${path ? `: ${path}` : ""}]`];
}

export async function loadJsonFileLines(path: string): Promise<ViewArtifactLoadResult> {
	let canPrettyPrint = false;
	try {
		const info = await stat(path);
		canPrettyPrint = info.size <= JSON_PRETTY_MAX_BYTES;
	} catch {
		return { lines: [`unable to read ${path}`], format: "text" };
	}
	if (canPrettyPrint) {
		try {
			const raw = await readFile(path, "utf8");
			const pretty = JSON.stringify(JSON.parse(raw), null, 2);
			return { lines: splitLinesCapped(pretty, path), format: "json" };
		} catch {
			return loadTextPath(path);
		}
	}
	const { lines } = await readTextFileLinesCapped(path);
	return { lines, format: "json" };
}

async function loadTextPath(path: string): Promise<ViewArtifactLoadResult> {
	try {
		const { lines } = await readTextFileLinesCapped(path);
		return { lines, format: "text" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { lines: [`unable to read ${path}: ${message}`], format: "text" };
	}
}

function evidenceBundlePath(dataDir: string, evidenceId: string): string | undefined {
	try {
		return evidenceDirectory(dataDir, evidenceId);
	} catch {
		return undefined;
	}
}

function evidenceSourceLabel(source: EvidenceSource): string {
	switch (source.kind) {
		case "run":
			return `run ${source.runId}`;
		case "session":
			return `session ${source.sessionId}`;
		case "eval":
			return `eval ${source.evalId}`;
	}
}

function evidenceSourceTitle(source: EvidenceSource): string {
	switch (source.kind) {
		case "run":
			return `run ${shortValue(source.runId)}`;
		case "session":
			return `session ${shortValue(source.sessionId)}`;
		case "eval":
			return `eval ${shortValue(source.evalId)}`;
	}
}

function renderEvidenceMarkdown(
	overview: EvidenceOverview,
	findings: ReadonlyArray<EvidenceFinding>,
	path: string | undefined,
	loadError?: string,
): string[] {
	const lines = [
		"# Evidence Bundle",
		"",
		`- evidence id: ${overview.evidenceId}`,
		`- source: ${evidenceSourceLabel(overview.source)}`,
		`- generated: ${overview.generatedAt}`,
		`- run ids: ${formatList(overview.runIds)}`,
		`- session id: ${formatOptionalString(overview.sessionId)}`,
		`- statuses: ${formatList(overview.statuses)}`,
		"",
		"## Tasks",
	];
	if (overview.tasks.length === 0) {
		lines.push("- none");
	} else {
		for (const task of overview.tasks) lines.push(`- ${task}`);
	}
	lines.push(
		"",
		"## Targets / Models",
		"",
		`- targets: ${formatList(overview.targetIds)}`,
		`- runtimes: ${formatList(overview.runtimeIds)}`,
		`- models: ${formatList(overview.modelIds)}`,
		`- agents: ${formatList(overview.agentIds)}`,
		"",
		"## Totals",
		"",
		`- runs: ${overview.totals.runs}`,
		`- receipts: ${overview.totals.receipts}`,
		`- tool calls: ${overview.totals.toolCalls}`,
		`- tool errors: ${overview.totals.toolErrors}`,
		`- blocked tool calls: ${overview.totals.blockedToolCalls}`,
		`- tokens: ${formatFooterTokens(overview.totals.tokens)}`,
		`- cost: ${formatUsd(overview.totals.costUsd)}`,
		`- protected artifacts: ${overview.totals.protectedArtifacts}`,
		`- wall time: ${formatDurationMs(overview.totals.wallTimeMs)}`,
		"",
		"## Tags",
	);
	if (overview.tags.length === 0) {
		lines.push("- none");
	} else {
		for (const tag of overview.tags) lines.push(`- ${tag}`);
	}
	lines.push("", "## Findings");
	if (findings.length === 0) {
		lines.push("- none");
	} else {
		for (const finding of findings) {
			const run = finding.runId ? ` run ${finding.runId}` : "";
			lines.push(`- ${finding.severity} ${finding.tag}${run}: ${finding.message}`);
		}
	}
	lines.push("", "## Files", "", `- backing path: ${path ?? "unknown"}`);
	if (overview.files.length === 0) {
		lines.push("- files: none");
	} else {
		for (const file of overview.files) lines.push(`- ${file}`);
	}
	if (loadError !== undefined) {
		lines.push("", "## Load Error", "", loadError);
	}
	return lines;
}

export class EvidenceArtifactProvider implements ArtifactProvider {
	readonly category = "evidence" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const dataDir = this.deps.dataDir;
		if (!dataDir) return [];
		let overviews: EvidenceOverview[];
		try {
			overviews = await listEvidenceOverviews(dataDir);
		} catch {
			return [];
		}
		return overviews.map((overview) => {
			const path = evidenceBundlePath(dataDir, overview.evidenceId);
			const artifact: ViewArtifact = {
				id: overview.evidenceId,
				category: this.category,
				title: safeTitle(`Evidence · ${evidenceSourceTitle(overview.source)}`, "Evidence bundle"),
				timestamp: parseTime(overview.generatedAt),
				searchText: [
					overview.evidenceId,
					evidenceSourceTitle(overview.source),
					...overview.runIds,
					...(overview.sessionId ? [overview.sessionId] : []),
					...overview.tasks,
					...overview.cwds,
					...overview.agentIds,
					...overview.targetIds,
					...overview.runtimeIds,
					...overview.modelIds,
					...overview.statuses,
					...overview.tags,
					...overview.files,
				],
				load: async () => {
					try {
						const inspected = await inspectEvidence(dataDir, overview.evidenceId);
						return {
							format: "markdown" as const,
							lines: renderEvidenceMarkdown(inspected.overview, inspected.findings, path),
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							format: "markdown" as const,
							lines: renderEvidenceMarkdown(overview, [], path, `unable to inspect evidence: ${message}`),
						};
					}
				},
			};
			if (path !== undefined) artifact.path = path;
			if (overview.runIds.length === 1 && overview.runIds[0] !== undefined) artifact.runId = overview.runIds[0];
			if (overview.sessionId !== null) artifact.sessionId = overview.sessionId;
			return artifact;
		});
	}
}

function receiptTitle(env: RunEnvelope): string {
	return safeTitle(`${env.agentId} · ${env.task}`, env.id);
}

export class ReceiptArtifactProvider implements ArtifactProvider {
	readonly category = "receipt" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const runs = listRunEnvelopes(this.deps);
		return runs
			.filter(
				(env) => env.receiptPath !== null || maybeSizeBytes(receiptFilePath(this.deps.stateDir, env.id)) !== undefined,
			)
			.map((env) => {
				const path = env.receiptPath ?? receiptFilePath(this.deps.stateDir, env.id);
				return {
					id: env.id,
					category: this.category,
					title: receiptTitle(env),
					timestamp: parseTime(env.endedAt ?? env.startedAt),
					sizeBytes: maybeSizeBytes(path),
					path,
					description: env.task,
					runId: env.id,
					...(env.sessionId ? { sessionId: env.sessionId } : {}),
					searchText: [env.id, env.agentId, env.task, env.targetId, env.runtimeId, env.runtimeKind, env.cwd],
					load: () => loadJsonFileLines(path),
					verify: async () => {
						const result = verifyReceiptFile(this.deps.stateDir, env.id);
						if (!result.ok) {
							return { ok: false, detail: result.reason, ...(result.retired !== undefined ? { retired: true } : {}) };
						}
						// "integrity verified" alone read as a verified result. The
						// canonical line says what the seal proves and what it does not.
						return { ok: true, detail: receiptTrustDetail(this.deps.stateDir, env.id) };
					},
				};
			});
	}
}

function resultText(result: unknown): string {
	if (!isRecord(result)) return "";
	if (result.kind === "ok" && typeof result.output === "string") return result.output;
	if (result.kind === "error" && typeof result.message === "string") return result.message;
	return "";
}

function resultDetails(result: unknown): Record<string, unknown> | null {
	return isRecord(result) && isRecord(result.details) ? result.details : null;
}

function messagePayload(entry: SessionEntry): Record<string, unknown> | null {
	if (entry.kind !== "message") return null;
	return isRecord(entry.payload) ? entry.payload : null;
}

function toolNameFor(entry: SessionEntry): string {
	const payload = messagePayload(entry);
	const name = payload?.toolName ?? payload?.name;
	return typeof name === "string" && name.length > 0 ? name : "tool";
}

function pathFromToolResult(entry: SessionEntry): string | null {
	const payload = messagePayload(entry);
	const details = payload ? resultDetails(payload.result) : null;
	if (!details) return null;
	for (const key of ["fullOutputPath", "outputPath", "artifactPath"] as const) {
		const value = details[key];
		if (typeof value === "string" && value.length > 0) return resolve(value);
	}
	return null;
}

function dispatchResultForRun(entries: ReadonlyArray<SessionEntry>, runId: string): string | null {
	for (const entry of entries) {
		const payload = messagePayload(entry);
		if (!payload) continue;
		const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
		if (toolName !== "dispatch") continue;
		const details = resultDetails(payload.result);
		const detailRunId = details?.runId;
		const runIds = details?.runIds;
		const matches =
			detailRunId === runId ||
			(Array.isArray(runIds) && runIds.some((item) => item === runId)) ||
			(Array.isArray(details?.runs) && details.runs.some((item) => isRecord(item) && item.runId === runId));
		if (!matches) continue;
		const text = resultText(payload.result);
		if (text.length > 0) return text;
	}
	return null;
}

function sessionEntries(deps: ArtifactProviderDeps): ReadonlyArray<SessionEntry> {
	try {
		return deps.readSessionEntries?.() ?? [];
	} catch {
		return [];
	}
}

export class DispatchArtifactProvider implements ArtifactProvider {
	readonly category = "dispatch" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const runs = listRunEnvelopes(this.deps);
		const entries = sessionEntries(this.deps);
		const ledgerPath = runLedgerPath(this.deps.stateDir);
		return runs.map((env) => {
			const receiptPath = env.receiptPath ?? receiptFilePath(this.deps.stateDir, env.id);
			const path = maybeSizeBytes(receiptPath) !== undefined ? receiptPath : ledgerPath;
			return {
				id: env.id,
				category: this.category,
				title: receiptTitle(env),
				timestamp: parseTime(env.endedAt ?? env.startedAt),
				sizeBytes: maybeSizeBytes(path),
				path,
				description: env.task,
				runId: env.id,
				...(env.sessionId ? { sessionId: env.sessionId } : {}),
				searchText: [env.id, env.agentId, env.task, env.targetId, env.runtimeId, env.runtimeKind, env.cwd],
				load: async () => {
					const text = dispatchResultForRun(entries, env.id);
					const lines = [
						`Dispatch run ${env.id}`,
						`agent: ${env.agentId}`,
						`task: ${env.task}`,
						`status: ${env.status}`,
						`outcome: ${env.outcome ?? "unknown"}`,
						`exit: ${env.exitCode ?? "?"}`,
						`target: ${env.targetId}`,
						`model: ${abbreviateModelId(env.wireModelId)}`,
						`runtime: ${env.runtimeKind}:${env.runtimeId}`,
						`started: ${formatLocalTime(env.startedAt)}`,
						`ended: ${env.endedAt ? formatLocalTime(env.endedAt) : "running"}`,
						`tokens: ${formatFooterTokens(env.tokenCount)}`,
						`cost: ${formatUsd(env.costUsd)}`,
						`receipt: ${env.receiptPath ?? receiptFilePath(this.deps.stateDir, env.id)}`,
						"",
						"agent output:",
						...(text ? text.split(/\r?\n/) : ["(no session dispatch tool output found)"]),
					];
					return { lines: splitLinesCapped(lines.join("\n"), path), format: "text" };
				},
			};
		});
	}
}

function taskLedgerStatusSummary(entry: TaskLedgerEntry): string {
	const items = [...entry.goals, ...entry.subgoals];
	if (items.length === 0) return "no goals";
	const completed = items.filter((item) => item.status === "completed").length;
	const active = items.filter((item) => item.status === "active").length;
	const blocked = items.filter((item) => item.status === "blocked").length;
	const parts = [`${completed}/${items.length} done`];
	if (active > 0) parts.push(`${active} active`);
	if (blocked > 0) parts.push(`${blocked} blocked`);
	return parts.join(" · ");
}

function taskLedgerTitle(entry: TaskLedgerEntry): string {
	const boardTitle = entry.goals[0]?.title ?? "Task ledger";
	return safeTitle(`Task ledger · ${boardTitle} · ${taskLedgerStatusSummary(entry)}`, "Task ledger");
}

function renderTaskLedgerGoals(lines: string[], heading: string, goals: ReadonlyArray<TaskLedgerGoal>): void {
	lines.push("", heading);
	if (goals.length === 0) {
		lines.push("- none");
		return;
	}
	for (const goal of goals) {
		const parent = goal.parentGoalId ? ` parent ${goal.parentGoalId}` : "";
		lines.push(`- [${goal.status}] ${goal.id} ${goal.title}${parent}`);
		if (goal.origin) lines.push(`  - origin: ${goal.origin}`);
		if (goal.userTaskId) lines.push(`  - operator task: ${goal.userTaskId}`);
		if (goal.description) lines.push(`  - description: ${goal.description}`);
	}
}

function renderValidationEvidence(lines: string[], evidence: ReadonlyArray<TaskLedgerValidationEvidence>): void {
	lines.push("", "## Required Validation Evidence");
	if (evidence.length === 0) {
		lines.push("- none");
		return;
	}
	for (const item of evidence) {
		lines.push(`- [${item.status}] ${item.id} ${item.description}`);
		if (item.command) lines.push(`  - command: ${item.command}`);
		if (item.artifactPath) lines.push(`  - artifact: ${item.artifactPath}`);
		if (item.observedAt) lines.push(`  - observed: ${item.observedAt}`);
		if (item.notes) lines.push(`  - notes: ${item.notes}`);
	}
}

function renderTaskLedgerMarkdown(entry: TaskLedgerEntry): string[] {
	const lines = [
		"# Task Ledger",
		"",
		`- turn id: ${entry.turnId}`,
		`- timestamp: ${entry.timestamp}`,
		`- status: ${taskLedgerStatusSummary(entry)}`,
	];
	if (entry.boardId) lines.push(`- board id: ${entry.boardId}`);
	renderTaskLedgerGoals(lines, "## Board Goals", entry.goals);
	renderTaskLedgerGoals(lines, "## Subgoals", entry.subgoals);
	lines.push("", "## Active Runs");
	if (entry.activeRunIds.length === 0) {
		lines.push("- none");
	} else {
		for (const runId of entry.activeRunIds) lines.push(`- ${runId}`);
	}
	renderValidationEvidence(lines, entry.requiredValidationEvidence);
	return lines;
}

export class TaskLedgerArtifactProvider implements ArtifactProvider {
	readonly category = "task-ledger" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const entries = sessionEntries(this.deps);
		const path = sessionCurrentPath(this.deps.stateDir, this.deps.sessionMeta);
		return entries
			.filter((entry): entry is TaskLedgerEntry => entry.kind === "taskLedger")
			.map((entry) => ({
				id: `task-ledger:${entry.turnId}`,
				category: this.category,
				title: taskLedgerTitle(entry),
				timestamp: parseTime(entry.timestamp),
				sizeBytes: Buffer.byteLength(JSON.stringify(entry), "utf8"),
				...(path ? { path } : {}),
				searchText: [
					entry.turnId,
					entry.boardId ?? "",
					...entry.activeRunIds,
					...entry.goals.flatMap((goal) => [
						goal.id,
						goal.title,
						goal.description ?? "",
						goal.parentGoalId ?? "",
						goal.origin ?? "agent",
						goal.userTaskId ?? "",
					]),
					...entry.subgoals.flatMap((goal) => [
						goal.id,
						goal.title,
						goal.description ?? "",
						goal.parentGoalId ?? "",
						goal.origin ?? "agent",
						goal.userTaskId ?? "",
					]),
					...entry.requiredValidationEvidence.flatMap((item) => [
						item.id,
						item.description,
						item.command ?? "",
						item.artifactPath ?? "",
						item.notes ?? "",
					]),
				].filter(isNonEmptyString),
				load: async () => ({
					format: "markdown" as const,
					lines: renderTaskLedgerMarkdown(entry),
				}),
			}));
	}
}

function workspaceArtifactFormat(path: string): ViewArtifactFormat {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : "text";
}

class WorkspaceArtifactContainmentError extends Error {}

async function canonicalWorkspaceArtifactPath(path: string, workspace: string): Promise<string> {
	// Resolve both sides from the live filesystem for every load. The artifact
	// row is durable, but neither an earlier lexical check nor an earlier realpath
	// result is authority after a symlink has changed.
	const canonicalWorkspace = await realpath(workspace);
	const canonicalTarget = await realpath(path);
	const rel = relative(canonicalWorkspace, canonicalTarget);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new WorkspaceArtifactContainmentError("canonical target is outside the recorded workspace");
	}
	return canonicalTarget;
}

async function loadWorkspaceArtifact(
	path: string,
	workspace: string,
	recordedAt: string,
): Promise<ViewArtifactLoadResult> {
	try {
		const canonicalPath = await canonicalWorkspaceArtifactPath(path, workspace);
		const { lines } = await readTextFileLinesCapped(canonicalPath);
		return { lines, format: workspaceArtifactFormat(path) };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return { lines: [`file no longer on disk (recorded at ${recordedAt})`], format: "text" };
		}
		if (error instanceof WorkspaceArtifactContainmentError) {
			return { lines: [`refusing to read ${path}: ${error.message}`], format: "text" };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { lines: [`unable to read ${path}: ${message}`], format: "text" };
	}
}

/** Files successfully produced by artifact/write/edit on the active session branch. */
export class WorkspaceArtifactProvider implements ArtifactProvider {
	readonly category = "workspace" as const;
	private readonly entries: ReadonlyArray<SessionEntry>;

	constructor(private readonly deps: ArtifactProviderDeps) {
		const entries = [...sessionEntries(deps)];
		this.entries = filterEntriesToActivePath(entries, deps.sessionMeta?.pinnedLeafTurnId ?? undefined);
	}

	async list(): Promise<ViewArtifact[]> {
		const workspace = this.deps.sessionMeta?.cwd;
		if (!workspace) return [];
		return foldSessionArtifacts(this.entries, { workspace }).flatMap((artifact) => {
			const path = resolveSessionArtifactPath(artifact.path, workspace);
			if (path === null) return [];
			const kind = artifact.artifactKind ? ` · ${artifact.artifactKind}` : "";
			const overwriteLabel = `${artifact.overwrites} overwrite${artifact.overwrites === 1 ? "" : "s"}`;
			return [
				{
					id: `workspace:${path}`,
					category: this.category,
					title: safeTitle(`${artifact.path} · ${artifact.tool}${kind}`, artifact.path),
					timestamp: parseTime(artifact.timestamp),
					sizeBytes: maybeSizeBytes(path),
					path,
					description: `${artifact.tool}${kind} · ${overwriteLabel}`,
					toolName: artifact.tool,
					searchText: [
						artifact.path,
						path,
						basename(path),
						artifact.tool,
						artifact.artifactKind ?? "",
						overwriteLabel,
						String(artifact.overwrites),
						artifact.turnId,
					].filter(isNonEmptyString),
					load: () => loadWorkspaceArtifact(path, workspace, artifact.timestamp),
				},
			];
		});
	}
}

export class ToolOutputArtifactProvider implements ArtifactProvider {
	readonly category = "tool-output" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const entries = sessionEntries(this.deps);
		const out: ViewArtifact[] = [];
		const seen = new Set<string>();
		for (const entry of entries) {
			if (entry.kind === "bashExecution" && entry.fullOutputPath) {
				const artifact = this.bashArtifact(entry);
				if (!seen.has(artifact.path ?? artifact.id)) {
					seen.add(artifact.path ?? artifact.id);
					out.push(artifact);
				}
				continue;
			}
			if (entry.kind !== "message" || entry.role !== "tool_result") continue;
			const path = pathFromToolResult(entry);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			out.push(this.toolResultArtifact(entry, path));
		}
		return out;
	}

	private bashArtifact(entry: BashExecutionEntry): ViewArtifact {
		const path = resolve(entry.fullOutputPath ?? "");
		return {
			id: `bash:${entry.turnId}`,
			category: this.category,
			title: safeTitle(`Bash · ${entry.command}`, "Bash output"),
			timestamp: parseTime(entry.timestamp),
			sizeBytes: maybeSizeBytes(path),
			path,
			toolName: "bash",
			searchText: ["bash", entry.turnId, entry.command, path, basename(path)],
			load: () => loadTextPath(path),
		};
	}

	private toolResultArtifact(entry: MessageEntry, path: string): ViewArtifact {
		const toolName = toolNameFor(entry);
		const artifact: ViewArtifact = {
			id: `tool:${entry.turnId}`,
			category: this.category,
			title: safeTitle(`${toolName} · ${basename(path)}`, `${toolName} output`),
			timestamp: parseTime(entry.timestamp),
			sizeBytes: maybeSizeBytes(path),
			path,
			toolName,
			searchText: [toolName, entry.turnId, path, basename(path)],
			load: () => loadTextPath(path),
		};
		const payload = messagePayload(entry);
		const details = payload ? resultDetails(payload.result) : null;
		const runId = readStringField(payload ?? {}, "runId") ?? readStringField(details ?? {}, "runId");
		if (runId !== null) artifact.runId = runId;
		return artifact;
	}
}

function protectedArtifactTitle(entry: ProtectedArtifactEntry): string {
	const name = basename(entry.artifact.path) || entry.artifact.path || entry.turnId;
	return safeTitle(`Protected · ${name}`, "Protected artifact");
}

function renderProtectedArtifactMarkdown(entry: ProtectedArtifactEntry): string[] {
	return [
		"# Protected Artifact",
		"",
		`- turn id: ${entry.turnId}`,
		`- action: ${entry.action}`,
		`- path: ${entry.artifact.path}`,
		`- source: ${entry.artifact.source}`,
		`- protectedAt: ${entry.artifact.protectedAt}`,
		`- reason: ${entry.artifact.reason}`,
		`- validation command: ${entry.artifact.validationCommand ?? "none"}`,
		`- validation exit code: ${entry.artifact.validationExitCode ?? "none"}`,
		`- tool name: ${entry.toolName ?? "none"}`,
		`- tool call id: ${entry.toolCallId ?? "none"}`,
		`- run id: ${entry.runId ?? "none"}`,
		`- correlation id: ${entry.correlationId ?? "none"}`,
	];
}

export class ProtectedArtifactProvider implements ArtifactProvider {
	readonly category = "protected-artifact" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const entries = sessionEntries(this.deps);
		return entries
			.filter((entry): entry is ProtectedArtifactEntry => entry.kind === "protectedArtifact")
			.map((entry) => {
				const path = protectedArtifactPath(entry.artifact.path);
				const artifact: ViewArtifact = {
					id: `protected:${entry.turnId}`,
					category: this.category,
					title: protectedArtifactTitle(entry),
					timestamp: parseTime(entry.timestamp),
					sizeBytes: path ? maybeSizeBytes(path) : Buffer.byteLength(JSON.stringify(entry), "utf8"),
					description: entry.artifact.reason,
					...(entry.runId ? { runId: entry.runId } : {}),
					...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
					...(entry.toolName ? { toolName: entry.toolName } : {}),
					searchText: [
						entry.turnId,
						entry.parentTurnId ?? "",
						entry.artifact.path,
						entry.artifact.source,
						entry.artifact.reason,
						entry.artifact.validationCommand ?? "",
						entry.toolName ?? "",
						entry.toolCallId ?? "",
						entry.runId ?? "",
						entry.correlationId ?? "",
					].filter(isNonEmptyString),
					load: async () => ({
						format: "markdown" as const,
						lines: renderProtectedArtifactMarkdown(entry),
					}),
				};
				if (path !== undefined) artifact.path = path;
				return artifact;
			});
	}
}

export class CompactionArtifactProvider implements ArtifactProvider {
	readonly category = "compaction" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const entries = sessionEntries(this.deps);
		const path = sessionCurrentPath(this.deps.stateDir, this.deps.sessionMeta);
		return entries
			.filter((entry) => entry.kind === "compactionSummary")
			.map((entry) => ({
				id: `compaction:${entry.turnId}`,
				category: this.category,
				title: safeTitle(`Compaction · ${entry.trigger ?? "summary"}`, "Compaction summary"),
				timestamp: parseTime(entry.timestamp),
				sizeBytes: Buffer.byteLength(entry.summary, "utf8"),
				...(path ? { path } : {}),
				load: async () => ({
					format: "markdown" as const,
					lines: [
						"# Compaction Summary",
						"",
						`- trigger: ${entry.trigger ?? "unknown"}`,
						`- tokens before: ${formatFooterTokens(entry.tokensBefore)}`,
						...(entry.tokensAfter !== undefined ? [`- tokens after: ${formatFooterTokens(entry.tokensAfter)}`] : []),
						...(entry.messagesSummarized !== undefined ? [`- messages summarized: ${entry.messagesSummarized}`] : []),
						`- continues at turn: ${entry.firstKeptTurnId}`,
						"",
						entry.summary,
					],
				}),
			}));
	}
}

function promptManifestSearchText(record: SessionPromptCompileRecord): string[] {
	return [
		record.systemPromptHash,
		record.previousHash ?? "",
		record.thinkingLevel ?? "",
		record.projectPreload?.mode ?? "",
		record.projectPreload?.reason ?? "",
		record.projectPreload?.label ?? "",
		...record.sections.map((section) => section.id),
		...record.fragments.flatMap((fragment) => [fragment.id, fragment.relPath, fragment.contentHash]),
	].filter(isNonEmptyString);
}

export class PromptManifestArtifactProvider implements ArtifactProvider {
	readonly category = "prompt-manifest" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const meta = this.deps.sessionMeta;
		if (!meta) return [];
		const path = getPromptManifestFilePath(meta, this.deps.stateDir);
		const read = readPromptCompileManifest(meta, this.deps.stateDir);
		const artifacts = read.records.map(
			(record, index): ViewArtifact => ({
				id: `prompt-manifest:${index + 1}:${shortValue(record.systemPromptHash)}`,
				category: this.category,
				title: `Prompt compile · ${shortValue(record.systemPromptHash)} · ${formatFooterTokens(record.tokenEstimate)}`,
				timestamp: parseTime(record.at),
				sizeBytes: Buffer.byteLength(JSON.stringify(record), "utf8"),
				path,
				sessionId: meta.id,
				description: `thinking ${record.thinkingLevel ?? "off"} · ${record.sections.length} sections · ${record.fragments.length} fragments`,
				searchText: promptManifestSearchText(record),
				load: async () => ({
					format: "json" as const,
					lines: splitLinesCapped(JSON.stringify(record, null, 2), path),
				}),
			}),
		);
		if (read.errors.length === 0) return artifacts;
		return [
			...artifacts,
			{
				id: "prompt-manifest:read-errors",
				category: this.category,
				title: `Prompt manifest · ${read.errors.length} read error${read.errors.length === 1 ? "" : "s"}`,
				timestamp: Date.now(),
				path,
				sessionId: meta.id,
				load: async () => ({
					format: "markdown" as const,
					lines: [
						"# Prompt Manifest Read Errors",
						"",
						...read.errors.map((error) =>
							error.line === null ? `- ${error.message}` : `- line ${error.line}: ${error.message}`,
						),
					],
				}),
			},
		];
	}
}

function renderAccountabilitySummary(summary: AccountabilitySummary): string[] {
	const pct = Math.round(summary.firstPassRate * 100);
	const lines = [
		"# Accountability",
		"",
		`first-pass success: ${summary.firstPassRuns}/${summary.totalRuns} (${pct}%)`,
		"",
		"## Top failure causes",
		"",
	];
	if (summary.failureCauses.length === 0) {
		lines.push("none");
		return lines;
	}
	for (const { tag, count } of summary.failureCauses.slice(0, ACCOUNTABILITY_TOP_CAUSES)) {
		lines.push(`- ${tag}: ${count}`);
	}
	return lines;
}

export class AccountabilityArtifactProvider implements ArtifactProvider {
	readonly category = "accountability" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const stateDir = this.deps.stateDir;
		return [
			{
				id: "session",
				category: this.category,
				title: "Session accountability",
				timestamp: Date.now(),
				load: async () => ({
					format: "markdown" as const,
					lines: renderAccountabilitySummary(readAccountabilitySummary(stateDir)),
				}),
			},
		];
	}
}

const SAFETY_AUDIT_ARTIFACT_LIMIT = 200;

function compareAuditRowsNewestFirst(left: AuditJsonRow, right: AuditJsonRow): number {
	const time = parseTime(right.ts) - parseTime(left.ts);
	if (time !== 0) return time;
	const file = right.file.localeCompare(left.file);
	if (file !== 0) return file;
	return right.line - left.line;
}

function currentSessionAuditRows(
	rows: ReadonlyArray<AuditJsonRow>,
	sessionId: string | null | undefined,
): ReadonlyArray<AuditJsonRow> {
	if (!sessionId) return rows;
	const matching = rows.filter((row) => readStringField(row.row, "sessionId") === sessionId);
	return matching.length > 0 ? matching : rows;
}

function auditRowSubject(row: AuditJsonRow): string {
	const subjectParts: string[] = [];
	const tool = readStringField(row.row, "tool");
	if (tool !== null) subjectParts.push(tool);
	const actionClass = readStringField(row.row, "actionClass");
	if (actionClass !== null) subjectParts.push(actionClass);
	const decision =
		readStringField(row.row, "decision") ??
		readStringField(row.row, "status") ??
		readStringField(row.row, "source") ??
		readStringField(row.row, "phase");
	if (decision !== null) subjectParts.push(decision);
	const runId = readStringField(row.row, "runId");
	const sessionId = readStringField(row.row, "sessionId");
	const correlationId = readStringField(row.row, "correlationId") ?? row.correlationId;
	if (runId !== null) {
		subjectParts.push(`run ${shortValue(runId)}`);
	} else if (sessionId !== null) {
		subjectParts.push(`session ${shortValue(sessionId)}`);
	} else if (correlationId.length > 0) {
		subjectParts.push(`corr ${shortValue(correlationId)}`);
	}
	return subjectParts.join(" · ");
}

function auditRowTitle(row: AuditJsonRow): string {
	const subject = auditRowSubject(row);
	return safeTitle(`Audit · ${row.auditKind}${subject ? ` · ${subject}` : ""}`, "Audit row");
}

function auditRowPayload(row: AuditJsonRow): Record<string, unknown> {
	return {
		file: row.file,
		line: row.line,
		auditKind: row.auditKind,
		correlationId: row.correlationId,
		row: row.row,
	};
}

function auditReadErrorsArtifact(stateDir: string, errors: ReadonlyArray<string>): ViewArtifact | null {
	if (errors.length === 0) return null;
	const path = join(stateDir, "audit");
	return {
		id: "audit:read-errors",
		category: "audit",
		title: `Audit · ${errors.length} read error${errors.length === 1 ? "" : "s"}`,
		timestamp: Date.now(),
		path,
		load: async () => ({
			format: "markdown" as const,
			lines: ["# Audit Read Errors", "", ...errors.map((error) => `- ${error}`)],
		}),
	};
}

export class SafetyAuditArtifactProvider implements ArtifactProvider {
	readonly category = "audit" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		let read: AuditReadResult;
		try {
			read = await readAuditRows(this.deps.stateDir);
		} catch {
			return [];
		}
		const selected = [...currentSessionAuditRows(read.rows, this.deps.sessionMeta?.id)]
			.sort(compareAuditRowsNewestFirst)
			.slice(0, SAFETY_AUDIT_ARTIFACT_LIMIT);
		const artifacts: ViewArtifact[] = selected.map((row) => {
			const path = join(this.deps.stateDir, "audit", row.file);
			const runId = readStringField(row.row, "runId");
			const sessionId = readStringField(row.row, "sessionId");
			const correlationId = readStringField(row.row, "correlationId") ?? row.correlationId;
			const tool = readStringField(row.row, "tool");
			const actionClass = readStringField(row.row, "actionClass");
			const decision = readStringField(row.row, "decision");
			const status = readStringField(row.row, "status");
			const source = readStringField(row.row, "source");
			const phase = readStringField(row.row, "phase");
			return {
				id: `audit:${row.file}:${row.line}`,
				category: this.category,
				title: auditRowTitle(row),
				timestamp: parseTime(row.ts),
				sizeBytes: maybeSizeBytes(path),
				path,
				...(runId ? { runId } : {}),
				...(sessionId ? { sessionId } : {}),
				...(correlationId ? { correlationId } : {}),
				...(tool ? { toolName: tool } : {}),
				searchText: [
					row.file,
					String(row.line),
					row.auditKind,
					row.correlationId,
					runId ?? "",
					sessionId ?? "",
					correlationId,
					tool ?? "",
					actionClass ?? "",
					decision ?? "",
					status ?? "",
					source ?? "",
					phase ?? "",
				].filter(isNonEmptyString),
				load: async () => ({
					format: "json" as const,
					lines: splitLinesCapped(JSON.stringify(auditRowPayload(row), null, 2), path),
				}),
			};
		});
		const errors = auditReadErrorsArtifact(this.deps.stateDir, read.errors);
		return errors ? [...artifacts, errors] : artifacts;
	}
}

export function createDefaultArtifactProviders(deps: ArtifactProviderDeps): ArtifactProvider[] {
	return [
		new AccountabilityArtifactProvider(deps),
		new EvidenceArtifactProvider(deps),
		new ReceiptArtifactProvider(deps),
		new DispatchArtifactProvider(deps),
		new TaskLedgerArtifactProvider(deps),
		new WorkspaceArtifactProvider(deps),
		new ToolOutputArtifactProvider(deps),
		new ProtectedArtifactProvider(deps),
		new CompactionArtifactProvider(deps),
		new PromptManifestArtifactProvider(deps),
		new SafetyAuditArtifactProvider(deps),
	];
}

export function sortViewArtifacts(artifacts: ReadonlyArray<ViewArtifact>): ViewArtifact[] {
	return [...artifacts].sort((a, b) => {
		const time = b.timestamp - a.timestamp;
		if (time !== 0) return time;
		const category = VIEW_ARTIFACT_CATEGORIES.indexOf(a.category) - VIEW_ARTIFACT_CATEGORIES.indexOf(b.category);
		if (category !== 0) return category;
		return a.id.localeCompare(b.id);
	});
}

export async function listViewArtifacts(providers: ReadonlyArray<ArtifactProvider>): Promise<ViewArtifact[]> {
	const groups = await Promise.all(
		providers.map(async (provider) => {
			try {
				return await provider.list();
			} catch {
				return [];
			}
		}),
	);
	return sortViewArtifacts(groups.flat());
}
