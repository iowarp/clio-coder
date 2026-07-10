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
 * Everything here is pure and derived from the call arguments alone, so the
 * artifact the operator approves at admission and the hash sealed into the
 * receipts are guaranteed to describe the same plan.
 */

import { createHash } from "node:crypto";
import { prepareDispatchArguments } from "./dispatch.js";

export type DispatchPlanTopology = "parallel" | "sequential" | "pipeline" | "compete" | "detached";

export interface DispatchPlanTaskView {
	agent: string;
	model?: string;
	node?: string;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function taskViews(args: Record<string, unknown>): DispatchPlanTaskView[] {
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];
	const sharedAgent = str(args.agent) ?? "coder";
	const sharedModel = str(args.model);
	const sharedNode = str(args.node);
	return tasks.map((item) => {
		const record = isRecord(item) ? item : {};
		const view: DispatchPlanTaskView = { agent: str(record.agent) ?? str(record.agent_id) ?? sharedAgent };
		const model = str(record.model) ?? sharedModel;
		if (model !== undefined) view.model = model;
		const node = str(record.node) ?? sharedNode;
		if (node !== undefined) view.node = node;
		return view;
	});
}

function topologyOf(args: Record<string, unknown>): DispatchPlanTopology {
	if (args.mode === "compete") return "compete";
	if (args.detach === true) return "detached";
	if (args.mode === "sequential") return "sequential";
	if (args.mode === "pipeline") return "pipeline";
	return "parallel";
}

function renderPlanText(topology: DispatchPlanTopology, tasks: ReadonlyArray<DispatchPlanTaskView>): string {
	const lines = [`dispatch plan: topology=${topology} tasks=${tasks.length}`];
	for (const [index, task] of tasks.entries()) {
		const model = task.model !== undefined ? ` model=${task.model}` : "";
		const node = ` node=${task.node ?? "local"}`;
		lines.push(`  ${index + 1}. agent=${task.agent}${model}${node}`);
	}
	return lines.join("\n");
}

/**
 * Derive the plan view for a dispatch tool call. Arguments are normalized
 * through the same prepareDispatchArguments the tool itself applies, so the
 * admission-time view and the execution-time view agree.
 */
export function describeDispatchPlan(rawArgs: Record<string, unknown> | undefined): DispatchPlanView {
	const args = prepareDispatchArguments(rawArgs ?? {});
	const topology = topologyOf(args);
	const tasks = taskViews(args);
	const remote = tasks.some((task) => task.node !== undefined && task.node !== "local");
	const planScale =
		args.list !== true && (tasks.length > 1 || topology === "compete" || remote || isRecord(args.apply_winner));
	const text = renderPlanText(topology, tasks);
	return {
		topology,
		taskCount: Math.max(1, tasks.length),
		planScale,
		tasks,
		text,
		hash: createHash("sha256").update(text, "utf8").digest("hex"),
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
