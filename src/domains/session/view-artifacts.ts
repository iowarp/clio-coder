import { createReadStream, readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatFooterTokens } from "../../core/display-units.js";
import { clockLocal } from "../../core/format-time.js";
import { parseJsonObjectPayload } from "../../core/json-payload.js";
import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { RunResultObject } from "../../core/telemetry/schemas.js";
import { displayToolCall } from "../../tools/gateway-display.js";
import { expandChainMessages } from "../../tools/surface.js";
import type { DispatchContract } from "../dispatch/contract.js";
import type { DispatchOwnership } from "../dispatch/ownership.js";
import { dispatchOwnership } from "../dispatch/ownership.js";
import type { RunEnvelope } from "../dispatch/types.js";
import { listRunEvidence, runEvidence } from "../evidence/run-evidence.js";
import { readRunGateIndex } from "../evidence/run-trust.js";
import { formatTrustSummaryLine, trustStateWord } from "../evidence/trust-projection.js";
import type { CanonicalTrustStatus, TrustStatusAxis } from "../evidence/trust-status.js";
import { inspectRunTrustStatus, TRUST_STATUS_AXES } from "../evidence/trust-status.js";
import type { RunEvidence } from "../evidence/types.js";
import { sanitizeCallTargetText } from "../safety/call-target.js";
import { redactSecretString } from "../safety/redaction.js";
import { renderCostAmount } from "../telemetry/cost.js";
import { type DecisionRow, decisionRow } from "../telemetry/fact-folds.js";
import type { AccountabilitySummary } from "../telemetry/index.js";
import {
	readRunRecord,
	readRunRecordAsync,
	summarizeRunAccountability,
	telemetryJournalPath,
	telemetryRunDirectory,
	telemetrySessionDirectory,
} from "../telemetry/index.js";
import type { JournalSource, SessionSource } from "../telemetry/read-model.js";
import { accountabilityRecords, sessionJournals } from "../telemetry/read-model.js";
import type { SessionMeta } from "./contract.js";
import type {
	BashExecutionEntry,
	MessageEntry,
	ProtectedArtifactEntry,
	SessionEntry,
	TaskLedgerEntry,
	TaskLedgerGoal,
	TaskLedgerValidationEvidence,
} from "./entries.js";
import type { SessionPromptCompileRecord } from "./prompt-manifest.js";
import { readPromptCompileManifest } from "./prompt-manifest.js";
import { foldSessionArtifacts, resolveSessionArtifactPath } from "./session-artifacts.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";

export type ViewArtifactCategory =
	| "transcript"
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
	details?: { lines: string[]; format: ViewArtifactFormat };
	/**
	 * The same content laid out by its own renderer at a given width. A
	 * transcript block's rows carry a hanging indent and a `│` rail, which a
	 * re-wrap of the rows rendered for another width loses, so the preview
	 * renders the block at its own width instead.
	 */
	render?: (width: number) => string[];
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
	/**
	 * Set on a protected artifact. Its load renders the protection record and
	 * never the file, and a client read states this reason instead of bytes.
	 */
	refusal?: string;
	load(): Promise<ViewArtifactLoadResult>;
	verify?(): Promise<ViewArtifactVerification>;
}

export interface ArtifactProvider {
	category: ViewArtifactCategory;
	list(): Promise<ViewArtifact[]>;
}

export interface ArtifactProviderDeps {
	readTranscript?: (() => ViewArtifact[]) | undefined;
	stateDir: string;
	dataDir?: string | undefined;
	dispatch?: Pick<DispatchContract, "listRuns" | "getRun"> | undefined;
	sessionMeta?: SessionMeta | null | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	/**
	 * Label for a model id in a dispatch body. The terminal fits it to its cell
	 * budget; a surface without one keeps the full id. Absent means the full id.
	 */
	formatModelId?: ((modelId: string) => string) | undefined;
}

/**
 * The one sanitizer every surface runs on an artifact's title and provenance
 * before display: control sequences stripped, then secrets redacted. Bodies are
 * shown as loaded, on the terminal and over ACP alike.
 */
export function viewArtifactDisplayText(text: string): string {
	return redactSecretString(sanitizeCallTargetText(text));
}

