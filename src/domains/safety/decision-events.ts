import type { TelemetryContext } from "../../core/telemetry/context.js";
import { ownerTelemetryContext } from "../../core/telemetry/context.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { QualityFinding } from "../../tools/verify/quality-policy.js";
import type { FinishContractReason, FinishContractVerificationScope } from "./finish-contract.js";
import type { SafetyPolicyDecision } from "./policy-engine.js";
import type { Rigor } from "./rigor.js";

/**
 * The safety domain's accountability records (#434): every tool decision, finish-contract decision and safety judge
 * review becomes a journal event in the scope that made it. These builders keep the payloads structural; commands,
 * arguments, paths and prose never reach the journal.
 */

export type ToolDecision = EventPayload<"tool.decided">["decision"];

export interface ToolDecisionInput {
	tool: string;
	classification: { actionClass: string; exposure?: "outward" };
	decision: ToolDecision;
	requestId?: string;
	posture?: string;
	policy?: SafetyPolicyDecision;
	/** The final axis may apply a different rule than the classifier (#434). */
	ruleId?: string;
	policySource?: string;
	/**
	 * Reason code of the final decision. Set this when the decision was made by a later axis than the policy engine
	 * (autonomy denial, budget admission): the policy's own reasonCode describes a net pass ("allowed") and would
	 * misstate why the call was denied.
	 */
	reasonCode?: string;
}

export function toolDecidedPayload(input: ToolDecisionInput): EventPayload<"tool.decided"> {
	const reasonCode = input.reasonCode ?? input.policy?.reasonCode;
	const ruleId = input.ruleId ?? input.policy?.ruleId;
	const policySource = input.policySource ?? input.policy?.policySource;
	const posture = input.posture ?? input.policy?.posture;
	return {
		tool: input.tool,
		actionClass: input.classification.actionClass,
		decision: input.decision,
		...(input.classification.exposure !== undefined ? { exposure: input.classification.exposure } : {}),
		...(posture !== undefined ? { posture } : {}),
		...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
		...(ruleId !== undefined ? { ruleId } : {}),
		...(reasonCode !== undefined ? { reasonCode } : {}),
		...(policySource !== undefined ? { policySource } : {}),
		...(input.policy?.policyHash !== undefined ? { policyHash: input.policy.policyHash } : {}),
	};
}

/** Tool decisions use the host call context and the same structural payload in every runtime (#434). */
export function recordToolDecision(input: ToolDecisionInput, hub: TelemetryHub = telemetryHub()): boolean {
	return hub.emit("tool.decided", toolDecidedPayload(input));
}

export interface CompletionEvaluationInput {
	runId?: string;
	sessionId?: string;
	turnId: string | null;
	decision: "ok" | "engage";
	reason: FinishContractReason;
	rigor: Rigor;
	mutatedPaths: ReadonlyArray<string>;
	evidenceKinds: ReadonlyArray<string>;
	quality?: ReadonlyArray<QualityFinding>;
	verificationScope?: FinishContractVerificationScope;
}

export function completionEvaluatedPayload(input: CompletionEvaluationInput): EventPayload<"completion.evaluated"> {
	return {
		decision: input.decision,
		reason: input.reason,
		rigor: input.rigor,
		mutatedPaths: input.mutatedPaths.length,
		evidenceKinds: [...new Set(input.evidenceKinds)],
		...(input.quality !== undefined
			? { quality: input.quality.map(({ rule, check, state }) => ({ rule, check, state })) }
			: {}),
		...(input.verificationScope !== undefined
			? {
					verification: {
						passedChecks: [...input.verificationScope.passedChecks],
						acceptance: input.verificationScope.acceptance.map(({ check, state }) => ({ check, state })),
					},
				}
			: {}),
	};
}

/** The finish contract runs at a turn's end or a run's finalization; the record belongs to that run or session. */
export function completionContext(input: CompletionEvaluationInput): TelemetryContext | undefined {
	return ownerTelemetryContext({
		sessionId: input.sessionId,
		runId: input.runId,
		...(input.turnId !== null ? { turnId: input.turnId } : {}),
	});
}

/** One safety judge verdict, or its absence, for a call that would have parked. */
export interface SafetyJudgementInput {
	sessionId: string | null;
	turnId?: string;
	toolCallId?: string;
	tool: string;
	actionClass: string;
	/** Set when the call was a dispatched worker's ask: that attempt's run id. */
	workerRunId?: string;
	/** The rule that made admission ask. */
	askRule?: string;
	/** `none` is no verdict (see `noVerdict`); `escalated` is a call handed to the operator unjudged. */
	verdict: EventPayload<"safety.judged">["verdict"];
	/** The rule the judge named; its reason prose goes to the transcript note, never the journal. */
	rule?: string;
	latencyMs: number;
	target?: string;
	model?: string;
	noVerdict?: string;
	/** Operator messages the judge's prompt carried; absent when no prompt was built (escalated, no route). */
	operatorMessages?: number;
}

export function safetyJudgedPayload(input: SafetyJudgementInput): EventPayload<"safety.judged"> {
	return {
		tool: input.tool,
		actionClass: input.actionClass,
		verdict: input.verdict,
		latencyMs: Math.max(0, Math.round(input.latencyMs)),
		...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
		...(input.askRule !== undefined ? { askRule: input.askRule } : {}),
		// The judge writes the rule name; a bounded slice keeps an overlong answer from voiding the record.
		...(input.rule ? { rule: input.rule.slice(0, 128) } : {}),
		...(input.target !== undefined ? { target: input.target } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
		...(input.noVerdict !== undefined ? { noVerdict: input.noVerdict } : {}),
		...(input.operatorMessages !== undefined ? { operatorMessages: input.operatorMessages } : {}),
	};
}

/** A judge review belongs to the session whose call it judged; a worker's ask names its run in the payload. */
export function safetyJudgementContext(input: SafetyJudgementInput): TelemetryContext | undefined {
	return ownerTelemetryContext({ sessionId: input.sessionId, turnId: input.turnId, toolCallId: input.toolCallId });
}
