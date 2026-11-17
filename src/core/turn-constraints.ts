import { COORDINATOR_DIRECT_TOOLS, toolPlacement } from "../tools/surface.js";
import { resolveGuardrail, resolveTemplateCeiling, templateBudgetLimit } from "./guardrails.js";
import { MODEL_TIERS, type ModelTier } from "./model-tier.js";
import { ToolNames } from "./tool-names.js";

export interface ToolSurfaceSource {
	readonly tools: readonly string[];
	readonly source: string;
	readonly remedy: string;
	/** The prompt template that declared this limit, when one did. */
	readonly template?: string;
}

/** The prompt template whose tool scope bounds a turn, when one does. */
export function turnTemplateName(constraints: TurnConstraints | undefined): string | undefined {
	for (const entry of [...(constraints?.toolSurfaceSources ?? []), ...(constraints?.delegatedToolSurfaceSources ?? [])])
		if (entry.template !== undefined && entry.template.length > 0) return entry.template;
	return undefined;
}

interface TemplateConstraintSource {
	name: string;
	allowedTools?: readonly string[];
	delegatedTools?: readonly string[];
	budget?: { toolCalls?: number; observationBytes?: number };
	turnPolicy?: { mode: "step"; stepTool: string; when?: readonly StepPolicyRoute[] };
}

/**
 * An expanded template's turn constraint: its tool scope, its budget and its
 * turn policy. Undefined when the template declares none of them, so a plain
 * template submits no constraint at all.
 */
export function templateTurnConstraints(template: TemplateConstraintSource): TurnConstraints | undefined {
	return template.allowedTools === undefined &&
		template.delegatedTools === undefined &&
		template.budget === undefined &&
		template.turnPolicy === undefined
		? undefined
		: templateToolConstraints(template);
}

