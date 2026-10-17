import { toolSurfaceSources, turnAllowsTool, turnDelegatesTool } from "../../core/turn-constraints.js";
import type { DispatchRequest } from "./contract.js";

export function assertTurnConstraintCompatibility(
	req: DispatchRequest,
	tools: ReadonlyArray<string>,
	mediated: boolean,
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
		throw new Error(
			`dispatch: worker tool surface exceeds the parent task's explicit scope: ${outside.join(", ")}.\nRefused by: ${source}.\nRemedy: ${remedy} Or pass a narrower tool_profile or recipe in the dispatch.`,
		);
	}
	if ((req.resolvedVerification?.length ?? 0) > 0 && !turnDelegatesTool(constraints, "verify")) {
		throw new Error("dispatch: host verification is outside the parent task's explicit tool scope");
	}
	if (req.worktree === true && !turnDelegatesTool(constraints, "write")) {
		throw new Error("dispatch: worktree creation requires write in the parent task's explicit tool scope");
	}
}
