/**
 * Sealed-receipt facts for a dispatched run.
 *
 * The receipt under `<state>/receipts/<runId>.json` is the terminal truth for a
 * dispatched run: the domain writes it before it publishes the run's terminal
 * event, so by the time any surface wants a footer the file is there. This is
 * the one place that turns it into the compact facts a surface reports, shared
 * by the TUI worker block (live and replayed) and by ACP terminal fleet frames
 * (#ACP-02), so every surface draws the same numbers from the same bytes.
 *
 * Every failure path returns null rather than throwing. A missing or corrupt
 * receipt is an operator-visible state (`receipt unavailable`), never a reason
 * to take down a render or a wire frame.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReceiptEvidenceV1 } from "../../core/telemetry/dto.js";
import { TELEMETRY_DTO_VERSION } from "../../core/telemetry/dto.js";
import { clioStateDir } from "../../core/xdg.js";
import { integrityClause, trustStateWord, validationClause } from "../evidence/trust-projection.js";
import type { CanonicalTrustStatus } from "../evidence/trust-status.js";
import { inspectRunReceiptTrustStatus, retiredIntegrityVersionOf } from "../evidence/trust-status.js";
import { readEvidenceIndex } from "../observability/evidence-index.js";
import { TELEMETRY_FOLD_VERSION } from "../observability/folds.js";
import { receiptFilePath } from "../session/view-artifacts.js";
import type { RunEnvelope, RunReceipt } from "./types.js";

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
 * that says it spent zero would be claiming something no receipt sealed.
 */
export interface RunReceiptSummary {
	/**
	 * The canonical trust status of the persisted receipt, authenticated
	 * against the persisted ledger row it was sealed from. Present only when
	 * both could be read back, so a surface that shows it shows an
	 * authenticated verdict and never the sealing process's own claim.
	 */
	trust?: CanonicalTrustStatus;
	outcome: string;
	outcomeCode?: string;
	exitCode?: number;
	failureMessage?: string;
	mergeDetail?: string;
	tokenCount?: number;
	durationMs?: number;
	toolCalls?: number;
	/** Per-tool call counts from the receipt, for the exit summary's tally. */
	toolCounts?: ReadonlyArray<{ tool: string; count: number }>;
	/** Paths the run changed, from its worktree or checkout facts, for the exit summary. */
	changedPaths?: ReadonlyArray<string>;
	/** Integrity-checked external workspace facts for a shared result. */
	placement?:
		| { mode: "current"; cwd: string; changedPaths?: string[] }
		| { mode: "worktree"; cwd: string; branch: string; changedPaths?: string[] };
	contract?: RunResultContract;
	/** Parsed from the receipt's result-contract source id; absent on legacy and untyped receipts. */
	contractKind?: RunPresentedResultContract;
	/** Replay only: the ledger row for this run has no `endedAt` yet, so the run is still going in another process. */
	stillRunning?: boolean;
	/** Replay only: no receipt exists because the ledger closed this row early (`closeAbandonedRows`); the row's own explanation, verbatim. */
	abandonedDetail?: string;
}

