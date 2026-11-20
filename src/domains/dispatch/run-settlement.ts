/**
 * A finished run's one persisted record (#434): the structural facts run.settled carries and the `run-result` object
 * it names, built together so the journal and the object never disagree.
 */

import type { EventPayload } from "../../core/telemetry/events.js";
import {
	type RunResultObject,
	type RunSettled,
	SEALED_CHECK_REPORT_KEYS_MAX,
	type SealedCheckReport,
} from "../../core/telemetry/schemas.js";
import { type NumericDeviation, widestSpread } from "../../tools/verify/numeric.js";
import type { DeclaredCheckReport } from "../../tools/verify/scripts.js";
import { RESULT_CONTRACT_REPAIR_LIMIT } from "../agents/result-contract.js";
import type { RunAssessmentContext } from "../evidence/assessment.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";
import { runContextProvenance } from "../evidence/trust-status.js";
import { runtimeResolutionWarnings } from "../providers/runtime-resolution.js";
import { redactSecretString } from "../safety/redaction.js";
import { telemetryObjectRef } from "../telemetry/objects.js";
import { runSettledDigest } from "../telemetry/run-digest.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
} from "./budget-envelope.js";
import type { ResolvedTerminalReason } from "./outcome.js";
import { deriveEnvelopePhaseDurations } from "./phase-timing.js";
import { type RouteDecisionV1, routeConstraintValidity } from "./route-decision.js";
import { defaultRoutingIntent, type RoutingIntent } from "./routing-intent.js";
import type { RunCallUsage, RunUsageFacts } from "./run-call-usage.js";
import { unobservedRunUsageFacts } from "./run-call-usage.js";
import { labelledRunHashes, undeclaredRunHashes } from "./run-hashes.js";
import { runGatewayRoutingLabel, runResponseModelIdObservationLabel } from "./run-upstream.js";
import type {
	RunEnvelope,
	RunOutcome,
	RunPhaseDurations,
	RunResult,
	RunResultDraft,
	SafetyBlockedAttempt,
	ToolActivitySummary,
} from "./types.js";

/** The facts and the object a run settles with; the journal adds the object's reference as `result`. */
export interface RunSettlement {
	facts: Omit<RunSettled, "result">;
	result: RunResultObject;
	/** What the run's assessment reads of its dispatch, from the ledger row it settled from (#434). */
	assessment?: RunAssessmentContext;
}

/** The provenance a run's sealed assessment records, as dispatch admitted the run. */
function runAssessmentContext(
	run: Pick<RunEnvelope, "sessionId" | "cwd" | "lineage" | "decisionRefs" | "pipeline" | "personaOverride">,
): RunAssessmentContext {
	return {
		sessionId: run.sessionId,
		cwd: run.cwd,
		attempt: run.lineage?.attempt ?? null,
		decisionRefs: [...(run.decisionRefs ?? [])],
		pipeline: run.pipeline ? { ...run.pipeline } : null,
		personaOverride: run.personaOverride ? { ...run.personaOverride } : null,
	};
}

const DIAGNOSTIC_CHARS = 1024;

/** Diagnostic text as run.settled states it: redacted and clipped. The full text stays in the result object. */
function diagnostic(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value === "") return null;
	const redacted = redactSecretString(value);
	return redacted.length <= DIAGNOSTIC_CHARS ? redacted : `${redacted.slice(0, DIAGNOSTIC_CHARS - 1)}…`;
}

function repairRounds(terminal: ResolvedTerminalReason | undefined): RunSettled["repairRounds"] {
	return terminal?.terminalReason === "contract_exhausted_after_repair"
		? { kind: "measured", value: RESULT_CONTRACT_REPAIR_LIMIT, source: "local-count" }
		: { kind: "unknown", reason: "not-observed" };
}

