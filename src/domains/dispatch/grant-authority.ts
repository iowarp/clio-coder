import { ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { turnDelegatesTool } from "../../core/turn-constraints.js";
import { evaluateAdmission } from "../safety/admission.js";
import type { AutonomyLevel } from "../safety/autonomy.js";
import type { SafetyContract } from "../safety/contract.js";
import type { GrantRecord } from "./grant-broker.js";

/**
 * How the main agent's approval of one worker ask is admitted (Phase D,
 * operator decisions Q2 and Q3).
 *
 * - Main at yolo may grant an ordinary autonomy ask when the worker effect,
 *   evaluated as the main agent's own call, is inside the operator's
 *   delegation ceiling and admitted at yolo. The worker still re-admits the
 *   call under its unchanged permit before it runs.
 * - Main at any other level, attended: the approval becomes the main agent's
 *   ask to the operator, who decides with the main request as provenance.
 * - Headless (no operator surface) below yolo: denied at once.
 * - Operator-authority asks, hard blocks, and effects the parent cannot
 *   evaluate are never main-grantable.
 */
export type MainGrantVerdict =
	| { kind: "grant" }
	| { kind: "ask-operator"; reason: string }
	| { kind: "deny"; reason: string };

export interface MainGrantInput {
	record: GrantRecord;
	autonomy: AutonomyLevel;
	/** True when an operator surface in this process answers forwarded worker asks. */
	attended: boolean;
	safety: Pick<SafetyContract, "evaluate">;
	/** The main turn's host constraints; the delegation ceiling is `delegatedTools ?? allowedTools`. */
	turnConstraints?: TurnConstraints;
}

/** Argument keys whose value decides admission; a digested value there cannot be evaluated. */
const DECIDING_ARGUMENT_KEYS = ["command", "path", "file_path", "cwd", "url", "paths", "op", "args", "argv", "script"];

function effectEvaluable(record: GrantRecord): boolean {
	const effect = record.effect;
	if (effect === null) return false;
	// A gateway call is a wrapper whose effect only the worker's own projection
	// knows; judged as the bare wrapper here it would read as harmless.
	if (effect.tool === ToolNames.Gateway) return false;
	for (const key of DECIDING_ARGUMENT_KEYS) {
		const value = effect.args[key];
		if (value !== null && typeof value === "object" && !Array.isArray(value) && "$sha256" in value) return false;
	}
	return true;
}

function inPermit(record: GrantRecord, tool: string): boolean {
	return record.permitTools.includes(tool);
}

export function evaluateMainGrant(input: MainGrantInput): MainGrantVerdict {
	const { record, autonomy, attended } = input;
	const refuse = (reason: string): MainGrantVerdict =>
		attended ? { kind: "ask-operator", reason } : { kind: "deny", reason };
	if (record.approvalAuthority !== "main") {
		return refuse(`${record.tool} raised an operator-authority ask, which only the operator can approve`);
	}
	const effect = record.effect;
	if (effect === null || !effectEvaluable(record)) {
		return refuse(`the ${record.tool} call is too large for the main agent to evaluate`);
	}
	if (!inPermit(record, effect.tool)) {
		return { kind: "deny", reason: `${effect.tool} is outside the worker's permit` };
	}
	if (!turnDelegatesTool(input.turnConstraints, effect.tool)) {
		return { kind: "deny", reason: `${effect.tool} is outside the operator's delegation ceiling for this turn` };
	}
	if (autonomy !== "yolo") {
		return attended
			? { kind: "ask-operator", reason: `the main agent runs at autonomy ${autonomy}, so the operator decides` }
			: {
					kind: "deny",
					reason: `the main agent runs at autonomy ${autonomy} with no operator to ask; only --autonomy yolo lets it grant worker asks`,
				};
	}
	const admission = evaluateAdmission({
		principal: "main",
		effects: [{ tool: effect.tool, args: effect.args }],
		cwd: record.cwd,
		safety: input.safety,
		autonomy: "yolo",
		...(input.turnConstraints !== undefined ? { constraints: { turnConstraints: input.turnConstraints } } : {}),
	});
	if (admission.kind === "deny") return { kind: "deny", reason: admission.reason };
	if (admission.kind === "ask") return refuse(`the main agent's own admission asks: ${admission.reason}`);
	return { kind: "grant" };
}
