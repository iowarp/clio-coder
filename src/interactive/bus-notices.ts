/**
 * Payload→notice formatters for bus channels the interactive layer renders
 * as operator notices. Validation lives here so malformed payloads are
 * dropped in one place and the index.ts subscribers stay wiring-only.
 * Returning null means "ignore the event".
 */

import type { BudgetAlertPayload, MiddlewareHookFailedPayload, SafetyBlockedPayload } from "../core/bus-events.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { askAxis } from "./permission-overlay.js";

export interface BusNotice {
	level: "warn" | "error";
	text: string;
}

export interface MiddlewareHookFailedNoticeOptions {
	noteBudgetWarningSuppression?: boolean;
}

function isBudgetAlertPayload(value: unknown): value is BudgetAlertPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (p.level !== "at" && p.level !== "over") return false;
	if (typeof p.currentUsd !== "number" || !Number.isFinite(p.currentUsd)) return false;
	if (typeof p.ceilingUsd !== "number" || !Number.isFinite(p.ceilingUsd)) return false;
	return true;
}

export function budgetAlertNotice(payload: unknown): BusNotice | null {
	if (!isBudgetAlertPayload(payload)) return null;
	const spend = `$${payload.currentUsd.toFixed(2)} of $${payload.ceilingUsd.toFixed(2)} ceiling`;
	if (payload.level === "over") {
		return {
			level: "error",
			text: `[budget] session spend ${spend} exceeded. New dispatches are denied at admission; raise budget.sessionCeilingUsd or wind down.`,
		};
	}
	return { level: "warn", text: `[budget] session spend ${spend} reached. New dispatches are denied at admission.` };
}

/**
 * Restart-required settings changed under a running session. The level is
 * always a warning; only the text varies, so this returns the text or null.
 */
export function restartRequiredNotice(payload: unknown): string | null {
	const diff = (payload as { diff?: { restartRequired?: unknown } } | null | undefined)?.diff;
	const raw = diff?.restartRequired;
	if (!Array.isArray(raw)) return null;
	const paths = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
	if (paths.length === 0) return null;
	const label = paths.length === 1 ? "setting" : "settings";
	return `[config] ${label} ${paths.join(", ")} changed; restart Clio to apply.`;
}

function isSafetyBlockedPayload(value: unknown): value is SafetyBlockedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.tool !== "string" || p.tool.length === 0) return false;
	if (typeof p.actionClass !== "string" || p.actionClass.length === 0) return false;
	if (p.ruleId !== undefined && typeof p.ruleId !== "string") return false;
	if (typeof p.policySource !== "string" || p.policySource.length === 0) return false;
	if (typeof p.reasonCode !== "string" || p.reasonCode.length === 0) return false;
	return true;
}

function isMiddlewareHookFailedPayload(value: unknown): value is MiddlewareHookFailedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (p.kind !== "hook_failed" && p.kind !== "budget_exceeded") return false;
	if (typeof p.registrationId !== "string" || p.registrationId.length === 0) return false;
	if (typeof p.hook !== "string" || p.hook.length === 0) return false;
	if (p.message !== undefined && typeof p.message !== "string") return false;
	if (p.elapsedMs !== undefined && typeof p.elapsedMs !== "number") return false;
	if (p.budgetMs !== undefined && typeof p.budgetMs !== "number") return false;
	return true;
}

export function middlewareBudgetWarningKey(payload: unknown): string | null {
	if (!isMiddlewareHookFailedPayload(payload)) return null;
	if (payload.kind !== "budget_exceeded") return null;
	return `${payload.registrationId}\u0000${payload.hook}`;
}

/**
 * A middleware hook registration threw (its effects were discarded) or
 * overran the soft budget (its effects still applied). The turn proceeded
 * either way; this warn notice is the operator's only interactive signal
 * that a guard or assessor is misbehaving.
 */
