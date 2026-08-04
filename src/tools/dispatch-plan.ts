/**
 * Plan-scale dispatch detection and the operator-facing plan artifact.
 *
 * A dispatch call is plan-scale when it fans out more than one task, runs a
 * compete topology, applies a compete winner, or places work on a remote
 * fleet node. Supervised autonomy levels route exactly these calls through
 * ONE plan approval: the registry parks the call with the rendered plan as
 * the ask, and approving it approves the whole plan. full-auto never stops;
 * the dispatch tool logs the same artifact's hash into every run's receipt
 * (RunPlanProvenance) so the chain records what would have been approved.
 *
 * Production calls carry a strict v2 resolved artifact attached by the
 * dispatch tool's admission planner. That artifact pins effective
 * target/model/node choices and any active route approval into execution.
 * Older artifact versions are rejected rather than interpreted.
 */

import { createHash } from "node:crypto";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import {
	type ApprovedAssignmentRoute,
	cloneApprovedAssignmentRoute,
	isApprovedAssignmentRoute,
} from "../domains/dispatch/route-approval.js";
import { isRoutingIntent, type RoutingIntent } from "../domains/dispatch/routing-intent.js";
import type { DispatchFailoverCandidate, DispatchFailoverMode } from "../domains/dispatch/validation.js";
import { prepareDispatchArguments } from "./dispatch.js";

export type DispatchPlanTopology = "parallel" | "sequential" | "pipeline" | "review" | "compete" | "detached";

export interface DispatchPlanTaskView {
	agent: string;
	/** Exact bounded task being approved, sanitized only when rendered. */
	task: string;
	/** Exact canonical bounded briefing approved for this task. */
	briefing?: string;
	model?: string;
	node?: string;
	/** Effective transport identity; host is authenticated for SSH placement. */
	nodeKind?: "local" | "ssh";
	nodeHost?: string;
	/** Effective configured target id used as the execution pin. */
	target?: string;
	/** Coordinator role when the topology expands one user task into several runs. */
	role?: "task" | "builder" | "reviewer" | "candidate" | "judge";
	/** One-based source task or gate cycle/candidate number. */
	position?: number;
	/** Normalized advisory posture and hard bounds sealed into the plan. */
	routingIntent?: RoutingIntent;
	/** Approved failover mode sealed into the plan. */
	failover?: DispatchFailoverMode;
	/** Exact approved fallback tuples, order-significant, present only for approved failover. */
	allowedCandidates?: ReadonlyArray<DispatchFailoverCandidate>;
	/** Active authority is always explicit; null is the shadow/fixed posture. */
	routeApproval: ApprovedAssignmentRoute | null;
}

export interface DispatchPlanView {
	topology: DispatchPlanTopology;
	taskCount: number;
	/** True when this call requires plan approval at supervised autonomy levels. */
	planScale: boolean;
	tasks: DispatchPlanTaskView[];
	/** Rendered plan artifact, deterministic for identical arguments. */
	text: string;
	/** sha256 of the rendered artifact. */
	hash: string;
	/** Scheduling ceiling visible in the approved artifact. */
	costCeilingUsd?: number;
	/** Supervised compete-winner confirmation, when this is an apply action. */
	confirmation?: { branch: string; group: string; index: number };
}

export const RESOLVED_DISPATCH_PLAN_ARGUMENT = "__clio_resolved_dispatch_plan";
export const DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT = "__clio_dispatch_plan_preparation_error";

export interface ResolvedDispatchPlanArtifact {
	version: 2;
	topology: DispatchPlanTopology;
	tasks: Array<
		Required<Pick<DispatchPlanTaskView, "agent" | "task" | "model" | "node" | "target">> &
			Required<Pick<DispatchPlanTaskView, "nodeKind" | "failover">> &
			Required<Pick<DispatchPlanTaskView, "routingIntent">> &
			Pick<DispatchPlanTaskView, "briefing" | "nodeHost" | "role" | "position" | "allowedCandidates"> &
			Required<Pick<DispatchPlanTaskView, "routeApproval">>
	>;
	costCeilingUsd: number;
	confirmation?: { branch: string; group: string; index: number };
}

