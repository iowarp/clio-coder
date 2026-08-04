/** Stateful evidence adapter for the pure joint route resolver. */

import type { DispatchRequest } from "./contract.js";
import {
	emptyJointHardFilterVerdicts,
	type JointAgentDimension,
	type JointNodeDimension,
	type JointRouteResolverInput,
	type JointTargetDimension,
} from "./joint-route-resolver.js";
import { routeBoundaryRejections } from "./route-candidates.js";
import type { RouteCandidate } from "./route-decision.js";
import type { RouteReadinessEvidenceWindow } from "./route-observer.js";

export function adaptJointRouteInput(input: {
	mode: JointRouteResolverInput["mode"];
	request: DispatchRequest;
	exact: boolean;
	executedRoute: RouteCandidate;
	agents: JointRouteResolverInput["agents"];
	agentSelection: JointRouteResolverInput["agentSelection"];
	targets: ReadonlyArray<JointTargetDimension>;
	nodes: ReadonlyArray<JointNodeDimension>;
	intent: JointRouteResolverInput["intent"];
	independenceSubject: JointRouteResolverInput["independenceSubject"];
	settingsFingerprint: string;
	readiness: RouteReadinessEvidenceWindow;
	cooldown(target: JointTargetDimension): string | null;
	facts(
		target: JointTargetDimension,
		node: JointNodeDimension,
	): {
		ok: boolean;
		reason?: string;
		unknowns: ReadonlyArray<string>;
	};
	preview(
		agent: JointAgentDimension,
		target: JointTargetDimension,
		node: JointNodeDimension,
	): {
		candidate: RouteCandidate;
		capabilities: string[];
		costUpperBoundUsd: number | null;
	};
	envelopeRejection(candidate: RouteCandidate): string | null;
}): JointRouteResolverInput {
	return {
		mode: input.mode,
		agents: input.agents,
		agentSelection: input.agentSelection,
		executedRoute: input.executedRoute,
		targets: input.targets,
		nodes: input.nodes,
		intent: input.intent,
		independenceSubject: input.independenceSubject,
		project(agent, target, node) {
			const hardFilters = emptyJointHardFilterVerdicts();
			Object.assign(
				hardFilters,
				routeBoundaryRejections(
					input.request,
					{ agentId: agent.agentId, targetId: target.targetId, modelId: target.modelId, nodeId: node.nodeId },
					input.exact,
				),
			);
			const cooldown = input.cooldown(target);
			if (cooldown !== null) hardFilters.cooldown = cooldown;
			const facts = input.facts(target, node);
			if (!facts.ok) hardFilters["endpoint-reachability"] = facts.reason ?? "route facts unavailable";
			let candidate: RouteCandidate = {
				...input.executedRoute,
				agentId: agent.agentId,
				specFingerprint: agent.specFingerprint,
				executionRole: agent.executionRole,
				targetId: target.targetId,
				modelId: target.modelId,
				runtimeId: target.runtimeId,
				nodeId: node.nodeId,
				endpointIdentityHash: target.endpointIdentityHash,
				settingsFingerprint: input.settingsFingerprint,
			};
			let capabilities: string[] = [];
			let costUpperBoundUsd: number | null = null;
			try {
				const projected = input.preview(agent, target, node);
				candidate = projected.candidate;
				capabilities = projected.capabilities;
				costUpperBoundUsd = projected.costUpperBoundUsd;
				if (
					input.intent.maxCostUsd !== null &&
					projected.costUpperBoundUsd !== null &&
					projected.costUpperBoundUsd > input.intent.maxCostUsd
				) {
					hardFilters.budget = "route cost upper bound exceeds the request ceiling";
				}
			} catch (error) {
				hardFilters.authority = error instanceof Error ? error.message : String(error);
			}
			hardFilters["approved-envelope"] = input.envelopeRejection(candidate);
			const evidence = input.readiness.forRoute(candidate, {
				costUpperBoundUsd,
				factsFresh: facts.ok && facts.unknowns.length === 0,
			});
			return {
				candidate,
				hardFilters,
				observations: evidence.observations,
				capabilities,
				readiness: evidence.readiness,
			};
		},
	};
}
