/** Coordinator-owned materialization of one shared-resolver Scout successor proposal. */

import type { AgentSpec } from "../agents/spec.js";
import type {
	DispatchAgentPlanInput,
	DispatchAgentPlanResolution,
	DispatchPlanTaskResolution,
	DispatchRequest,
} from "./contract.js";
import type { JointRouteResolverInput } from "./joint-route-resolver.js";
import { type RouteDecisionV1, sameRouteIdentity } from "./route-decision.js";
import { defaultRoutingIntent } from "./routing-intent.js";

export function materializeAgentPlanSelection(
	input: DispatchAgentPlanInput,
	adapters: {
		resolve(
			request: DispatchRequest,
			mode: JointRouteResolverInput["mode"],
			intent: {
				expectedResultContractKind: DispatchAgentPlanInput["expectedResultContract"];
				requestedAuthority: DispatchAgentPlanInput["requestedAuthority"];
			},
		): RouteDecisionV1;
		preview(request: DispatchRequest): DispatchPlanTaskResolution;
		getAgentSpec(agentId: string): AgentSpec | null;
	},
): DispatchAgentPlanResolution {
	const intent = input.request.routingIntent ?? defaultRoutingIntent(input.request);
	const request: DispatchRequest = {
		...input.request,
		agentSelection: {
			version: 1,
			mode: "auto",
			baselineAgentId: input.request.agentId,
			approvedAuthorities: [input.requestedAuthority],
			authorityBasis: input.authorization,
		},
		routingIntent: { ...intent, failover: "approved" },
		failover: "approved",
	};
	const mode = input.authorization === "full-auto-policy" ? "active" : "shadow";
	const decision = adapters.resolve(request, mode, {
		expectedResultContractKind: input.expectedResultContract,
		requestedAuthority: input.requestedAuthority,
	});
	const selected = decision.selected;
	const selectedEvaluation = decision.candidateEvaluations.find((entry) => sameRouteIdentity(entry.candidate, selected));
	if (selectedEvaluation === undefined || selectedEvaluation.rejection !== null) {
		throw new Error("dispatch: Scout successor has no hard-admissible route");
	}
	const selectedAgent = decision.agentSelection.evaluations.find(
		(entry) =>
			entry.agentId === selected.agentId &&
			entry.specFingerprint === selected.specFingerprint &&
			entry.executionRole === selected.executionRole,
	);
	if (selectedAgent === undefined || selectedAgent.rejections.length > 0) {
		throw new Error("dispatch: Scout successor agent failed a hard constraint");
	}
	const selectedRequest: DispatchRequest = {
		...request,
		agentId: selected.agentId,
		executionRole: selected.executionRole,
		target: selected.targetId,
		model: selected.modelId,
		workerRuntime: selected.runtimeId,
		node: selected.nodeId,
		allowedCandidates: [
			{ agentId: selected.agentId, target: selected.targetId, model: selected.modelId, node: selected.nodeId },
		],
	};
	if (selected.thinkingLevel !== undefined) {
		selectedRequest.thinkingLevel = selected.thinkingLevel as NonNullable<DispatchRequest["thinkingLevel"]>;
	}
	const agentSpec = adapters.getAgentSpec(selected.agentId);
	if (agentSpec === null) throw new Error(`dispatch: selected agent '${selected.agentId}' is unavailable`);
	if (
		agentSpec.resultContract.kind !== input.expectedResultContract ||
		agentSpec.capabilityClass !== input.requestedAuthority
	) {
		throw new Error("dispatch: selected Scout successor drifted from its requested contract or authority");
	}
	return { resolution: adapters.preview(selectedRequest), decision, agentSpec };
}
