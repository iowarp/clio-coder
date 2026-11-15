import { toolSurfaceSources, turnAllowsTool, turnDelegatesTool } from "../../core/turn-constraints.js";
import type { AgentSpec } from "../agents/index.js";
import type { DispatchRequest } from "./contract.js";

const FITTING_AGENT_LIMIT = 5;

/**
 * Dispatchable recipes whose declared tools all sit inside the delegated
 * scope. Admission only subtracts from a recipe's declared tools, so one that
 * fits here cannot exceed the ceiling at run time. A model that omitted
 * `agent` got the default recipe; naming one of these is the fix it can make
 * itself, where widening the ceiling needs the operator.
 */
function fittingAgents(
	constraints: NonNullable<DispatchRequest["turnConstraints"]>,
	current: string,
	specs: ReadonlyArray<Pick<AgentSpec, "id" | "tools" | "audience">>,
): string[] {
	return specs
		.filter(
			(spec) =>
				spec.id !== current &&
				spec.audience !== "internal" &&
				spec.tools.length > 0 &&
				spec.tools.every((tool) => turnDelegatesTool(constraints, tool)),
		)
		.map((spec) => spec.id)
		.slice(0, FITTING_AGENT_LIMIT);
}

export function assertTurnConstraintCompatibility(
	req: DispatchRequest,
	tools: ReadonlyArray<string>,
	mediated: boolean,
	specs: ReadonlyArray<Pick<AgentSpec, "id" | "tools" | "audience">> = [],
): void {
	const constraints = req.turnConstraints;
	if (!constraints) return;
	if (!turnAllowsTool(constraints, "dispatch"))
		throw new Error("dispatch: forbidden by the parent task's explicit scope");
	if (
		!mediated &&
		(constraints.allowedTools !== undefined ||
			constraints.delegatedTools !== undefined ||
			constraints.skills === "disabled")
	) {
		throw new Error(
			"dispatch: this external runtime cannot enforce the parent task's tool/skill constraints; use a native worker",
		);
	}
	const outside = tools.filter((name) => !turnDelegatesTool(constraints, name));
	if (outside.length > 0) {
		const sources = toolSurfaceSources(constraints, true).filter((entry) =>
			outside.some((name) => !entry.tools.includes(name)),
		);
		const source = [...new Set(sources.map((entry) => entry.source))].join("; ") || "explicit task scope";
		const remedy =
			[...new Set(sources.map((entry) => entry.remedy))].join(" ") ||
			"Ask the submitting operator to widen the task's tool scope, then resubmit.";
		const fitting = fittingAgents(constraints, req.agentId, specs);
		const remedyLine =
			fitting.length > 0
				? `Remedy: dispatch with agent set to one of these recipes, whose tools fit the delegated scope: ${fitting.join(", ")}. Or ${remedy.charAt(0).toLowerCase()}${remedy.slice(1)}`
				: `Remedy: ${remedy} Or pass a narrower tool_profile or recipe in the dispatch.`;
		throw new Error(
			`dispatch: worker tool surface exceeds the parent task's explicit scope for agent ${req.agentId}: ${outside.join(", ")}.\nRefused by: ${source}.\n${remedyLine}`,
		);
	}
	if ((req.resolvedVerification?.length ?? 0) > 0 && !turnDelegatesTool(constraints, "verify")) {
		throw new Error("dispatch: host verification is outside the parent task's explicit tool scope");
	}
	if (req.worktree === true && !turnDelegatesTool(constraints, "write")) {
		throw new Error("dispatch: worktree creation requires write in the parent task's explicit tool scope");
	}
}
