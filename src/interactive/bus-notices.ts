/**
 * Pure payload→notice formatters for bus channels the interactive layer
 * renders as operator notices. Validation lives here so malformed payloads
 * are dropped in one place and the index.ts subscribers stay wiring-only.
 * Returning null means "ignore the event".
 */

import type { BudgetAlertPayload, SafetyBlockedPayload } from "../core/bus-events.js";

export interface BusNotice {
	level: "warn" | "error";
	text: string;
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
			text: `[budget] session spend ${spend} exceeded. Dispatches are not blocked; raise budget.sessionCeilingUsd or wind down.`,
		};
	}
	return { level: "warn", text: `[budget] session spend ${spend} reached.` };
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

/**
 * The transcript already shows the rejection text the model received
 * (rejection.short names the tool and action class), so this notice aims at
 * the policy dimension the transcript omits: which rule fired and from which
 * policy source.
 */
export function safetyBlockedNotice(payload: unknown): BusNotice | null {
	if (!isSafetyBlockedPayload(payload)) return null;
	const rule =
		payload.ruleId !== undefined && payload.ruleId !== payload.reasonCode
			? `rule ${payload.ruleId} (${payload.reasonCode})`
			: payload.reasonCode;
	return {
		level: "warn",
		text: `[safety] blocked ${payload.tool} (${payload.actionClass}): ${rule} via ${payload.policySource}.`,
	};
}
