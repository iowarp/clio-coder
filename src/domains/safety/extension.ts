import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clearSessionAuthoredFiles } from "../../core/session-authored-files.js";
import { classify as classifyCall } from "./action-classifier.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import {
	type CompletionEvaluationInput,
	completionContext,
	completionEvaluatedPayload,
	recordToolDecision as emitToolDecision,
	type SafetyJudgementInput,
	safetyJudgedPayload,
	safetyJudgementContext,
	type ToolDecisionInput,
} from "./decision-events.js";
import { mergeFlowRestrictions } from "./information-flow.js";
import { createLoopState, type LoopDetectorState, observe as observeLoop } from "./loop-detector.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "./policy-engine.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "./scope.js";

export function createSafetyBundle(context: DomainContext): DomainBundle<SafetyContract> {
	let policyEngine: SafetyPolicyEngine | null = null;
	let loopState: LoopDetectorState = createLoopState();
	let recordCount = 0;
	let unsubscribeSessionParked: (() => void) | null = null;

	function activePolicyEngine(): SafetyPolicyEngine {
		policyEngine ??= createSafetyPolicyEngine();
		return policyEngine;
	}

	// Tool decisions run inside the call's async context, so the scope comes from there (#434).
	function recordToolDecision(input: ToolDecisionInput): void {
		if (emitToolDecision(input, context.bus)) recordCount += 1;
	}

	function recordCompletionEvaluation(input: CompletionEvaluationInput): void {
		if (context.bus.emit("completion.evaluated", completionEvaluatedPayload(input), completionContext(input)))
			recordCount += 1;
	}

	function recordSafetyJudgement(input: SafetyJudgementInput): void {
		if (context.bus.emit("safety.judged", safetyJudgedPayload(input), safetyJudgementContext(input))) recordCount += 1;
	}

	const extension: DomainExtension = {
		async start() {
			policyEngine = createSafetyPolicyEngine();
			unsubscribeSessionParked = context.bus.subscribe("session.parked", () => {
				// Authorship is per session: the next session asks again for the parked one's outside files.
				clearSessionAuthoredFiles();
			});
		},
		async stop() {
			unsubscribeSessionParked?.();
			unsubscribeSessionParked = null;
		},
	};

	const contract: SafetyContract = {
		classify(call) {
			return classifyCall(call);
		},
		evaluate(call, posture, scope) {
			const policy = activePolicyEngine().evaluate(call, posture, scope);
			const classification = policy.classification;

			if (policy.kind === "block") {
				const decided: ToolDecisionInput = {
					tool: call.tool,
					classification,
					decision: "blocked",
					policy,
				};
				if (posture !== undefined) decided.posture = posture;
				recordToolDecision(decided);
				context.bus.emit("safety.blocked", {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: policy.ruleId,
					posture,
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
				const decided: ToolDecisionInput = {
					tool: call.tool,
					classification,
					decision: "classified",
					policy,
				};
				if (posture !== undefined) decided.posture = posture;
				recordToolDecision(decided);
				const decision: SafetyDecision = {
					kind: "ask",
					classification,
					rejection: policy.rejection ?? fallbackRejection(policy),
					policy,
				};
				if (policy.match) (decision as { match?: typeof policy.match }).match = policy.match;
				return decision;
			}

			const decided: ToolDecisionInput = {
				tool: call.tool,
				classification,
				// Non-confirmed net passes are not final: registry admission still
				// applies autonomy and records the resolved allowed/park/denied decision.
				decision: posture === "confirmed" ? "allowed" : "classified",
				policy,
			};
			if (posture !== undefined) decided.posture = posture;
			recordToolDecision(decided);
			return { kind: "allow", classification, policy };
		},
		observeLoop(key, now) {
			const [next, verdict] = observeLoop(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		policy: {
			metadata: (posture) => activePolicyEngine().metadata(posture),
			allowsObservationPath: (path) =>
				activePolicyEngine().evaluate({ tool: "read", args: { path } }).reasonCode !== "path-policy:zeroAccessPaths",
			informationFlow: () => activePolicyEngine().informationFlow(),
			flowRestrictionsFor: (call) => activePolicyEngine().flowRestrictionsFor(call),
			flowRestrictionsForPaths: (paths, cwd) =>
				mergeFlowRestrictions(
					...paths.map((path) =>
						activePolicyEngine().flowRestrictionsFor({ tool: "read", args: { path, ...(cwd ? { cwd } : {}) } }),
					),
				),
		},
		audit: {
			recordCount: () => recordCount,
			recordToolCall: recordToolDecision,
			recordCompletionContract: recordCompletionEvaluation,
			recordSafetyJudge: recordSafetyJudgement,
		},
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