/** The decision as run.settled records it, with the executed route's whole identity for the route history fold. */
function routeDecisionOf(decision: RouteDecisionV1 | undefined): RunSettled["routeDecision"] {
	if (decision === undefined) return null;
	const executed = decision.executedRoute;
	return {
		decisionHash: decision.decisionHash,
		mode: decision.mode,
		durationMs: decision.decisionDurationMs,
		constraintsValid: routeConstraintValidity(decision).valid,
		executed: {
			agentId: executed.agentId,
			specFingerprint: executed.specFingerprint,
			executionRole: executed.executionRole,
			targetId: executed.targetId,
			modelId: executed.modelId,
			runtimeId: executed.runtimeId,
			nodeId: executed.nodeId,
			thinkingLevel: executed.thinkingLevel ?? null,
			toolSignature: executed.toolSignature,
			promptCompositionHash: executed.promptCompositionHash,
			endpointIdentityHash: executed.endpointIdentityHash,
			settingsFingerprint: executed.settingsFingerprint,
		},
	};
}

const UNMARKED_PHASES: RunPhaseDurations = { queueWaitMs: null, totalEndToEndMs: null };

function routeOf(
	run: Pick<RunEnvelope, "targetId" | "wireModelId" | "runtimeId" | "runtimeKind">,
): RunSettled["route"] {
	return {
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		runtimeKind: run.runtimeKind,
	};
}

/** The finalizer's tool activity and the calls it saw start and never finish, which the producer alone observed (FL-6). */
function toolActivityOf(
	activity: ToolActivitySummary,
	telemetry: { unfinished: ReadonlyArray<{ count: number }> } | undefined,
): NonNullable<RunSettled["toolActivity"]> {
	const unfinished = telemetry?.unfinished.reduce((sum, entry) => sum + entry.count, 0) ?? 0;
	return { ...activity, ...(unfinished > 0 ? { unfinished } : {}) };
}

function routeWarningsOf(run: Pick<RunResultDraft, "runtimeResolution">): Pick<RunSettled, "routeWarnings"> {
	const warnings = runtimeResolutionWarnings(run.runtimeResolution?.diagnostics ?? [])
		.slice(0, 16)
		.flatMap((message) => diagnostic(message) ?? []);
	return warnings.length > 0 ? { routeWarnings: warnings } : {};
}

function nodeOf(run: Pick<RunEnvelope, "node">): RunSettled["node"] {
	return run.node ? { id: run.node.id, kind: run.node.kind } : null;
}

function identityOf(run: Pick<RunEnvelope, "identity">): RunSettled["identity"] {
	return run.identity ? { host: run.identity.host, user: run.identity.user } : null;
}

function routingIntentOf(intent: RoutingIntent): RunSettled["routingIntent"] {
	return { ...intent, requiredCapabilities: [...intent.requiredCapabilities] };
}

function contextOf(
	run: Pick<RunResultDraft, "briefing" | "workerContext"> & Partial<Pick<RunResultDraft, "projectContext">>,
): RunSettled["context"] {
	return {
		briefingBytes: run.briefing?.bytes ?? null,
		worker: run.workerContext
			? {
					mode: run.workerContext.mode,
					estimatedTokens: run.workerContext.estimatedTokens,
					omittedMessages: run.workerContext.omittedMessages,
				}
			: null,
		project: run.projectContext
			? {
					tier: run.projectContext.tier,
					chars: run.projectContext.chars ?? null,
					sections: [...(run.projectContext.sections ?? [])],
				}
			: null,
	};
}

function escalationsOf(safety: RunResultDraft["safety"]): RunSettled["escalations"] {
	const decisions = safety?.decisions;
	if (decisions?.escalationRequested === undefined) return null;
	return {
		requested: decisions.escalationRequested,
		approved: decisions.escalationApproved ?? 0,
		denied: decisions.escalationDenied ?? 0,
		timedOut: decisions.escalationTimedOut ?? 0,
	};
}

const REPORT_TEXT_CHARS = 256;

function clipped(value: string): string {
	return value.length <= REPORT_TEXT_CHARS ? value : `${value.slice(0, REPORT_TEXT_CHARS - 1)}…`;
}

