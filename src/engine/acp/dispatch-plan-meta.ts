import type { AcpDispatchPlanMeta } from "./types.js";

export type { AcpDispatchPlanMeta } from "./types.js";
export { ACP_DISPATCH_PLAN_META_KEY } from "./types.js";

/**
 * The dispatch plan admission rendered, projected onto a permission ask under
 * `clio-coder/dispatchPlan`. A client approving a dispatch used to see only the
 * first task's agent and text from the call's arguments; a plan-scale call
 * approves every run in it, so the ask carries each task's placement and the
 * hash the run will seal.
 *
 * Only the fields a person weighs travel: agent, task, role, placement, the
 * worktree posture and the dependency shape. Briefings, routing internals and
 * authority records stay in the ledger. Every list and string is bounded so
 * one ask stays well under the stdio line ceiling.
 */

import type { DispatchPlanView } from "../../tools/dispatch-plan.js";

export const ACP_DISPATCH_PLAN_MAX_TASKS = 32;
const MAX_TASK_BYTES = 1024;
const MAX_FIELD_BYTES = 256;
const MAX_DEPENDENCIES = 8;

function clean(value: string, maxBytes: number): string {
	let safe = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		safe += code <= 0x1f || code === 0x7f ? (character === "\n" ? "\n" : " ") : character;
	}
	if (Buffer.byteLength(safe, "utf8") <= maxBytes) return safe;
	let cut = safe.slice(0, maxBytes);
	while (Buffer.byteLength(cut, "utf8") > maxBytes - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

/** A bounded optional string under its own key, or nothing. */
const bounded = <K extends string>(key: K, value: string | null | undefined) =>
	(value === undefined || value === null ? {} : { [key]: clean(value, MAX_FIELD_BYTES) }) as Partial<Record<K, string>>;

export function projectDispatchPlanMeta(view: DispatchPlanView): AcpDispatchPlanMeta {
	const tasks = view.tasks.slice(0, ACP_DISPATCH_PLAN_MAX_TASKS).map((task) => ({
		agent: clean(task.agent, MAX_FIELD_BYTES),
		task: clean(task.task, MAX_TASK_BYTES),
		...(task.role !== undefined ? { role: task.role } : {}),
		...(task.position !== undefined ? { position: task.position } : {}),
		...bounded("target", task.target),
		...bounded("model", task.model),
		...bounded("node", task.node),
		...(task.nodeKind !== undefined ? { nodeKind: task.nodeKind } : {}),
		...(task.worktree === true ? { worktree: true as const } : {}),
		...(task.apply !== undefined ? { apply: task.apply } : {}),
		...bounded("stepId", task.stepId),
		dependencies: task.dependencies.slice(0, MAX_DEPENDENCIES).map((dependency) => clean(dependency, MAX_FIELD_BYTES)),
		...(task.wave !== null ? { wave: task.wave } : {}),
	}));
	return {
		version: 1,
		topology: view.topology,
		taskCount: view.taskCount,
		planScale: view.planScale,
		hash: view.hash,
		...(view.costCeilingUsd !== undefined ? { costCeilingUsd: view.costCeilingUsd } : {}),
		...(view.deadlineMs !== undefined ? { deadlineMs: view.deadlineMs } : {}),
		tasks,
		truncated: view.tasks.length > ACP_DISPATCH_PLAN_MAX_TASKS,
	};
}
