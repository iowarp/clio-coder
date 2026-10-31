import { clioStateDir } from "../core/xdg.js";
import { parseScoutResult, resultContractSourceId, type ScoutResult } from "../domains/agents/result-contract.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type {
	DispatchAgentPlanResolution,
	DispatchContract,
	DispatchPlanTaskResolution,
	DispatchRequest,
} from "../domains/dispatch/contract.js";
import { type ExecutionPlan, requireAgentSteps } from "../domains/dispatch/execution-plan.js";
import { normalizeDispatchIntent } from "../domains/dispatch/intent.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { RoutingIntent } from "../domains/dispatch/routing-intent.js";
import { compileScoutTransition, type ScoutAgentBinding } from "../domains/dispatch/scout-transition.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { readVerifiedRun } from "../domains/telemetry/index.js";
import type { ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";
import type { FinishedRun } from "./worker-evidence.js";

export interface ScoutContinuationRef {
	runId: string;
	runDigest: string;
}

export interface VerifiedScoutSource {
	envelope: RunEnvelope;
	/** The Scout run as it settled; its digest is the identity a continuation cites. */
	run: FinishedRun & { digest: string };
	scout: ScoutResult;
	spec: AgentSpec;
}

export interface PreparedScoutContinuation {
	artifact: ResolvedDispatchPlanArtifact;
	requests: DispatchRequest[];
	resolutions: DispatchPlanTaskResolution[];
	executionPlan: ExecutionPlan;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scoutContinuationRefFromArgs(
	args: Record<string, unknown>,
): { ok: true; ref: ScoutContinuationRef | null } | { ok: false; message: string } {
	if (!Object.hasOwn(args, "from_scout")) return { ok: true, ref: null };
	if (Object.keys(args).some((key) => key !== "from_scout")) {
		return {
			ok: false,
			message: "dispatch: from_scout cannot be combined with task, agent, route, topology, or tool controls",
		};
	}
	const value = args.from_scout;
	if (!record(value) || Object.keys(value).sort().join("\u0000") !== "run_digest\u0000run_id") {
		return { ok: false, message: "dispatch: from_scout requires exactly run_id and run_digest" };
	}
	if (typeof value.run_id !== "string" || value.run_id.trim().length === 0) {
		return { ok: false, message: "dispatch: from_scout.run_id must be non-empty" };
	}
	if (typeof value.run_digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.run_digest)) {
		return { ok: false, message: "dispatch: from_scout.run_digest must be a sha256 digest" };
	}
	return { ok: true, ref: { runId: value.run_id.trim(), runDigest: value.run_digest } };
}

/**
 * A Scout run its continuation may build on: authenticated (held by its producer, or read back under a seal that
 * verifies), succeeded, and carrying an exact passing scout-report under the strict contract.
 */
export function validateScoutSource(
	run: FinishedRun,
	envelope: RunEnvelope,
	agentSpecs: ReadonlyArray<AgentSpec>,
): VerifiedScoutSource {
	if (run.digest === null) throw new Error("dispatch: Scout source has not settled");
	if (run.facts.exitCode !== 0 || run.facts.outcome !== "succeeded") {
		throw new Error("dispatch: Scout source did not succeed");
	}
	const spec = agentSpecs.find((candidate) => candidate.id === run.facts.agentId);
	if (spec === undefined || spec.resultContract.kind !== "scout-report") {
		throw new Error("dispatch: Scout source agent no longer declares scout-report");
	}
	const fact = run.facts.quality?.resultContract ?? null;
	if (fact === null || fact.conformance !== "pass" || fact.sourceId !== resultContractSourceId(spec.resultContract)) {
		throw new Error("dispatch: Scout source lacks an exact passing result-contract fact");
	}
	const output = run.delivered?.output;
	if (output?.state !== "final") throw new Error("dispatch: Scout source has no settled final output");
	const scout = parseScoutResult(output.text);
	if (scout === null) throw new Error("dispatch: Scout source output does not match the current strict contract");
	return { envelope, run: { ...run, digest: run.digest }, scout, spec };
}

/** Load a Scout source from its sealed run scope; its seal must verify and its settled digest match the cited one. */
export function loadVerifiedScoutSource(input: {
	ref: ScoutContinuationRef;
	dispatch: Pick<DispatchContract, "getRun" | "owner">;
	agentSpecs: ReadonlyArray<AgentSpec>;
}): VerifiedScoutSource {
	const envelope = input.dispatch.getRun(input.ref.runId);
	if (envelope === null) throw new Error(`dispatch: Scout source run '${input.ref.runId}' is unavailable`);
	// A continuation dispatches workers into the source run's cwd, so a Scout
	// run another session made would send this session's workers into that
	// session's project.
	if (!dispatchOwnership(dispatchOwnerOf(input.dispatch)).ownsRun(envelope)) {
		throw new Error(`dispatch: Scout source run '${input.ref.runId}' belongs to another session`);
	}
	const record = readVerifiedRun(clioStateDir(), input.ref.runId, input.ref.runDigest);
	if (record === null)
		throw new Error(`dispatch: Scout source '${input.ref.runId}' has no sealed record under the cited digest`);
	return validateScoutSource(
		{
			runId: input.ref.runId,
			digest: record.settled.digest,
			facts: record.settled,
			delivered: record.result?.state === "resolved" ? record.result.value : null,
		},
		envelope,
		input.agentSpecs,
	);
}

export function prepareScoutContinuation(input: {
	source: VerifiedScoutSource;
	authorization: "operator-plan-approval" | "yolo-policy" | "harness-read-only";
	maxWorkers?: number;
	planAgentSelection: DispatchContract["planAgentSelection"];
	costCeilingUsd: number;
}): PreparedScoutContinuation {
	if (!input.source.scout.needsSplit) throw new Error("dispatch: Scout phase is settled and has no continuation plan");
	const harnessIntent =
		input.authorization === "harness-read-only"
			? normalizeDispatchIntent(
					{ read_roots: [], write_roots: [], relevant_paths: [], expected_outputs: [], verification: [] },
					new Map(),
				)
			: null;
	if (harnessIntent !== null && !harnessIntent.ok) throw new Error(harnessIntent.message);
	const proposals: Array<
		DispatchAgentPlanResolution & { subtask: ScoutResult["proposedSubtasks"][number]; routingIntent: RoutingIntent }
	> = [];
	if (
		input.authorization === "harness-read-only" &&
		input.source.scout.proposedSubtasks.some((task) => task.requestedAuthority !== "read-only")
	)
		throw new Error("split refused: harness orientation permits read-only subtasks only");
	for (const subtask of input.source.scout.proposedSubtasks) {
		const sourceIntent = input.source.run.facts.routingIntent;
		const routingIntent: RoutingIntent =
			input.authorization === "yolo-policy"
				? { ...sourceIntent, requiredCapabilities: [...sourceIntent.requiredCapabilities], failover: "approved" }
				: {
						...sourceIntent,
						posture: sourceIntent.posture === "manual" ? "balanced" : sourceIntent.posture,
						maxCostUsd: sourceIntent.maxCostUsd,
						deadlineMs: sourceIntent.deadlineMs,
						requiredCapabilities: [...sourceIntent.requiredCapabilities],
						failover: "approved",
					};
		const request: DispatchRequest = {
			agentId: input.source.run.facts.agentId,
			executionRole: "researcher",
			task: subtask.task,
			cwd: input.source.envelope.cwd,
			requestOrigin: input.authorization === "harness-read-only" ? "harness" : "user",
			...(input.authorization === "harness-read-only" ? { readOnly: true } : {}),
			...(harnessIntent?.ok ? { intent: harnessIntent.intent } : {}),
			routingIntent,
			failover: "approved",
			...(input.authorization === "yolo-policy" && sourceIntent.posture === "manual"
				? {
						target: input.source.run.facts.route.targetId,
						model: input.source.run.facts.route.wireModelId,
						node: input.source.run.facts.node?.id ?? "local",
					}
				: {}),
		};
		proposals.push({
			...input.planAgentSelection({
				request,
				expectedResultContract: subtask.expectedResultContract,
				requestedAuthority: subtask.requestedAuthority,
				authorization: input.authorization,
			}),
			subtask,
			routingIntent,
		});
	}
	const explicitCostCeiling = input.source.run.facts.routingIntent.maxCostUsd;
	const bindings: ScoutAgentBinding[] = proposals.map(({ subtask, agentSpec }) => ({
		subtaskId: subtask.id,
		spec: agentSpec,
	}));
	const requestedAuthorities = [
		...new Set(input.source.scout.proposedSubtasks.map((subtask) => subtask.requestedAuthority)),
	];
	const transition = compileScoutTransition({
		scout: input.source.scout,
		sourceRunDigest: input.source.run.digest,
		rootTask: input.source.envelope.task,
		bindings,
		authority: {
			basis: input.authorization,
			approvedAuthorities:
				input.authorization === "harness-read-only"
					? ["read-only"]
					: input.authorization === "yolo-policy"
						? requestedAuthorities
						: [],
		},
		maxWorkers: input.maxWorkers ?? 4,
	});
	if (transition.kind === "settled") throw new Error("dispatch: Scout phase unexpectedly settled during compilation");
	if (input.authorization !== "operator-plan-approval" && transition.kind !== "ready") {
		throw new Error("dispatch: yolo policy does not grant every requested Scout authority");
	}
	const plan = transition.plan;
	// Route estimates are advisory. Only a caller-supplied deadline grants stop authority.
	const deadlineMs = input.source.run.facts.routingIntent.deadlineMs;
	const requests: DispatchRequest[] = [];
	const resolutions: DispatchPlanTaskResolution[] = [];
	const tasks = requireAgentSteps(plan.steps).map((step, index): ResolvedDispatchPlanArtifact["tasks"][number] => {
		const proposal = proposals.find((entry) => entry.subtask.id === step.id);
		if (proposal === undefined) throw new Error(`dispatch: Scout step '${step.id}' has no route proposal`);
		const selected = proposal.decision.selected;
		const selection: NonNullable<DispatchRequest["agentSelection"]> = {
			version: 1,
			mode: "auto",
			baselineAgentId: input.source.run.facts.agentId,
			approvedAuthorities: [step.requestedAuthority],
			authorityBasis: input.authorization,
		};
		requests.push({
			agentId: selected.agentId,
			executionRole: selected.executionRole,
			task: step.task,
			cwd: input.source.envelope.cwd,
			requestOrigin: input.authorization === "harness-read-only" ? "harness" : "user",
			...(input.authorization === "harness-read-only" ? { readOnly: true } : {}),
			...(harnessIntent?.ok ? { intent: harnessIntent.intent } : {}),
			agentSelection: selection,
			routingIntent: { ...proposal.routingIntent, maxCostUsd: explicitCostCeiling, deadlineMs, failover: "none" },
			failover: "none",
		});
		resolutions.push(proposal.resolution);
		return {
			...(harnessIntent?.ok ? { intent: harnessIntent.intent } : {}),
			agent: proposal.resolution.agentId,
			task: step.task,
			target: proposal.resolution.targetId,
			model: proposal.resolution.wireModelId,
			node: proposal.resolution.node.id,
			nodeKind: proposal.resolution.node.kind,
			...(proposal.resolution.node.host === undefined ? {} : { nodeHost: proposal.resolution.node.host }),
			routingIntent: { ...proposal.routingIntent, maxCostUsd: explicitCostCeiling, deadlineMs, failover: "none" },
			failover: "none",
			routeApproval: null,
			agentSelection: selection,
			stepId: step.id,
			dependencies: [...step.dependencies],
			executionRole: step.executionRole,
			expectedResultContract: step.expectedResultContract,
			authorityGrant: { requested: step.requestedAuthority, basis: input.authorization },
			agentDecision: proposal.decision,
			wave: plan.waves.findIndex((wave) => wave.includes(step.id)),
			role: "task",
			position: index + 1,
		};
	});
	const aggregateCost = resolutions.reduce((sum, resolution) => sum + resolution.costUpperBoundUsd, 0);
	if (!Number.isFinite(aggregateCost) || (explicitCostCeiling !== null && aggregateCost > explicitCostCeiling)) {
		throw new Error("dispatch: Scout continuation exceeds the explicit routing cost ceiling");
	}
	return {
		artifact: {
			version: 3,
			topology: "fleet",
			source: {
				kind: "scout-transition",
				runId: input.source.run.runId,
				runDigest: input.source.run.digest,
				executionPlanHash: plan.hash,
			},
			maxWorkers: plan.maxWorkers,
			onFailure: plan.onFailure,
			tasks,
			costCeilingUsd: input.costCeilingUsd,
			deadlineMs,
		},
		requests,
		resolutions,
		executionPlan: plan,
	};
}
