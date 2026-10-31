/**
 * A dispatched run's terminal facts, from the read model's run DTO over its sealed run scope (#434).
 *
 * The run's run.settled and the result object it names are the terminal truth for a dispatched run. This is the one
 * place that turns them into the compact facts a surface reports, shared by the TUI worker block (live and replayed)
 * and by ACP terminal fleet frames (#ACP-02), so every surface draws the same numbers from the same record.
 *
 * Every failure path returns null rather than throwing. A run that has not settled is an operator-visible state
 * (`result unavailable`), never a reason to take down a render or a wire frame.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvidenceV1, RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { TELEMETRY_DTO_VERSION } from "../../core/telemetry/dto.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { clioStateDir } from "../../core/xdg.js";
import { type GateReview, readRunGateIndex, readRunTrust } from "../evidence/run-trust.js";
import { integrityClause, trustStateWord, validationClause } from "../evidence/trust-projection.js";
import type { CanonicalTrustStatus } from "../evidence/trust-status.js";
import { TELEMETRY_FOLD_VERSION } from "../telemetry/folds.js";
import { readRunRecord } from "../telemetry/index.js";

export type RunResultContract = "pass" | "fail" | "not-reached" | "unmeasured";

/** Result kinds whose parsed envelopes have a dedicated transcript presentation. */
export type RunPresentedResultContract =
	| "debugger-report"
	| "verifier-report"
	| "research-report"
	| "world-knowledge-report"
	| "scout-report";

/**
 * Terminal facts a finished run reports. Every unit is optional and reported
 * only when known: an ACP peer reports no tokens of its own, and a surface
 * that says it spent zero would be claiming something no run settled.
 */
export interface RunResultSummary {
	/** The canonical trust status of the run's record, authenticated by its run seal. */
	trust?: CanonicalTrustStatus;
	outcome: string;
	outcomeCode?: string;
	exitCode?: number;
	failureMessage?: string;
	mergeDetail?: string;
	tokenCount?: number;
	/** The run's settled token total as a fact, so a surface words its coverage rather than a bare number. */
	tokens?: Fact<number>;
	/** The calls the run made, when its settled usage states how many (#434). */
	apiCalls?: number;
	durationMs?: number;
	toolCalls?: number;
	/** Per-tool call counts the run settled, for the exit summary's tally. */
	toolCounts?: ReadonlyArray<{ tool: string; count: number }>;
	/** Paths the run changed, from its worktree or checkout facts, for the exit summary. */
	changedPaths?: ReadonlyArray<string>;
	/** Integrity-checked external workspace facts for a shared result. */
	placement?:
		| { mode: "current"; cwd: string; changedPaths?: string[] }
		| { mode: "worktree"; cwd: string; branch: string; changedPaths?: string[] };
	contract?: RunResultContract;
	/** Parsed from the settled result-contract source id; absent on untyped runs. */
	contractKind?: RunPresentedResultContract;
	/** Replay only: the ledger row for this run has no `endedAt` yet, so the run is still going in another process. */
	stillRunning?: boolean;
	/** Replay only: the run never settled because the ledger closed its row early; the row's own explanation, verbatim. */
	abandonedDetail?: string;
}

/** A run's projection: the summary plus the answer it delivered. */
export interface RunResultFacts extends RunResultSummary {
	text?: string;
	/**
	 * The run's folded token quantity as the read model words it. Unlike `tokens`, it keeps the measured subtotal
	 * beside unknown call coverage, so a partly counted run reads as a lower bound rather than unknown (#434).
	 */
	tokensDisplay?: string;
}

function factValue(fact: Fact<number>): number | undefined {
	return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : undefined;
}

const PRESENTED_RESULT_CONTRACTS: ReadonlyArray<RunPresentedResultContract> = [
	"debugger-report",
	"verifier-report",
	"research-report",
	"world-knowledge-report",
	"scout-report",
];

/** The kind sits inside the validator source id, which the settled record carries. */
function contractKindOf(sourceId: string | undefined): RunPresentedResultContract | undefined {
	if (sourceId === undefined) return undefined;
	return PRESENTED_RESULT_CONTRACTS.find((kind) => sourceId.startsWith(`agent-result-contract:${kind}:`));
}

