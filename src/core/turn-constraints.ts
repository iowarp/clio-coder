import { toolPlacement } from "../tools/surface.js";
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
	readonly skills?: "allowed" | "disabled";
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
		(value.allowedTools !== undefined &&
			(!Array.isArray(value.allowedTools) ||
				value.allowedTools.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(name))))
	) {
		throw new Error("Invalid explicit turn constraints");
	}
	return Object.freeze({
		...(value.mode === undefined ? {} : { mode: value.mode }),
		...(value.delegation === undefined ? {} : { delegation: value.delegation }),
		...(value.skills === undefined ? {} : { skills: value.skills }),
		...(value.allowedTools === undefined ? {} : { allowedTools: Object.freeze([...new Set(value.allowedTools)].sort()) }),
	});
}

/** Capability policy, shared by schema projection, gateway, admission and prompts. */
export function turnAllowsTool(constraints: TurnConstraints | undefined, capability: string): boolean {
	if (constraints?.delegation === "forbidden" && capability === ToolNames.Dispatch) return false;
	const allowed = constraints?.allowedTools;
	if (allowed === undefined || allowed.includes(capability)) return true;
	// Naming a secondary capability necessarily admits its transport wrapper;
	// naming the wrapper alone never admits every capability behind it.
	return capability === ToolNames.Gateway && allowed.some((name) => toolPlacement(name) === "gateway");
}

export function turnAllowsContinuation(constraints: TurnConstraints | undefined): boolean {
	return constraints?.mode !== "answer" && constraints?.mode !== "proposal";
}