function sealedKey(
	key: string,
	passed: boolean,
	worst: NumericDeviation | undefined,
): SealedCheckReport["keys"][number] {
	return {
		key: clipped(key),
		passed,
		absolute: worst?.absolute ?? null,
		relative: worst?.relative ?? null,
		ulp: worst?.ulp ?? null,
	};
}

/**
 * A judged check's verdict as the sealed result keeps it (D3-3): what it judged by, the digests of what it read, and
 * each key's worst deviation, failing keys first, so a reviewer can audit the verdict without the unsealed logs.
 */
function sealedCheckReport(report: DeclaredCheckReport): SealedCheckReport {
	if (report.kind === "perf-budget") {
		return {
			kind: report.kind,
			passed: report.passed,
			rule: clipped(
				`wall time <= ${report.budgetMs}ms (${report.source} ${report.referenceMs}ms, relative tolerance ${report.relative})`,
			),
			tolerance: { relative: report.relative },
			reference: report.baseline ? { path: report.baseline.path, sha256: report.baseline.sha256 } : null,
			payloadSha256: null,
			keyCount: 0,
			failedKeyCount: 0,
			failedKeys: [],
			keys: [],
			measuredMs: report.measuredMs,
			budgetMs: report.budgetMs,
		};
	}
	const keys =
		report.kind === "numeric-compare"
			? report.keys.map((key) => sealedKey(key.key, key.passed, key.worst))
			: report.metrics.map((metric) => sealedKey(metric.metric, metric.passed, metric.agreement?.worst));
	const failedKeys = report.kind === "numeric-compare" ? report.failedKeys : report.failedMetrics;
	const payloadSha256 =
		report.kind === "numeric-compare" ? (report.actual?.sha256 ?? null) : (report.runs[0]?.payload?.sha256 ?? null);
	const inputs = report.kind === "numeric-compare" ? (report.provenance?.inputs ?? []) : report.conditions.inputs;
	const probes = report.kind === "numeric-compare" ? report.provenance?.probes : report.conditions.probes;
	const untracked = report.kind === "reproduce" ? report.conditions.untracked : undefined;
	const repeat = report.repeat;
	const spread = repeat === undefined ? [] : widestSpread(repeat.spread).slice(0, SEALED_CHECK_REPORT_KEYS_MAX);
	return {
		kind: report.kind,
		passed: report.passed,
		rule: clipped(report.rule),
		tolerance: { ...report.tolerance },
		reference: report.reference ? { path: report.reference.path ?? null, sha256: report.reference.sha256 } : null,
		payloadSha256,
		keyCount: keys.length,
		failedKeyCount: failedKeys.length,
		failedKeys: failedKeys.slice(0, SEALED_CHECK_REPORT_KEYS_MAX).map(clipped),
		keys: [...keys.filter((key) => !key.passed), ...keys.filter((key) => key.passed)].slice(
			0,
			SEALED_CHECK_REPORT_KEYS_MAX,
		),
		...(inputs.length > 0
			? {
					inputs: inputs.slice(0, SEALED_CHECK_REPORT_KEYS_MAX).map((input) => ({ path: input.path, sha256: input.sha256 })),
				}
			: {}),
		...(probes !== undefined && probes.length > 0
			? {
					probes: probes.slice(0, 8).map((probe) => ({
						argv: probe.argv.slice(0, 64).map(clipped),
						exitCode: probe.exitCode,
						sha256: probe.sha256,
						version: probe.version === null ? null : clipped(probe.version),
					})),
				}
			: {}),
		...(untracked !== undefined ? { untracked } : {}),
		...(repeat !== undefined
			? {
					runs: repeat.runs,
					failedRuns: repeat.failedRuns.slice(0, 8),
					...(spread.length > 0
						? { spread: spread.map((entry) => ({ key: clipped(entry.key), spread: entry.spread })) }
						: {}),
				}
			: {}),
	};
}

