import { type Static, Type } from "typebox";
import type { FleetSettings } from "../core/defaults.js";
import { RESULT_SUMMARY_MAX_BYTES_CEILING } from "../domains/agents/result-contract.js";
import { DISPATCH_BRIEFING_MAX_BYTES } from "../domains/dispatch/validation.js";
import { StringEnum } from "../engine/ai.js";
import { TOOL_PROFILE_NAMES } from "./profiles.js";

/**
 * Which optional blocks of the `dispatch` argument schema a session advertises.
 *
 * The schema is composed once per session from the fleet the session was
 * started with. A block whose feature the fleet cannot exercise is left off the
 * wire, because every first turn pays for every description whether or not the
 * feature is reachable: on Qwen3.8-27B the council block costs 233 tokens, the
 * compete block 216, and the adaptive routing fields about 100. Admission keeps
 * reading every field regardless, so a caller that sends a hidden field is
 * still honored; only the advertisement moves.
 */
export interface DispatchSchemaComposition {
	/** `roster`, `members`, `synthesis`, `rounds`: a council needs a configured roster to name. */
	council: boolean;
	/** `candidates`, `judge`, `apply_winner`: distinct executions may share one fleet route. */
	compete: boolean;
	/** `routing.posture`, `minimumQuality`, `locality`, `failover`: they act only once adaptive routing is activated. */
	adaptiveRouting: boolean;
}

export const FULL_DISPATCH_SCHEMA_COMPOSITION: DispatchSchemaComposition = Object.freeze({
	council: true,
	compete: true,
	adaptiveRouting: true,
});

type FleetShape = Pick<FleetSettings, "rosters" | "adaptiveRouting">;

export function dispatchSchemaCompositionFor(fleet: FleetShape): DispatchSchemaComposition {
	const routing = fleet.adaptiveRouting;
	return {
		council: Object.keys(fleet.rosters).length > 0,
		// The runner isolates candidate executions and dispatches a separate judge;
		// route diversity is not required. Normal admission still validates routes.
		compete: true,
		adaptiveRouting: routing.roles.length > 0 || routing.postures.length > 0 || routing.agentRoles.length > 0,
	};
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const CouncilMemberSchema = Type.Object(
	{
		label: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
		target: Type.String(),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
	},
	{ additionalProperties: false },
);

const DispatchBudgetPhaseSchema = Type.Object(
	{
		toolCalls: Type.Integer({ minimum: 1 }),
		readReserve: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const DispatchBudgetSchema = Type.Object(
	{
		toolCalls: Type.Integer({ minimum: 1, description: "Tool-call phase boundary." }),
		readReserve: Type.Integer({ minimum: 0, description: "Tail reserve for read calls." }),
		retryRevision: Type.Optional(DispatchBudgetPhaseSchema),
	},
	{
		additionalProperties: false,
		description:
			"Advisory tool-call estimate; choose appropriate counts even above recipe recommendations. retryRevision sets a retry/revision estimate. Crossing estimates does not stop work.",
	},
);

const DispatchVerificationSchema = Type.Array(
	Type.Object(
		{
			check: Type.String({ description: "Declared check id, never a shell command." }),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Within the check's declared bounds." })),
		},
		{ additionalProperties: false },
	),
	{ maxItems: 8 },
);

// The intent and budget schemas are wanted at the top level and on every
// task. Each is serialized once, under `$defs`, and referenced by JSON
// pointer from both places; the per-task copies alone cost 371 tokens of
// every first turn on the ornith tokenizer. TypeBox's validator and pi's
// argument validator both resolve the pointer.
const DispatchIntentSchema = Type.Object(
	{
		read_roots: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
		write_roots: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 32,
				description:
					"Paths the worker may write; every expected output sits under one. Declaring any confines the worker and removes bash and verify from it, so put checks in verification instead of the task text.",
			}),
		),
		relevant_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
		expected_outputs: Type.Optional(
			Type.Array(Type.String(), { maxItems: 32, description: "Output paths only, never a description of the change." }),
		),
		verification: Type.Optional(DispatchVerificationSchema),
	},
	{
		additionalProperties: false,
		description:
			"Repository-relative paths and outputs. Declare it on every dispatch: it selects the project rules that apply and pins worker context, where omitting it falls back to path tokens scraped from the task text. verification entries are declared check ids from package scripts or .clio-coder/verifiers.yaml. Per-task intent must fit inside the top-level intent.",
	},
);

const DISPATCH_DEFS = { intent: DispatchIntentSchema, budget: DispatchBudgetSchema };
const IntentRef = Type.Unsafe<Static<typeof DispatchIntentSchema>>({ $ref: "#/$defs/intent" });
const BudgetRef = Type.Unsafe<Static<typeof DispatchBudgetSchema>>({ $ref: "#/$defs/budget" });

