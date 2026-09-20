import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { type Permission, type PermissionDecision, PermissionDecisionFacts } from "../../contracts/permissions.js";
import type { TimelineItem } from "../../contracts/sessions.js";
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
	const value = record(meta)["clio-coder/decision"];
	if (value === undefined) return undefined;
	const projected = Value.Clean(PermissionDecisionFacts, structuredClone(value));
	return Value.Check(PermissionDecisionFacts, projected) ? projected : undefined;
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
	request(sessionId: string, turnId: string | null, value: unknown, timeline: TimelineItem[]) {
		const params = record(value),
			call = record(params.toolCall);
		const tool = timeline.find((item) => item.turnId === turnId && item.toolCallId === call.toolCallId);
		const options = Array.isArray(params.options) ? params.options.map(record) : [];
		const allow = options.find((option) => option.kind === "allow_once"),
			reject = options.find((option) => option.kind === "reject_once");
		// The turn-ending refusal is the agent's announced third option, matched by
		// its exact id rather than by position: a second `reject_once` entry is
		// only the stop choice when the agent says it is, and an agent that sends
		// none leaves `canStopTurn` false so the UI does not draw a control that
		// would resolve to an ordinary reject.
		const stop = options.find((option) => option.optionId === "reject-and-stop" && typeof option.optionId === "string");
		if (
			params.sessionId !== sessionId ||
			!turnId ||
			this.pending ||
			!tool ||
			!["pending", "in_progress"].includes(tool.status) ||
			tool.title !== call.title ||
			tool.toolKind !== call.kind ||
			JSON.stringify(tool.locations) !== JSON.stringify(call.locations) ||
			JSON.stringify(tool.rawInput) !== JSON.stringify(call.rawInput) ||
			typeof allow?.optionId !== "string" ||
			typeof reject?.optionId !== "string" ||
			allow.optionId === reject.optionId ||
			allow.optionId.length > 128 ||
			reject.optionId.length > 128
		)
			throw new AppProblem("upstream_acp", "Permission does not match an active tool call and one-time choices.");
		const now = Date.now();
		const facts = decisionFacts(params._meta);
		const permission: Permission = {
			id: randomUUID(),
			turnId,
			toolCallId: tool.toolCallId ?? "",
			title: tool.title ?? "Tool",
			kind: tool.toolKind ?? "other",
			requestedAt: new Date(now).toISOString(),
			escalateAt: new Date(now + this.timing.escalateMs).toISOString(),
			expiresAt: new Date(now + this.timing.budgetMs).toISOString(),
			status: "pending",
			canStopTurn: stop !== undefined,
			...(facts ? { decision: facts } : {}),
		};
		return new Promise<AcpRequestPermissionResponse>((resolve) => {
			const pending: Pending = {
				value: permission,
				allow: allow.optionId as string,
				reject: reject.optionId as string,
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
					// Cancellation crosses ACP before the parked request is released. No decision is invented.
					void this.cancelTurn()
						.finally(() => pending.resolve({ outcome: { outcome: "cancelled" } }))
						.catch(() => undefined);
				}, this.timing.budgetMs),
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
			throw new AppProblem("conflict", "Clio did not offer a turn-ending refusal for this request.");
		this.take(pending);
		this.publish("permission.resolved", { ...pending.value, status: decision === "allow-once" ? "allowed" : "rejected" });
		const optionId =
			decision === "allow-once" ? pending.allow : decision === "reject-and-stop" ? pending.stop : pending.reject;
		pending.resolve({ outcome: { outcome: "selected", optionId: optionId as string } });
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
