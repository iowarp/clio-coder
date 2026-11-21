import { randomUUID } from "node:crypto";
import { telemetryContext, withToolTelemetryContext } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import {
	type MiddlewareFiredRule,
	type MiddlewareHookResult,
	type MiddlewareReminderSeverity,
	SETTLING_EFFECT_KINDS,
} from "./types.js";

const SEVERITY_ORDER: ReadonlyArray<MiddlewareReminderSeverity> = ["info", "advisory", "warn", "hard-block"];
/** The evidence class shape middleware.fired admits; a class built from an operator's id that misses it is dropped. */
const EVIDENCE_CLASS = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}(?:@[a-z][a-z0-9-]{0,31})?$/;
/** The process's one firing sequence: every owner draws from it, so no owner is ever forgotten and handed an id again. */
let firingSequence = 0;
/**
 * This process's token in every id it draws. A resumed session runs in a new process whose sequence starts again at 1,
 * so the token keeps its ids apart from the ones its journal already holds.
 */
const PROCESS_TOKEN = randomUUID().slice(0, 8);

/**
 * The next firing id: `fir_<process token>_<sequence>`. One sequence serves every session (and every run, in a
 * worker) of the process, so ids are monotonic per owner for the life of the process, never reused within it however
 * many owners it serves, and unique across the processes one owner's journal spans (memory design 4.1). A host
 * surface that fires outside middleware, such as steering triage, draws from the same sequence.
 */
export function nextFiringId(): string {
	firingSequence += 1;
	return `fir_${PROCESS_TOKEN}_${firingSequence}`;
}

/** A firing settles when one of its effects does or its rule declares that every firing of it settles. */
function settles(rule: MiddlewareFiredRule): boolean {
	return rule.settles === true || rule.effects.some((kind) => SETTLING_EFFECT_KINDS.has(kind));
}

/** The result with a firing id on every rule whose effects settle; a hook with no session or run has no ledger. */
function withFiringIds(result: MiddlewareHookResult): MiddlewareHookResult {
	const owner = result.input.sessionId ?? result.input.runId;
	if (owner === undefined || !result.fired?.some(settles)) return result;
	const fired: MiddlewareFiredRule[] = result.fired.map((rule) =>
		settles(rule) ? { ...rule, firingId: nextFiringId() } : rule,
	);
	return { ...result, fired };
}

/**
 * One middleware.fired per rule that emitted, under the hook's own session, run, turn and tool call. A worker records
 * through the same path, so its records reach the host through the run's telemetry forwarder. A settling rule's
 * firing id is added to the result for the host's outcome ledger; telemetry never changes the effects the hook
 * returns (#431, #434, C9).
 */
export function recordFiredRules(
	given: MiddlewareHookResult,
	phase: "sync" | "async" | "awaited",
): MiddlewareHookResult {
	if (!given.fired?.length) return given;
	const result = withFiringIds(given);
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
		for (const rule of result.fired ?? []) {
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
					...(rule.firingId !== undefined ? { firingId: rule.firingId } : {}),
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