export const VIEW_ARTIFACT_CATEGORIES: readonly ViewArtifactCategory[] = [
	"transcript",
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

export interface RunRecordVerificationCheck {
	name: string;
	ok: boolean;
	evidence: string;
}

/** What `/view verify` reports for a run: its seal verdict, the checks behind it and the trust it supports (#434). */
export type RunRecordVerificationReport = ({ ok: true } | { ok: false; reason: string }) & {
	runDirectory: string;
	/** The run's identity: the digest of its run.settled; null before it settles. */
	sealedDigest: string | null;
	trustSummary: string | null;
	verificationSummary: string | null;
	compromised: boolean;
	checks: RunRecordVerificationCheck[];
};

/**
 * What a verify action reports: the run seal verified, or why it did not.
 */
export type ViewArtifactVerification =
	| { ok: true; detail: string; compromised?: boolean }
	| { ok: false; detail: string; retired?: true };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
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

function runLedgerPath(stateDir: string): string {
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

/**
 * The session the overlay was opened in, as ownership.ts reads it. The run
 * ledger, run journals, and evidence bundles are machine-wide, so every category
 * built from them keeps only what this session or this project produced.
 */
function viewOwnership(deps: ArtifactProviderDeps): DispatchOwnership {
	return dispatchOwnership({ sessionId: deps.sessionMeta?.id ?? null, cwd: deps.sessionMeta?.cwd ?? process.cwd() });
}

function allRunEnvelopes(deps: ArtifactProviderDeps): RunEnvelope[] {
	// The in-process dispatch ledger only sees runs created by this process.
	// A headless `clio-coder run` in another process writes runs.json and run journals
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

function listRunEnvelopes(deps: ArtifactProviderDeps): RunEnvelope[] {
	const ownership = viewOwnership(deps);
	return allRunEnvelopes(deps).filter((env) => ownership.seesRun(env));
}

/**
 * Finished runs whose ledger rows the bounded run ledger has dropped while their sealed scopes remain (#434). Each is
 * visible by the session its journal names or the workspace its sealed assessment records, as a ledger row would be.
 */
async function retainedRunEvidence(deps: ArtifactProviderDeps): Promise<RunEvidence[]> {
	const known = new Set(allRunEnvelopes(deps).map((env) => env.id));
	const ownership = viewOwnership(deps);
	let runs: RunEvidence[];
	try {
		runs = await listRunEvidence(deps.stateDir, (runId) => known.has(runId));
	} catch {
		// An unreadable run store retains nothing beyond what the ledger lists.
		return [];
	}
	return runs.filter(
		(run) =>
			(run.settled !== null || run.integrity.state === "failed") &&
			ownership.seesRun({ sessionId: run.sessionId, cwd: run.cwd ?? "" }),
	);
}

function trustCheckEvidence(status: CanonicalTrustStatus, axis: string): string {
	const entry = status[axis as keyof typeof status];
	if (typeof entry !== "object" || entry === null || !("state" in entry)) return "canonical trust projection";
	if (entry.state === "absent") return `reason=${entry.reason}`;
	const refs = entry.artifacts.map((artifact) => `${artifact.kind}:${artifact.id}`);
	return refs.length > 0 ? refs.join(", ") : `${entry.authority.kind}:${entry.authority.id}`;
}

function compromisedTrustAxes(status: CanonicalTrustStatus): TrustStatusAxis[] {
	return TRUST_STATUS_AXES.filter((axis) => {
		const state = status[axis].state;
		if (axis === "artifactIntegrity") return state === "failed";
		if (axis === "validationGrounding") return state === "failed" || state === "ungrounded";
		if (axis === "independentReview") return state === "failed" || state === "not_independent";
		if (axis === "contextProvenance") return state === "invalid";
		return false;
	});
}

/** Actionable `/view verify` report: the run's sealed scope checked again from its own files (#434). */
export function verifyRunRecordReport(stateDir: string, runId: string): RunRecordVerificationReport {
	const runDirectory = telemetryRunDirectory(stateDir, runId);
	let record: RunTelemetryV1 | null = null;
	let readError: string | null = null;
	try {
		record = readRunRecord(stateDir, runId);
	} catch (error) {
		readError = error instanceof Error ? error.message : String(error);
	}
	const inspection = inspectRunTrustStatus(record);
	const checks: RunRecordVerificationCheck[] = [];
	if (record === null) {
		checks.push({ name: "run journal", ok: false, evidence: `${runDirectory}: ${readError ?? "no run journal"}` });
	} else {
		checks.push({ name: "run journal", ok: true, evidence: runDirectory });
		if (record.settled === null) {
			checks.push({ name: "run settled", ok: false, evidence: "the run has not settled" });
		} else {
			checks.push({ name: "run settled", ok: true, evidence: `run.settled at ${record.settled.at}` });
			const seal = record.seal;
			checks.push(
				seal?.status === "verified"
					? {
							name: "run seal",
							ok: true,
							evidence: `sealed at ${seal.sealedAt}; ${seal.records} records, ${seal.segments} segments and ${seal.objects} objects verify`,
						}
					: {
							name: "run seal",
							ok: false,
							evidence: inspection.integrity.state === "verified" ? "verified" : inspection.integrity.reason,
						},
			);
		}
	}
	const settled = record?.settled ?? null;
	const compromiseAxes = settled === null ? [] : compromisedTrustAxes(inspection.status);
	for (const axis of compromiseAxes) {
		checks.push({
			name: `trust ${axis}`,
			ok: false,
			evidence: `${trustStateWord(axis, inspection.status[axis].state)}; ${trustCheckEvidence(inspection.status, axis)}`,
		});
	}
	const outcome =
		inspection.integrity.state === "verified"
			? ({ ok: true } as const)
			: ({ ok: false, reason: record === null ? (readError ?? "no run journal") : inspection.integrity.reason } as const);
	return {
		...outcome,
		runDirectory,
		sealedDigest: settled === null ? null : `sha256:${settled.digest}`,
		trustSummary: settled === null ? null : formatTrustSummaryLine(inspection.status),
		verificationSummary: settled === null ? null : readableVerification(inspection.status),
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

async function loadTextPath(path: string): Promise<ViewArtifactLoadResult> {
	try {
		const { lines } = await readTextFileLinesCapped(path);
		return { lines, format: "text" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { lines: [`unable to read ${path}: ${message}`], format: "text" };
	}
}

function renderEvidenceDetails(evidence: RunEvidence, path: string): string[] {
	const settled = evidence.settled;
	const totals = evidence.totals;
	return [
		"# Run evidence",
		"",
		`- run id: ${evidence.runId}`,
		`- session id: ${formatOptionalString(evidence.sessionId)}`,
		`- seal: ${evidence.integrity.state === "verified" ? "verified" : evidence.integrity.reason}`,
		`- assessed: ${evidence.assessedAt ?? "no"}`,
		...(settled
			? [
					`- outcome: ${settled.outcome} (exit ${settled.exitCode ?? "?"})`,
					`- agent: ${settled.agentId}`,
					`- target: ${settled.targetId}`,
					`- runtime: ${settled.runtimeId}`,
					`- model: ${settled.wireModelId}`,
				]
			: []),
		"",
		"## Totals",
		"",
		...(totals
			? [
					`- tool calls: ${totals.toolCalls}`,
					`- tool errors: ${totals.toolErrors}`,
					`- blocked tool calls: ${totals.blockedToolCalls}`,
					`- tokens: ${totals.tokens.display}`,
					`- cost: ${totals.usd.display}`,
					`- wall time: ${formatDurationMs(totals.wallTimeMs)}`,
				]
			: ["- not stated: the run's seal does not vouch for its record"]),
		"",
		"## Tags",
		...(evidence.tags.length === 0 ? ["- none"] : evidence.tags.map((tag) => `- ${tag}`)),
		"",
		"## Findings",
		...(evidence.findings.length === 0
			? ["- none"]
			: evidence.findings.map((finding) => `- ${finding.severity} ${finding.tag}: ${finding.message}`)),
		...(evidence.verdicts.length === 0
			? []
			: [
					"",
					"## Gate verdicts",
					...evidence.verdicts.map((verdict) => `- ${verdict.decisionId}: ${verdict.outcome} (${verdict.review})`),
				]),
		"",
		"## Files",
		"",
		`- run scope: ${path}`,
	];
}

function readableVerification(status: CanonicalTrustStatus): string {
	const validation = status.validationGrounding;
	const authority = "authority" in validation ? validation.authority.id : null;
	const checkLabel = authority === "host-verification" ? "host checks" : "recorded checks";
	const validationText =
		validation.state === "validated"
			? `${checkLabel} passed`
			: validation.state === "failed"
				? `${checkLabel} failed`
				: authority === "host-verification-baseline-failed"
					? "check also failed on the task base; change validation unknown"
					: trustStateWord("validationGrounding", validation.state);
	return [
		status.artifactIntegrity.state === "verified"
			? "run seal valid"
			: trustStateWord("artifactIntegrity", status.artifactIntegrity.state),
		validationText,
		trustStateWord("independentReview", status.independentReview.state),
		...(status.contextProvenance.state === "invalid" ? ["context record invalid"] : []),
	].join("; ");
}

/** A settled run as the `/view` summaries read it: its settled facts and the result object they name. */
interface SettledRunView {
	runId: string;
	settled: NonNullable<RunTelemetryV1["settled"]>;
	result: RunResultObject | null;
}

function settledRunView(runId: string, record: RunTelemetryV1 | null): SettledRunView | null {
	if (record?.settled == null) return null;
	return {
		runId,
		settled: record.settled,
		result: record.result?.state === "resolved" ? record.result.value : null,
	};
}

function factValue(fact: Fact<number>): number | null {
	return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : null;
}

function renderEvidenceSummary(evidence: RunEvidence, run: SettledRunView | null): string[] {
	const settled = evidence.settled;
	const totals = evidence.totals;
	return [
		`Agent: ${settled?.agentId ?? "not recorded"}`,
		`Run: ${evidence.runId}`,
		`Model: ${settled?.wireModelId ?? "not recorded"}`,
		"",
		`Recorded verification: ${readableVerification(evidence.trust)}`,
		"",
		"## What changed",
		...(run ? renderRunChanges(run) : ["Changed paths were not recorded."]),
		"",
		"## Checks and findings",
		...(run ? renderRunChecks(run) : []),
		...(evidence.findings.length > 0
			? evidence.findings.map((finding) => `- ${finding.message}`)
			: ["No additional findings recorded."]),
		"",
		"## What happened",
		...(totals
			? [
					`${totals.toolCalls} tool calls · ${totals.toolErrors} errors · ${totals.blockedToolCalls} blocked`,
					`${formatDurationMs(totals.wallTimeMs)} · ${totals.tokens.display} tokens · ${totals.usd.display}`,
				]
			: ["Not stated: the run's seal does not vouch for its record."]),
		"",
		"Press i for all evidence details.",
	];
}

function runVerificationLine(report: RunRecordVerificationReport): string {
	if (!report.ok) return `Verification: failed. ${report.reason}`;
	return `Verification: ${report.verificationSummary ?? "run seal verified; result validation unknown"}`;
}

function renderRunChanges(run: SettledRunView): string[] {
	const result = run.result;
	const observed = result?.worktree?.changedPaths ?? result?.checkoutChanges?.changedPaths;
	const output = result?.output;
	const contract = run.settled.quality?.resultContract;
	const kind =
		output?.structured?.kind ?? (contract?.conformance === "pass" ? contract.sourceId.split(":")[1] : undefined);
	const parsed =
		output?.state === "final" && !output.truncated && kind === "mutation-report"
			? output.structured
				? { ok: true as const, value: output.structured.data }
				: parseJsonObjectPayload(output.text)
			: null;
	const reported =
		parsed?.ok && Array.isArray(parsed.value.mutatedPaths)
			? parsed.value.mutatedPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
			: undefined;
	const changed = observed ?? (reported?.length ? reported : undefined);
	const worktree = run.settled.worktree;
	return [
		...(observed === undefined && changed !== undefined ? ["Paths reported by the worker:"] : []),
		...(changed === undefined
			? ["Changed paths were not recorded."]
			: changed.length === 0
				? ["No changed paths recorded."]
				: changed.map((path) => {
						const clean = viewArtifactDisplayText(path);
						let longest = 0;
						for (const match of clean.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
						const fence = "`".repeat(longest + 1);
						// CommonMark needs padding only when the code span would otherwise merge with the
						// fence or lose an edge space; anything else reads cleanly on plain-text surfaces.
						const pad = /^`|`$/.test(clean) || (/^ .* $/s.test(clean) && clean.trim().length > 0) ? " " : "";
						return `- ${fence}${pad}${clean}${pad}${fence}`;
					})),
		...(worktree
			? [
					worktree.applied
						? "Changes applied to the source checkout."
						: `Changes kept in the worktree${result?.worktree?.reason ? `: ${result.worktree.reason}` : "."}`,
				]
			: []),
		...(result?.checkoutChanges ? ["Observed checkout changes; concurrent edits may be included."] : []),
	];
}

function renderRunChecks(run: SettledRunView): string[] {
	const checks = run.result?.hostVerification?.checks ?? [];
	const failedOnBase = run.settled.hostVerification?.failedOnBase ?? 0;
	return [
		...(checks.length > 0
			? checks.map(
					(check) =>
						`- ${check.exitCode === 0 ? "Passed" : "Failed"}: ${check.check} (exit ${check.exitCode})${check.memo ? "; reused result" : ""}`,
				)
			: ["No host-run checks recorded."]),
		...(failedOnBase > 0 ? [`${failedOnBase} failing check(s) also failed on the task base.`] : []),
		...(run.result?.hostVerification?.reason ? [run.result.hostVerification.reason] : []),
		...run.settled.tools.map(
			(stat) => `- ${stat.tool}: ${stat.ok} succeeded, ${stat.errors} failed, ${stat.blocked} blocked`,
		),
	];
}

/** A run's settled spend in the canonical cost wording. */
function renderRunCost(settled: SettledRunView["settled"]): string {
	const usd = settled.pricing.usd;
	return renderCostAmount(
		factValue(usd) ?? 0,
		usd.kind === "unknown" || usd.kind === "absent"
			? "unknown"
			: settled.pricing.pricedBy === "free"
				? "known_free"
				: usd.kind === "estimated"
					? "estimated"
					: "known",
	);
}

function renderRunSummary(run: SettledRunView, report: RunRecordVerificationReport): string[] {
	const { settled, result } = run;
	const tokens = factValue(settled.totalTokens);
	return [
		`Agent: ${settled.agentId} · Run: ${run.runId}`,
		`Model: ${settled.route.wireModelId} (${settled.route.targetId})`,
		...(result?.failureMessage ? [result.failureMessage] : []),
		...(result?.outcomeDetail ? [result.outcomeDetail] : []),
		"",
		runVerificationLine(report),
		...(!report.ok ? ["The recorded claims below could not be verified."] : []),
		"",
		"## What changed",
		...renderRunChanges(run),
		"",
		"## Checks",
		...renderRunChecks(run),
		"",
		`${formatDurationMs(parseTime(settled.endedAt) - parseTime(settled.startedAt))} · ${tokens === null ? "unknown" : formatFooterTokens(tokens)} tokens · ${renderRunCost(settled)}`,
		"",
		...(result?.output
			? [
					result.output.state === "partial" ? "## Partial result" : "## Result",
					result.output.text,
					...(result.output.truncated ? ["Stored result was truncated."] : []),
					"",
				]
			: []),
		"Press i for the full run record and verification checks. Press v to verify again.",
	];
}

async function loadRunRecordSummary(stateDir: string, runId: string): Promise<ViewArtifactLoadResult> {
	try {
		const record = await readRunRecordAsync(stateDir, runId);
		const run = settledRunView(runId, record);
		if (run === null)
			return { format: "text", lines: [`Run ${runId} has not settled; it has no run record to summarize.`] };
		const report = verifyRunRecordReport(stateDir, runId);
		return {
			format: "markdown",
			lines: renderRunSummary(run, report),
			details: {
				format: "text",
				lines: [
					runVerificationLine(report),
					...(report.trustSummary ? [report.trustSummary] : []),
					...report.checks.map((check) => `${check.ok ? "Passed" : "Failed"}: ${check.name}: ${check.evidence}`),
					"",
					"Full run record",
					"",
					...JSON.stringify({ settled: record?.settled, seal: record?.seal, result: record?.result }, null, 2).split("\n"),
				],
			},
		};
	} catch (err) {
		return {
			format: "text",
			lines: [`Run record summary unavailable: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
}

/** Finished runs by their sealed evidence: the run's seal verdict and the assessment it sealed with (#434). */
export class EvidenceArtifactProvider implements ArtifactProvider {
	readonly category = "evidence" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const stateDir = this.deps.stateDir;
		const gates = readRunGateIndex(stateDir);
		const artifact = (
			runId: string,
			sessionId: string | null,
			title: string,
			timestamp: number,
			searchText: string[],
		): ViewArtifact => {
			const directory = telemetryRunDirectory(stateDir, runId);
			return {
				id: runId,
				category: this.category,
				title,
				timestamp,
				searchText,
				path: directory,
				runId,
				...(sessionId !== null ? { sessionId } : {}),
				load: async () => {
					try {
						const record = await readRunRecordAsync(stateDir, runId);
						const evidence = runEvidence(runId, record, gates(runId));
						const run = evidence.integrity.state === "verified" ? settledRunView(runId, record) : null;
						return {
							format: "markdown" as const,
							lines: renderEvidenceSummary(evidence, run),
							details: {
								format: "markdown",
								lines: [
									...renderEvidenceDetails(evidence, directory),
									"",
									"## Recorded verification",
									"",
									"```json",
									JSON.stringify(evidence.trust, null, 2),
									"```",
								],
							},
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return { format: "markdown" as const, lines: [`unable to read run evidence: ${message}`] };
					}
				},
			};
		};
		const artifacts: ViewArtifact[] = [];
		// A ledger row decides whether this session may see its run; everything shown comes from each run's scope.
		for (const env of listRunEnvelopes(this.deps)) {
			if (env.endedAt === null) continue;
			if (maybeSizeBytes(telemetryJournalPath(telemetryRunDirectory(stateDir, env.id))) === undefined) continue;
			artifacts.push(
				artifact(
					env.id,
					env.sessionId,
					safeTitle(`${env.outcome ?? env.status} · ${env.task}`, "Run evidence"),
					parseTime(env.endedAt),
					[
						env.id,
						...(env.sessionId ? [env.sessionId] : []),
						env.agentId,
						env.targetId,
						env.runtimeId,
						env.wireModelId,
						env.status,
					],
				),
			);
		}
		for (const run of await retainedRunEvidence(this.deps)) {
			const settled = run.settled;
			artifacts.push(
				artifact(
					run.runId,
					run.sessionId,
					safeTitle(settled ? `${settled.outcome} · ${settled.agentId}` : "seal failed", "Run evidence"),
					settled ? parseTime(settled.endedAt) : 0,
					[
						run.runId,
						...(run.sessionId ? [run.sessionId] : []),
						...(settled ? [settled.agentId, settled.targetId, settled.runtimeId, settled.wireModelId, settled.outcome] : []),
					],
				),
			);
		}
		return artifacts;
	}
}

function runTitle(env: RunEnvelope): string {
	return safeTitle(`${env.outcome ?? env.status} · ${env.agentId} · ${env.task}`, env.id);
}

/** Finished runs by their sealed run record: the `receipt` category, whose id `/view verify` names (#434). */
export class RunRecordArtifactProvider implements ArtifactProvider {
	readonly category = "receipt" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const runs = listRunEnvelopes(this.deps);
		return runs
			.filter(
				(env) =>
					env.endedAt !== null &&
					maybeSizeBytes(telemetryJournalPath(telemetryRunDirectory(this.deps.stateDir, env.id))) !== undefined,
			)
			.map((env) => {
				const path = telemetryJournalPath(telemetryRunDirectory(this.deps.stateDir, env.id));
				return {
					id: env.id,
					category: this.category,
					title: runTitle(env),
					timestamp: parseTime(env.endedAt ?? env.startedAt),
					sizeBytes: maybeSizeBytes(path),
					path,
					description: env.task,
					runId: env.id,
					...(env.sessionId ? { sessionId: env.sessionId } : {}),
					searchText: [env.id, env.agentId, env.task, env.targetId, env.runtimeId, env.runtimeKind, env.cwd],
					load: () => loadRunRecordSummary(this.deps.stateDir, env.id),
					verify: async () => {
						const result = verifyRunRecordReport(this.deps.stateDir, env.id);
						if (!result.ok) return { ok: false, detail: result.reason };
						// A valid seal and a checked result are separate facts.
						return {
							ok: true,
							detail: result.verificationSummary ?? "run seal valid; result validation unknown",
							compromised: result.compromised,
						};
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

/** The capability a result came from: a gateway op=call names what it ran, as a direct call did. */
function toolNameFor(entry: SessionEntry): string {
	const payload = messagePayload(entry);
	const name = payload?.toolName ?? payload?.name;
	if (typeof name !== "string" || name.length === 0) return "tool";
	return displayToolCall(name, payload?.args, resultDetails(payload?.result)).toolName;
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
			const journalPath = telemetryJournalPath(telemetryRunDirectory(this.deps.stateDir, env.id));
			const path = maybeSizeBytes(journalPath) !== undefined ? journalPath : ledgerPath;
			return {
				id: env.id,
				category: this.category,
				title: runTitle(env),
				timestamp: parseTime(env.endedAt ?? env.startedAt),
				sizeBytes: maybeSizeBytes(path),
				path,
				description: env.task,
				runId: env.id,
				...(env.sessionId ? { sessionId: env.sessionId } : {}),
				searchText: [env.id, env.agentId, env.task, env.targetId, env.runtimeId, env.runtimeKind, env.cwd],
				load: async () => {
					let run: SettledRunView | null = null;
					try {
						run = settledRunView(env.id, await readRunRecordAsync(this.deps.stateDir, env.id));
					} catch {
						// A run whose record cannot be read can still have session tool output to show.
					}
					const output = run?.result?.output;
					const text = output?.text ?? dispatchResultForRun(entries, env.id);
					const lines = [
						`Dispatch run ${env.id}`,
						`agent: ${env.agentId}`,
						`task: ${env.task}`,
						`status: ${env.status}`,
						`outcome: ${env.outcome ?? "unknown"}`,
						`exit: ${env.exitCode ?? "?"}`,
						`target: ${env.targetId}`,
						`model: ${this.deps.formatModelId?.(env.wireModelId) ?? sanitizeCallTargetText(env.wireModelId)}`,
						`runtime: ${env.runtimeKind}:${env.runtimeId}`,
						`started: ${formatLocalTime(env.startedAt)}`,
						`ended: ${env.endedAt ? formatLocalTime(env.endedAt) : "running"}`,
						`tokens: ${formatFooterTokens(env.tokenCount)}`,
						`cost: ${renderCostAmount(env.costUsd, env.costProvenance, env.costSummary)}`,
						`run journal: ${journalPath}`,
						"",
						"## What changed",
						...(run ? renderRunChanges(run) : ["Changed paths were not recorded."]),
						"",
						output?.state === "partial" ? "agent output (partial):" : "agent output:",
						...(text ? text.split(/\r?\n/) : ["(no recorded agent output found)"]),
						...(output?.truncated ? ["Stored result was truncated."] : []),
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

export function workspaceArtifactFormat(path: string): ViewArtifactFormat {
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
	private entries: ReadonlyArray<SessionEntry> | undefined;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const workspace = this.deps.sessionMeta?.cwd;
		if (!workspace) return [];
		// Read on first list, not at construction: an ACP read builds every
		// provider to reach one category and must not pay for this one.
		this.entries ??= filterEntriesToActivePath(
			[...sessionEntries(this.deps)],
			this.deps.sessionMeta?.pinnedLeafTurnId ?? undefined,
		);
		return foldSessionArtifacts(this.entries, { workspace }).flatMap((artifact) => {
			const path = resolveSessionArtifactPath(artifact.path, workspace);
			if (path === null) return [];
			const kind = artifact.artifactKind ? ` · ${artifact.artifactKind}` : "";
			const overwriteLabel = `${artifact.overwrites} overwrite${artifact.overwrites === 1 ? "" : "s"}`;
			return [
				{
					id: `workspace:${path}`,
					category: this.category,
					title: safeTitle(`${basename(path)} · ${relative(workspace, path)} · ${artifact.tool}${kind}`, basename(path)),
					timestamp: parseTime(artifact.timestamp),
					sizeBytes: maybeSizeBytes(path),
					path,
					description: `${artifact.tool}${kind} · ${overwriteLabel} · Workspace: ${workspace} · Turn: ${artifact.turnId}`,
					...(this.deps.sessionMeta ? { sessionId: this.deps.sessionMeta.id } : {}),
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
			// A chain's settled steps keep their own offloaded outputs; the
			// aggregate result carries none of its own.
			for (const [index, result] of expandChainMessages([entry]).entries()) {
				if (result.kind !== "message" || result.role !== "tool_result") continue;
				const path = pathFromToolResult(result);
				if (!path || seen.has(path)) continue;
				seen.add(path);
				out.push(this.toolResultArtifact(result, path, index > 0));
			}
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

	private toolResultArtifact(entry: MessageEntry, path: string, chainStep = false): ViewArtifact {
		const toolName = toolNameFor(entry);
		const stepCallId = chainStep ? readStringField(messagePayload(entry) ?? {}, "toolCallId") : null;
		const artifact: ViewArtifact = {
			// Steps share their chain's ledger row, so the step's call id keeps them apart.
			id: stepCallId === null ? `tool:${entry.turnId}` : `tool:${entry.turnId}:${stepCallId}`,
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
					refusal: `protected by ${entry.artifact.source}: ${entry.artifact.reason}; contents are not served`,
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
		const path = telemetryJournalPath(telemetrySessionDirectory(this.deps.stateDir, meta.id));
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
		`unverified successes: ${summary.unverifiedSuccesses}`,
		`ungrounded claims: ${summary.ungroundedClaims}`,
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
				load: async () => {
					// Fold only the runs this view lists, each from its own sealed assessment (#434).
					const gates = readRunGateIndex(stateDir);
					const runs: RunEvidence[] = [];
					for (const env of listRunEnvelopes(this.deps)) {
						if (env.endedAt === null) continue;
						const record = await readRunRecordAsync(stateDir, env.id).catch(() => null);
						runs.push(runEvidence(env.id, record, gates(env.id)));
					}
					runs.push(...(await retainedRunEvidence(this.deps)));
					return { format: "markdown" as const, lines: renderAccountabilitySummary(summarizeRunAccountability(runs)) };
				},
			},
		];
	}
}

const SAFETY_AUDIT_ARTIFACT_LIMIT = 200;

function accountabilityTitle(row: DecisionRow): string {
	const parts = [
		row.tool,
		row.actionClass,
		row.outcome,
		row.runId !== null ? `run ${shortValue(row.runId)}` : null,
	].filter(isNonEmptyString);
	return safeTitle(`Audit · ${row.kind}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`, "Audit record");
}

function auditReadErrorsArtifact(path: string, journals: ReadonlyArray<JournalSource>): ViewArtifact | null {
	const unreadable = journals.reduce((total, journal) => total + journal.skipped + journal.damaged, 0);
	if (unreadable === 0) return null;
	return {
		id: "audit:read-errors",
		category: "audit",
		title: `Audit · ${unreadable} unreadable journal record${unreadable === 1 ? "" : "s"}`,
		timestamp: Date.now(),
		path,
		load: async () => ({
			format: "markdown" as const,
			lines: [
				"# Unreadable Journal Records",
				"",
				`- ${unreadable} record(s) in this session's journals could not be read; the decisions listed are partial.`,
			],
		}),
	};
}

/**
 * The current session's safety and lifecycle decisions, newest first, from its journal and the run journals it
 * references (#434). A view with no session lists none: the journals are per scope, never machine-wide.
 */
export class SafetyAuditArtifactProvider implements ArtifactProvider {
	readonly category = "audit" as const;

	constructor(private readonly deps: ArtifactProviderDeps) {}

	async list(): Promise<ViewArtifact[]> {
		const sessionId = this.deps.sessionMeta?.id;
		if (!sessionId) return [];
		let source: SessionSource | null;
		try {
			// The journal loader reaches run records and dispatch; the /view list loads it only when opened.
			const { loadSessionTelemetrySourceAsync } = await import("./telemetry-source.js");
			source = await loadSessionTelemetrySourceAsync(this.deps.stateDir, sessionId);
		} catch {
			return [];
		}
		if (source === null) return [];
		const journals = sessionJournals(source);
		const path = telemetryJournalPath(telemetrySessionDirectory(this.deps.stateDir, sessionId));
		const selected = accountabilityRecords(journals).reverse().slice(0, SAFETY_AUDIT_ARTIFACT_LIMIT);
		const artifacts: ViewArtifact[] = selected.map((record) => {
			const row = decisionRow(record);
			const { runId, tool, actionClass, outcome } = row;
			return {
				id: `audit:${record.id}`,
				category: this.category,
				title: accountabilityTitle(row),
				timestamp: parseTime(record.t),
				path,
				...(runId ? { runId } : {}),
				...(record.ctx.sessionId ? { sessionId: record.ctx.sessionId } : {}),
				...(tool ? { toolName: tool } : {}),
				searchText: [record.k, record.id, runId ?? "", tool ?? "", actionClass ?? "", outcome ?? ""].filter(
					isNonEmptyString,
				),
				load: async () => ({
					format: "json" as const,
					lines: splitLinesCapped(
						JSON.stringify({ kind: record.k, at: record.t, ctx: record.ctx, data: record.data }, null, 2),
						path,
					),
				}),
			};
		});
		const errors = auditReadErrorsArtifact(path, journals);
		return errors ? [...artifacts, errors] : artifacts;
	}
}

export function createDefaultArtifactProviders(deps: ArtifactProviderDeps): ArtifactProvider[] {
	return [
		{ category: "transcript", list: async () => deps.readTranscript?.() ?? [] },
		new AccountabilityArtifactProvider(deps),
		new EvidenceArtifactProvider(deps),
		new RunRecordArtifactProvider(deps),
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

function sortViewArtifacts(artifacts: ReadonlyArray<ViewArtifact>): ViewArtifact[] {
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
