import { isAbsolute, relative, resolve } from "node:path";
import type { DispatchPlanTaskResolution, DispatchRequest } from "../domains/dispatch/contract.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { gateDeciderAgentId } from "../domains/dispatch/execution-role.js";
import { JUDGE_GATE_PROMPT, REVIEWER_GATE_PROMPT } from "../domains/dispatch/gate-role-prompts.js";
import { normalizeDispatchIntent } from "../domains/dispatch/intent.js";
import { approvedRouteCandidates } from "../domains/dispatch/route-approval.js";
import { defaultRoutingIntent } from "../domains/dispatch/routing-intent.js";
import type { DispatchFailoverMode } from "../domains/dispatch/validation.js";
import {
	dispatchRequestsFromArgs,
	maxOutputBytesArg,
	prepareDispatchArguments,
	stringArg,
	timeoutMsArg,
} from "./dispatch-arguments.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	type DispatchPlanView,
	describeDispatchPlan,
	RESOLVED_DISPATCH_PLAN_ARGUMENT,
	type ResolvedDispatchPlanArtifact,
	resolvedDispatchPlanFromArgs,
	withResolvedDispatchPlan,
} from "./dispatch-plan.js";
import {
	loadVerifiedScoutSource,
	prepareScoutContinuation,
	scoutContinuationRefFromArgs,
} from "./dispatch-scout-admission.js";
import type {
	DispatchCompeteSettings,
	DispatchExecutionSnapshot,
	DispatchMode,
	DispatchReviewSettings,
	DispatchToolDeps,
} from "./dispatch-types.js";
import type { ToolSpec } from "./registry.js";
import { gitCheckoutRoot } from "./task-worktree.js";
import { discoverDeclaredChecks } from "./verify/scripts.js";

/**
 * The six identity-sensitive stores which bind synchronous admission to the
 * later, dynamically loaded dispatch runner. They intentionally live for one
 * tool surface and are never serialized or reconstructed.
 */
export interface DispatchAdmissionState {
	readonly preparedAdmissionArgs: WeakSet<Record<string, unknown>>;
	readonly trustedResolvedPlans: WeakMap<Record<string, unknown>, ResolvedDispatchPlanArtifact>;
	readonly trustedReservationOwners: WeakMap<Record<string, unknown>, string>;
	readonly trustedExecutionSnapshots: WeakMap<Record<string, unknown>, DispatchExecutionSnapshot>;
	readonly trustedExecutionPlans: WeakMap<Record<string, unknown>, ExecutionPlan>;
	readonly taskResolutions: WeakMap<object, DispatchPlanTaskResolution>;
}

export interface DispatchAdmissionController {
	readonly state: DispatchAdmissionState;
	prepareAdmissionArguments(args: Record<string, unknown>): Record<string, unknown>;
	disposeAdmissionArguments(args: Record<string, unknown>): void;
	prepareArguments(args: Record<string, unknown>): Record<string, unknown>;
	describeDispatchPlan(args: Record<string, unknown>): DispatchPlanView;
}

type ResolvedPlanTask = ResolvedDispatchPlanArtifact["tasks"][number];

const REVIEW_MAX_CYCLES_DEFAULT = 2;
const REVIEW_MAX_CYCLES_LIMIT = 4;
const REVIEW_SINGLE_TASK_MESSAGE =
	"dispatch: review supports exactly one task; run the fan-out without review, then dispatch one integration task with review to gate the combined result";
const COMPETE_SINGLE_TASK_MESSAGE = "dispatch: compete requires exactly one task";
const COMPETE_NO_REVIEW_MESSAGE = "dispatch: compete has its own judge and cannot combine with review";
const COMPETE_MIN_CANDIDATES = 2;
const COMPETE_MAX_CANDIDATES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewerTask(originalTask: string, builderRunId: string, cycle: number): string {
	return [
		`Review the work of builder run ${builderRunId} (review cycle ${cycle}).`,
		"The builder's final answer is provided as input data; verify it against the workspace, do not trust it blindly.",
		"Original task the builder was given:",
		originalTask,
	].join("\n\n");
}