const MODE_DESCRIPTION: Record<"full" | "noCouncil" | "noCompete" | "neither", string> = {
	full:
		"parallel (default); sequential; pipeline, where each task receives the previous output; compete, where candidates build the same task in scratch worktrees and a judge picks; council, where roster members answer the same question.",
	noCouncil:
		"parallel (default); sequential; pipeline, where each task receives the previous output; compete, where candidates build the same task in scratch worktrees and a judge picks.",
	noCompete:
		"parallel (default); sequential; pipeline, where each task receives the previous output; council, where roster members answer the same question.",
	neither: "parallel (default); sequential; pipeline, where each task receives the previous output.",
};

/**
 * Build the `dispatch` argument schema for one session. Every field keeps one
 * discriminating sentence; the tool description states only the call shape.
 * Optional blocks come and go with `composition`, and the `mode` enum only
 * names the modes whose fields are advertised.
 */
export function buildDispatchParameters(composition: DispatchSchemaComposition = FULL_DISPATCH_SCHEMA_COMPOSITION) {
	const modes = [
		"parallel",
		"sequential",
		"pipeline",
		...(composition.compete ? ["compete" as const] : []),
		...(composition.council ? ["council" as const] : []),
	];
	const modeDescription =
		composition.compete && composition.council
			? MODE_DESCRIPTION.full
			: composition.compete
				? MODE_DESCRIPTION.noCouncil
				: composition.council
					? MODE_DESCRIPTION.noCompete
					: MODE_DESCRIPTION.neither;
	return Type.Object(
		{
			list: Type.Optional(Type.Boolean({ description: "List the agent roster instead of dispatching." })),
			from_scout: Type.Optional(
				Type.Object(
					{
						run_id: Type.String({ description: "Terminal Scout run id." }),
						receipt_digest: Type.String({ description: "Its sha256 receipt digest." }),
					},
					{
						additionalProperties: false,
						description: "Compile a Scout split result into one approval-gated dependency plan; use with no other argument.",
					},
				),
			),
			task: Type.Optional(Type.String({ description: "One worker assignment. Use tasks for a batch." })),
			tasks: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String(),
						// A task carries only what varies per task. persona, tool_profile,
						// cwd, and apply come from the batch defaults (admission still reads
						// them when a caller sends them; the schema no longer spends the
						// tokens advertising them twice).
						Type.Object({
							task: Type.String({ description: "The assignment, with expected output and constraints." }),
							briefing: Type.Optional(
								Type.String({ description: `Per-task parent context, max ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes.` }),
							),
							agent: Type.Optional(Type.String({ description: "Recipe id (default coder)." })),
							budget: Type.Optional(BudgetRef),
							target: Type.Optional(Type.String()),
							model: Type.Optional(Type.String()),
							node: Type.Optional(Type.String({ description: "Fleet node pin: local or a fleet.nodes id." })),
							worktree: Type.Optional(Type.Literal(true, { description: "Run this writer in an isolated git worktree." })),
							intent: Type.Optional(IntentRef),
							gate: Type.Optional(Type.String({ description: "One declared check id, shorthand for intent.verification." })),
							result_summary_max_bytes: Type.Optional(
								Type.Integer({
									minimum: 1,
									maximum: RESULT_SUMMARY_MAX_BYTES_CEILING,
									description: "This task's inline summary allowance; mutation-report workers (coder, documenter) only.",
								}),
							),
						}),
					]),
					{ description: "Batch of assignments; one string or object is wrapped." },
				),
			),
			mode: Type.Optional(StringEnum(modes, { description: modeDescription })),
			...(composition.council
				? {
						roster: Type.Optional(Type.String({ description: "Configured workers.rosters name (council)." })),
						members: Type.Optional(
							Type.Array(CouncilMemberSchema, { minItems: 2, maxItems: 5, description: "Explicit council members, 2 to 5." }),
						),
						synthesis: Type.Optional(StringEnum(["none", "judge", "vote"] as const, { description: "Council synthesis." })),
						rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Council rounds." })),
					}
				: {}),
			writers: Type.Optional(
				Type.Literal(1, { description: "Serialize writer admission in task order while readers run concurrently." }),
			),
			worktree: Type.Optional(
				Type.Literal(true, { description: "Run a singular writer task in an isolated git worktree." }),
			),
			apply: Type.Optional(
				StringEnum(["merge", "preserve"], { description: "merge (default) or preserve the worktree branch." }),
			),
			detach: Type.Optional(
				Type.Boolean({
					description: "Return run ids immediately and collect with monitor before final synthesis. Parallel mode only.",
				}),
			),
			review: Type.Optional(
				Type.Union(
					[
						Type.Boolean(),
						Type.Object({
							reviewer: Type.Optional(
								Type.String({ description: "Reviewer recipe id (default: the builder's agent, read-only)." }),
							),
							max_cycles: Type.Optional(
								Type.Number({ description: "Review/revise cycles before an operator decision (default 2, max 4)." }),
							),
							node: Type.Optional(Type.String({ description: "Fleet node pin for the reviewer." })),
							model: Type.Optional(Type.String({ description: "Model for the reviewer." })),
							target: Type.Optional(Type.String({ description: "Target for the reviewer." })),
						}),
					],
					{
						description:
							"Reviewer gate for one task: a read-only reviewer verdicts pass, revise, or fail, and revise re-runs the builder with the findings.",
					},
				),
			),
			...(composition.compete
				? {
						candidates: Type.Optional(Type.Number({ description: "Compete candidates, 2 to 4 (default 2)." })),
						judge: Type.Optional(
							Type.Object(
								{
									agent: Type.Optional(Type.String({ description: "Judge recipe id (default: the builder's agent)." })),
									model: Type.Optional(Type.String()),
									target: Type.Optional(Type.String()),
									node: Type.Optional(Type.String({ description: "Fleet node pin for the judge." })),
								},
								{ description: "Read-only judge that ranks compete candidates." },
							),
						),
						apply_winner: Type.Optional(
							Type.Object(
								{
									branch: Type.String({ description: "Preserved winner branch: clio-coder/compete/<group>/<n>." }),
									cwd: Type.Optional(Type.String({ description: "Repository root (default: current directory)." })),
								},
								{
									description:
										"Merge a preserved compete winner and clean up its group; supervised autonomy parks this for operator confirmation.",
								},
							),
						),
					}
				: {}),
			agent: Type.Optional(
				Type.String({
					description: composition.council
						? "Default recipe id for string tasks, or auto (default coder; researcher for council)."
						: "Default recipe id for string tasks, or auto (default coder).",
				}),
			),
			briefing: Type.Optional(
				Type.String({
					description: `Parent context for task, or the shared default for tasks; never instructions. Max ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes.`,
				}),
			),
			intent: Type.Optional(IntentRef),
			gate: Type.Optional(Type.String({ description: "One declared check id, shorthand for intent.verification." })),
			persona: Type.Optional(Type.String({ description: "Default persona for the batch, max 8000 chars." })),
			tool_profile: Type.Optional(StringEnum(TOOL_PROFILE_NAMES, { description: "Default worker tool profile." })),
			budget: Type.Optional(BudgetRef),
			target: Type.Optional(Type.String({ description: "Default target id (omit for the fleet default)." })),
			model: Type.Optional(Type.String({ description: "Default model override." })),
			node: Type.Optional(Type.String({ description: "Default fleet node pin (omit for automatic placement)." })),
			routing: Type.Optional(
				Type.Object(
					{
						...(composition.adaptiveRouting
							? { posture: Type.Optional(StringEnum(["manual", "quality", "balanced", "latency", "economy"] as const)) }
							: {}),
						maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
						deadlineMs: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
						...(composition.adaptiveRouting
							? { minimumQuality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) }
							: {}),
						requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
						...(composition.adaptiveRouting
							? {
									locality: Type.Optional(StringEnum(["local-only", "prefer-local", "any"] as const)),
									failover: Type.Optional(StringEnum(["none", "approved"] as const)),
								}
							: {}),
					},
					{
						additionalProperties: false,
						description: composition.adaptiveRouting
							? "Advisory posture and hard routing bounds; exact target, model, and node pins stay manual."
							: "Hard routing bounds: cost ceiling, deadline, and required model capabilities.",
					},
				),
			),
			thinking_level: Type.Optional(StringEnum(THINKING_LEVELS)),
			cwd: Type.Optional(Type.String({ description: "Default worker working directory." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Abort the dispatch after this many ms." })),
			max_output_bytes: Type.Optional(Type.Number({ description: "Max summary bytes returned." })),
			result_summary_max_bytes: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: RESULT_SUMMARY_MAX_BYTES_CEILING,
					description: `UTF-8 byte allowance for a mutation-report worker's inline summary (coder, documenter), default 16384. A batch default applies to mutation-report steps only; other steps ignore it. Storage bound, not the returned preview (max_output_bytes).`,
				}),
			),
		},
		{ $defs: DISPATCH_DEFS },
	);
}
