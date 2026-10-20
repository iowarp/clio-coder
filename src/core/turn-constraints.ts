import { COORDINATOR_DIRECT_TOOLS, toolPlacement } from "../tools/surface.js";
import { ToolNames } from "./tool-names.js";

export interface ToolSurfaceSource {
	readonly tools: readonly string[];
	readonly source: string;
	readonly remedy: string;
}

export function templateToolConstraints(template: {
	name: string;
	allowedTools?: readonly string[];
	delegatedTools?: readonly string[];
}): TurnConstraints {
	const limit = (tools: readonly string[], field: string): ToolSurfaceSource[] => [
		{
			tools,
			source: `prompt template "${template.name}" ${field}`,
			remedy: `Ask the operator to widen ${field} in prompt template "${template.name}", then resubmit.`,
		},
	];
	return {
		...(template.allowedTools === undefined
			? {}
			: {
					allowedTools: template.allowedTools,
					toolSurfaceSources: limit(template.allowedTools, "allowed-tools"),
				}),
		...(template.delegatedTools === undefined
			? {}
			: {
					delegatedTools: template.delegatedTools,
					delegatedToolSurfaceSources: limit(template.delegatedTools, "delegated-tools"),
				}),
	};
}

export function toolSurfaceSources(
	constraints: TurnConstraints | undefined,
	delegated = false,
): readonly ToolSurfaceSource[] {
	const tools = delegated ? (constraints?.delegatedTools ?? constraints?.allowedTools) : constraints?.allowedTools;
	const sources =
		delegated && constraints?.delegatedTools !== undefined
			? constraints.delegatedToolSurfaceSources
			: constraints?.toolSurfaceSources;
	return (
		sources ??
		(tools === undefined
			? []
			: [
					{
						tools,
						source: "explicit task scope",
						remedy: "Ask the submitting operator to widen the task's tool scope, then resubmit.",
					},
				])
	);
}

/**
 * Explicit host-supplied scope for one submitted task and its continuations.
 * Never derived from model arguments or guessed from natural-language text.
 * These bounds only narrow existing safety, skill, and recipe policy.
 */
export interface TurnConstraints {
	readonly mode?: "answer" | "proposal" | "change";
	readonly delegation?: "allowed" | "forbidden";
	readonly allowedTools?: readonly string[];
	readonly toolSurfaceSources?: readonly ToolSurfaceSource[];
	readonly delegatedToolSurfaceSources?: readonly ToolSurfaceSource[];
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
		!isToolNameList(value.delegatedTools) ||
		!isSurfaceSources(value.toolSurfaceSources) ||
		!isSurfaceSources(value.delegatedToolSurfaceSources)
	) {
		throw new Error("Invalid explicit turn constraints");
	}
	return Object.freeze({
		...(value.toolSurfaceSources === undefined
			? {}
			: { toolSurfaceSources: snapshotSurfaceSources(value.toolSurfaceSources) }),
		...(value.delegatedToolSurfaceSources === undefined
			? {}
			: { delegatedToolSurfaceSources: snapshotSurfaceSources(value.delegatedToolSurfaceSources) }),
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

const MODE_BREADTH = { answer: 0, proposal: 1, change: 2 } as const;

function narrowerMode(first: TurnConstraints["mode"], second: TurnConstraints["mode"]): TurnConstraints["mode"] {
	if (first === undefined) return second;
	if (second === undefined) return first;
	return MODE_BREADTH[first] <= MODE_BREADTH[second] ? first : second;
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
	// Once any layer is read-only every narrower one is too (Z1).
	const readOnly = session.readOnly === true || turn.readOnly === true;
	// A template's turn carries only allowed-tools, so keeping turn.mode alone
	// dropped a headless run's own --mode the moment a template expanded.
	const mode = narrowerMode(session.mode, turn.mode);
	return {
		...(mode === undefined ? {} : { mode }),
		...(delegation === undefined ? {} : { delegation }),
		...(skills === undefined ? {} : { skills }),
		...(readOnly ? { readOnly: true as const } : {}),
		...(allowedTools === undefined
			? {}
			: {
					allowedTools,
					...(session.toolSurfaceSources || turn.toolSurfaceSources
						? { toolSurfaceSources: [...toolSurfaceSources(session), ...toolSurfaceSources(turn)] }
						: {}),
				}),
		...(delegatedTools === undefined
			? {}
			: {
					delegatedTools,
					...(session.toolSurfaceSources ||
					turn.toolSurfaceSources ||
					session.delegatedToolSurfaceSources ||
					turn.delegatedToolSurfaceSources
						? { delegatedToolSurfaceSources: [...toolSurfaceSources(session, true), ...toolSurfaceSources(turn, true)] }
						: {}),
				}),
	};
}

function isSurfaceSources(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(
				(entry) =>
					entry !== null &&
					typeof entry === "object" &&
					typeof entry.source === "string" &&
					typeof entry.remedy === "string" &&
					// Source tools only attribute a refusal and never admit anything, so they
					// take a recipe's tool list verbatim instead of the strict name rule.
					Array.isArray(entry.tools) &&
					entry.tools.every((name: unknown) => typeof name === "string"),
			))
	);
}

function snapshotSurfaceSources(sources: readonly ToolSurfaceSource[]): readonly ToolSurfaceSource[] {
	return Object.freeze(sources.map((entry) => Object.freeze({ ...entry, tools: Object.freeze([...entry.tools]) })));
}

function isToolNameList(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) && value.every((name) => typeof name === "string" && /^[a-zA-Z0-9_.-]+$/.test(name)))
	);
}

/** Capability policy, shared by schema projection, gateway, admission and prompts. */
/**
 * The scope lines a turn delivers in its host-framed reminder. They never enter
 * a compiled prompt: a scope that toggled between turns recompiled the system
 * prompt and re-billed the whole conversation as a cache write (#422).
 */
export function turnScopeGuidance(constraints: TurnConstraints | undefined): string {
	if (!constraints) return "";
	const lines: string[] = [];
	if (constraints.mode === "answer") lines.push("Answer the requested question; stop when it is answered.");
	if (constraints.mode === "proposal")
		lines.push(
			"Propose from supplied context; inspect only missing facts. Leave implementation blocked pending authorization.",
		);
	if (constraints.mode === "change") lines.push("Carry out the requested change within the authorized scope.");
	if (constraints.delegation === "forbidden") lines.push("Work directly; do not delegate.");
	if (constraints.skills === "disabled") lines.push("Skill activation and discovery are disabled for this turn.");
	if (constraints.readOnly === true)
		lines.push("This task is read-only: every write, command, or delegation is denied, and no approval clears it.");
	if (constraints.allowedTools) {
		const names = [...new Set(constraints.allowedTools)].sort();
		lines.push(
			names.length > 0 ? `Allowed capabilities for this turn: ${names.join(", ")}.` : "Use no tools for this turn.",
		);
	}
	if (constraints.delegatedTools) {
		const names = [...new Set(constraints.delegatedTools)].sort();
		lines.push(
			names.length > 0
				? `Allowed capabilities for delegated workers this turn: ${names.join(", ")}.`
				: "Delegated workers may use no tools for this turn.",
		);
	}
	return lines.length > 0 ? ["# Current task scope", ...lines].join("\n") : "";
}

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
	const { delegatedTools, delegatedToolSurfaceSources: _delegatedSources, ...rest } = constraints;
	return Object.freeze({
		...rest,
		...(delegatedTools === undefined
			? {}
			: { allowedTools: delegatedTools, toolSurfaceSources: toolSurfaceSources(constraints, true) }),
	});
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
