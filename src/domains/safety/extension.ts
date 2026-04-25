import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { classify as classifyCall } from "./action-classifier.js";
import {
	type AbortSource,
	type AuditRecord,
	type AuditWriter,
	buildAbortAuditRecord,
	buildAuditRecord,
	buildModeChangeAuditRecord,
	buildSessionParkAuditRecord,
	buildSessionResumeAuditRecord,
	openAuditWriter,
	type SessionParkReason,
	type SessionResumeVia,
} from "./audit.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import { type DamageControlRuleset, loadDefaultRuleset, match as matchRule } from "./damage-control.js";
import { createLoopState, type LoopDetectorState, observe as observeLoop } from "./loop-detector.js";
import { formatRejection } from "./rejection-feedback.js";
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

export function createSafetyBundle(context: DomainContext): DomainBundle<SafetyContract> {
	let writer: AuditWriter | null = null;
	let ruleset: DamageControlRuleset | null = null;
	let loopState: LoopDetectorState = createLoopState();
	let recordCount = 0;
	let unsubscribeModeChanged: (() => void) | null = null;
	let unsubscribeRunAborted: (() => void) | null = null;
	let unsubscribeSessionParked: (() => void) | null = null;
	let unsubscribeSessionResumed: (() => void) | null = null;

	function writeAudit(rec: AuditRecord): void {
		if (writer === null) return;
		writer.write(rec);
		recordCount += 1;
	}

	const extension: DomainExtension = {
		async start() {
			ruleset = loadDefaultRuleset();
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
			await writer?.close();
			writer = null;
		},
	};

	const contract: SafetyContract = {
		classify(call) {
			return classifyCall(call);
		},
		evaluate(call, mode) {
			const classification = classifyCall(call);

			// damage-control override: matched rule flips decision to block regardless of class
			const scan = serializeArgs(call.args);
			const hit = ruleset && scan ? matchRule(scan, ruleset) : null;

			const isHardBlock = classification.actionClass === "git_destructive" || hit?.block === true;

			context.bus.emit(BusChannels.SafetyClassified, {
				tool: call.tool,
				actionClass: classification.actionClass,
				reasons: classification.reasons,
				ruleId: hit?.ruleId,
				mode,
			});

			if (isHardBlock) {
				const rejectionCtx: Parameters<typeof formatRejection>[0] = {
					tool: call.tool,
					actionClass: classification.actionClass,
					reasons: [...classification.reasons, ...(hit ? [`damage-control:${hit.ruleId}`] : [])],
				};
				if (mode !== undefined) rejectionCtx.mode = mode;
				if (hit?.ruleId !== undefined) rejectionCtx.ruleId = hit.ruleId;
				const rejection = formatRejection(rejectionCtx);
				const auditInput: Parameters<typeof buildAuditRecord>[0] = {
					tool: call.tool,
					classification,
					decision: "blocked",
					args: call.args,
				};
				if (mode !== undefined) auditInput.mode = mode;
				const record = buildAuditRecord(auditInput);
				writeAudit(record);
				context.bus.emit(BusChannels.SafetyBlocked, {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: hit?.ruleId,
					mode,
					rejection,
				});
				const decision: SafetyDecision = { kind: "block", classification, rejection };
				if (hit) (decision as { match?: typeof hit }).match = hit;
				return decision;
			}

			const auditInput: Parameters<typeof buildAuditRecord>[0] = {
				tool: call.tool,
				classification,
				decision: "allowed",
				args: call.args,
			};
			if (mode !== undefined) auditInput.mode = mode;
			const record = buildAuditRecord(auditInput);
			writeAudit(record);
			context.bus.emit(BusChannels.SafetyAllowed, {
				tool: call.tool,
				actionClass: classification.actionClass,
				mode,
			});
			return { kind: "allow", classification };
		},
		observeLoop(key, now) {
			const [next, verdict] = observeLoop(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset,
		audit: { recordCount: () => recordCount },
	};

	return { extension, contract };
}

function serializeArgs(args?: Record<string, unknown>): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const v of Object.values(args)) {
		if (v == null) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(String(v));
		else {
			try {
				parts.push(JSON.stringify(v));
			} catch {
				// ignore values that cannot be serialized
			}
		}
	}
	return parts.join(" ");
}
