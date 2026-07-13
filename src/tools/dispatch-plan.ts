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
 * Production calls carry a v1 resolved artifact attached by the dispatch
 * tool's admission planner. That artifact pins effective target/model/node
 * choices into execution. Raw-argument derivation remains only as a
 * compatibility fallback for direct unit-level tool calls.
 */

import { createHash } from "node:crypto";
import { prepareDispatchArguments } from "./dispatch.js";

export type DispatchPlanTopology = "parallel" | "sequential" | "pipeline" | "review" | "compete" | "detached";

export interface DispatchPlanTaskView {
	agent: string;
	/** Exact bounded task being approved, sanitized only when rendered. */
	task: string;
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
	version: 1;
	topology: DispatchPlanTopology;
	tasks: Array<
		Required<Pick<DispatchPlanTaskView, "agent" | "task" | "model" | "node" | "target">> &
			Required<Pick<DispatchPlanTaskView, "nodeKind">> &
			Pick<DispatchPlanTaskView, "nodeHost" | "role" | "position">
	>;
	costCeilingUsd: number;
	confirmation?: { branch: string; group: string; index: number };
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
		};
		const model = str(record.model) ?? sharedModel;
		if (model !== undefined) view.model = model;
		const node = str(record.node) ?? sharedNode;
		if (node !== undefined) view.node = node;
		const target = str(record.target) ?? sharedTarget;
		if (target !== undefined) view.target = target;
		return view;
	});
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
		lines.push(
			`  ${index + 1}.${role} agent=${safeField(task.agent)}${target}${model}${node} task=${JSON.stringify(safeField(task.task))}`,
		);
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
	return [value.agent, value.task, value.model, value.node, value.target].every(
		(candidate) => typeof candidate === "string" && candidate.trim().length > 0,
	);
}

export function resolvedDispatchPlanFromArgs(args: Record<string, unknown>): ResolvedDispatchPlanArtifact | null {
	const value = args[RESOLVED_DISPATCH_PLAN_ARGUMENT];
	if (!isRecord(value) || value.version !== 1) return null;
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
		version: 1,
		topology: value.topology,
		tasks: value.tasks.map((task) => ({
			agent: task.agent.trim(),
			task: task.task.trim(),
			model: task.model.trim(),
			node: task.node.trim(),
			nodeKind: task.nodeKind,
			target: task.target.trim(),
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
		(tasks.length > 1 || topology === "compete" || remote || confirmation !== undefined || isRecord(args.apply_winner));
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
