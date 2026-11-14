import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
	DispatchPlanFacts,
	type Permission,
	type PermissionDecision,
	PermissionDecisionFacts,
	WorkerAskFacts,
} from "../../contracts/permissions.js";
import { boundedText } from "../../contracts/session-projection.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import { ACP_DECISION_META_KEY, ACP_DISPATCH_PLAN_META_KEY, ACP_WORKER_ASK_META_KEY } from "../../contracts/wire.js";
import type { AcpRequestPermissionResponse } from "../clio/http-shims.js";
import { AppProblem } from "../services/problem.js";
import { record } from "./client.js";

export type PermissionTimers = { escalateMs: number; budgetMs: number };
export const PERMISSION_TIMERS: PermissionTimers = { escalateMs: 45000, budgetMs: 600000 };
type Pending = {
	value: Permission;
	allow: string;
	reject: string;
	/** Absent when the agent offered only the two one-time choices. */
	stop?: string;
	resolve: (response: AcpRequestPermissionResponse) => void;
	timers: ReturnType<typeof setTimeout>[];
};

/**
 * The agent's own classification of the call, or undefined when it sent none it
 * could represent. Read leniently and dropped whole on a mismatch: the ask is
 * still answerable without the facts, and refusing the request over a field the
 * UI only uses for a badge would park a turn forever.
 */
