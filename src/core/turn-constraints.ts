import { COORDINATOR_DIRECT_TOOLS, toolPlacement } from "../tools/surface.js";
import { ToolNames } from "./tool-names.js";

/**
 * Explicit host-supplied scope for one submitted task and its continuations.
 * Never derived from model arguments or guessed from natural-language text.
 * These bounds only narrow existing safety, skill, and recipe policy.
 */
export interface TurnConstraints {
	readonly mode?: "answer" | "proposal" | "change";
	readonly delegation?: "allowed" | "forbidden";
	readonly allowedTools?: readonly string[];
	/**
	 * Delegation ceiling: the tools a dispatched worker may hold, separate from
	 * the parent's own `allowedTools`. Without it a dispatch-only coordinator had
	 * to hold every worker tool itself, including write, and could then bypass
	 * dispatch entirely (D8c). Absent means the parent's own set is the ceiling.
	 */
	readonly delegatedTools?: readonly string[];
	readonly skills?: "allowed" | "disabled";
	/**
	 * Enforced read-only ceiling: admission denies every call that is not a
	 * read inside the workspace, exactly as a read-only dispatch does. Unlike
	 * `mode`, which only shapes the workflow, no approval clears it.
	 */
	readonly readOnly?: true;
}

/** Snapshot caller-owned input before asynchronous admission or queuing. */
export function snapshotTurnConstraints(value: TurnConstraints | undefined): TurnConstraints | undefined {
	if (value === undefined) return undefined;
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value.mode !== undefined && !["answer", "proposal", "change"].includes(value.mode)) ||
		(value.delegation !== undefined && !["allowed", "forbidden"].includes(value.delegation)) ||
		(value.skills !== undefined && !["allowed", "disabled"].includes(value.skills)) ||
		(value.readOnly !== undefined && value.readOnly !== true) ||
		!isToolNameList(value.allowedTools) ||
		!isToolNameList(value.delegatedTools)
	) {
		throw new Error("Invalid explicit turn constraints");
	}
	return Object.freeze({
		...(value.mode === undefined ? {} : { mode: value.mode }),
		...(value.delegation === undefined ? {} : { delegation: value.delegation }),
		...(value.skills === undefined ? {} : { skills: value.skills }),
		...(value.readOnly === true ? { readOnly: true as const } : {}),
		...(value.allowedTools === undefined ? {} : { allowedTools: Object.freeze([...new Set(value.allowedTools)].sort()) }),
		...(value.delegatedTools === undefined
			? {}
			: { delegatedTools: Object.freeze([...new Set(value.delegatedTools)].sort()) }),
	});
}

function intersectLists(
	first: readonly string[] | undefined,
	second: readonly string[] | undefined,
): readonly string[] | undefined {
	if (first === undefined) return second;
	if (second === undefined) return first;
	return first.filter((name) => second.includes(name));
}

/**
 * A turn's constraints under the session's standing tool limits: the session
 * entry flags of an interactive or ACP session. Every bound only narrows, so
 * neither a host-supplied turn scope nor a continuation can widen what the
 * operator limited the session to.
 */
export function narrowTurnConstraints(
	session: TurnConstraints | undefined,
	turn: TurnConstraints | undefined,
): TurnConstraints | undefined {
	if (session === undefined) return turn;
	if (turn === undefined) return session;
	const allowedTools = intersectLists(session.allowedTools, turn.allowedTools);
	// Each side's ceiling falls back to its own tool set, so the narrower one holds.
	const delegatedTools =
		session.delegatedTools === undefined && turn.delegatedTools === undefined
			? undefined
			: intersectLists(session.delegatedTools ?? session.allowedTools, turn.delegatedTools ?? turn.allowedTools);
	const delegation = session.delegation === "forbidden" ? "forbidden" : turn.delegation;
	const skills = session.skills === "disabled" ? "disabled" : turn.skills;
	return {
		...(turn.mode === undefined ? {} : { mode: turn.mode }),
		...(delegation === undefined ? {} : { delegation }),
		...(skills === undefined ? {} : { skills }),
		...(allowedTools === undefined ? {} : { allowedTools }),
		...(delegatedTools === undefined ? {} : { delegatedTools }),
	};
}

function isToolNameList(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) && value.every((name) => typeof name === "string" && /^[a-zA-Z0-9_.-]+$/.test(name)))
	);
}

/** Capability policy, shared by schema projection, gateway, admission and prompts. */
export function turnAllowsTool(constraints: TurnConstraints | undefined, capability: string): boolean {
	if (constraints?.delegation === "forbidden" && capability === ToolNames.Dispatch) return false;
	return listAllowsTool(constraints?.allowedTools, capability);
}

/** Whether a dispatched worker may hold a tool under the parent's delegation ceiling. */
export function turnDelegatesTool(constraints: TurnConstraints | undefined, capability: string): boolean {
	return listAllowsTool(constraints?.delegatedTools ?? constraints?.allowedTools, capability);
}

/**
 * The constraints a dispatched worker runs under: the delegation ceiling
 * becomes its own tool set, and its own dispatches inherit that set as their
 * ceiling rather than the parent's wider one.
 */
export function workerTurnConstraints(constraints: TurnConstraints): TurnConstraints {
	const { delegatedTools, ...rest } = constraints;
	return Object.freeze({ ...rest, ...(delegatedTools === undefined ? {} : { allowedTools: delegatedTools }) });
}

function listAllowsTool(allowed: readonly string[] | undefined, capability: string): boolean {
	if (allowed === undefined || allowed.includes(capability)) return true;
	// Naming a secondary capability necessarily admits its transport wrapper;
	// naming the wrapper alone never admits every capability behind it.
	return (
		capability === ToolNames.Gateway &&
		allowed.some((name) => toolPlacement(name) === "gateway" || !COORDINATOR_DIRECT_TOOLS.has(name))
	);
}

export function turnAllowsContinuation(constraints: TurnConstraints | undefined): boolean {
	return constraints?.mode !== "answer" && constraints?.mode !== "proposal";
}