/** Blocked attempts as the sealed record keeps them: by tool, class and rule, never the reason prose. */
function settledBlockedAttempts(attempts: ReadonlyArray<SafetyBlockedAttempt>): RunSettled["blockedAttempts"] {
	return attempts.slice(0, 64).map((attempt) => ({
		tool: attempt.tool,
		actionClass: attempt.actionClass ?? null,
		ruleId: attempt.ruleId ?? null,
		reasonCode: attempt.reasonCode ?? null,
	}));
}

/** The settlement of a run whose worker finished, from what its finalization sealed (#434). */
export function settleFinishedRun(
	receipt: RunResultDraft,
	input: {
		terminal: ResolvedTerminalReason;
		processExitCode: number | null;
		frameType: string | null;
		usage: RunUsageFacts | undefined;
		/** From the ledger row's phase marks; a producer settling without its row records them unmarked. */
		phaseTiming?: RunPhaseDurations;
		/** How the run's step template pipeline ended, when the run drove one (bt-20). */
		stepPipeline?: RunSettled["stepPipeline"];
		/**
		 * Refused asks per tool, counted exactly by a producer that lists only the first `BLOCKED_ATTEMPTS_LIMIT` in
		 * `permissionRequestedAttempts`. Without it the list is counted, which falls short past the limit (SC-2).
		 */
		askedByTool?: ReadonlyMap<string, number>;
	},
): RunSettlement {
	const usage = input.usage ?? unobservedRunUsageFacts();
	const host = receipt.hostVerification;
	// An ask refused without an answer, as a --timeout abort denies one, is a permission request the way `decisions`
	// counts it, not a blocked call (bt-15 c14a). The tools row counts it as `asked`, so the row still sums (FX-3).
	const asked = new Map<string, number>(input.askedByTool ?? []);
	if (input.askedByTool === undefined)
		for (const attempt of receipt.safety?.permissionRequestedAttempts ?? [])
			asked.set(attempt.tool, (asked.get(attempt.tool) ?? 0) + 1);
	return redactedSettlement({
		facts: {
			version: 1,
			agentId: receipt.agentId,
			executionRole: receipt.executionRole,
			requestOrigin: receipt.requestOrigin ?? null,
			identity: identityOf(receipt),
			route: routeOf(receipt),
			node: nodeOf(receipt),
			routeDecision: routeDecisionOf(receipt.routeDecision),
			attempt: receipt.lineage?.attempt ?? 0,
			phaseTiming: input.phaseTiming ?? UNMARKED_PHASES,
			routingIntent: routingIntentOf(receipt.routingIntent ?? defaultRoutingIntent({})),
			startedAt: receipt.startedAt,
			endedAt: receipt.endedAt,
			outcome: receipt.outcome,
			outcomeCode: receipt.outcomeCode ?? null,
			exitCode: receipt.exitCode,
			outcomeDetail: diagnostic(receipt.outcomeDetail),
			failureMessage: diagnostic(receipt.failureMessage),
			terminalReason: input.terminal.terminalReason,
			callIds: receipt.callIds ?? null,
			processExitCode: input.processExitCode,
			...(input.terminal.boundKind ? { boundKind: input.terminal.boundKind } : {}),
			...(input.stepPipeline ? { stepPipeline: { ...input.stepPipeline } } : {}),
			repairRounds: repairRounds(input.terminal),
			frameType: input.frameType,
			...usage,
			toolCalls: receipt.toolCalls,
			tools: receipt.toolStats.slice(0, 256).map((stat) => {
				const refusedAsks = Math.min(stat.blocked, asked.get(stat.tool) ?? 0);
				return {
					tool: stat.tool,
					calls: stat.count,
					ok: stat.ok,
					errors: stat.errors,
					blocked: stat.blocked - refusedAsks,
					...(refusedAsks > 0 ? { asked: refusedAsks } : {}),
				};
			}),
			skills: (receipt.skillActivations ?? [])
				.slice(0, 256)
				.map((skill) => ({ name: skill.name, requestSource: skill.requestSource ?? null })),
			toolActivity: receipt.toolActivity ? toolActivityOf(receipt.toolActivity, receipt.safety?.toolTelemetry) : null,
			capabilityMismatch: receipt.capabilityMismatch
				? {
						agentId: receipt.capabilityMismatch.agentId,
						capabilityClass: receipt.capabilityMismatch.capabilityClass,
						taskType: receipt.capabilityMismatch.taskType,
						suggestedAgentId: receipt.capabilityMismatch.suggestedAgentId,
					}
				: null,
			budget: receipt.budget
				? {
						policy: diagnostic(formatBudgetPolicy(receipt.budget)) ?? "",
						requested: diagnostic(formatBudgetRequest(receipt.budget)) ?? "",
						effective: diagnostic(formatEffectiveBudget(receipt.budget)) ?? "",
						reasons: diagnostic(formatBudgetReasons(receipt.budget)) ?? "",
					}
				: null,
			context: contextOf(receipt),
			upstream: {
				responseModelIds: diagnostic(runResponseModelIdObservationLabel(receipt)),
				gatewayRoutes: diagnostic(runGatewayRoutingLabel(receipt)),
			},
			blockedAttempts: settledBlockedAttempts(receipt.safety?.blockedAttempts ?? []),
			...(receipt.safety?.guardBlockedAttempts?.length
				? { guardBlockedAttempts: settledBlockedAttempts(receipt.safety.guardBlockedAttempts) }
				: {}),
			...(receipt.safety?.permissionRequestedAttempts?.length
				? { permissionRequestedAttempts: settledBlockedAttempts(receipt.safety.permissionRequestedAttempts) }
				: {}),
			escalations: escalationsOf(receipt.safety),
			flowRestrictions: receipt.safety?.flowRestrictions
				? {
						version: 1,
						restrictions: receipt.safety.flowRestrictions.restrictions.map((entry) => ({
							ruleId: entry.ruleId,
							policyHash: entry.policyHash,
							sourceRef: entry.sourceRef,
							recipients: [...entry.recipients],
						})),
						...(receipt.safety.flowRestrictions.advisory ? { advisory: [...receipt.safety.flowRestrictions.advisory] } : {}),
					}
				: null,
			toolGovernance: receipt.delegation?.toolGovernance ?? null,
			verification: {
				state: receipt.verification.state,
				basis: receipt.verification.basis,
				...(receipt.verification.detail !== undefined ? { detail: receipt.verification.detail } : {}),
			},
			quality: {
				typedValidations: receipt.quality.typedValidations.map((fact) => ({ ...fact })),
				responseSchema: { ...receipt.quality.responseSchema },
				resultContract: receipt.quality.resultContract ? { ...receipt.quality.resultContract } : null,
			},
			validationGrounding: receipt.validationGrounding
				? { ...receipt.validationGrounding, ungrounded: [...receipt.validationGrounding.ungrounded] }
				: null,
			...(receipt.unclassifiedAfterLastCheck
				? {
						unclassifiedAfterLastCheck: {
							count: receipt.unclassifiedAfterLastCheck.count,
							commands: receipt.unclassifiedAfterLastCheck.commands.slice(0, 5),
						},
					}
				: {}),
			...routeWarningsOf(receipt),
			...(receipt.answerBudgetBytes !== undefined ? { answerBudgetBytes: receipt.answerBudgetBytes } : {}),
			worktree: receipt.worktree
				? { apply: receipt.worktree.apply, applied: receipt.worktree.applied, snapshot: receipt.worktree.snapshot ?? null }
				: null,
			hostVerification: host
				? {
						status: host.status,
						strategy: host.strategy ?? "single",
						checks: host.checks.length,
						failed: host.checks.filter((check) => check.exitCode !== 0).length,
						failedOnBase: host.checks.filter((check) => check.exitCode !== 0 && check.baseComparison?.status === "failed")
							.length,
						executed: host.checks.filter((check) => !check.memo && check.notRun === undefined).length,
						reused: host.checks.filter((check) => check.memo).length,
						skipped: host.checks.filter((check) => !check.memo && check.notRun !== undefined).length,
					}
				: null,
			contextProvenance: runContextProvenance(receipt),
			hashes: labelledRunHashes(receipt, receipt.agentId),
		},
		result: {
			version: 1,
			output: receipt.output
				? {
						state: receipt.output.state,
						text: receipt.output.text,
						bytes: receipt.output.bytes,
						truncated: receipt.output.truncated,
						...(receipt.output.structured !== undefined ? { structured: receipt.output.structured } : {}),
					}
				: null,
			failureMessage: receipt.failureMessage ?? null,
			outcomeDetail: receipt.outcomeDetail ?? null,
			worktree: receipt.worktree
				? {
						path: receipt.worktree.path,
						branch: receipt.worktree.branch,
						diffHash: receipt.worktree.diffHash,
						...(receipt.worktree.changedPaths !== undefined ? { changedPaths: [...receipt.worktree.changedPaths] } : {}),
						...(receipt.worktree.commit !== undefined ? { commit: receipt.worktree.commit } : {}),
						...(receipt.worktree.reason !== undefined ? { reason: receipt.worktree.reason } : {}),
						...(receipt.worktree.detail !== undefined ? { detail: receipt.worktree.detail } : {}),
						...(receipt.worktree.leftUncommitted !== undefined
							? {
									leftUncommitted: { ...receipt.worktree.leftUncommitted, paths: [...receipt.worktree.leftUncommitted.paths] },
								}
							: {}),
						...(receipt.worktree.changedAfterCommit !== undefined
							? {
									changedAfterCommit: {
										...receipt.worktree.changedAfterCommit,
										paths: [...receipt.worktree.changedAfterCommit.paths],
									},
								}
							: {}),
					}
				: null,
			checkoutChanges: receipt.checkoutChanges
				? { ...receipt.checkoutChanges, changedPaths: [...receipt.checkoutChanges.changedPaths] }
				: null,
			hostVerification: host
				? {
						reason: host.reason ?? null,
						checks: host.checks.map((check) => ({
							check: check.check,
							argv: [...check.argv],
							cwd: check.cwd,
							exitCode: check.exitCode,
							durationMs: check.durationMs,
							memo: check.memo,
							outputTail: check.outputTail,
							evidenceRunId: check.evidenceRunId ?? null,
							...(check.notRun !== undefined ? { notRun: check.notRun } : {}),
							baseComparison: check.baseComparison ? { ...check.baseComparison } : null,
							...(check.report !== undefined ? { report: sealedCheckReport(check.report) } : {}),
							...(check.tree !== undefined
								? {
										tree: {
											head: check.tree.head,
											fingerprint: check.tree.fingerprint,
											...(check.tree.untracked !== undefined ? { untracked: check.tree.untracked } : {}),
										},
									}
								: {}),
						})),
					}
				: null,
		},
	});
}

