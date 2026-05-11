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
	buildModeChangeAuditRecord,
	buildSessionParkAuditRecord,
	buildSessionResumeAuditRecord,
	openAuditWriter,
	type SessionParkReason,
	type SessionResumeVia,
} from "./audit.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import { createLoopState, type LoopDetectorState, observe as observeLoop } from "./loop-detector.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "./policy-engine.js";
import { DEFAULT_SCOPE, isSubset, READONLY_SCOPE, SUPER_SCOPE } from "./scope.js";

interface ModeChangedPayload {
	from: string | null;
	to: string;
	reason: string | null;
	at?: number;
	requestedBy?: string;
	requiresConfirmation?: boolean;
}

function isModeChangedPayload(value: unknown): value is ModeChangedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	const fromOk = p.from === null || typeof p.from === "string";
	const reasonOk = p.reason === null || typeof p.reason === "string";
	return fromOk && typeof p.to === "string" && reasonOk;
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
	let unsubscribeModeChanged: (() => void) | null = null;
	let unsubscribeRunAborted: (() => void) | null = null;
	let unsubscribeSessionParked: (() => void) | null = null;
	let unsubscribeSessionResumed: (() => void) | null = null;
	let unsubscribeAgentStatusChanged: (() => void) | null = null;

	function writeAudit(rec: AuditRecord): void {
		if (writer === null) return;
		writer.write(rec);
		recordCount += 1;
	}

	const extension: DomainExtension = {
		async start() {
			policyEngine = createSafetyPolicyEngine();
			writer = openAuditWriter();
			unsubscribeModeChanged = context.bus.on(BusChannels.ModeChanged, (payload) => {
				if (!isModeChangedPayload(payload)) return;
				const recordInput: Parameters<typeof buildModeChangeAuditRecord>[0] = {
					from: payload.from,
					to: payload.to,
					reason: payload.reason,
				};
				if (payload.requestedBy !== undefined) recordInput.requestedBy = payload.requestedBy;
				if (payload.requiresConfirmation !== undefined) recordInput.requiresConfirmation = payload.requiresConfirmation;
				writeAudit(buildModeChangeAuditRecord(recordInput));
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
		},
		async stop() {
			unsubscribeModeChanged?.();
			unsubscribeModeChanged = null;
			unsubscribeRunAborted?.();
			unsubscribeRunAborted = null;
			unsubscribeSessionParked?.();
			unsubscribeSessionParked = null;
			unsubscribeSessionResumed?.();
			unsubscribeSessionResumed = null;
			unsubscribeAgentStatusChanged?.();
			unsubscribeAgentStatusChanged = null;
			await writer?.close();
			writer = null;
		},
	};

	const contract: SafetyContract = {
		classify(call) {
			return classifyCall(call);
		},
		evaluate(call, mode) {
			const policy = (policyEngine ?? createSafetyPolicyEngine()).evaluate(call, mode);
			const classification = policy.classification;

			context.bus.emit(BusChannels.SafetyClassified, {
				tool: call.tool,
				actionClass: classification.actionClass,
				reasons: classification.reasons,
				ruleId: policy.ruleId,
				mode,
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
				if (mode !== undefined) auditInput.mode = mode;
				const record = buildAuditRecord(auditInput);
				writeAudit(record);
				context.bus.emit(BusChannels.SafetyBlocked, {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: policy.ruleId,
					mode,
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
					decision: "elevated",
					args: call.args,
					policy,
				};
				if (mode !== undefined) auditInput.mode = mode;
				writeAudit(buildAuditRecord(auditInput));
				context.bus.emit(BusChannels.SafetyBlocked, {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: policy.ruleId,
					mode,
					rejection: policy.rejection,
					policySource: policy.policySource,
					reasonCode: policy.reasonCode,
					elevationMode: policy.elevationMode,
				});
				const decision: SafetyDecision = {
					kind: "ask",
					classification,
					rejection: policy.rejection ?? fallbackRejection(policy),
					policy,
				};
				if (policy.elevationMode !== undefined) decision.elevationMode = policy.elevationMode;
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
			if (mode !== undefined) auditInput.mode = mode;
			const record = buildAuditRecord(auditInput);
			writeAudit(record);
			context.bus.emit(BusChannels.SafetyAllowed, {
				tool: call.tool,
				actionClass: classification.actionClass,
				mode,
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
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset,
		policy: { metadata: (mode) => (policyEngine ?? createSafetyPolicyEngine()).metadata(mode) },
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