type SettledRun = RunTelemetryV1 & { settled: NonNullable<RunTelemetryV1["settled"]> };

/**
 * Project a run DTO onto the facts a worker block renders; null when the run has not settled. `gates` are the
 * journaled review decisions about the run, so its trust agrees with its evidence view (#434).
 */
function runResultFactsOf(record: RunTelemetryV1 | null, gates: ReadonlyArray<GateReview>): RunResultFacts | null {
	if (record === null || record.settled === null) return null;
	const settled = record.settled;
	const result = record.result?.state === "resolved" ? record.result.value : null;
	const quality = settled.quality;
	const contract: RunResultContract | undefined =
		quality === null ? undefined : quality.resultContract === null ? "unmeasured" : quality.resultContract.conformance;
	const contractKind = contractKindOf(quality?.resultContract?.sourceId);
	const worktree = result?.worktree ?? null;
	const mergeDetail = settled.worktree?.applied === true ? worktree?.detail : undefined;
	const changedPaths = worktree?.changedPaths ?? result?.checkoutChanges?.changedPaths;
	const external = settled.route.runtimeKind === "subprocess" || settled.route.runtimeKind === "acp-delegation";
	const placement = !external
		? undefined
		: worktree
			? {
					mode: "worktree" as const,
					cwd: worktree.path,
					branch: worktree.branch,
					...(worktree.changedPaths ? { changedPaths: worktree.changedPaths } : {}),
				}
			: result?.checkoutChanges
				? {
						mode: "current" as const,
						cwd: result.checkoutChanges.cwd,
						changedPaths: result.checkoutChanges.changedPaths,
					}
				: undefined;
	const tokenCount = factValue(settled.totalTokens);
	const apiCalls = factValue(settled.apiCalls);
	const durationMs = Math.max(0, Date.parse(settled.endedAt) - Date.parse(settled.startedAt));
	const failureMessage = result?.failureMessage ?? settled.failureMessage;
	const text = result?.output?.text;
	return {
		trust: readRunTrust(record, gates).trust,
		outcome: settled.outcome,
		tokens: settled.totalTokens,
		tokensDisplay: record.row.tokens.display,
		toolCounts: settled.tools.map((entry) => ({ tool: entry.tool, count: entry.calls })),
		...(changedPaths !== undefined ? { changedPaths } : {}),
		...(settled.outcomeCode !== null ? { outcomeCode: settled.outcomeCode } : {}),
		...(failureMessage ? { failureMessage } : {}),
		...(mergeDetail ? { mergeDetail } : {}),
		...(settled.exitCode !== null ? { exitCode: settled.exitCode } : {}),
		...(tokenCount !== undefined ? { tokenCount } : {}),
		...(apiCalls !== undefined ? { apiCalls } : {}),
		...(Number.isFinite(durationMs) ? { durationMs } : {}),
		toolCalls: settled.toolCalls,
		...(placement !== undefined ? { placement } : {}),
		...(contract !== undefined ? { contract } : {}),
		...(contractKind !== undefined ? { contractKind } : {}),
		...(text ? { text } : {}),
	};
}

/** The run's facts from its run scope; null when it has not settled or cannot be read. */
export function readRunResultFacts(runId: string, stateDir = clioStateDir()): RunResultFacts | null {
	try {
		return runResultFactsOf(readRunRecord(stateDir, runId), readRunGateIndex(stateDir)(runId));
	} catch {
		// An unreadable run scope is an unavailable result, never a failed render.
		return null;
	}
}

/**
 * The subset of a `runs.json` row replay needs once a run has not settled: whether the run is still open, and, if
 * the ledger closed it early, the closing row's own explanation.
 */
