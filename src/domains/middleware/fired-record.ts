import { telemetryContext, withToolTelemetryContext } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { MiddlewareHookResult, MiddlewareReminderSeverity } from "./types.js";

const SEVERITY_ORDER: ReadonlyArray<MiddlewareReminderSeverity> = ["info", "advisory", "warn", "hard-block"];
/** The evidence class shape middleware.fired admits; a class built from an operator's id that misses it is dropped. */
const EVIDENCE_CLASS = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}(?:@[a-z][a-z0-9-]{0,31})?$/;

/**
 * One middleware.fired per rule that emitted, under the hook's own session, run, turn and tool call. A worker records
 * through the same path, so its records reach the host through the run's telemetry forwarder. Telemetry never
 * changes what the hook returns (#431, #434, C9).
 */
export function recordFiredRules(
	result: MiddlewareHookResult,
	phase: "sync" | "async" | "awaited",
): MiddlewareHookResult {
	if (!result.fired?.length) return result;
	try {
		const { input } = result;
		const ctx = withToolTelemetryContext(
			{
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
				...(input.runId !== undefined ? { runId: input.runId } : {}),
				...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
				...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
			},
			telemetryContext,
		);
		if (!ctx) return result;
		let offset = 0;
		for (const rule of result.fired) {
			const own = result.effects.slice(offset, offset + rule.effects.length);
			offset += rule.effects.length;
			let severity = -1;
			for (const effect of own) {
				const level =
					effect.kind === "inject_reminder"
						? SEVERITY_ORDER.indexOf(effect.severity ?? "info")
						: effect.kind === "block_tool"
							? SEVERITY_ORDER.indexOf("hard-block")
							: -1;
				if (level > severity) severity = level;
			}
			telemetryHub().emit(
				"middleware.fired",
				{
					hook: result.hook,
					phase,
					ruleId: rule.ruleId,
					effects: rule.effects.slice(0, 32),
					...(severity >= 0 ? { severity: SEVERITY_ORDER[severity] as MiddlewareReminderSeverity } : {}),
					...(rule.evidence !== undefined && EVIDENCE_CLASS.test(rule.evidence) ? { evidence: rule.evidence } : {}),
					...(input.toolName !== undefined ? { tool: input.toolName } : {}),
				},
				ctx,
			);
		}
	} catch {
		// A rule's record is evidence about the hook, never part of its verdict (#434).
	}
	return result;
}
