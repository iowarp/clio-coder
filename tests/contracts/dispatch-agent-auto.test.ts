import { deepStrictEqual, notDeepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { parseScoutResult, type ScoutResult } from "../../src/domains/agents/result-contract.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import {
	agentRoleReadinessReport,
	classifyAgentTask,
	evaluateAgentCandidates,
} from "../../src/domains/dispatch/agent-candidates.js";
import { requireAgentSteps } from "../../src/domains/dispatch/execution-plan.js";
import { routePriorForAgentEvidence } from "../../src/domains/dispatch/joint-route-resolver.js";
import { selectApprovedRecoveryCandidates } from "../../src/domains/dispatch/recovery-candidates.js";
import {
	type ApprovedAssignmentRoute,
	assertApprovedAssignmentRoute,
	assertApprovedRecoveryCapability,
} from "../../src/domains/dispatch/route-approval.js";
import {
	decideRoute,
	type RouteCandidate,
	type RouteDecisionInput,
} from "../../src/domains/dispatch/route-decision.js";
import { estimateRoute, type RouteEstimate, type RouteObservation } from "../../src/domains/dispatch/route-policy.js";
import { evaluateRouteReadiness } from "../../src/domains/dispatch/route-readiness.js";
import { compileScoutTransition } from "../../src/domains/dispatch/scout-transition.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { withResolvedPlanTaskPin } from "../../src/tools/dispatch-plan.js";
import { prepareScoutContinuation, runScoutContinuationPlan } from "../../src/tools/dispatch-scout.js";

function spec(overrides: Partial<AgentSpec> & Pick<AgentSpec, "id">): AgentSpec {
	return {
		version: 1,
		name: overrides.id,
		description: `${overrides.id} test agent`,
		source: "builtin",
		filepath: `${overrides.id}.md`,
		tools: [ToolNames.Read],
		toolRequirements: { required: [ToolNames.Read], optional: [] },
		category: "explore",
		capabilityClass: "read-only",
		latencyClass: "balanced",
		projectContextTier: "none",
		audience: "base",
		tags: [],
		skills: [],
		resultContract: { kind: "scout-report" },
		budget: { toolCalls: 4, readReserve: 1, synthesis: true },
		body: "test",
		...overrides,
	};
}

const SCOUT = spec({ id: "scout", latencyClass: "fast", tags: ["reconnaissance"] });
const SCOUT_ALT = spec({ id: "scout-alt", latencyClass: "deep" });
const CODER = spec({
	id: "coder",
	tools: [ToolNames.Read, ToolNames.Write],
	toolRequirements: { required: [ToolNames.Read, ToolNames.Write], optional: [] },
	category: "implement",
	capabilityClass: "workspace-edit",
	resultContract: { kind: "mutation-report" },
});

function intent(overrides: Partial<Parameters<typeof evaluateAgentCandidates>[1]> = {}) {
	return {
		selectionMode: "auto" as const,
		baselineAgentId: "scout",
		approvedAudiences: ["base"] as const,
		approvedAuthorities: ["read-only"] as const,
		requiredTools: [ToolNames.Read],
		requiredSkills: [] as string[],
		expectedResultContractKind: null,
		locality: "any" as const,
		localAgentIds: ["scout", "scout-alt", "coder"],
		allowedAgentIds: null,
		features: classifyAgentTask("Inspect the dispatch boundary"),
		...overrides,
	};
}

function observation(label: RouteObservation["qualityLabel"] = "pass"): RouteObservation {
	return {
		qualityLabel: label,
		reliability: "success",
		completedCostUsd: 0.01,
		completedEndToEndMs: 100,
		queueWaitMs: 0,
		cacheRead: false,
		firstPass: true,
	};
}

function estimate(): RouteEstimate {
	return estimateRoute(Array.from({ length: 6 }, () => observation()));
}