function findRunRow(runId: string, stateDir: string): Record<string, unknown> | null {
	const path = join(stateDir, "runs.json");
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return null;
		for (const entry of parsed) {
			if (typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === runId)
				return entry as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Replay-only reader: falls back to the run's own `runs.json` row when the run never settled, so a resumed
 * transcript can tell a run still going in another process, one the ledger closed as dead or stalled before it could
 * settle, and one whose record is genuinely gone apart from each other. Never used by the live subscription: there,
 * an unsettled run at settle time is a flush race the terminal event's own payload already covers.
 */
export function readRunResultFactsForReplay(runId: string, stateDir = clioStateDir()): RunResultFacts | null {
	const settled = readRunResultFacts(runId, stateDir);
	if (settled !== null) return settled;
	const row = findRunRow(runId, stateDir);
	if (row === null) return null;
	if (row.endedAt === null || row.endedAt === undefined) return { outcome: "running", stillRunning: true };
	const outcome = optionalString(row.outcome) ?? optionalString(row.status) ?? "unknown";
	const abandonedDetail = optionalString(row.outcomeDetail);
	return { outcome, ...(abandonedDetail !== undefined ? { abandonedDetail } : {}) };
}

/**
 * The wire shape of `_meta["clio-coder/receipt"]` on an ACP terminal fleet frame. `trust` is the artifact-integrity
 * word the TUI footer prints and `validation` its quality clause, so a client shows the same words without
 * re-implementing the trust projection.
 */
export interface RunResultWireFacts {
	receiptId: string;
	outcome: string | null;
	contract: RunResultContract | null;
	contractKind: RunPresentedResultContract | null;
	trust: string | null;
	validation: string | null;
	tokens: number | null;
	tokensDisplay: string | null;
	elapsedMs: number | null;
	placement: { mode: "current" | "worktree"; branch?: string; changedPaths?: string[] } | null;
	unavailable?: true;
}

/** Project run facts onto the wire; null facts become `unavailable: true`, never an error. */
export function runResultWireFacts(runId: string, facts: RunResultFacts | null): RunResultWireFacts {
	if (facts === null) {
		return {
			receiptId: runId,
			outcome: null,
			contract: null,
			contractKind: null,
			trust: null,
			validation: null,
			tokens: null,
			tokensDisplay: null,
			elapsedMs: null,
			placement: null,
			unavailable: true,
		};
	}
	const placement = facts.placement;
	return {
		receiptId: runId,
		outcome: facts.outcome,
		contract: facts.contract ?? null,
		contractKind: facts.contractKind ?? null,
		trust: facts.trust ? trustStateWord("artifactIntegrity", facts.trust.artifactIntegrity.state) : null,
		validation: facts.trust ? validationClause(facts.trust) : null,
		tokens: facts.tokenCount ?? null,
		tokensDisplay: facts.tokensDisplay ?? null,
		elapsedMs: facts.durationMs ?? null,
		placement:
			placement === undefined
				? null
				: {
						mode: placement.mode,
						...(placement.mode === "worktree" ? { branch: placement.branch } : {}),
						...(placement.changedPaths !== undefined ? { changedPaths: placement.changedPaths } : {}),
					},
		// Only the replay fallback sets abandonedDetail: the outcome came from the ledger row because the run never
		// settled, which is still an unavailable result.
		...(facts.abandonedDetail !== undefined ? { unavailable: true as const } : {}),
	};
}

type Sealed = NonNullable<RunEvidenceV1["sealed"]>;
type EvidenceTrust = RunEvidenceV1["trust"];

const clip = (value: string, max = 4096) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function trustAxis<Axis extends keyof Omit<EvidenceTrust, "validation">>(
	status: CanonicalTrustStatus,
	axis: Axis,
): EvidenceTrust[Axis] {
	const entry = status[axis];
	return {
		state: entry.state,
		display: trustStateWord(axis, entry.state),
		authority: entry.state === "absent" ? null : clip(entry.authority.id),
	} as EvidenceTrust[Axis];
}

/** The checks a verified run settled, with the check commands' outcomes from its result object. */
function sealedChecks(run: SettledRun): Sealed {
	const settled = run.settled;
	const result = run.result?.state === "resolved" ? run.result.value : null;
	const host = settled.hostVerification;
	const contract = settled.quality?.resultContract;
	return {
		outcome: settled.outcome,
		outcomeCode: settled.outcomeCode,
		exitCode: settled.exitCode,
		failureMessage: result?.failureMessage ? clip(result.failureMessage) : settled.failureMessage,
		verification: { ...settled.verification },
		typedValidations: settled.quality ? settled.quality.typedValidations.map((fact) => ({ ...fact })) : null,
		hostVerification: host
			? {
					status: host.status,
					reason: result?.hostVerification?.reason ? clip(result.hostVerification.reason) : null,
					strategy: host.strategy,
					checks: (result?.hostVerification?.checks ?? []).map((check) => ({
						check: clip(check.check),
						exitCode: check.exitCode,
						durationMs: check.durationMs,
						memo: check.memo,
						outputTail: clip(check.outputTail, 16_384),
						evidenceRunId: check.evidenceRunId,
					})),
				}
			: null,
		resultContract:
			settled.quality === null
				? null
				: contract === null || contract === undefined
					? "unmeasured"
					: { ...contract, kind: contractKindOf(contract.sourceId) ?? null },
		responseSchema: settled.quality ? { ...settled.quality.responseSchema } : null,
		validationGrounding: settled.validationGrounding
			? { ...settled.validationGrounding, ungrounded: [...settled.validationGrounding.ungrounded] }
			: null,
	};
}

/**
 * A run's evidence from its run DTO, for every surface that shows what the run's seal vouches for (#434 §11.3). The
 * seal authenticates the record; the checks appear only under a seal that verifies.
 */
export function runEvidenceOf(
	runId: string,
	record: RunTelemetryV1 | null,
	options: { now?: Date; gates?: ReadonlyArray<GateReview> } = {},
): RunEvidenceV1 {
	// The evidence domain's one derivation: the sealed assessment's trust under the seal's verdict, with later review
	// gates composed over it, so this DTO and `runEvidence` agree on every axis (#434).
	const read = readRunTrust(record, options.gates);
	const status = read.trust;
	const verified = read.integrity.state === "verified";
	const settled = record?.settled ? (record as SettledRun) : null;
	const integrity: RunEvidenceV1["integrity"] =
		settled === null
			? { state: "unavailable", display: integrityClause(status), detail: "the run has not settled" }
			: read.integrity.state === "verified"
				? { state: "verified", display: integrityClause(status), detail: null }
				: {
						state: read.integrity.state,
						display: integrityClause(status),
						detail: clip(read.integrity.reason),
					};
	const assessment = read.assessment;
	const evidence: RunEvidenceV1["evidence"] =
		assessment === null
			? null
			: {
					assessedAt: assessment.at,
					firstPassSuccess: assessment.firstPassSuccess,
					findingCount: read.findings.length,
					tags: [...new Set(read.findings.map((finding) => finding.tag))].sort(),
				};
	return {
		v: TELEMETRY_DTO_VERSION,
		foldVersion: TELEMETRY_FOLD_VERSION,
		generatedAt: (options.now ?? new Date()).toISOString(),
		kind: "run-evidence",
		runId,
		record: record === null || !record.journal.present ? "missing" : settled === null ? "unsettled" : "settled",
		integrity,
		trust: {
			artifactIntegrity: trustAxis(status, "artifactIntegrity"),
			validationGrounding: trustAxis(status, "validationGrounding"),
			independentReview: trustAxis(status, "independentReview"),
			contextProvenance: trustAxis(status, "contextProvenance"),
			completionEvidence: trustAxis(status, "completionEvidence"),
			validation: validationClause(status),
		},
		sealed: settled && verified ? sealedChecks(settled) : null,
		evidence,
	};
}

/** A run's evidence read from its run scope, with the review gates decided about it. */
export function readRunEvidence(runId: string, stateDir = clioStateDir(), options: { now?: Date } = {}): RunEvidenceV1 {
	let record: RunTelemetryV1 | null = null;
	try {
		record = readRunRecord(stateDir, runId);
	} catch {
		// An unreadable run scope reads as a missing record.
		record = null;
	}
	return runEvidenceOf(runId, record, { ...options, gates: readRunGateIndex(stateDir)(runId) });
}