function reviewSettingsFromArgs(
	args: Record<string, unknown>,
): { ok: true; review: DispatchReviewSettings | undefined } | { ok: false; message: string } {
	const raw = args.review;
	if (raw === undefined || raw === false) return { ok: true, review: undefined };
	const record = raw === true ? {} : isRecord(raw) ? raw : null;
	if (record === null) return { ok: false, message: "dispatch: review must be true or an options object" };
	const review: DispatchReviewSettings = { maxCycles: REVIEW_MAX_CYCLES_DEFAULT };
	const reviewer = stringArg(record, "reviewer", "agent");
	if (reviewer) review.reviewer = reviewer;
	if (record.max_cycles !== undefined) {
		const cycles = record.max_cycles;
		if (typeof cycles !== "number" || !Number.isInteger(cycles) || cycles < 1 || cycles > REVIEW_MAX_CYCLES_LIMIT) {
			return { ok: false, message: `dispatch: review.max_cycles must be an integer 1..${REVIEW_MAX_CYCLES_LIMIT}` };
		}
		review.maxCycles = cycles;
	}
	const node = stringArg(record, "node");
	if (node) review.node = node;
	const model = stringArg(record, "model");
	if (model) review.model = model;
	const target = stringArg(record, "target");
	if (target) review.target = target;
	return { ok: true, review };
}