export function middlewareHookFailedNotice(
	payload: unknown,
	options: MiddlewareHookFailedNoticeOptions = {},
): BusNotice | null {
	if (!isMiddlewareHookFailedPayload(payload)) return null;
	if (payload.kind === "hook_failed") {
		const detail = payload.message !== undefined && payload.message.length > 0 ? `: ${payload.message}` : "";
		return {
			level: "warn",
			text: `[middleware] hook '${payload.registrationId}' failed on ${payload.hook}${detail}. Its effects were skipped; the turn continued.`,
		};
	}
	const elapsed = payload.elapsedMs !== undefined ? `${payload.elapsedMs.toFixed(1)}ms` : "unknown";
	const budget = payload.budgetMs !== undefined ? `${payload.budgetMs}ms` : "budget";
	const suffix = options.noteBudgetWarningSuppression ? "; further budget warnings for this hook suppressed" : "";
	return {
		level: "warn",
		text: `[middleware] hook '${payload.registrationId}' exceeded its soft budget on ${payload.hook} (${elapsed} > ${budget})${suffix}.`,
	};
}

export function middlewareHookFailedSessionNotice(payload: unknown, seenBudgetWarnings: Set<string>): BusNotice | null {
	const key = middlewareBudgetWarningKey(payload);
	if (key !== null) {
		if (seenBudgetWarnings.has(key)) return null;
		seenBudgetWarnings.add(key);
	}
	return middlewareHookFailedNotice(payload, { noteBudgetWarningSuppression: key !== null });
}

/**
 * A tool call parked for one-shot approval (sd-01 §3.3). The text names the
 * axis that produced the ask: a safety-net rail asks at every level, while an
 * autonomy ask exists only because of the current level and can be widened in
 * .clio/safety.yaml when it is an execute action.
 */
export function approvalParkedNotice(tool: string, decision: SafetyDecision, autonomy: string): BusNotice {
	const actionClass = decision.classification.actionClass;
	const axis = askAxis(decision);
	if (axis.kind === "net") {
		return {
			level: "warn",
			text: `[approval] ${tool} parked (${actionClass}): safety-net rail ${axis.ruleId} asks for confirmation. Approve once, or Esc to cancel.`,
		};
	}
	const widen =
		actionClass === "execute"
			? " Approve once, or add it to .clio/safety.yaml commands."
			: " Approve once, or Esc to cancel.";
	return {
		level: "warn",
		text: `[approval] ${tool} parked (${actionClass}): asks at autonomy ${autonomy}.${widen}`,
	};
}

/**
 * The autonomy mapping auto-denied a call (deny dispositions; today only the
 * read-only level). The transcript shows the rejection the model received;
 * this notice names the level so the operator knows the dial, not a safety
 * rail, refused the action.
 */
export function autonomyDeniedNotice(decision: SafetyDecision, level: string): BusNotice {
	const actionClass = decision.classification.actionClass;
	return {
		level: "warn",
		text: `[autonomy] denied ${actionClass} (${level}): Clio proposes changes at this level.`,
	};
}

/**
 * The transcript already shows the rejection text the model received
 * (rejection.short names the tool and action class), so this notice aims at
 * the policy dimension the transcript omits: which rule fired and from which
 * policy source. The closing sentence states that these gates are
 * level-independent, so the notice never reads as a contradiction of the
 * autonomy level shown in the dashboards (sd-01).
 */
export function safetyBlockedNotice(payload: unknown): BusNotice | null {
	if (!isSafetyBlockedPayload(payload)) return null;
	const rule =
		payload.ruleId !== undefined && payload.ruleId !== payload.reasonCode
			? `rule ${payload.ruleId} (${payload.reasonCode})`
			: payload.reasonCode;
	return {
		level: "warn",
		text: `[safety-net] blocked ${payload.tool} (${payload.actionClass}): ${rule} via ${payload.policySource}. This gate applies at every autonomy level.`,
	};
}