function decisionFacts(meta: unknown): Permission["decision"] {
	const value = record(meta)[ACP_DECISION_META_KEY];
	if (value === undefined) return undefined;
	const projected = Value.Clean(PermissionDecisionFacts, structuredClone(value));
	return Value.Check(PermissionDecisionFacts, projected) ? projected : undefined;
}
/** The plan the agent admitted for a dispatch ask, read as leniently as the decision facts. */
function dispatchPlan(meta: unknown): Permission["plan"] {
	const value = record(meta)[ACP_DISPATCH_PLAN_META_KEY];
	if (value === undefined) return undefined;
	const projected = Value.Clean(DispatchPlanFacts, structuredClone(value));
	return Value.Check(DispatchPlanFacts, projected) ? projected : undefined;
}
/** The forwarded worker ask's provenance, read as leniently as the decision facts. */
function workerAsk(meta: unknown): Permission["worker"] {
	const value = record(meta)[ACP_WORKER_ASK_META_KEY];
	if (value === undefined) return undefined;
	const projected = Value.Clean(WorkerAskFacts, structuredClone(value));
	return Value.Check(WorkerAskFacts, projected) ? projected : undefined;
}
export class Permissions {
	private pending: Pending | undefined;
	constructor(
		private readonly publish: (
			type: "permission.requested" | "permission.escalated" | "permission.resolved" | "permission.expired",
			permission: Permission,
		) => void,
		private readonly cancelTurn: () => Promise<void>,
		private readonly timing: PermissionTimers = PERMISSION_TIMERS,
		/** Told why an ask was answered `cancelled` without a card, so the task can say so. */
		private readonly declined: (reason: string) => void = () => {},
	) {
		if (
			!Number.isSafeInteger(timing.escalateMs) ||
			!Number.isSafeInteger(timing.budgetMs) ||
			timing.escalateMs < 1 ||
			timing.budgetMs <= timing.escalateMs ||
			timing.budgetMs > 600000
		)
			throw new Error("Permission timers require 0 < escalation < budget <= 600000 ms.");
	}
	request(
		sessionId: string,
		turnId: string | null,
		value: unknown,
		timeline: TimelineItem[],
	): Promise<AcpRequestPermissionResponse> {
		const params = record(value),
			call = record(params.toolCall);
		const options = Array.isArray(params.options) ? params.options.map(record) : [];
		const allow = options.find((option) => option.kind === "allow_once"),
			reject = options.find((option) => option.kind === "reject_once");
		// The turn-ending refusal is the agent's announced third option, matched by
		// its exact id rather than by position: a second `reject_once` entry is
		// only the stop choice when the agent says it is, and an agent that sends
		// none leaves `canStopTurn` false so the UI does not draw a control that
		// would resolve to an ordinary reject.
		const stop = options.find((option) => option.optionId === "reject-and-stop" && typeof option.optionId === "string");
		// Declining is the only answer this app gives on its own, and the session keeps running after it.
		const decline = (reason: string) => {
			this.declined(reason);
			return Promise.resolve<AcpRequestPermissionResponse>({ outcome: { outcome: "cancelled" } });
		};
		if (params.sessionId !== sessionId) return decline("foreign session");
		if (!turnId) return decline("no active turn");
		if (this.pending) return decline("another approval is waiting");
		const allowId = allow?.optionId,
			rejectId = reject?.optionId;
		if (typeof allowId !== "string" || typeof rejectId !== "string") return decline("no one-time allow or reject choice");
		if (allowId === rejectId) return decline("allow and reject share one choice id");
		if (allowId.length > 128 || rejectId.length > 128) return decline("choice id too long");
		// The agent authors both the tool frame and the ask, so the ask's own fields describe the call
		// at least as well as the row does. An ask with no row, such as a report-bundle consent, is still shown.
		const tool = timeline.find((item) => item.turnId === turnId && item.toolCallId === call.toolCallId);
		const askedId = typeof call.toolCallId === "string" && call.toolCallId.length <= 128 ? call.toolCallId : undefined;
		const askedTitle = typeof call.title === "string" && call.title.trim() ? boundedText(call.title, 512) : undefined;
		const askedKind = typeof call.kind === "string" && call.kind && call.kind.length <= 64 ? call.kind : undefined;
		const now = Date.now();
		const facts = decisionFacts(params._meta);
		const plan = dispatchPlan(params._meta);
		const worker = workerAsk(params._meta);
		// A forwarded worker ask has its own window, after which the agent denies the worker and the turn goes on.
		const workerWindow =
			worker?.timeoutMs !== undefined && Number.isFinite(worker.timeoutMs) && worker.timeoutMs > 0
				? Math.min(this.timing.budgetMs, worker.timeoutMs)
				: undefined;
		const budgetMs = workerWindow ?? this.timing.budgetMs;
		const permission: Permission = {
			id: randomUUID(),
			turnId,
			toolCallId: askedId ?? tool?.toolCallId ?? "",
			title: askedTitle ?? (tool?.title ? boundedText(tool.title, 512) : "Approval needed"),
			kind: askedKind ?? tool?.toolKind ?? "other",
			requestedAt: new Date(now).toISOString(),
			escalateAt: new Date(now + this.timing.escalateMs).toISOString(),
			expiresAt: new Date(now + budgetMs).toISOString(),
			status: "pending",
			canStopTurn: stop !== undefined,
			...(facts ? { decision: facts } : {}),
			...(plan ? { plan } : {}),
			...(worker ? { worker } : {}),
		};
		return new Promise<AcpRequestPermissionResponse>((resolve) => {
			const pending: Pending = {
				value: permission,
				allow: allowId,
				reject: rejectId,
				...(stop ? { stop: stop.optionId as string } : {}),
				resolve,
				timers: [],
			};
			this.pending = pending;
			pending.timers.push(
				setTimeout(() => {
					if (this.pending !== pending) return;
					pending.value = { ...pending.value, status: "escalated" };
					this.publish("permission.escalated", pending.value);
				}, this.timing.escalateMs),
			);
			pending.timers.push(
				setTimeout(() => {
					if (this.pending !== pending) return;
					this.take(pending);
					this.publish("permission.expired", { ...pending.value, status: "expired" });
					// The agent has already denied the worker by now; only the main agent's own ask stops the turn.
					if (workerWindow !== undefined) {
						pending.resolve({ outcome: { outcome: "cancelled" } });
						return;
					}
					// Cancellation crosses ACP before the parked request is released. No decision is invented.
					void this.cancelTurn()
						.finally(() => pending.resolve({ outcome: { outcome: "cancelled" } }))
						.catch(() => undefined);
				}, budgetMs),
			);
			this.publish("permission.requested", permission);
		});
	}
	decide(id: string, decision: PermissionDecision) {
		const pending = this.pending;
		if (!pending || pending.value.id !== id) throw new AppProblem("conflict", "Permission is no longer waiting.");
		// A turn-ending refusal the agent never offered would land on an unknown
		// optionId, which the agent treats as a plain deny. Refusing it here
		// instead keeps the client's own UI honest about what it just did.
		if (decision === "reject-and-stop" && !pending.stop)
			throw new AppProblem("conflict", "CLIO Coder did not offer a turn-ending refusal for this request.");
		this.take(pending);
		this.publish("permission.resolved", { ...pending.value, status: decision === "allow-once" ? "allowed" : "rejected" });
		const optionId =
			decision === "allow-once" ? pending.allow : decision === "reject-and-stop" ? pending.stop : pending.reject;
		pending.resolve({ outcome: { outcome: "selected", optionId: optionId as string } });
	}
	/**
	 * The agent says a forwarded worker ask stopped waiting (the worker timed out, its run ended, or
	 * its owner revoked it). The card leaves with the same status a cancelled one has, and the parked
	 * response settles as cancelled so the next approval is not refused as a second pending one.
	 */
	withdraw(requestId: unknown) {
		const pending = this.pending;
		if (!pending || typeof requestId !== "string" || pending.value.worker?.requestId !== requestId) return;
		this.cancel();
	}
	cancel() {
		const pending = this.pending;
		if (!pending) return;
		this.take(pending);
		this.publish("permission.resolved", { ...pending.value, status: "cancelled" });
		pending.resolve({ outcome: { outcome: "cancelled" } });
	}
	private take(pending: Pending) {
		this.pending = undefined;
		for (const timer of pending.timers) clearTimeout(timer);
	}
}