export function templateToolConstraints(template: TemplateConstraintSource): TurnConstraints {
	const limit = (tools: readonly string[], field: string): ToolSurfaceSource[] => [
		{
			tools,
			source: `prompt template "${template.name}" ${field}`,
			remedy: `Ask the operator to widen ${field} in prompt template "${template.name}", then resubmit.`,
			...(template.name.length > 0 ? { template: template.name } : {}),
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
		...(template.budget === undefined ? {} : { budget: { ...template.budget, template: template.name } }),
		...(template.turnPolicy === undefined
			? {}
			: {
					turnPolicy: {
						mode: "step" as const,
						stepTool: template.turnPolicy.stepTool,
						...(template.turnPolicy.when === undefined ? {} : { when: template.turnPolicy.when }),
						template: template.name,
					},
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
	/**
	 * A prompt template's per-turn budget. It lowers the operator's
	 * `safety.limits.chatToolCallsPerTurn` and `observationBytesPerTurn`, and
	 * raises them only up to `templateToolCallsPerTurnMax` and
	 * `templateObservationBytesPerTurnMax`; with no ceiling set it only lowers.
	 */
	readonly budget?: TurnBudget;
	/** A prompt template's turn policy: one step of its step tool per turn. */
	readonly turnPolicy?: TurnStepPolicy;
	/**
	 * A step policy whose `when` does not match this turn's route. Nothing
	 * enforces it; it is kept so the scope reminder can say so and a request
	 * continuation can scope it again against the route it then runs on.
	 */
	readonly dormantTurnPolicy?: TurnStepPolicy;
}

/** Template budget bounds; `template` names the prompt template that set them, for refusal text. */
export interface TurnBudget {
	readonly toolCalls?: number;
	readonly observationBytes?: number;
	readonly template?: string;
}

/**
 * `turnPolicy: {mode: step, stepTool}`: once the step tool succeeds in a turn,
 * a second call to it is refused and the turn locks to a text-only summary, so
 * each turn runs one step and a continuation starts the next one.
 */
export interface TurnStepPolicy {
	readonly mode: "step";
	readonly stepTool: string;
	/** The routes the policy applies on; absent means every route. */
	readonly when?: readonly StepPolicyRoute[];
	readonly template?: string;
}

/** A `turnPolicy.when` token: a model tier, or `uncached` for a route that does not cache prompts. */
export type StepPolicyRoute = ModelTier | "uncached";

export const STEP_POLICY_ROUTES: ReadonlyArray<StepPolicyRoute> = [...MODEL_TIERS, "uncached"];

/** The session chat route a turn starts on, as its runtime resolution reports it (WTF-P 0.8.3 C1). */
export interface StepPolicyRouteFacts {
	modelTier?: ModelTier;
	promptCaching?: boolean;
}

/** Whether a step policy applies on a route: always without `when`, else when any token matches. */
function stepPolicyApplies(policy: TurnStepPolicy, route: StepPolicyRouteFacts): boolean {
	return (
		policy.when === undefined ||
		policy.when.some((token) => (token === "uncached" ? route.promptCaching === false : token === route.modelTier))
	);
}

/**
 * A turn's constraints on the route it starts on. A step policy whose `when`
 * misses the route becomes dormant, so the turn runs with no step policy at
 * all: no step-tool refusal, no text-only lock, no step continuation and no
 * step checkpoint. Run at every turn start, so a model switch takes effect on
 * the next turn (WTF-P 0.8.3 C5).
 */
export function routeScopedTurnConstraints(
	constraints: TurnConstraints | undefined,
	route: StepPolicyRouteFacts,
): TurnConstraints | undefined {
	const policy = constraints?.turnPolicy ?? constraints?.dormantTurnPolicy;
	if (constraints === undefined || policy === undefined) return constraints;
	const { turnPolicy: _active, dormantTurnPolicy: _dormant, ...rest } = constraints;
	return Object.freeze(
		stepPolicyApplies(policy, route) ? { ...rest, turnPolicy: policy } : { ...rest, dormantTurnPolicy: policy },
	);
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
		!isSurfaceSources(value.delegatedToolSurfaceSources) ||
		!isTurnBudget(value.budget) ||
		!isTurnStepPolicy(value.turnPolicy) ||
		!isTurnStepPolicy(value.dormantTurnPolicy)
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
		...(value.budget === undefined ? {} : { budget: Object.freeze({ ...value.budget }) }),
		...(value.turnPolicy === undefined ? {} : { turnPolicy: snapshotStepPolicy(value.turnPolicy) }),
		...(value.dormantTurnPolicy === undefined ? {} : { dormantTurnPolicy: snapshotStepPolicy(value.dormantTurnPolicy) }),
	});
}

function snapshotStepPolicy(policy: TurnStepPolicy): TurnStepPolicy {
	return Object.freeze({ ...policy, ...(policy.when === undefined ? {} : { when: Object.freeze([...policy.when]) }) });
}

function isTurnBudget(value: unknown): boolean {
	if (value === undefined) return true;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const budget = value as Record<string, unknown>;
	const bound = (entry: unknown): boolean =>
		entry === undefined || (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0);
	return (
		Object.keys(budget).every((key) => key === "toolCalls" || key === "observationBytes" || key === "template") &&
		bound(budget.toolCalls) &&
		bound(budget.observationBytes) &&
		(budget.template === undefined || typeof budget.template === "string")
	);
}

function isTurnStepPolicy(value: unknown): boolean {
	if (value === undefined) return true;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const policy = value as Record<string, unknown>;
	return (
		Object.keys(policy).every((key) => ["mode", "stepTool", "when", "template"].includes(key)) &&
		policy.mode === "step" &&
		(policy.when === undefined ||
			(Array.isArray(policy.when) &&
				policy.when.length > 0 &&
				policy.when.every((token) => (STEP_POLICY_ROUTES as ReadonlyArray<unknown>).includes(token)))) &&
		typeof policy.stepTool === "string" &&
		/^[a-zA-Z0-9_.-]+$/.test(policy.stepTool) &&
		(policy.template === undefined || typeof policy.template === "string")
	);
}

/** Each bound is the smaller of the two layers', named after the layer that set it. */
function narrowerBudget(first: TurnBudget | undefined, second: TurnBudget | undefined): TurnBudget | undefined {
	if (first === undefined) return second;
	if (second === undefined) return first;
	const lower = (key: "toolCalls" | "observationBytes"): TurnBudget | undefined => {
		const a = first[key];
		const b = second[key];
		return a === undefined ? (b === undefined ? undefined : second) : b === undefined || a <= b ? first : second;
	};
	const calls = lower("toolCalls");
	const bytes = lower("observationBytes");
	const template = calls?.template ?? bytes?.template;
	return {
		...(calls?.toolCalls === undefined ? {} : { toolCalls: calls.toolCalls }),
		...(bytes?.observationBytes === undefined ? {} : { observationBytes: bytes.observationBytes }),
		...(template === undefined ? {} : { template }),
	};
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
	const budget = narrowerBudget(session.budget, turn.budget);
	const turnPolicy = turn.turnPolicy ?? session.turnPolicy;
	return {
		...(mode === undefined ? {} : { mode }),
		...(budget === undefined ? {} : { budget }),
		...(turnPolicy === undefined ? {} : { turnPolicy }),
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
					(entry.template === undefined || typeof entry.template === "string") &&
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
		lines.push(
			"This task is read-only: no user file may change. Writes are denied, a shell command runs only in a read-only sandbox, a dispatched worker is read-only too, and no approval clears a denial.",
		);
	if (constraints.allowedTools) {
		const names = [...new Set(constraints.allowedTools)].sort();
		lines.push(
			names.length > 0 ? `Allowed capabilities for this turn: ${names.join(", ")}.` : "Use no tools for this turn.",
		);
		// A narrowed scope that keeps the shell beside the file tools admits it
		// for the commands the workflow runs. Given only the list, a model ran
		// find, ls and grep through bash eight-plus times a turn (WTF-P campaign).
		const fileTools = [ToolNames.Read, ToolNames.Grep].filter((name) => names.includes(name));
		if (names.includes(ToolNames.Bash) && fileTools.length > 0) {
			const listing = [ToolNames.Find, ToolNames.Ls].filter((name) => names.includes(name));
			lines.push(
				`bash is admitted for the commands this task runs; use ${fileTools.join(" and ")} for files${listing.length > 0 ? ` and ${listing.join("/")} through gateway for listings` : ""}, not shell commands.`,
			);
		}
	}
	if (constraints.delegatedTools) {
		const names = [...new Set(constraints.delegatedTools)].sort();
		lines.push(
			names.length > 0
				? `Allowed capabilities for delegated workers this turn: ${names.join(", ")}.`
				: "Delegated workers may use no tools for this turn.",
		);
	}
	const budget = constraints.budget;
	if (budget?.toolCalls !== undefined || budget?.observationBytes !== undefined) {
		// The limits the turn actually gets: a value above the operator's applies only up to its template ceiling.
		const calls =
			budget.toolCalls === undefined
				? undefined
				: templateBudgetLimit(
						budget.toolCalls,
						resolveGuardrail("turnToolCallBudget"),
						resolveTemplateCeiling("templateTurnToolCallCeiling"),
					).limit;
		const bytes =
			budget.observationBytes === undefined
				? undefined
				: templateBudgetLimit(
						budget.observationBytes,
						resolveGuardrail("observationTurnBudgetBytes"),
						resolveTemplateCeiling("templateObservationTurnCeilingBytes"),
					).limit;
		const bounds = [
			...(calls === undefined ? [] : [`${calls} tool calls`]),
			...(bytes === undefined ? [] : [`${bytes} bytes of tool output`]),
		];
		lines.push(
			`Budget for this turn${budget.template ? ` from prompt template "${budget.template}"` : ""}: at most ${bounds.join(" and ")}.`,
		);
	}
	const policy = constraints.turnPolicy;
	const scoped =
		policy?.when === undefined ? "" : ` This step policy applies on this route (when: ${policy.when.join(", ")}).`;
	if (policy !== undefined)
		lines.push(
			`One step per turn: once ${policy.stepTool} returns a step, run that step, then end the turn with a compact state summary (the step, its outcome, what changed, and the after value for the next ${policy.stepTool} call). Do not call ${policy.stepTool} again this turn; the next turn starts the next step.${scoped}`,
		);
	const dormant = constraints.dormantTurnPolicy;
	if (policy === undefined && dormant?.when !== undefined)
		lines.push(
			`The template's one-step-per-turn policy (when: ${dormant.when.join(", ")}) does not apply on this route, so ${dormant.stepTool} may run more than one step this turn.`,
		);
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
	// A template's budget and step policy bound the main turn, not a worker's run.
	const {
		delegatedTools,
		delegatedToolSurfaceSources: _delegatedSources,
		budget: _budget,
		turnPolicy: _turnPolicy,
		dormantTurnPolicy: _dormantTurnPolicy,
		...rest
	} = constraints;
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