/**
 * The settlement the host writes for a run whose own finish never sealed: a finalization that failed, or recovery for
 * a run whose host died. How the loop ended when it was resolved, else a failed worker; nothing it did not see (#425).
 */
export function settleUnfinishedRun(
	run: RunEnvelope,
	input: {
		terminal: ResolvedTerminalReason | undefined;
		outcome: RunOutcome;
		detail: string;
		endedAt: string;
		processExitCode: number | null;
		/** What the run's journal recorded it spending; absent, its spend stays unobserved (FL-24). */
		usage?: RunCallUsage;
	},
): RunSettlement {
	return redactedSettlement({
		assessment: runAssessmentContext(run),
		facts: {
			version: 1,
			agentId: run.agentId,
			executionRole: run.executionRole,
			requestOrigin: run.requestOrigin ?? null,
			identity: identityOf(run),
			route: routeOf(run),
			node: nodeOf(run),
			routeDecision: null,
			attempt: run.lineage?.attempt ?? 0,
			phaseTiming: deriveEnvelopePhaseDurations(run, input.endedAt),
			routingIntent: routingIntentOf(defaultRoutingIntent({})),
			startedAt: run.startedAt,
			endedAt: input.endedAt,
			outcome: input.outcome,
			outcomeCode: null,
			exitCode: run.exitCode ?? input.processExitCode,
			outcomeDetail: diagnostic(input.detail),
			failureMessage: null,
			terminalReason: input.terminal?.terminalReason ?? "worker_failed",
			callIds: input.usage ? [...input.usage.callIds] : null,
			processExitCode: input.processExitCode,
			...(input.terminal?.boundKind ? { boundKind: input.terminal.boundKind } : {}),
			repairRounds: repairRounds(input.terminal),
			frameType: null,
			...(input.usage?.facts ?? unobservedRunUsageFacts()),
			toolCalls: 0,
			tools: [],
			skills: [],
			toolActivity: null,
			capabilityMismatch: null,
			budget: null,
			context: contextOf(run),
			upstream: { responseModelIds: null, gatewayRoutes: null },
			blockedAttempts: [],
			escalations: null,
			flowRestrictions: null,
			toolGovernance: null,
			verification: { state: "unknown", basis: "result-unavailable" },
			quality: null,
			validationGrounding: null,
			worktree: null,
			hostVerification: null,
			contextProvenance: runContextProvenance(run),
			hashes: [],
		},
		result: {
			version: 1,
			output: null,
			failureMessage: null,
			outcomeDetail: input.detail,
			worktree: null,
			checkoutChanges: null,
			hostVerification: null,
		},
	});
}