export function withResolvedPlanTaskPin(
	request: DispatchRequest,
	task: ResolvedDispatchPlanArtifact["tasks"][number] | undefined,
	options: { pinTask?: boolean } = {},
): DispatchRequest {
	if (task === undefined) return request;
	const {
		briefing: _briefing,
		failover: _failover,
		allowedCandidates: _candidates,
		routeApproval: _approval,
		assignmentDeadlineAt: _deadline,
		...base
	} = request;
	return {
		...base,
		agentId: task.agent,
		...(request.reservation !== undefined && task.role !== undefined && task.position !== undefined
			? { reservation: { ownerId: request.reservation.ownerId, memberId: `${task.role}-${task.position}` } }
			: {}),
		routingIntent: structuredClone(task.routingIntent),
		failover: task.failover,
		...(task.routeApproval === null ? {} : { routeApproval: cloneApprovedAssignmentRoute(task.routeApproval) }),
		...(task.allowedCandidates === undefined
			? {}
			: { allowedCandidates: task.allowedCandidates.map((candidate) => ({ ...candidate })) }),
		task: options.pinTask === false ? request.task : task.task,
		...(task.briefing !== undefined ? { briefing: task.briefing } : {}),
		target: task.target,
		model: task.model,
		node: task.node,
		plannedNode: {
			id: task.node,
			kind: task.nodeKind,
			...(task.nodeHost !== undefined ? { host: task.nodeHost } : {}),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Keep terminal control bytes and line breaks out of approval artifacts. */
function safeField(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		result += code < 32 || (code >= 127 && code <= 159) ? "?" : character;
		if (result.length >= 256) return `${result.slice(0, 255)}…`;
	}
	return result;
}

function taskViews(args: Record<string, unknown>): DispatchPlanTaskView[] {
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];
	const sharedAgent = str(args.agent) ?? "coder";
	const sharedModel = str(args.model);
	const sharedNode = str(args.node);
	const sharedTarget = str(args.target);
	return tasks.map((item) => {
		const record = isRecord(item) ? item : {};
		const view: DispatchPlanTaskView = {
			agent: str(record.agent) ?? str(record.agent_id) ?? sharedAgent,
			task: str(item) ?? str(record.task) ?? "(invalid task)",
			routeApproval: null,
		};
		const briefing = "briefing" in record ? str(record.briefing) : str(args.briefing);
		if (briefing !== undefined) view.briefing = briefing;
		const model = str(record.model) ?? sharedModel;
		if (model !== undefined) view.model = model;
		const node = str(record.node) ?? sharedNode;
		if (node !== undefined) view.node = node;
		const target = str(record.target) ?? sharedTarget;
		if (target !== undefined) view.target = target;
		const failover = failoverModeOf(record.failover) ?? failoverModeOf(args.failover);
		if (failover !== undefined) view.failover = failover;
		const rawCandidates = "allowedCandidates" in record ? record.allowedCandidates : args.allowedCandidates;
		const candidates = canonicalCandidates(rawCandidates);
		if (failover === "approved" && candidates !== null) view.allowedCandidates = candidates;
		return view;
	});
}

function failoverModeOf(value: unknown): DispatchFailoverMode | undefined {
	return value === "none" || value === "approved" ? value : undefined;
}

/**
 * Canonicalize an approved failover envelope: trim every field, drop malformed
 * tuples, and preserve order (order is the approved preference and is part of
 * the plan hash). Returns null when the list is absent or empty after cleanup.
 */
function canonicalCandidates(value: unknown): DispatchFailoverCandidate[] | null {
	if (!Array.isArray(value)) return null;
	const out: DispatchFailoverCandidate[] = [];
	for (const item of value) {
		if (!isRecord(item)) return null;
		const agentId = str(item.agentId);
		const target = str(item.target);
		const model = str(item.model);
		const node = str(item.node);
		if (!agentId || !target || !model || !node) return null;
		out.push({ agentId, target, model, node });
	}
	return out.length > 0 ? out : null;
}

function topologyOf(args: Record<string, unknown>): DispatchPlanTopology {
	if (isRecord(args.apply_winner)) return "compete";
	if (args.mode === "compete") return "compete";
	if (args.review === true || isRecord(args.review)) return "review";
	if (args.detach === true) return "detached";
	if (args.mode === "sequential") return "sequential";
	if (args.mode === "pipeline") return "pipeline";
	return "parallel";
}

function renderPlanText(
	topology: DispatchPlanTopology,
	tasks: ReadonlyArray<DispatchPlanTaskView>,
	costCeilingUsd: number | undefined,
	confirmation?: ResolvedDispatchPlanArtifact["confirmation"],
): string {
	const lines = [
		`dispatch plan: topology=${topology} tasks=${tasks.length}`,
		`cost ceiling: ${costCeilingUsd === undefined ? "unavailable" : `$${costCeilingUsd.toFixed(4)}`}`,
	];
	if (confirmation !== undefined) {
		lines.push(
			`winner confirmation: group=${safeField(confirmation.group)} candidate=${confirmation.index} branch=${safeField(confirmation.branch)}`,
		);
	}
	for (const [index, task] of tasks.entries()) {
		const model = task.model !== undefined ? ` model=${safeField(task.model)}` : "";
		const target = task.target !== undefined ? ` target=${safeField(task.target)}` : "";
		const node = ` node=${safeField(task.node ?? "local")}${
			task.nodeKind !== undefined ? ` kind=${task.nodeKind}` : ""
		}${task.nodeHost !== undefined ? ` host=${safeField(task.nodeHost)}` : ""}`;
		const role =
			task.role !== undefined ? ` role=${task.role}${task.position !== undefined ? `#${task.position}` : ""}` : "";
		const failover = task.failover !== undefined ? ` failover=${task.failover}` : "";
		const routing = task.routingIntent;
		const routingText =
			routing === undefined
				? ""
				: ` posture=${routing.posture} maxCostUsd=${routing.maxCostUsd ?? "none"} deadlineMs=${routing.deadlineMs ?? "none"} minimumQuality=${routing.minimumQuality ?? "none"} locality=${routing.locality}`;
		lines.push(
			`  ${index + 1}.${role} agent=${safeField(task.agent)}${target}${model}${node}${failover}${routingText} task=${JSON.stringify(safeField(task.task))}`,
		);
		if (task.allowedCandidates !== undefined) {
			for (const [candidateIndex, candidate] of task.allowedCandidates.entries()) {
				lines.push(
					`    candidate#${candidateIndex + 1} agent=${safeField(candidate.agentId)} target=${safeField(candidate.target)} model=${safeField(candidate.model)} node=${safeField(candidate.node)}`,
				);
			}
		}
		if (task.routeApproval !== null) {
			const approval = task.routeApproval;
			const selected = approval.decision.selected;
			lines.push(
				`    active policy=${safeField(approval.decision.policyVersion)} decision=${approval.decision.decisionHash} runtime=${safeField(selected.runtimeId)} thinking=${safeField(selected.thinkingLevel ?? "default")} totalCostUpperBoundUsd=${approval.totalCostUpperBoundUsd.toFixed(6)} deadlineMs=${approval.deadlineMs} maxAttempts=${approval.maxAttempts}`,
			);
		}
		if (task.briefing !== undefined) {
			lines.push(
				`    briefing_bytes=${Buffer.byteLength(task.briefing, "utf8")} briefing_sha256=${createHash("sha256").update(task.briefing, "utf8").digest("hex")} briefing_preview=${JSON.stringify(safeField(task.briefing))}`,
			);
		}
	}
	return lines.join("\n");
}

function isResolvedTask(value: unknown): value is ResolvedDispatchPlanArtifact["tasks"][number] {
	if (!isRecord(value)) return false;
	if (
		value.role !== undefined &&
		value.role !== "task" &&
		value.role !== "builder" &&
		value.role !== "reviewer" &&
		value.role !== "candidate" &&
		value.role !== "judge"
	) {
		return false;
	}
	if (value.position !== undefined && (!Number.isInteger(value.position) || Number(value.position) < 1)) return false;
	if (value.nodeKind !== "local" && value.nodeKind !== "ssh") return false;
	if (value.nodeKind === "ssh" && (typeof value.nodeHost !== "string" || value.nodeHost.trim().length === 0))
		return false;
	if (value.nodeKind === "local" && value.nodeHost !== undefined) return false;
	if (value.briefing !== undefined && (typeof value.briefing !== "string" || value.briefing.trim().length === 0))
		return false;
	if (failoverModeOf(value.failover) === undefined) return false;
	if (!isRoutingIntent(value.routingIntent)) return false;
	if (value.routeApproval !== null && !isApprovedAssignmentRoute(value.routeApproval)) return false;
	if (value.routeApproval !== null && value.failover !== "approved") return false;
	if (value.failover === "approved") {
		if (canonicalCandidates(value.allowedCandidates) === null) return false;
	} else if (value.allowedCandidates !== undefined) {
		return false;
	}
	return [value.agent, value.task, value.model, value.node, value.target].every(
		(candidate) => typeof candidate === "string" && candidate.trim().length > 0,
	);
}

export function resolvedDispatchPlanFromArgs(args: Record<string, unknown>): ResolvedDispatchPlanArtifact | null {
	const value = args[RESOLVED_DISPATCH_PLAN_ARGUMENT];
	if (!isRecord(value) || value.version !== 2) return null;
	if (!Array.isArray(value.tasks) || !value.tasks.every(isResolvedTask)) return null;
	let confirmation: ResolvedDispatchPlanArtifact["confirmation"];
	if (value.confirmation !== undefined) {
		if (
			!isRecord(value.confirmation) ||
			typeof value.confirmation.branch !== "string" ||
			value.confirmation.branch.trim().length === 0 ||
			typeof value.confirmation.group !== "string" ||
			value.confirmation.group.trim().length === 0 ||
			!Number.isInteger(value.confirmation.index) ||
			Number(value.confirmation.index) < 1
		) {
			return null;
		}
		confirmation = {
			branch: value.confirmation.branch.trim(),
			group: value.confirmation.group.trim(),
			index: Number(value.confirmation.index),
		};
	}
	if (value.tasks.length === 0 && confirmation === undefined) return null;
	if (
		value.topology !== "parallel" &&
		value.topology !== "sequential" &&
		value.topology !== "pipeline" &&
		value.topology !== "review" &&
		value.topology !== "compete" &&
		value.topology !== "detached"
	) {
		return null;
	}
	if (typeof value.costCeilingUsd !== "number" || !Number.isFinite(value.costCeilingUsd) || value.costCeilingUsd <= 0) {
		return null;
	}
	return {
		version: 2,
		topology: value.topology,
		tasks: value.tasks.map((task) => ({
			agent: task.agent.trim(),
			task: task.task.trim(),
			...(task.briefing !== undefined ? { briefing: task.briefing.trim() } : {}),
			model: task.model.trim(),
			node: task.node.trim(),
			nodeKind: task.nodeKind,
			target: task.target.trim(),
			failover: task.failover,
			routingIntent: structuredClone(task.routingIntent),
			routeApproval: task.routeApproval === null ? null : cloneApprovedAssignmentRoute(task.routeApproval),
			...(task.failover === "approved" && canonicalCandidates(task.allowedCandidates) !== null
				? { allowedCandidates: canonicalCandidates(task.allowedCandidates) as DispatchFailoverCandidate[] }
				: {}),
			...(task.nodeHost !== undefined ? { nodeHost: task.nodeHost.trim() } : {}),
			...(task.role !== undefined ? { role: task.role } : {}),
			...(task.position !== undefined ? { position: task.position } : {}),
		})),
		costCeilingUsd: value.costCeilingUsd,
		...(confirmation !== undefined ? { confirmation } : {}),
	};
}

export function withResolvedDispatchPlan(
	args: Record<string, unknown>,
	artifact: ResolvedDispatchPlanArtifact,
): Record<string, unknown> {
	return { ...args, [RESOLVED_DISPATCH_PLAN_ARGUMENT]: structuredClone(artifact) };
}

/**
 * Derive the plan view for a dispatch tool call. Arguments are normalized
 * through the same prepareDispatchArguments the tool itself applies, so the
 * admission-time view and the execution-time view agree.
 */
export function describeDispatchPlan(rawArgs: Record<string, unknown> | undefined): DispatchPlanView {
	const args = prepareDispatchArguments(rawArgs ?? {});
	const preparationFailed = typeof args[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT] === "string";
	const resolved = resolvedDispatchPlanFromArgs(args);
	const topology = resolved?.topology ?? topologyOf(args);
	const tasks = resolved?.tasks ?? taskViews(args);
	const costCeilingUsd = resolved?.costCeilingUsd;
	const confirmation = resolved?.confirmation;
	const remote = tasks.some((task) => task.node !== undefined && task.node !== "local");
	const planScale =
		!preparationFailed &&
		args.list !== true &&
		(tasks.length > 1 ||
			topology === "compete" ||
			remote ||
			tasks.some((task) => task.failover === "approved") ||
			confirmation !== undefined ||
			isRecord(args.apply_winner));
	const text = renderPlanText(topology, tasks, costCeilingUsd, confirmation);
	return {
		topology,
		taskCount: Math.max(1, tasks.length),
		planScale,
		tasks,
		text,
		hash: createHash("sha256").update(text, "utf8").digest("hex"),
		...(costCeilingUsd !== undefined ? { costCeilingUsd } : {}),
		...(confirmation !== undefined ? { confirmation } : {}),
	};
}

/** Registry-side predicate: does this dispatch call require plan approval at supervised levels? */
export function isPlanScaleDispatchArgs(rawArgs: Record<string, unknown> | undefined): boolean {
	try {
		return describeDispatchPlan(rawArgs).planScale;
	} catch {
		// A malformed call fails closed as NOT plan-scale; the dispatch tool's
		// own validation rejects it with a real error message.
		return false;
	}
}