function candidate(
	agentId: string,
	specFingerprint: string,
	executionRole: RouteCandidate["executionRole"],
): RouteCandidate {
	return {
		agentId,
		specFingerprint,
		executionRole,
		targetId: "mini",
		modelId: "model",
		runtimeId: "llamacpp",
		nodeId: "local",
		toolSignature: "tools",
		promptCompositionHash: "prompt",
		endpointIdentityHash: "endpoint",
		settingsFingerprint: "settings",
	};
}

function ready(estimateValue = estimate()) {
	return evaluateRouteReadiness({
		estimate: estimateValue,
		posture: "balanced",
		hardConstraintValidity: 1,
		integrityFailures: 0,
		costUpperBoundUsd: 0.01,
		factsFresh: true,
		decisionP95Ms: 1,
		requestedMinimumQuality: null,
	});
}

function activeApproval(): { approval: ApprovedAssignmentRoute; current: RouteCandidate; alternate: RouteCandidate } {
	const evaluated = evaluateAgentCandidates(
		[SCOUT, CODER],
		intent({ approvedAuthorities: ["read-only", "workspace-edit"] }),
	);
	const scoutEval = evaluated.evaluations.find((entry) => entry.agentId === "scout");
	const coderEval = evaluated.evaluations.find((entry) => entry.agentId === "coder");
	if (!scoutEval || !coderEval) throw new Error("missing evaluation");
	const current = candidate("coder", coderEval.specFingerprint, coderEval.executionRole);
	const alternate = candidate("scout", scoutEval.specFingerprint, scoutEval.executionRole);
	const report = ready();
	const routes = [
		{ candidate: current, report },
		{ candidate: alternate, report },
	];
	const decision = decideRoute({
		mode: "active",
		posture: "balanced",
		executedRoute: alternate,
		candidates: routes.map((entry) => ({
			candidate: entry.candidate,
			estimate: estimate(),
			activeReadiness: report,
			rejection: null,
		})),
		independenceSubject: null,
		hardConstraints: ["authority", "approved-envelope"],
		maxFallbacks: 1,
		decisionDurationMs: 1,
		agentSelection: {
			request: "auto",
			baselineAgentId: "scout",
			evaluations: evaluated.evaluations,
			readiness: agentRoleReadinessReport(routes),
			authorityBasis: "operator-plan-approval",
		},
	});
	const approval: ApprovedAssignmentRoute = {
		version: 1,
		decision,
		totalCostUpperBoundUsd: 1,
		deadlineMs: 60_000,
		maxAttempts: 2,
	};
	assertApprovedAssignmentRoute(approval);
	return { approval, current: decision.selected, alternate: decision.approvedFallbacks[0] as RouteCandidate };
}