function competeSettingsFromArgs(args: Record<string, unknown>):
	| { ok: true; compete: DispatchCompeteSettings }
	| {
			ok: false;
			message: string;
	  } {
	let candidates = COMPETE_MIN_CANDIDATES;
	if (args.candidates !== undefined) {
		if (
			typeof args.candidates !== "number" ||
			!Number.isInteger(args.candidates) ||
			args.candidates < COMPETE_MIN_CANDIDATES ||
			args.candidates > COMPETE_MAX_CANDIDATES
		) {
			return {
				ok: false,
				message: `dispatch: candidates must be an integer ${COMPETE_MIN_CANDIDATES}..${COMPETE_MAX_CANDIDATES}`,
			};
		}
		candidates = args.candidates;
	}
	if (args.judge !== undefined && !isRecord(args.judge)) {
		return { ok: false, message: "dispatch: judge must be an options object" };
	}
	if (!isRecord(args.judge)) return { ok: true, compete: { candidates } };
	const judge: { agent?: string; model?: string; target?: string; node?: string } = {};
	for (const key of ["agent", "model", "target", "node"] as const) {
		const value = stringArg(args.judge, key);
		if (value !== undefined) judge[key] = value;
	}
	return { ok: true, compete: { candidates, judge } };
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function createDispatchAdmissionController(deps: DispatchToolDeps): DispatchAdmissionController {
	const state: DispatchAdmissionState = {
		preparedAdmissionArgs: new WeakSet<Record<string, unknown>>(),
		trustedResolvedPlans: new WeakMap<Record<string, unknown>, ResolvedDispatchPlanArtifact>(),
		trustedReservationOwners: new WeakMap<Record<string, unknown>, string>(),
		trustedExecutionSnapshots: new WeakMap<Record<string, unknown>, DispatchExecutionSnapshot>(),
		trustedExecutionPlans: new WeakMap<Record<string, unknown>, ExecutionPlan>(),
		taskResolutions: new WeakMap<object, DispatchPlanTaskResolution>(),
	};

	const parseRequests = (args: Record<string, unknown>) =>
		dispatchRequestsFromArgs(args, {
			...(deps.getAgentRoleFacts ? { resolveFacts: deps.getAgentRoleFacts } : {}),
			hasAgent: (id) => deps.getAgentSpecs().some((spec) => spec.id === id),
			auto: {
				approvedAuthorities: ["read-only", "verification", "artifact-write", "workspace-edit"],
				authorityBasis: deps.getAutonomy?.() === "full-auto" ? "full-auto-policy" : "operator-plan-approval",
			},
			resolveIntent(rawIntent, cwd) {
				const discovery = discoverDeclaredChecks(cwd);
				if (!discovery.ok) return { ok: false, message: `verification_catalog_invalid: ${discovery.reason}` };
				const declared = discovery.sources.flatMap((source) => source.checks);
				const byId = new Map(declared.map((check) => [check.id, check]));
				const normalized = normalizeDispatchIntent(rawIntent, byId);
				if (!normalized.ok) return { ok: false, message: `${normalized.reason}: ${normalized.message}` };
				return {
					ok: true,
					intent: normalized.intent,
					resolvedVerification: normalized.intent.verification.map((entry) => {
						const check = byId.get(entry.check);
						if (check === undefined) throw new Error(`resolved verification check '${entry.check}' disappeared`);
						return {
							check: entry.check,
							argv: [...check.command],
							cwd: resolve(process.cwd(), check.cwd),
							timeoutMs: entry.timeoutMs,
						};
					}),
				};
			},
		});
	const trustExecution = (args: Record<string, unknown>, snapshot: DispatchExecutionSnapshot) => {
		state.trustedExecutionSnapshots.set(args, deepFreeze(structuredClone(snapshot)));
		return args;
	};
	const dispatchExecutionSnapshot = (
		args: Record<string, unknown>,
		fields: Pick<DispatchExecutionSnapshot & { kind: "dispatch" }, "requests" | "mode" | "review" | "compete">,
	): DispatchExecutionSnapshot => ({
		kind: "dispatch",
		planView: describeDispatchPlan(args),
		...fields,
		writers: args.writers === 1 ? 1 : undefined,
		detach: args.detach === true,
		timeoutMs: timeoutMsArg(args),
		maxOutputBytes: maxOutputBytesArg(args),
	});
	const markPrepared = (args: Record<string, unknown>): Record<string, unknown> => {
		const exposed = resolvedDispatchPlanFromArgs(args);
		if (exposed !== null) {
			const trusted = deepFreeze(structuredClone(exposed));
			const policyView = deepFreeze(structuredClone(exposed));
			state.trustedResolvedPlans.set(args, trusted);
			Object.defineProperty(args, RESOLVED_DISPATCH_PLAN_ARGUMENT, {
				value: policyView,
				enumerable: true,
				configurable: false,
				writable: false,
			});
		}
		state.preparedAdmissionArgs.add(args);
		return args;
	};
	const stripUntrustedPlanFields = (rawArgs: Record<string, unknown>): Record<string, unknown> => {
		const clean = { ...prepareDispatchArguments(rawArgs) };
		Reflect.deleteProperty(clean, RESOLVED_DISPATCH_PLAN_ARGUMENT);
		Reflect.deleteProperty(clean, DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT);
		return clean;
	};
	const preparationFailure = (args: Record<string, unknown>, err: unknown): Record<string, unknown> =>
		markPrepared({
			...args,
			[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]: err instanceof Error ? err.message : String(err),
		});
	const shapeRejection = (args: Record<string, unknown>, message: string): Record<string, unknown> =>
		preparationFailure(args, message);
	const resolveTask = (
		request: DispatchRequest,
		role: NonNullable<ResolvedPlanTask["role"]>,
		position: number,
	): ResolvedPlanTask => {
		const resolution = deps.dispatch.preview?.(request);
		if (resolution === undefined) throw new Error("dispatch preview is unavailable");
		if (request.resolvedVerification?.length && resolution.runtimeId === "claude-code") {
			throw new Error("verification_unsupported_runtime: claude-code subprocess dispatch cannot run host verification");
		}
		const pinned = request.node !== undefined || request.target !== undefined || request.model !== undefined;
		const approvedCandidates =
			pinned || request.failover !== "approved"
				? []
				: resolution.routeApproval === null
					? (deps.dispatch.routeCandidates?.(request) ?? [])
					: approvedRouteCandidates(resolution.routeApproval);
		const failover: DispatchFailoverMode = pinned || approvedCandidates.length === 0 ? "none" : "approved";
		const task: ResolvedPlanTask = {
			agent: resolution.agentId,
			task: request.task,
			...(request.briefing !== undefined ? { briefing: request.briefing } : {}),
			...(request.worktree === true
				? {
						worktree: true as const,
						apply: request.apply ?? "merge",
						...(gitCheckoutRoot(resolve(request.cwd ?? process.cwd())) === null
							? {}
							: { worktreeDestination: gitCheckoutRoot(resolve(request.cwd ?? process.cwd())) as string }),
					}
				: {}),
			target: resolution.targetId,
			model: resolution.wireModelId,
			node: resolution.node.id,
			nodeKind: resolution.node.kind,
			...(resolution.node.host !== undefined ? { nodeHost: resolution.node.host } : {}),
			routingIntent: request.routingIntent ?? defaultRoutingIntent(request),
			failover,
			routeApproval: resolution.routeApproval,
			agentSelection: request.agentSelection === undefined ? null : structuredClone(request.agentSelection),
			stepId: null,
			dependencies: [],
			executionRole: request.executionRole,
			expectedResultContract: null,
			authorityGrant: null,
			agentDecision: null,
			wave: null,
			...(failover === "approved" ? { allowedCandidates: approvedCandidates.map((candidate) => ({ ...candidate })) } : {}),
			role,
			position,
			...(request.intent !== undefined ? { intent: structuredClone(request.intent) } : {}),
			...(request.resolvedVerification !== undefined
				? { resolvedVerification: request.resolvedVerification.map((check) => ({ ...check, argv: [...check.argv] })) }
				: {}),
		};
		state.taskResolutions.set(task, resolution);
		return task;
	};
	const resolvedCostCeiling = (): number => {
		const injected = deps.getCostCeilingUsd?.();
		if (injected !== undefined && Number.isFinite(injected) && injected > 0) return injected;
		const ceiling = deps.dispatch.costCeilingUsd?.();
		if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) {
			throw new Error("dispatch scheduling cost ceiling is unavailable");
		}
		return ceiling;
	};
	const reservationWave = (
		topology: ResolvedDispatchPlanArtifact["topology"],
		task: ResolvedPlanTask,
		index: number,
	) => {
		if (topology === "fleet") return task.wave ?? index;
		if (topology === "parallel" || topology === "detached") return 0;
		if (topology === "compete") return task.role === "judge" ? 1 : 0;
		return index;
	};
	const markReservedPlan = (args: Record<string, unknown>, artifact: ResolvedDispatchPlanArtifact) => {
		const prepared = withResolvedDispatchPlan(args, artifact);
		if (deps.dispatch.reservations === undefined) return markPrepared(prepared);
		const tasks = artifact.tasks.map((task, index) => {
			const resolution = state.taskResolutions.get(task);
			if (resolution === undefined || (task.stepId === null && (task.role === undefined || task.position === undefined))) {
				throw new Error("dispatch reservation resolution is incomplete");
			}
			return {
				memberId: task.stepId ?? `${task.role}-${task.position}`,
				wave: reservationWave(artifact.topology, task, index),
				resolution,
			};
		});
		const reservation = deps.dispatch.reservations.prepare({
			topology: artifact.topology === "fleet" ? "parallel" : artifact.topology,
			tasks,
		});
		try {
			const marked = markPrepared(prepared);
			state.trustedReservationOwners.set(marked, reservation.ownerId);
			return marked;
		} catch (error) {
			deps.dispatch.reservations.rollback(reservation.ownerId);
			throw error;
		}
	};

	const prepareAdmissionArguments = (rawArgs: Record<string, unknown>): Record<string, unknown> => {
		const args = stripUntrustedPlanFields(rawArgs);
		if (args.list === true) {
			const marked = markPrepared(args);
			return trustExecution(marked, { kind: "list" });
		}
		const continuation = scoutContinuationRefFromArgs(args);
		if (!continuation.ok) return preparationFailure(args, continuation.message);
		if (continuation.ref !== null) {
			try {
				const source = loadVerifiedScoutSource({
					ref: continuation.ref,
					dispatch: deps.dispatch,
					agentSpecs: deps.getAgentSpecs(),
				});
				const prepared = prepareScoutContinuation({
					source,
					authorization: deps.getAutonomy?.() === "full-auto" ? "full-auto-policy" : "operator-plan-approval",
					planAgentSelection: deps.dispatch.planAgentSelection,
					costCeilingUsd: resolvedCostCeiling(),
				});
				for (const [index, task] of prepared.artifact.tasks.entries()) {
					const resolution = prepared.resolutions[index];
					if (resolution === undefined) throw new Error("dispatch: Scout route resolution is incomplete");
					state.taskResolutions.set(task, resolution);
				}
				const marked = markReservedPlan(args, prepared.artifact);
				trustExecution(
					marked,
					dispatchExecutionSnapshot(marked, {
						requests: prepared.requests,
						mode: "parallel",
						review: undefined,
						compete: undefined,
					}),
				);
				state.trustedExecutionPlans.set(marked, deepFreeze(structuredClone(prepared.executionPlan)));
				return marked;
			} catch (error) {
				return preparationFailure(args, error);
			}
		}
		if (args.apply_winner !== undefined) {
			if (!isRecord(args.apply_winner)) {
				return shapeRejection(args, "dispatch: apply_winner must be an options object");
			}
			const branch = stringArg(args.apply_winner, "branch");
			const match = branch ? /^clio\/compete\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([1-9]\d*)$/.exec(branch) : null;
			if (branch === undefined) return shapeRejection(args, "dispatch: apply_winner.branch is required");
			if (match === null) {
				return shapeRejection(args, "dispatch: apply_winner.branch must be a clio/compete/<group>/<n> branch");
			}
			try {
				const cwd = resolve(stringArg(args.apply_winner, "cwd") ?? process.cwd());
				return trustExecution(
					markPrepared(
						withResolvedDispatchPlan(args, {
							version: 3,
							topology: "compete",
							source: null,
							maxWorkers: null,
							onFailure: null,
							tasks: [],
							costCeilingUsd: resolvedCostCeiling(),
							deadlineMs: null,
							confirmation: { branch, group: match[1] ?? "", index: Number.parseInt(match[2] ?? "", 10), cwd },
						}),
					),
					{ kind: "apply-winner", branch, cwd },
				);
			} catch (error) {
				return preparationFailure(args, error);
			}
		}
		const parsed = parseRequests(args);
		if (!parsed.ok) return shapeRejection(args, parsed.message);
		if (args.mode !== undefined && !["parallel", "sequential", "pipeline", "compete"].includes(String(args.mode))) {
			return shapeRejection(
				args,
				`dispatch: mode must be parallel, sequential, pipeline, or compete; got '${String(args.mode)}'`,
			);
		}
		const mode: DispatchMode =
			args.mode === "sequential"
				? "sequential"
				: args.mode === "pipeline"
					? "pipeline"
					: args.mode === "compete"
						? "compete"
						: "parallel";
		if (args.writers !== undefined && args.writers !== 1) {
			return shapeRejection(args, "dispatch: writers must be 1 when present");
		}
		if (args.writers === 1 && mode !== "parallel") {
			return shapeRejection(args, "dispatch: writers is supported only for parallel dispatch");
		}
		const parentCheckout = gitCheckoutRoot(process.cwd());
		for (const request of parsed.requests) {
			if (request.worktree !== true) continue;
			if (mode === "compete") return shapeRejection(args, "worktree_compete_incompatible");
			if (parentCheckout === null) return shapeRejection(args, "worktree_non_git_checkout");
			const spec = deps.getAgentSpecs().find((candidate) => candidate.id === request.agentId);
			if (spec?.capabilityClass === "read-only") return shapeRejection(args, "worktree_read_only_agent");
			if (request.cwd !== undefined) {
				const requested = resolve(request.cwd);
				const rel = relative(parentCheckout, requested);
				if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
					return shapeRejection(args, "worktree_cwd_outside_checkout");
				}
			}
		}
		const reviewResult = reviewSettingsFromArgs(args);
		if (!reviewResult.ok) return shapeRejection(args, reviewResult.message);
		if (reviewResult.review !== undefined) {
			if (mode === "compete") return shapeRejection(args, COMPETE_NO_REVIEW_MESSAGE);
			if (mode !== "parallel") return shapeRejection(args, `dispatch: review does not combine with mode=${mode}`);
			if (parsed.requests.length !== 1 || parsed.requests[0] === undefined) {
				return shapeRejection(args, REVIEW_SINGLE_TASK_MESSAGE);
			}
			if (parsed.requests.some((request) => (request.resolvedVerification?.length ?? 0) > 0)) {
				return shapeRejection(args, "verification_unsupported_for_mode: review requests cannot run host verification");
			}
		}
		if (mode === "compete" && (parsed.requests.length !== 1 || parsed.requests[0] === undefined)) {
			return shapeRejection(args, COMPETE_SINGLE_TASK_MESSAGE);
		}
		if (mode === "compete" && parsed.requests.some((request) => (request.resolvedVerification?.length ?? 0) > 0)) {
			return shapeRejection(args, "verification_unsupported_for_mode: compete requests cannot run host verification");
		}
		const competeResult = mode === "compete" ? competeSettingsFromArgs(args) : undefined;
		if (competeResult !== undefined && !competeResult.ok) return shapeRejection(args, competeResult.message);
		const snapshotFields = {
			requests: parsed.requests,
			mode,
			review: reviewResult.review,
			compete: competeResult?.ok === true ? competeResult.compete : undefined,
		};
		if (deps.dispatch.preview === undefined) {
			const marked = markPrepared(args);
			return trustExecution(marked, dispatchExecutionSnapshot(marked, snapshotFields));
		}
		try {
			const tasks: ResolvedDispatchPlanArtifact["tasks"] = [];
			if (reviewResult.review !== undefined) {
				const base = parsed.requests[0];
				if (base === undefined) return shapeRejection(args, REVIEW_SINGLE_TASK_MESSAGE);
				for (let cycle = 1; cycle <= reviewResult.review.maxCycles; cycle += 1) {
					const subject = { runId: `plan-builder-${cycle}`, digest: null };
					tasks.push(
						resolveTask(
							{ ...base, executionRole: "builder", gate: { role: "builder", group: "plan-preview", cycle } },
							"builder",
							cycle,
						),
					);
					tasks.push(
						resolveTask(
							{
								agentId: gateDeciderAgentId(reviewResult.review.reviewer),
								executionRole: "reviewer",
								task: reviewerTask(base.task, subject.runId, cycle),
								systemPrompt: REVIEWER_GATE_PROMPT,
								autonomy: "read-only",
								gate: { role: "reviewer", group: "plan-preview", cycle, subjects: [subject] },
								...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
								...(reviewResult.review.node !== undefined ? { node: reviewResult.review.node } : {}),
								...(reviewResult.review.model !== undefined ? { model: reviewResult.review.model } : {}),
								...(reviewResult.review.target !== undefined ? { target: reviewResult.review.target } : {}),
							},
							"reviewer",
							cycle,
						),
					);
				}
			} else if (mode === "compete") {
				const compete = competeResult?.ok === true ? competeResult.compete : undefined;
				if (compete === undefined) throw new Error("dispatch: compete admission settings are unavailable");
				const base = parsed.requests[0];
				if (base === undefined) return shapeRejection(args, COMPETE_SINGLE_TASK_MESSAGE);
				const subjects: Array<{ runId: string; digest: null }> = [];
				for (let candidate = 1; candidate <= compete.candidates; candidate += 1) {
					subjects.push({ runId: `plan-candidate-${candidate}`, digest: null });
					tasks.push(
						resolveTask(
							{ ...base, executionRole: "builder", gate: { role: "candidate", group: "plan-preview", cycle: candidate } },
							"candidate",
							candidate,
						),
					);
				}
				tasks.push(
					resolveTask(
						{
							agentId: gateDeciderAgentId(compete.judge?.agent),
							executionRole: "judge",
							task: `Plan-time capability check for the ${compete.candidates}-candidate judge.`,
							systemPrompt: JUDGE_GATE_PROMPT,
							autonomy: "read-only",
							gate: { role: "judge", group: "plan-preview", cycle: 1, subjects },
							...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
							...(compete.judge?.node !== undefined ? { node: compete.judge.node } : {}),
							...(compete.judge?.model !== undefined ? { model: compete.judge.model } : {}),
							...(compete.judge?.target !== undefined ? { target: compete.judge.target } : {}),
						},
						"judge",
						1,
					),
				);
			} else {
				for (const [index, request] of parsed.requests.entries()) tasks.push(resolveTask(request, "task", index + 1));
			}

			const topology = describeDispatchPlan(args).topology;
			const planScale =
				tasks.length > 1 ||
				topology === "compete" ||
				tasks.some((task) => task.node !== "local" || task.failover === "approved");
			if (!planScale) {
				const marked = parsed.requests.some((request) => request.intent !== undefined)
					? markPrepared(
							withResolvedDispatchPlan(args, {
								version: 3,
								topology,
								source: null,
								maxWorkers: null,
								onFailure: null,
								tasks,
								costCeilingUsd: resolvedCostCeiling(),
								deadlineMs: null,
							}),
						)
					: markPrepared(args);
				return trustExecution(marked, dispatchExecutionSnapshot(marked, snapshotFields));
			}
			const marked = markReservedPlan(args, {
				version: 3,
				topology,
				source: null,
				maxWorkers: null,
				onFailure: null,
				tasks,
				costCeilingUsd: resolvedCostCeiling(),
				deadlineMs: null,
			});
			return trustExecution(marked, dispatchExecutionSnapshot(marked, snapshotFields));
		} catch (error) {
			return preparationFailure(args, error);
		}
	};

	const prepareArguments = (args: Record<string, unknown>): Record<string, unknown> =>
		state.preparedAdmissionArgs.has(args) ? args : prepareAdmissionArguments(args);

	return {
		state,
		prepareAdmissionArguments,
		disposeAdmissionArguments(args) {
			const ownerId = state.trustedReservationOwners.get(args);
			if (ownerId !== undefined) deps.dispatch.reservations?.rollbackUnconsumed(ownerId);
		},
		prepareArguments,
		describeDispatchPlan(args) {
			const trusted = state.trustedResolvedPlans.get(args);
			return describeDispatchPlan(trusted === undefined ? args : { ...args, [RESOLVED_DISPATCH_PLAN_ARGUMENT]: trusted });
		},
	};
}

export type DispatchAdmissionToolHooks = Pick<
	ToolSpec,
	"prepareAdmissionArguments" | "disposeAdmissionArguments" | "prepareArguments" | "describeDispatchPlan"
>;
