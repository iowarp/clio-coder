import { Type } from "typebox";
import { incompleteInstallationAdvice } from "../core/incomplete-installation.js";
import { ToolNames } from "../core/tool-names.js";
import { DISPATCH_BRIEFING_MAX_BYTES } from "../domains/dispatch/validation.js";
import { StringEnum } from "../engine/ai.js";
import { createDispatchAdmissionController } from "./dispatch-admission.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "./dispatch-plan.js";
import { createDispatchRunEventRegistry } from "./dispatch-run-events.js";
import type { DispatchToolDeps } from "./dispatch-types.js";
import { TOOL_PROFILE_NAMES } from "./profiles.js";
import type { ToolSpec } from "./registry.js";

export type {
	DispatchBackgroundControl,
	DispatchBackgroundOutcome,
	DispatchBackgroundRegistry,
} from "./dispatch-background.js";
export {
	createDispatchRunEventRegistry,
	type DispatchEventSummary,
	type DispatchRunEventRegistry,
	type RunTailEntry,
} from "./dispatch-run-events.js";
export type { DispatchToolDeps } from "./dispatch-types.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const DispatchBudgetPhaseSchema = Type.Object(
	{
		toolCalls: Type.Integer({ minimum: 1 }),
		readReserve: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const DispatchBudgetSchema = Type.Object(
	{
		toolCalls: Type.Integer({ minimum: 1, description: "Requested tool-call phase boundary." }),
		readReserve: Type.Integer({ minimum: 0, description: "Requested tail reserve for canonical read calls." }),
		retryRevision: Type.Optional(DispatchBudgetPhaseSchema),
	},
	{
		additionalProperties: false,
		description:
			"Invocation budget inside the recipe policy. retryRevision preauthorizes one ceiling for retry, result-contract revision, or review revision phases.",
	},
);

/**
 * Stable, lightweight dispatch surface. Admission remains synchronous so the
 * policy decision and provisional reservation are bound to the exact argument
 * object which the dynamically imported runner later consumes.
 */
type DispatchRunnerModule = Pick<typeof import("./dispatch-runner.js"), "runDispatchTool">;

export interface DispatchToolSurfaceOptions {
	/** Test-only loader seam for proving admission failures do not load the implementation graph. */
	loadRunner?: () => Promise<DispatchRunnerModule>;
}

function admissionFailureResult(message: string) {
	return {
		kind: "error" as const,
		message: message.startsWith("dispatch: ") ? message : `dispatch: plan admission failed: ${message}`,
	};
}

export function createDispatchTool(
	inputDeps: DispatchToolDeps,
	surfaceOptions: DispatchToolSurfaceOptions = {},
): ToolSpec {
	const deps: DispatchToolDeps = {
		...inputDeps,
		runEvents: inputDeps.runEvents ?? createDispatchRunEventRegistry(),
	};
	const admission = createDispatchAdmissionController(deps);
	let runnerPromise: Promise<DispatchRunnerModule> | null = null;
	const loadRunner = (): Promise<DispatchRunnerModule> => {
		runnerPromise ??= (surfaceOptions.loadRunner ?? (() => import("./dispatch-runner.js")))();
		return runnerPromise;
	};

	return {
		name: ToolNames.Dispatch,
		description:
			'Dispatch one bounded task with task, or a batch with tasks (never both). Singular example: {agent:"debugger", task:"Verify the receipt boundary", briefing:"Prior receipt evidence...", detach:true}. task is the worker assignment; briefing is separate bounded parent context/data and cannot replace task. Ordinary calls auto-wait; detach:true returns ids for monitoring/steering, and collect is the authoritative terminal batch operation before final synthesis. Batch modes are parallel (default), sequential, pipeline, or compete. Task objects may include persona, tool_profile, and a recipe-admitted budget envelope. Sealed receipts are durable evidence; report receipt integrity, evidence verification, briefing provenance, and project-context provenance separately. Call with list:true to see agents. Do not repeat an identical successful dispatch in the same user turn. Prefer this tool over inline exploration whenever work is read-only fan-out, parallel investigation, or the operator asked for a worker by name; if you cannot dispatch, say so plainly and name the reason, and never narrate or summarize a worker you did not actually dispatch.',
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List available agents instead of dispatching." })),
			from_scout: Type.Optional(
				Type.Object(
					{
						run_id: Type.String({ description: "Exact terminal Scout run id." }),
						receipt_digest: Type.String({ description: "Exact sha256 receipt digest." }),
					},
					{
						additionalProperties: false,
						description:
							"Compile an authenticated split Scout result into one new approval-gated dependency plan; cannot combine with any other argument.",
					},
				),
			),
			task: Type.Optional(
				Type.String({
					description:
						"Singular worker assignment/instructions. Use tasks instead for a batch; briefing is separate context and cannot replace task.",
				}),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String(),
						Type.Object({
							task: Type.String({ description: "Concrete agent task with expected output and constraints." }),
							briefing: Type.Optional(
								Type.String({
									description: `Per-task parent context/data override, max ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes.`,
								}),
							),
							agent: Type.Optional(Type.String({ description: "Agent recipe id (default coder)." })),
							persona: Type.Optional(
								Type.String({
									description:
										"Ad-hoc specialist persona to substitute for the recipe body inside the stable worker shell, max 8000 chars.",
								}),
							),
							tool_profile: Type.Optional(
								StringEnum(TOOL_PROFILE_NAMES, { description: "Narrow this worker's available tools." }),
							),
							budget: Type.Optional(DispatchBudgetSchema),
							target: Type.Optional(Type.String()),
							model: Type.Optional(Type.String()),
							node: Type.Optional(Type.String({ description: "Fleet node pin: local or a fleet.nodes id." })),
							cwd: Type.Optional(Type.String()),
						}),
					]),
					{ description: "Tasks to dispatch; a single object or string is accepted and wrapped." },
				),
			),
			mode: Type.Optional(
				StringEnum(["parallel", "sequential", "pipeline", "compete"], {
					description:
						"Run tasks concurrently (default), one at a time, as a pipeline where each task receives the previous task's output as input data, or as a compete where N candidates build the same single task in scratch worktrees and a judge picks the winner.",
				}),
			),
			detach: Type.Optional(
				Type.Boolean({
					description:
						"Return immediately after admission with a batch id and run ids; runs continue in the background. Collect later with the monitor tool. Parallel mode only.",
				}),
			),
			review: Type.Optional(
				Type.Union(
					[
						Type.Boolean(),
						Type.Object({
							reviewer: Type.Optional(
								Type.String({
									description: "Reviewer agent recipe id (default: the builder's agent as a read-only reviewer).",
								}),
							),
							max_cycles: Type.Optional(
								Type.Number({
									description: "Max review/revise cycles before the gate needs an operator decision (default 2, max 4).",
								}),
							),
							node: Type.Optional(Type.String({ description: "Fleet node pin for the reviewer." })),
							model: Type.Optional(Type.String({ description: "Model override for the reviewer." })),
							target: Type.Optional(Type.String({ description: "Target override for the reviewer." })),
						}),
					],
					{
						description:
							"Reviewer gate for a single task: the builder runs, a read-only reviewer verdicts pass/revise/fail against the workspace, and revise re-runs the builder with the findings.",
					},
				),
			),
			candidates: Type.Optional(Type.Number({ description: "Compete candidates 2..4 (mode=compete only, default 2)." })),
			judge: Type.Optional(
				Type.Object(
					{
						agent: Type.Optional(Type.String({ description: "Judge agent recipe id (default: the builder's agent)." })),
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
						branch: Type.String({ description: "Preserved winner branch: clio/compete/<group>/<n>." }),
						cwd: Type.Optional(Type.String({ description: "Repository root (default: current directory)." })),
					},
					{
						description:
							"Apply a preserved compete winner: merges its branch and cleans up the compete group. Supervised autonomy parks this call so the operator confirms the winner.",
					},
				),
			),
			agent: Type.Optional(
				Type.String({
					description: "Default agent recipe for string tasks, or auto for bounded agent selection (default coder).",
				}),
			),
			briefing: Type.Optional(
				Type.String({
					description: `Separate bounded parent context/data for task, or the shared default for tasks; never worker instructions and never a task replacement. Max ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes.`,
				}),
			),
			persona: Type.Optional(
				Type.String({ description: "Default ad-hoc specialist persona for dispatched tasks, max 8000 chars." }),
			),
			tool_profile: Type.Optional(StringEnum(TOOL_PROFILE_NAMES, { description: "Default worker tool profile." })),
			budget: Type.Optional(DispatchBudgetSchema),
			target: Type.Optional(Type.String({ description: "Default configured target id (omit for fleet default)." })),
			model: Type.Optional(Type.String({ description: "Default model override." })),
			node: Type.Optional(
				Type.String({ description: "Default fleet node pin: local or a fleet.nodes id (omit for automatic placement)." }),
			),
			routing: Type.Optional(
				Type.Object(
					{
						posture: Type.Optional(StringEnum(["manual", "quality", "balanced", "latency", "economy"] as const)),
						maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
						deadlineMs: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
						minimumQuality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
						requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
						locality: Type.Optional(StringEnum(["local-only", "prefer-local", "any"] as const)),
						failover: Type.Optional(StringEnum(["none", "approved"] as const)),
					},
					{
						additionalProperties: false,
						description: "Advisory posture plus hard routing bounds. Exact target/model/node pins remain manual.",
					},
				),
			),
			thinking_level: Type.Optional(StringEnum(THINKING_LEVELS)),
			cwd: Type.Optional(Type.String({ description: "Default agent working directory." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Abort the dispatch after this many ms." })),
			max_output_bytes: Type.Optional(Type.Number({ description: "Max summary bytes returned." })),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		prepareAdmissionArguments: admission.prepareAdmissionArguments,
		disposeAdmissionArguments: admission.disposeAdmissionArguments,
		prepareArguments: admission.prepareArguments,
		describeDispatchPlan: admission.describeDispatchPlan,
		async run(rawArgs, options) {
			const args = admission.prepareArguments(rawArgs);
			const preparationError = args[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT];
			if (typeof preparationError === "string") return admissionFailureResult(preparationError);
			let runner: DispatchRunnerModule;
			try {
				runner = await loadRunner();
			} catch (error) {
				return {
					kind: "error",
					message:
						incompleteInstallationAdvice(error) ??
						`dispatch: implementation unavailable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			return runner.runDispatchTool(deps, admission.state, args, options);
		},
	};
}