describe("dispatch agent automation", () => {
	it("auto excludes agents whose authority or tools do not fit", () => {
		throws(
			() =>
				evaluateAgentCandidates(
					Array.from({ length: 65 }, (_, index) => spec({ id: `agent-${index}` })),
					intent(),
				),
			/agent candidate overflow/u,
		);
		const result = evaluateAgentCandidates([SCOUT, CODER], intent());
		deepStrictEqual(
			result.eligible.map((entry) => entry.agentId),
			["scout"],
		);
		const coder = result.evaluations.find((entry) => entry.agentId === "coder");
		strictEqual(coder?.rejections.includes("authority:workspace-edit"), true);
		const noWrite = evaluateAgentCandidates(
			[SCOUT, CODER],
			intent({ approvedAuthorities: ["workspace-edit"], requiredTools: [ToolNames.Write] }),
		);
		deepStrictEqual(
			noWrite.eligible.map((entry) => entry.agentId),
			["coder"],
		);
	});

	it("bounded task features affect only a cold agent prior", () => {
		const read = evaluateAgentCandidates([SCOUT], intent({ features: classifyAgentTask("Read the repository") }));
		const write = evaluateAgentCandidates([SCOUT], intent({ features: classifyAgentTask("Implement a feature") }));
		notDeepStrictEqual(read.evaluations[0]?.coldPrior, write.evaluations[0]?.coldPrior);
		deepStrictEqual(read.evaluations[0]?.rejections, write.evaluations[0]?.rejections);
		strictEqual(JSON.stringify(read.evaluations).includes("Inspect the repository"), false);
	});

	it("measured role quality supersedes the task prior", () => {
		const read = evaluateAgentCandidates([SCOUT], intent({ features: classifyAgentTask("Read the repository") }));
		const write = evaluateAgentCandidates([SCOUT], intent({ features: classifyAgentTask("Implement a feature") }));
		const readEvaluation = read.evaluations[0];
		const writeEvaluation = write.evaluations[0];
		if (readEvaluation === undefined || writeEvaluation === undefined) throw new Error("missing agent prior");
		notDeepStrictEqual(readEvaluation.coldPrior, writeEvaluation.coldPrior);
		const measured = [observation("pass")];
		const dimension = (coldPrior: typeof readEvaluation.coldPrior) => ({
			agentId: SCOUT.id,
			specFingerprint: readEvaluation.specFingerprint,
			executionRole: readEvaluation.executionRole,
			latencyClass: SCOUT.latencyClass,
			coldPrior,
		});
		deepStrictEqual(
			routePriorForAgentEvidence(dimension(readEvaluation.coldPrior), measured),
			routePriorForAgentEvidence(dimension(writeEvaluation.coldPrior), measured),
		);
		deepStrictEqual(
			estimateRoute(measured, routePriorForAgentEvidence(dimension(readEvaluation.coldPrior), measured)),
			estimateRoute(measured, routePriorForAgentEvidence(dimension(writeEvaluation.coldPrior), measured)),
		);
	});

	it("scout no-split settles without another dispatch", () => {
		const scout: ScoutResult = {
			findings: [{ claim: "observed", path: "src/a.ts", line: 1 }],
			citations: [{ path: "src/a.ts", line: 1 }],
			needsSplit: false,
			proposedSubtasks: [],
		};
		const transition = compileScoutTransition({
			scout,
			sourceReceiptDigest: "a".repeat(64),
			rootTask: "inspect",
			bindings: [],
			authority: { basis: "operator-plan-approval", approvedAuthorities: [] },
			maxWorkers: 4,
		});
		strictEqual(transition.kind, "settled");
	});

	it("scout split compiles a typed dependency plan", async () => {
		const scout = parseScoutResult(
			JSON.stringify({
				findings: [],
				needsSplit: true,
				proposedSubtasks: [
					{
						id: "inspect",
						task: "Inspect",
						dependencies: [],
						expectedResultContract: "scout-report",
						requestedAuthority: "read-only",
					},
					{
						id: "implement",
						task: "Implement",
						dependencies: ["inspect"],
						expectedResultContract: "mutation-report",
						requestedAuthority: "workspace-edit",
					},
				],
			}),
		);
		if (!scout) throw new Error("invalid Scout fixture");
		const transition = compileScoutTransition({
			scout,
			sourceReceiptDigest: "b".repeat(64),
			rootTask: "change",
			bindings: [
				{ subtaskId: "inspect", spec: SCOUT },
				{ subtaskId: "implement", spec: CODER },
			],
			authority: { basis: "operator-plan-approval", approvedAuthorities: ["read-only", "workspace-edit"] },
			maxWorkers: 4,
		});
		strictEqual(transition.kind, "ready");
		if (transition.kind !== "ready") return;
		deepStrictEqual(transition.plan.waves, [["inspect"], ["implement"]]);
		strictEqual(requireAgentSteps(transition.plan.steps)[1]?.expectedResultContract, "mutation-report");
		strictEqual(requireAgentSteps(transition.plan.steps)[1]?.approvedAuthority, "workspace-edit");

		const prepared = prepareScoutContinuation({
			source: {
				envelope: { cwd: "/tmp/project" } as RunEnvelope,
				receipt: {
					runId: "scout-source",
					agentId: "scout",
					task: "change",
					routingIntent: {
						posture: "balanced",
						maxCostUsd: null,
						deadlineMs: null,
						minimumQuality: null,
						requiredCapabilities: [],
						locality: "any",
						failover: "none",
					},
					integrity: { digest: "b".repeat(64) },
				} as unknown as RunReceipt,
				scout,
				spec: SCOUT,
			},
			authorization: "operator-plan-approval",
			costCeilingUsd: 5,
			planAgentSelection: (input) => {
				const selectedSpec = input.expectedResultContract === "mutation-report" ? CODER : SCOUT;
				const evaluated = evaluateAgentCandidates(
					[selectedSpec],
					intent({
						baselineAgentId: "scout",
						approvedAuthorities: [input.requestedAuthority],
						expectedResultContractKind: input.expectedResultContract,
					}),
				);
				const evaluation = evaluated.eligible[0];
				if (!evaluation) throw new Error("missing eligible Scout successor");
				const route = candidate(selectedSpec.id, evaluation.specFingerprint, evaluation.executionRole);
				const report = ready();
				const decision = decideRoute({
					mode: "shadow",
					posture: "balanced",
					executedRoute: route,
					candidates: [{ candidate: route, estimate: estimate(), activeReadiness: report, rejection: null }],
					independenceSubject: null,
					hardConstraints: ["authority", "result-contract"],
					maxFallbacks: 0,
					decisionDurationMs: 1,
					agentSelection: {
						request: "auto",
						baselineAgentId: "scout",
						evaluations: evaluated.evaluations,
						readiness: agentRoleReadinessReport([{ candidate: route, report }]),
						authorityBasis: input.authorization,
					},
				});
				return {
					agentSpec: selectedSpec,
					decision,
					resolution: {
						agentId: route.agentId,
						specFingerprint: route.specFingerprint,
						targetId: route.targetId,
						wireModelId: route.modelId,
						runtimeId: route.runtimeId,
						node: { id: route.nodeId, kind: "local" },
						thinkingLevel: null,
						toolSignature: route.toolSignature,
						endpointIdentityHash: route.endpointIdentityHash,
						settingsFingerprint: route.settingsFingerprint,
						costUpperBoundUsd: 0.01,
						costUpperBoundKnown: true,
						routeApproval: null,
					},
				};
			},
		});
		strictEqual(prepared.artifact.version, 3);
		strictEqual(prepared.artifact.topology, "fleet");
		strictEqual(typeof prepared.artifact.deadlineMs, "number");
		strictEqual((prepared.artifact.deadlineMs ?? 0) > 0, true);
		strictEqual(prepared.artifact.source?.executionPlanHash, prepared.executionPlan.hash);
		deepStrictEqual(
			requireAgentSteps(prepared.executionPlan.steps).map((step) => step.approvedAuthority),
			[null, null],
		);
		deepStrictEqual(
			prepared.artifact.tasks.map((task) => task.authorityGrant),
			[
				{ requested: "read-only", basis: "operator-plan-approval" },
				{ requested: "workspace-edit", basis: "operator-plan-approval" },
			],
		);
		const launched: Array<{ agentId: string; assignmentDeadlineAt?: number }> = [];
		const requests = prepared.requests.map((request, index) =>
			withResolvedPlanTaskPin(request, prepared.artifact.tasks[index]),
		);
		// Captured before dispatch, not after: assignmentDeadlineAt is `Date.now()
		// + deadlineMs` computed inside runScoutContinuationPlan, and this fixture's
		// deadlineMs is ~200ms (two 100ms-p95 waves). Comparing against a fresh
		// Date.now() taken after the await raced that 200ms budget against however
		// long the event loop took to get back to this line, which a loaded 24-lane
		// CI run lost. beforeDispatch is a lower bound on the internal Date.now()
		// call, so `assignmentDeadlineAt > beforeDispatch` holds independent of any
		// scheduling delay after dispatch returns.
		const beforeDispatch = Date.now();
		await runScoutContinuationPlan({
			dispatch: {
				preview: (request) => {
					const resolution = prepared.resolutions.find((candidate) => candidate.agentId === request.agentId);
					if (resolution === undefined) throw new Error("unexpected Scout plan route");
					return resolution;
				},
				dispatch: async (request) => {
					launched.push(request);
					const runId = `run-${launched.length}`;
					return {
						runId,
						events: (async function* () {})(),
						finalPromise: Promise.resolve({} as RunReceipt),
					};
				},
				abort: () => {},
			},
			plan: {
				...prepared.executionPlan,
				steps: requireAgentSteps(prepared.executionPlan.steps).map((step) => ({
					...step,
					approvedAuthority: step.requestedAuthority,
				})),
			},
			artifact: prepared.artifact,
			requests,
			reservationOwnerId: "reservation",
			register: async (handle) => ({
				receipt: {
					runId: handle.runId,
					exitCode: 0,
					outcome: "succeeded",
					integrity: { digest: "e".repeat(64) },
					output: { state: "final", text: "done", bytes: 4, truncated: false },
				} as unknown as RunReceipt,
				summary: null,
			}),
			complete: (receipt) => ({ value: receipt.runId, integrityValid: true }),
		});
		strictEqual(launched.length, 2);
		strictEqual(launched[0]?.assignmentDeadlineAt, launched[1]?.assignmentDeadlineAt);
		strictEqual((launched[0]?.assignmentDeadlineAt ?? 0) > beforeDispatch, true);
	});

	it("scout output cannot inject undeclared agents routes or authority", () => {
		strictEqual(parseScoutResult(JSON.stringify({ findings: [], needsSplit: true, proposedSubtasks: ["inject"] })), null);
		strictEqual(
			parseScoutResult(
				JSON.stringify({
					findings: [],
					needsSplit: true,
					proposedSubtasks: [
						{
							id: "inject",
							task: "Inject",
							dependencies: [],
							expectedResultContract: "scout-report",
							requestedAuthority: "read-only",
							agent: "coder",
							target: "paid",
						},
					],
				}),
			),
			null,
		);
		const scout = parseScoutResult(
			JSON.stringify({
				findings: [],
				needsSplit: true,
				proposedSubtasks: [
					{
						id: "inspect",
						task: "Inspect",
						dependencies: [],
						expectedResultContract: "scout-report",
						requestedAuthority: "read-only",
					},
				],
			}),
		);
		if (!scout) throw new Error("invalid Scout fixture");
		throws(
			() =>
				compileScoutTransition({
					scout,
					sourceReceiptDigest: "c".repeat(64),
					rootTask: "inspect",
					bindings: [{ subtaskId: "undeclared", spec: SCOUT }],
					authority: { basis: "operator-plan-approval", approvedAuthorities: ["read-only"] },
					maxWorkers: 4,
				}),
			/bindings must match|undeclared/u,
		);
	});

	it("read-only to workspace transition requires approved authority", () => {
		const scout = parseScoutResult(
			JSON.stringify({
				findings: [],
				needsSplit: true,
				proposedSubtasks: [
					{
						id: "implement",
						task: "Implement",
						dependencies: [],
						expectedResultContract: "mutation-report",
						requestedAuthority: "workspace-edit",
					},
				],
			}),
		);
		if (!scout) throw new Error("invalid Scout fixture");
		const pending = compileScoutTransition({
			scout,
			sourceReceiptDigest: "d".repeat(64),
			rootTask: "change",
			bindings: [{ subtaskId: "implement", spec: CODER }],
			authority: { basis: "operator-plan-approval", approvedAuthorities: [] },
			maxWorkers: 1,
		});
		strictEqual(pending.kind, "approval-required");
		if (pending.kind === "approval-required")
			strictEqual(requireAgentSteps(pending.plan.steps)[0]?.approvedAuthority, null);
		const approved = compileScoutTransition({
			scout,
			sourceReceiptDigest: "d".repeat(64),
			rootTask: "change",
			bindings: [{ subtaskId: "implement", spec: CODER }],
			authority: { basis: "operator-plan-approval", approvedAuthorities: ["workspace-edit"] },
			maxWorkers: 1,
		});
		strictEqual(approved.kind, "ready");
	});

	it("recovery changes agent only inside the approved envelope", () => {
		const { approval, current, alternate } = activeApproval();
		throws(
			() =>
				assertApprovedAssignmentRoute({
					...approval,
					decision: { ...approval.decision, policyVersion: "route-policy/3" },
				}),
			/unsupported route policy/u,
		);
		const allowed = [current, alternate].map((route) => ({
			agentId: route.agentId,
			target: route.targetId,
			model: route.modelId,
			node: route.nodeId,
		}));
		const currentTuple = allowed[0];
		const alternateTuple = allowed[1];
		if (!currentTuple || !alternateTuple) throw new Error("missing recovery tuple");
		const quality = selectApprovedRecoveryCandidates({
			current: currentTuple,
			allowed,
			approval,
			decision: {
				retry: true,
				excludedRouteParts: ["agent", "model"],
				qualityEscalation: { kind: "model-quality", allowAgentChange: true },
				reasonCode: "retry-model-quality",
			},
		});
		strictEqual(quality[0]?.agentId, alternate.agentId);
		throws(
			() =>
				selectApprovedRecoveryCandidates({
					current: currentTuple,
					allowed,
					approval: null,
					decision: {
						retry: true,
						excludedRouteParts: ["agent", "model"],
						qualityEscalation: { kind: "model-quality", allowAgentChange: true },
						reasonCode: "retry-model-quality",
					},
				}),
			/no eligible next candidate/u,
		);
		throws(
			() =>
				selectApprovedRecoveryCandidates({
					current: currentTuple,
					allowed,
					approval,
					decision: { retry: true, excludedRouteParts: ["target"], qualityEscalation: null, reasonCode: "retry-target" },
				}),
			/no eligible next candidate/u,
		);
		throws(
			() =>
				selectApprovedRecoveryCandidates({
					current: currentTuple,
					allowed: [...allowed, { ...alternateTuple, target: "forged-target" }],
					approval,
					decision: {
						retry: true,
						excludedRouteParts: ["agent", "model"],
						qualityEscalation: { kind: "model-quality", allowAgentChange: true },
						reasonCode: "retry-model-quality",
					},
				}),
			/exceeds the active route approval/u,
		);
		deepStrictEqual(
			selectApprovedRecoveryCandidates({
				current: currentTuple,
				allowed,
				approval,
				decision: {
					retry: true,
					excludedRouteParts: ["runtime"],
					qualityEscalation: null,
					reasonCode: "retry-worker-runtime",
				},
			}),
			[currentTuple],
		);
		throws(
			() => assertApprovedRecoveryCapability(approval, { ...alternate, toolSignature: "drifted-tools" }),
			/capability drifted outside/u,
		);
	});

	it("shadow agent automation leaves explicit-agent execution unchanged", () => {
		const evaluated = evaluateAgentCandidates([SCOUT, SCOUT_ALT], intent());
		const baselineEval = evaluated.evaluations[0];
		const alternateEval = evaluated.evaluations[1];
		if (!baselineEval || !alternateEval) throw new Error("missing evaluation");
		const executed = candidate("scout", baselineEval.specFingerprint, baselineEval.executionRole);
		const recommended = candidate("scout-alt", alternateEval.specFingerprint, alternateEval.executionRole);
		const report = ready();
		const routes = [
			{ candidate: recommended, report },
			{ candidate: executed, report },
		];
		const input: RouteDecisionInput = {
			mode: "shadow",
			posture: "balanced",
			executedRoute: executed,
			candidates: routes.map((entry) => ({
				candidate: entry.candidate,
				estimate: estimate(),
				activeReadiness: report,
				rejection: null,
			})),
			independenceSubject: null,
			hardConstraints: ["authority"],
			maxFallbacks: 1,
			decisionDurationMs: 1,
			agentSelection: {
				request: "explicit",
				baselineAgentId: "scout",
				evaluations: evaluated.evaluations,
				readiness: agentRoleReadinessReport(routes),
				authorityBasis: null,
			},
		};
		const decision = decideRoute(input);
		strictEqual(decision.executedRoute.agentId, "scout");
		strictEqual(decision.selected.agentId, "scout-alt");
		strictEqual(decision.agentSelection.recommendedAgentId, "scout-alt");
	});
});