/** A receipt's projection: the summary plus the answer it sealed. */
export interface RunReceiptFacts extends RunReceiptSummary {
	text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elapsedMsFrom(receipt: Record<string, unknown>): number | undefined {
	const startedAt = Date.parse(String(receipt.startedAt ?? ""));
	const endedAt = Date.parse(String(receipt.endedAt ?? ""));
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
	return Math.max(0, endedAt - startedAt);
}

/**
 * Result-contract conformance, plus the "unmeasured" case the receipt spells as
 * a null contract fact: a run that never had a typed contract to conform to.
 */
function contractFrom(receipt: Record<string, unknown>): RunResultContract | undefined {
	const quality = isRecord(receipt.quality) ? receipt.quality : null;
	if (quality === null) return undefined;
	if (!Object.hasOwn(quality, "resultContract")) return undefined;
	const fact = quality.resultContract;
	if (fact === null) return "unmeasured";
	if (!isRecord(fact)) return undefined;
	const conformance = fact.conformance;
	return conformance === "pass" || conformance === "fail" || conformance === "not-reached" ? conformance : undefined;
}

const PRESENTED_RESULT_CONTRACTS: ReadonlyArray<RunPresentedResultContract> = [
	"debugger-report",
	"verifier-report",
	"research-report",
	"world-knowledge-report",
	"scout-report",
];

/** The kind is integrity-covered inside the validator source id on current receipts. */
function contractKindFrom(receipt: Record<string, unknown>): RunPresentedResultContract | undefined {
	const quality = isRecord(receipt.quality) ? receipt.quality : null;
	const fact = quality !== null && isRecord(quality.resultContract) ? quality.resultContract : null;
	const sourceId = optionalString(fact?.sourceId);
	if (sourceId === undefined) return undefined;
	return PRESENTED_RESULT_CONTRACTS.find((kind) => sourceId.startsWith(`agent-result-contract:${kind}:`));
}

/**
 * Project a parsed receipt onto the facts a worker block renders. The input is
 * whatever JSON the file held, not a typed {@link RunReceipt}: receipts written
 * by older versions of Clio are still valid history, so every field is read
 * structurally and a missing one degrades the footer rather than the render.
 */
function workerReceiptFacts(receipt: Record<string, unknown>): RunReceiptFacts | null {
	const outcome = optionalString(receipt.outcome);
	if (outcome === undefined) return null;
	const output = isRecord(receipt.output) ? receipt.output : null;
	const contract = contractFrom(receipt);
	const contractKind = contractKindFrom(receipt);
	const text = optionalString(output?.text);
	const failureMessage = optionalString(receipt.failureMessage);
	const outcomeCode = optionalString(receipt.outcomeCode);
	const exitCode = optionalNumber(receipt.exitCode);
	const tokenCount = optionalNumber(receipt.tokenCount);
	const durationMs = elapsedMsFrom(receipt);
	const toolCalls = optionalNumber(receipt.toolCalls);
	const external = receipt.runtimeKind === "subprocess" || isRecord(receipt.delegation);
	const worktree = isRecord(receipt.worktree) ? receipt.worktree : null;
	const mergeDetail = worktree?.applied === true ? optionalString(worktree.detail) : undefined;
	const changedPaths = Array.isArray(worktree?.changedPaths)
		? worktree.changedPaths.filter((path): path is string => typeof path === "string")
		: undefined;
	const checkoutChanges = isRecord(receipt.checkoutChanges) ? receipt.checkoutChanges : null;
	const checkoutPaths = Array.isArray(checkoutChanges?.changedPaths)
		? checkoutChanges.changedPaths.filter((path): path is string => typeof path === "string")
		: undefined;
	const toolCounts = Array.isArray(receipt.toolStats)
		? receipt.toolStats.flatMap((stat) =>
				isRecord(stat) &&
				typeof stat.tool === "string" &&
				typeof stat.count === "number" &&
				Number.isFinite(stat.count) &&
				stat.count >= 0
					? [{ tool: stat.tool, count: stat.count }]
					: [],
			)
		: undefined;
	const reproducibility = isRecord(receipt.reproducibility) ? receipt.reproducibility : null;
	const placement = external
		? worktree && optionalString(worktree.path) && optionalString(worktree.branch)
			? {
					mode: "worktree" as const,
					cwd: String(worktree.path),
					branch: String(worktree.branch),
					...(changedPaths ? { changedPaths } : {}),
				}
			: optionalString(reproducibility?.cwd)
				? {
						mode: "current" as const,
						cwd: String(reproducibility?.cwd),
						...(checkoutPaths ? { changedPaths: checkoutPaths } : {}),
					}
				: undefined
		: undefined;
	return {
		outcome,
		...(toolCounts !== undefined ? { toolCounts } : {}),
		...((changedPaths ?? checkoutPaths) !== undefined ? { changedPaths: changedPaths ?? checkoutPaths ?? [] } : {}),
		...(outcomeCode !== undefined ? { outcomeCode } : {}),
		...(failureMessage !== undefined ? { failureMessage } : {}),
		...(mergeDetail !== undefined ? { mergeDetail } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(tokenCount !== undefined ? { tokenCount } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
		...(placement !== undefined ? { placement } : {}),
		...(contract !== undefined ? { contract } : {}),
		...(contractKind !== undefined ? { contractKind } : {}),
		...(text !== undefined ? { text } : {}),
	};
}

/** Read and project `<state>/receipts/<runId>.json` alone; null when it is absent or unreadable. */
function readReceiptFileFacts(runId: string, stateDir: string): RunReceiptFacts | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(receiptFilePath(stateDir, runId), "utf8"));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const facts = workerReceiptFacts(parsed);
	if (facts === null) return null;
	// The trust verdict is an authenticated read-back: the receipt file
	// against the ledger row it was sealed from. Without the row there is no
	// authentication, and no verdict is better than a guessed one.
	const row = findRunRow(runId, stateDir);
	if (row === null) return facts;
	const trust = inspectRunReceiptTrustStatus(parsed as unknown as RunReceipt, row as unknown as RunEnvelope).status;
	return { ...facts, trust };
}

/** Read and project `<state>/receipts/<runId>.json`; null when it is absent or unreadable. */
export function readRunReceiptFacts(runId: string, stateDir = clioStateDir()): RunReceiptFacts | null {
	return readReceiptFileFacts(runId, stateDir);
}

/**
 * The subset of a `runs.json` row replay needs once a receipt has failed to
 * read: whether the run is still open, and, if the ledger closed it early
 * (`closeAbandonedRows`), the closing row's own explanation.
 */
function findRunRow(runId: string, stateDir: string): Record<string, unknown> | null {
	const path = join(stateDir, "runs.json");
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return null;
		for (const entry of parsed) {
			if (isRecord(entry) && entry.id === runId) return entry;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Replay-only receipt reader: falls back to the run's own `runs.json` row
 * when no receipt was sealed for it, so a resumed transcript can tell a run
 * still going in another process, one the ledger closed as dead/stalled
 * before it could seal a receipt, and one whose evidence is genuinely gone
 * apart from each other. Never used by the live subscription: there, a
 * missing receipt at settle time is a flush race the terminal event's own
 * payload already covers (`worker-stream.ts`'s `settle`), not an open run.
 */
export function readRunReceiptFactsForReplay(runId: string, stateDir = clioStateDir()): RunReceiptFacts | null {
	const sealed = readReceiptFileFacts(runId, stateDir);
	if (sealed !== null) return sealed;
	const row = findRunRow(runId, stateDir);
	if (row === null) return null;
	if (row.endedAt === null || row.endedAt === undefined) return { outcome: "running", stillRunning: true };
	const outcome = optionalString(row.outcome) ?? optionalString(row.status) ?? "unknown";
	const abandonedDetail = optionalString(row.outcomeDetail);
	return {
		outcome,
		...(abandonedDetail !== undefined ? { abandonedDetail } : {}),
	};
}

/**
 * The wire shape of `_meta["clio-coder/receipt"]` on an ACP terminal fleet
 * frame. `trust` is the artifact-integrity word the TUI footer prints and
 * `validation` its quality clause, so a client shows the same words without
 * re-implementing the trust projection.
 */
export interface RunReceiptWireFacts {
	receiptId: string;
	outcome: string | null;
	contract: RunResultContract | null;
	contractKind: RunPresentedResultContract | null;
	trust: string | null;
	validation: string | null;
	tokens: number | null;
	elapsedMs: number | null;
	placement: { mode: "current" | "worktree"; branch?: string; changedPaths?: string[] } | null;
	unavailable?: true;
}

/** Project receipt facts onto the wire; null facts become `unavailable: true`, never an error. */
export function receiptWireFacts(runId: string, facts: RunReceiptFacts | null): RunReceiptWireFacts {
	if (facts === null) {
		return {
			receiptId: runId,
			outcome: null,
			contract: null,
			contractKind: null,
			trust: null,
			validation: null,
			tokens: null,
			elapsedMs: null,
			placement: null,
			unavailable: true,
		};
	}
	const integrity = facts.trust?.artifactIntegrity;
	const placement = facts.placement;
	return {
		receiptId: runId,
		outcome: facts.outcome,
		contract: facts.contract ?? null,
		contractKind: facts.contractKind ?? null,
		trust:
			integrity === undefined
				? null
				: retiredIntegrityVersionOf(integrity) !== null
					? "seal retired"
					: trustStateWord("artifactIntegrity", integrity.state),
		validation: facts.trust ? validationClause(facts.trust) : null,
		tokens: facts.tokenCount ?? null,
		elapsedMs: facts.durationMs ?? null,
		placement:
			placement === undefined
				? null
				: {
						mode: placement.mode,
						...(placement.mode === "worktree" ? { branch: placement.branch } : {}),
						...(placement.changedPaths !== undefined ? { changedPaths: placement.changedPaths } : {}),
					},
		// Only the replay fallback sets abandonedDetail: the outcome came from the
		// ledger row because no receipt was sealed, which is still a missing receipt.
		...(facts.abandonedDetail !== undefined ? { unavailable: true as const } : {}),
	};
}

type ReceiptSealed = NonNullable<ReceiptEvidenceV1["sealed"]>;
type ReceiptTrust = ReceiptEvidenceV1["trust"];

const clip = (value: string, max = 4096) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const textOrNull = (value: unknown, max?: number) => (typeof value === "string" ? clip(value, max) : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
	typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
const nonNegativeOrNull = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const integerOrNull = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : null);

function trustAxis<Axis extends keyof Omit<ReceiptTrust, "validation">>(
	status: CanonicalTrustStatus,
	axis: Axis,
): ReceiptTrust[Axis] {
	const entry = status[axis];
	return {
		state: entry.state,
		display: trustStateWord(axis, entry.state),
		authority: entry.state === "absent" ? null : clip(entry.authority.id),
	} as ReceiptTrust[Axis];
}

/**
 * The checks a verified receipt sealed, read structurally: a receipt from an older build is valid history, so a field
 * this build cannot read is null, never a pass (#434 §5.3).
 */
function sealedChecks(receipt: Record<string, unknown>): ReceiptSealed {
	const quality = isRecord(receipt.quality) ? receipt.quality : null;
	const verification = isRecord(receipt.verification) ? receipt.verification : null;
	const verificationState = oneOf(verification?.state, ["verified", "unverified", "not_applicable", "unknown"] as const);
	const verificationBasis = oneOf(verification?.basis, [
		"validation-tool",
		"read-only-agent",
		"no-validation-tool",
		"acp-external-unobserved",
		"receipt-unavailable",
	] as const);
	const typed = Array.isArray(quality?.typedValidations)
		? quality.typedValidations.flatMap((entry) =>
				isRecord(entry) &&
				typeof entry.sourceId === "string" &&
				typeof entry.validatorDigest === "string" &&
				typeof entry.passed === "boolean"
					? [{ sourceId: clip(entry.sourceId), validatorDigest: clip(entry.validatorDigest, 256), passed: entry.passed }]
					: [],
			)
		: null;
	const host = isRecord(receipt.hostVerification) ? receipt.hostVerification : null;
	const hostStatus = oneOf(host?.status, ["verified", "rejected", "skipped", "not_implicated"] as const);
	const contractFact = quality && Object.hasOwn(quality, "resultContract") ? quality.resultContract : undefined;
	const contract = isRecord(contractFact) ? contractFact : null;
	const conformance = oneOf(contract?.conformance, ["pass", "fail", "not-reached"] as const);
	const contractQuality = oneOf(contract?.quality, ["pass", "fail", "unmeasured"] as const);
	const schema = isRecord(quality?.responseSchema) ? quality.responseSchema : null;
	const grounding = isRecord(receipt.validationGrounding) ? receipt.validationGrounding : null;
	const groundingBasis = oneOf(grounding?.basis, ["no-command-executed", "unmatched-command"] as const);
	const claimed = integerOrNull(grounding?.claimed);
	const grounded = integerOrNull(grounding?.grounded);
	return {
		outcome: clip(optionalString(receipt.outcome) ?? "unknown"),
		outcomeCode: textOrNull(receipt.outcomeCode),
		exitCode: integerOrNull(receipt.exitCode),
		failureMessage: textOrNull(receipt.failureMessage),
		verification: verificationState && verificationBasis ? { state: verificationState, basis: verificationBasis } : null,
		typedValidations: typed,
		hostVerification:
			host && hostStatus
				? {
						status: hostStatus,
						reason: textOrNull(host.reason),
						strategy: host.strategy === "batch-settled" ? "batch-settled" : "single",
						checks: (Array.isArray(host.checks) ? host.checks : []).flatMap((check) => {
							if (!isRecord(check) || typeof check.check !== "string") return [];
							const exitCode = integerOrNull(check.exitCode);
							const durationMs = nonNegativeOrNull(check.durationMs);
							if (exitCode === null || durationMs === null) return [];
							return [
								{
									check: clip(check.check),
									exitCode,
									durationMs,
									memo: check.memo === true,
									outputTail: textOrNull(check.outputTail, 16_384) ?? "",
									evidenceRunId: optionalString(check.evidenceRunId) ?? null,
								},
							];
						}),
					}
				: null,
		resultContract:
			contractFact === null
				? "unmeasured"
				: contract && typeof contract.sourceId === "string" && conformance && contractQuality
					? {
							sourceId: clip(contract.sourceId),
							validatorDigest: clip(optionalString(contract.validatorDigest) ?? "", 256),
							kind: contractKindFrom(receipt) ?? null,
							conformance,
							quality: contractQuality,
						}
					: null,
		responseSchema:
			schema && typeof schema.runtimeEnforceable === "boolean"
				? {
						sourceId: textOrNull(schema.sourceId),
						schemaDigest: textOrNull(schema.schemaDigest, 256),
						runtimeEnforceable: schema.runtimeEnforceable,
						enforcementPassed: typeof schema.enforcementPassed === "boolean" ? schema.enforcementPassed : null,
					}
				: null,
		validationGrounding:
			grounding && groundingBasis && claimed !== null && claimed >= 0 && grounded !== null && grounded >= 0
				? {
						claimed,
						grounded,
						ungrounded: (Array.isArray(grounding.ungrounded) ? grounding.ungrounded : [])
							.filter((name): name is string => typeof name === "string")
							.map((name) => clip(name)),
						basis: groundingBasis,
					}
				: null,
	};
}

/**
 * A run's sealed receipt read through its integrity check, for every surface that shows what the receipt verified
 * (#434 §11.3). The ledger row authenticates the seal; without it the seal verifies alone as `ledger evicted`.
 */
export function readReceiptEvidence(
	runId: string,
	stateDir = clioStateDir(),
	options: { now?: Date } = {},
): ReceiptEvidenceV1 {
	let receipt: Record<string, unknown> | null = null;
	let state: ReceiptEvidenceV1["receipt"] = "missing";
	try {
		const parsed: unknown = JSON.parse(readFileSync(receiptFilePath(stateDir, runId), "utf8"));
		if (isRecord(parsed) && optionalString(parsed.runId) === runId) {
			receipt = parsed;
			state = "sealed";
		} else state = "unreadable";
	} catch (error) {
		// Any read or parse failure other than a missing file is a receipt that exists but cannot be read.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") state = "unreadable";
	}
	const row = receipt ? findRunRow(runId, stateDir) : null;
	const inspection = inspectRunReceiptTrustStatus(
		receipt as unknown as RunReceipt | null,
		row as unknown as RunEnvelope | null,
	);
	const outcome = inspection.integrity;
	const integrity: ReceiptEvidenceV1["integrity"] =
		receipt === null
			? { state: "unavailable", display: integrityClause(inspection.status), detail: `receipt ${state}` }
			: outcome.ok
				? {
						state: outcome.ledgerEvicted ? "verified-ledger-evicted" : "verified",
						display: integrityClause(inspection.status),
						detail: null,
					}
				: {
						state: outcome.retired ? "retired-format" : "failed",
						display: integrityClause(inspection.status),
						detail: clip(outcome.reason),
					};
	const status = inspection.status;
	let evidence: ReceiptEvidenceV1["evidence"] = null;
	try {
		const filed = readEvidenceIndex(stateDir).filter((entry) => entry.runId === runId);
		const newest = filed.reduce<(typeof filed)[number] | null>(
			(latest, entry) => (latest === null || entry.generatedAt > latest.generatedAt ? entry : latest),
			null,
		);
		if (newest && Number.isFinite(Date.parse(newest.generatedAt)))
			evidence = {
				evidenceId: newest.evidenceId,
				findingCount: Math.max(0, Math.trunc(newest.findingCount)),
				succeeded: newest.succeeded ?? null,
				filedAt: new Date(newest.generatedAt).toISOString(),
			};
	} catch {
		// An unreadable evidence index files the run under no bundle; the receipt's own facts still stand.
		evidence = null;
	}
	return {
		v: TELEMETRY_DTO_VERSION,
		foldVersion: TELEMETRY_FOLD_VERSION,
		generatedAt: (options.now ?? new Date()).toISOString(),
		kind: "receipt-evidence",
		runId,
		receipt: state,
		integrity,
		trust: {
			artifactIntegrity: trustAxis(status, "artifactIntegrity"),
			validationGrounding: trustAxis(status, "validationGrounding"),
			independentReview: trustAxis(status, "independentReview"),
			contextProvenance: trustAxis(status, "contextProvenance"),
			completionEvidence: trustAxis(status, "completionEvidence"),
			validation: validationClause(status),
		},
		sealed: receipt && outcome.ok ? sealedChecks(receipt) : null,
		evidence,
	};
}
