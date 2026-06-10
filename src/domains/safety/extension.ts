import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { classify as classifyCall } from "./action-classifier.js";
import {
	type AbortSource,
	type AuditRecord,
	type AuditWriter,
	buildAbortAuditRecord,
	buildAgentStatusChangeAuditRecord,
	buildAuditRecord,
	buildPermissionAuditRecord,
	buildSessionParkAuditRecord,
	buildSessionResumeAuditRecord,
	openAuditWriter,
	type SessionParkReason,
	type SessionResumeVia,
} from "./audit.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import { createLoopState, type LoopDetectorState, observe as observeLoop } from "./loop-detector.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "./policy-engine.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "./scope.js";

interface PermissionResolvedPayload {
	status: "granted" | "denied";
	tool?: string;
	actionClass?: string;
	reason?: string;
	requestedBy?: string;
	at?: number;
}

function isPermissionResolvedPayload(value: unknown): value is PermissionResolvedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (p.status !== "granted" && p.status !== "denied") return false;
	if (p.tool !== undefined && typeof p.tool !== "string") return false;
	if (p.actionClass !== undefined && typeof p.actionClass !== "string") return false;
	if (p.reason !== undefined && typeof p.reason !== "string") return false;
	if (p.requestedBy !== undefined && typeof p.requestedBy !== "string") return false;
	return true;
}

interface RunAbortedPayload {
	source: AbortSource;
	runId: string | null;
	startedAt: string | null;
	elapsedMs: number | null;
	at?: number;
	reason?: string;
}

const ABORT_SOURCES = new Set<AbortSource>(["dispatch_abort", "dispatch_drain", "stream_cancel"]);

function isRunAbortedPayload(value: unknown): value is RunAbortedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.source !== "string" || !ABORT_SOURCES.has(p.source as AbortSource)) return false;
	if (p.runId !== null && typeof p.runId !== "string") return false;
	if (p.startedAt !== null && typeof p.startedAt !== "string") return false;
	if (p.elapsedMs !== null && typeof p.elapsedMs !== "number") return false;
	if (p.reason !== undefined && typeof p.reason !== "string") return false;
	return true;
}

interface SessionParkedPayload {
	sessionId: string;
	reason: SessionParkReason;
	at?: number;
}

interface SessionResumedPayload {
	sessionId: string;
	via: SessionResumeVia;
	at?: number;
}

interface AgentStatusChangedPayload {
	runId: string | null;
	phase: string;
	prevPhase: string;
	at?: number;
	elapsedFromStart: number;
	watchdogTier: number;
	metadata?: Record<string, unknown>;
}

const PARK_REASONS = new Set<SessionParkReason>([
	"create_new",
	"resume_other",
	"fork",
	"switch_branch",
	"close",
	"shutdown",
]);
const RESUME_VIAS = new Set<SessionResumeVia>(["resume", "switch_branch"]);

function isSessionParkedPayload(value: unknown): value is SessionParkedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.sessionId !== "string") return false;
	if (typeof p.reason !== "string" || !PARK_REASONS.has(p.reason as SessionParkReason)) return false;
	return true;
}

function isSessionResumedPayload(value: unknown): value is SessionResumedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.sessionId !== "string") return false;
	if (typeof p.via !== "string" || !RESUME_VIAS.has(p.via as SessionResumeVia)) return false;
	return true;
}

function isAgentStatusChangedPayload(value: unknown): value is AgentStatusChangedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (p.runId !== null && typeof p.runId !== "string") return false;
	if (typeof p.phase !== "string" || typeof p.prevPhase !== "string") return false;
	if (typeof p.elapsedFromStart !== "number" || !Number.isFinite(p.elapsedFromStart)) return false;
	if (typeof p.watchdogTier !== "number" || !Number.isFinite(p.watchdogTier)) return false;
	if (p.metadata !== undefined && (!p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata)))
		return false;
	return true;
}

function isAlarmableStatus(payload: AgentStatusChangedPayload): boolean {
	if (payload.phase === "stuck" || payload.phase === "tool_blocked" || payload.phase === "retrying") return true;
	return payload.phase === "ended" && payload.metadata?.reason === "cancelled";
}