/** The record the journal writes once the result object is stored. */
export function runSettledRecord(settlement: RunSettlement, result: RunSettled["result"]): EventPayload<"run.settled"> {
	return { ...settlement.facts, result };
}

/**
 * The journal deep-redacts every record it writes. Settling facts that already passed the same redaction makes that
 * pass leave them unchanged, so the digest a producer computes names the payload the journal persists (#434).
 */
function redactedSettlement(settlement: RunSettlement): RunSettlement {
	return { ...settlement, facts: redactSecretsDeep(settlement.facts, createRedactionTally()) };
}

/** A finished run as dispatch hands it to its caller, and the settlement its journal records from the same facts. */
export interface FinishedRunResult {
	result: RunResult;
	settlement: RunSettlement;
}

/**
 * The one function that finishes a run (#434): it builds the settlement run.settled records from the result and names the result by the digest of that record, so the value dispatch hands its
 * caller and the record its journal keeps never disagree. `row` is the run ledger row as the terminal patch leaves it.
 */
export function finishRunResult(
	draft: RunResultDraft,
	row: RunEnvelope,
	input: {
		terminal: ResolvedTerminalReason;
		processExitCode: number | null;
		frameType: string | null;
		usage: RunUsageFacts | undefined;
		stepPipeline?: RunSettled["stepPipeline"];
		askedByTool?: ReadonlyMap<string, number>;
	},
): FinishedRunResult {
	if (draft.routingIntent === undefined) throw new Error(`run ${draft.runId} has no routing intent`);
	// R7: a hash without a declared function, canonicalization, subject and label is never settled (#434).
	const undeclared = undeclaredRunHashes(draft, draft.agentId);
	if (undeclared.length > 0) throw new Error(`run ${draft.runId} carries undeclared hashes ${undeclared.join(", ")}`);
	const settlement: RunSettlement = {
		...settleFinishedRun(draft, {
			...input,
			phaseTiming: deriveEnvelopePhaseDurations(row, row.endedAt ?? draft.endedAt),
		}),
		assessment: runAssessmentContext(row),
	};
	const record = runSettledRecord(settlement, telemetryObjectRef("run-result", settlement.result));
	return {
		result: { ...draft, routingIntent: draft.routingIntent, digest: runSettledDigest(record) },
		settlement,
	};
}
