import { createHash } from "node:crypto";
import { normalizeWriteBoundary } from "../agents/write-boundary.js";

export type DelegationTaskMode = "sequential" | "parallel";

export interface DelegationPlanTask {
	id: string;
	agent: string;
	description: string;
	depends_on: ReadonlyArray<string>;
	writes: ReadonlyArray<string>;
	mode?: DelegationTaskMode;
}

export interface DelegationPlan {
	tasks: ReadonlyArray<DelegationPlanTask>;
}

export type DelegationPlanReason =
	| "delegation_plan_malformed"
	| "delegation_plan_over_max_tasks"
	| "delegation_plan_duplicate_id"
	| "delegation_plan_roster_violation"
	| "delegation_plan_dependency_unknown"
	| "delegation_plan_dependency_cycle"
	| "delegation_plan_writes_outside_boundary";

export type DelegationPlanValidation =
	| { ok: true; plan: DelegationPlan; hash: string }
	| { ok: false; reason: DelegationPlanReason; detail: string };

export interface ValidateDelegationPlanInput {
	value: unknown;
	roster: ReadonlyArray<string>;
	maxTasks: number;
	writes: ReadonlyArray<string>;
}

export const DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES = 12_000;

export function buildDelegationProposalBriefing(proposals: ReadonlyArray<{ agent: string; output: string }>): string {
	const value = proposals.map((proposal) => `PROPOSAL ${proposal.agent}\n${proposal.output}`).join("\n\n");
	if (Buffer.byteLength(value, "utf8") <= DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES) return value;
	const suffix = "\n[truncated]";
	const source = Buffer.from(value, "utf8");
	let end = DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
	while (end > 0) {
		const byte = source[end];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		end -= 1;
	}
	return `${source.subarray(0, end).toString("utf8")}${suffix}`;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function insideBoundary(path: string, boundary: ReadonlyArray<string>): boolean {
	return boundary.some((root) => (root.endsWith("/") ? path.startsWith(root) : path === root));
}

function malformed(detail: string): DelegationPlanValidation {
	return { ok: false, reason: "delegation_plan_malformed", detail };
}

export function validateDelegationPlan(input: ValidateDelegationPlanInput): DelegationPlanValidation {
	if (input.value === null || typeof input.value !== "object" || Array.isArray(input.value)) {
		return malformed("delegation plan must be an object");
	}
	const record = input.value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "tasks") || !Array.isArray(record.tasks)) {
		return malformed("delegation plan must carry only tasks[]");
	}
	if (record.tasks.length === 0) return malformed("delegation plan must carry at least one task");
	if (record.tasks.length > input.maxTasks) {
		return {
			ok: false,
			reason: "delegation_plan_over_max_tasks",
			detail: `delegation plan returned ${record.tasks.length} tasks, above maxTasks ${input.maxTasks}`,
		};
	}
	const roster = new Set(input.roster);
	const ids = new Set<string>();
	const tasks: DelegationPlanTask[] = [];
	for (const raw of record.tasks) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return malformed("every task must be an object");
		const task = raw as Record<string, unknown>;
		if (
			Object.keys(task).some((key) => !["id", "agent", "description", "depends_on", "writes", "mode"].includes(key)) ||
			typeof task.id !== "string" ||
			!ID_RE.test(task.id) ||
			typeof task.agent !== "string" ||
			task.agent.length === 0 ||
			typeof task.description !== "string" ||
			task.description.trim().length === 0 ||
			!Array.isArray(task.depends_on) ||
			task.depends_on.some((value) => typeof value !== "string" || value.length === 0) ||
			!Array.isArray(task.writes) ||
			task.writes.some((value) => typeof value !== "string" || value.length === 0) ||
			(task.mode !== undefined && task.mode !== "sequential" && task.mode !== "parallel")
		) {
			return malformed("each task requires id, agent, description, depends_on[], writes[], and an optional valid mode");
		}
		if (ids.has(task.id)) {
			return { ok: false, reason: "delegation_plan_duplicate_id", detail: `duplicate task id '${task.id}'` };
		}
		if (!roster.has(task.agent)) {
			return {
				ok: false,
				reason: "delegation_plan_roster_violation",
				detail: `task '${task.id}' names agent '${task.agent}' outside the roster`,
			};
		}
		let writes: ReadonlyArray<string>;
		try {
			writes = normalizeWriteBoundary(task.writes as string[]);
		} catch (error) {
			return malformed(`task '${task.id}' has invalid writes: ${error instanceof Error ? error.message : String(error)}`);
		}
		const outside = writes.find((path) => !insideBoundary(path, input.writes));
		if (outside !== undefined) {
			return {
				ok: false,
				reason: "delegation_plan_writes_outside_boundary",
				detail: `task '${task.id}' writes '${outside}' outside the plan step boundary`,
			};
		}
		ids.add(task.id);
		tasks.push({
			id: task.id,
			agent: task.agent,
			description: task.description,
			depends_on: [...(task.depends_on as string[])],
			writes,
			...(task.mode !== undefined ? { mode: task.mode as DelegationTaskMode } : {}),
		});
	}
	for (const task of tasks) {
		const unknown = task.depends_on.find((dependency) => !ids.has(dependency));
		if (unknown !== undefined) {
			return {
				ok: false,
				reason: "delegation_plan_dependency_unknown",
				detail: `task '${task.id}' depends on unknown task '${unknown}'`,
			};
		}
	}
	const remaining = new Set(ids);
	const completed = new Set<string>();
	while (remaining.size > 0) {
		const ready = tasks.filter(
			(task) => remaining.has(task.id) && task.depends_on.every((dependency) => completed.has(dependency)),
		);
		if (ready.length === 0) {
			return {
				ok: false,
				reason: "delegation_plan_dependency_cycle",
				detail: `delegation plan dependency cycle includes ${[...remaining].sort().join(", ")}`,
			};
		}
		for (const task of ready) {
			remaining.delete(task.id);
			completed.add(task.id);
		}
	}
	const plan = { tasks } satisfies DelegationPlan;
	return { ok: true, plan, hash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}