export function createSafetyBundle(context: DomainContext): DomainBundle<SafetyContract> {
	let writer: AuditWriter | null = null;
	let policyEngine: SafetyPolicyEngine | null = null;
	let loopState: LoopDetectorState = createLoopState();
	let recordCount = 0;
	let unsubscribePermissionResolved: (() => void) | null = null;
	let unsubscribeRunAborted: (() => void) | null = null;
	let unsubscribeSessionParked: (() => void) | null = null;
	let unsubscribeSessionResumed: (() => void) | null = null;
	let unsubscribeAgentStatusChanged: (() => void) | null = null;
	let unsubscribeDispatchCompleted: (() => void) | null = null;
	let unsubscribeDispatchFailed: (() => void) | null = null;

	function writeAudit(rec: AuditRecord): void {
		if (writer === null) return;
		writer.write(rec);
		recordCount += 1;
	}

	const extension: DomainExtension = {
		async start() {
			policyEngine = createSafetyPolicyEngine();
			writer = openAuditWriter();
			unsubscribePermissionResolved = context.bus.on(BusChannels.PermissionResolved, (payload) => {
				if (!isPermissionResolvedPayload(payload)) return;
				writeAudit(
					buildPermissionAuditRecord({
						status: payload.status,
						...(payload.tool !== undefined ? { tool: payload.tool } : {}),
						...(payload.actionClass !== undefined ? { actionClass: payload.actionClass } : {}),
						...(payload.reason !== undefined ? { reason: payload.reason } : {}),
						...(payload.requestedBy !== undefined ? { requestedBy: payload.requestedBy } : {}),
					}),
				);
			});
			unsubscribeRunAborted = context.bus.on(BusChannels.RunAborted, (payload) => {
				if (!isRunAbortedPayload(payload)) return;
				const recordInput: Parameters<typeof buildAbortAuditRecord>[0] = {
					source: payload.source,
					runId: payload.runId,
					startedAt: payload.startedAt,
					elapsedMs: payload.elapsedMs,
				};
				if (payload.reason !== undefined) recordInput.reason = payload.reason;
				writeAudit(buildAbortAuditRecord(recordInput));
			});
			unsubscribeSessionParked = context.bus.on(BusChannels.SessionParked, (payload) => {
				if (!isSessionParkedPayload(payload)) return;
				writeAudit(buildSessionParkAuditRecord({ sessionId: payload.sessionId, reason: payload.reason }));
			});
			unsubscribeSessionResumed = context.bus.on(BusChannels.SessionResumed, (payload) => {
				if (!isSessionResumedPayload(payload)) return;
				writeAudit(buildSessionResumeAuditRecord({ sessionId: payload.sessionId, via: payload.via }));
			});
			unsubscribeAgentStatusChanged = context.bus.on(BusChannels.AgentStatusChanged, (payload) => {
				if (!isAgentStatusChangedPayload(payload) || !isAlarmableStatus(payload)) return;
				writeAudit(
					buildAgentStatusChangeAuditRecord({
						runId: payload.runId,
						phase: payload.phase,
						prevPhase: payload.prevPhase,
						elapsedFromStart: payload.elapsedFromStart,
						watchdogTier: payload.watchdogTier,
						...(payload.metadata ? { metadata: payload.metadata } : {}),
					}),
				);
			});
			// Every dispatch terminal transition is auditable with its resolved
			// outcome and lineage, so an auditor can walk a retry chain or a
			// fleet step back to the operator-initiated root run.
			const auditDispatchTerminal = (raw: unknown): void => {
				if (!raw || typeof raw !== "object") return;
				const payload = raw as Record<string, unknown>;
				if (typeof payload.runId !== "string" || typeof payload.outcome !== "string") return;
				const lineage =
					payload.lineage && typeof payload.lineage === "object" && !Array.isArray(payload.lineage)
						? (payload.lineage as Record<string, unknown>)
						: null;
				const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : 0;
				writeAudit(
					buildAgentStatusChangeAuditRecord({
						runId: payload.runId,
						phase: payload.outcome,
						prevPhase: "running",
						elapsedFromStart: durationMs,
						watchdogTier: 0,
						metadata: {
							outcome: payload.outcome,
							...(payload.outcomeDetail !== undefined && payload.outcomeDetail !== null
								? { outcomeDetail: payload.outcomeDetail }
								: {}),
							...(typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
							...(lineage !== null
								? {
										parentRunId: lineage.parentRunId ?? null,
										rootRunId: lineage.rootRunId ?? null,
										attempt: lineage.attempt ?? 0,
										depth: lineage.depth ?? 0,
									}
								: {}),
						},
					}),
				);
			};
			unsubscribeDispatchCompleted = context.bus.on(BusChannels.DispatchCompleted, auditDispatchTerminal);
			unsubscribeDispatchFailed = context.bus.on(BusChannels.DispatchFailed, auditDispatchTerminal);
		},
		async stop() {
			unsubscribePermissionResolved?.();
			unsubscribePermissionResolved = null;
			unsubscribeRunAborted?.();
			unsubscribeRunAborted = null;
			unsubscribeSessionParked?.();
			unsubscribeSessionParked = null;
			unsubscribeSessionResumed?.();
			unsubscribeSessionResumed = null;
			unsubscribeAgentStatusChanged?.();
			unsubscribeAgentStatusChanged = null;
			unsubscribeDispatchCompleted?.();
			unsubscribeDispatchCompleted = null;
			unsubscribeDispatchFailed?.();
			unsubscribeDispatchFailed = null;
			await writer?.close();
			writer = null;
		},
	};

	const contract: SafetyContract = {
		classify(call) {
			return classifyCall(call);
		},
		evaluate(call, posture) {
			const policy = (policyEngine ?? createSafetyPolicyEngine()).evaluate(call, posture);
			const classification = policy.classification;

			context.bus.emit(BusChannels.SafetyClassified, {
				tool: call.tool,
				actionClass: classification.actionClass,
				reasons: classification.reasons,
				ruleId: policy.ruleId,
				posture,
				policySource: policy.policySource,
				reasonCode: policy.reasonCode,
			});

			if (policy.kind === "block") {
				const auditInput: Parameters<typeof buildAuditRecord>[0] = {
					tool: call.tool,
					classification,
					decision: "blocked",
					args: call.args,
					policy,
				};
				if (posture !== undefined) auditInput.posture = posture;
				const record = buildAuditRecord(auditInput);
				writeAudit(record);
				context.bus.emit(BusChannels.SafetyBlocked, {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: policy.ruleId,
					posture,
					rejection: policy.rejection,
					policySource: policy.policySource,
					reasonCode: policy.reasonCode,
				});
				const decision: SafetyDecision = {
					kind: "block",
					classification,
					rejection: policy.rejection ?? fallbackRejection(policy),
					policy,
				};
				if (policy.match) (decision as { match?: typeof policy.match }).match = policy.match;
				return decision;
			}
			if (policy.kind === "ask") {
				const auditInput: Parameters<typeof buildAuditRecord>[0] = {
					tool: call.tool,
					classification,
					decision: "permission_requested",
					args: call.args,
					policy,
				};
				if (posture !== undefined) auditInput.posture = posture;
				writeAudit(buildAuditRecord(auditInput));
				context.bus.emit(BusChannels.PermissionRequested, {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: policy.ruleId,
					posture,
					rejection: policy.rejection,
					policySource: policy.policySource,
					reasonCode: policy.reasonCode,
				});
				const decision: SafetyDecision = {
					kind: "ask",
					classification,
					rejection: policy.rejection ?? fallbackRejection(policy),
					policy,
				};
				if (policy.match) (decision as { match?: typeof policy.match }).match = policy.match;
				return decision;
			}

			const auditInput: Parameters<typeof buildAuditRecord>[0] = {
				tool: call.tool,
				classification,
				decision: "allowed",
				args: call.args,
				policy,
			};
			if (posture !== undefined) auditInput.posture = posture;
			const record = buildAuditRecord(auditInput);
			writeAudit(record);
			context.bus.emit(BusChannels.SafetyAllowed, {
				tool: call.tool,
				actionClass: classification.actionClass,
				posture,
				ruleId: policy.ruleId,
				policySource: policy.policySource,
				reasonCode: policy.reasonCode,
			});
			return { kind: "allow", classification, policy };
		},
		observeLoop(key, now) {
			const [next, verdict] = observeLoop(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		policy: { metadata: (posture) => (policyEngine ?? createSafetyPolicyEngine()).metadata(posture) },
		audit: { recordCount: () => recordCount },
	};

	return { extension, contract };
}

function fallbackRejection(policy: { tool: string; actionClass: string; reasons: ReadonlyArray<string> }) {
	return {
		short: `${policy.tool} blocked: ${policy.actionClass}`,
		detail: policy.reasons.join("\n"),
		hints: [],
	};
}
