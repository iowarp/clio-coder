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
/** Owners whose firing sequence is kept; the oldest is forgotten past this, as a process outlives many sessions. */
const FIRING_OWNER_LIMIT = 256;
const firingSequences = new Map<string, number>();
/**
 * This process's token in every id it draws. A resumed session runs in a new process whose sequence starts again at 1,
 * so the token keeps its ids apart from the ones its journal already holds.
 */
const PROCESS_TOKEN = randomUUID().slice(0, 8);

/**
 * The next firing id of a session (or of a run, in a worker): `fir_<process token>_<sequence>`, monotonic per owner
 * for the life of the process and unique across the processes one owner's journal spans, so two firings never share
 * one (memory design 4.1). A host surface that fires outside middleware, such as steering triage, draws from the same
 * sequence.
 */
export function nextFiringId(owner: string): string {
	const next = (firingSequences.get(owner) ?? 0) + 1;
	firingSequences.delete(owner);
	firingSequences.set(owner, next);
	if (firingSequences.size > FIRING_OWNER_LIMIT) {
		const oldest = firingSequences.keys().next().value;
		if (oldest !== undefined) firingSequences.delete(oldest);
	}
	return `fir_${PROCESS_TOKEN}_${next}`;
}

/** The result with a firing id on every rule whose effects settle; ids need an owner to be monotonic within. */
function withFiringIds(result: MiddlewareHookResult): MiddlewareHookResult {
	const owner = result.input.sessionId ?? result.input.runId;
	if (owner === undefined || !result.fired?.some((rule) => rule.effects.some((kind) => SETTLING_EFFECT_KINDS.has(kind))))
		return result;
	const fired: MiddlewareFiredRule[] = result.fired.map((rule) =>
		rule.effects.some((kind) => SETTLING_EFFECT_KINDS.has(kind)) ? { ...rule, firingId: nextFiringId(owner) } : rule,
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
