import { incompleteInstallationAdvice } from "../core/incomplete-installation.js";
import { ToolNames } from "../core/tool-names.js";
import { createDispatchAdmissionController } from "./dispatch-admission.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "./dispatch-plan.js";
import { createDispatchRunEventRegistry } from "./dispatch-run-events.js";
import { buildDispatchParameters, FULL_DISPATCH_SCHEMA_COMPOSITION } from "./dispatch-schema.js";
import type { DispatchToolDeps } from "./dispatch-types.js";
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
		// Keep the selection cue beside the schema; detailed coordination and
		// evidence discipline live in the role prompt.
		description:
			"Delegate work to Clio helpers. Configured profiles select worker models. task dispatches one assignment, tasks a batch, never both. context selects isolated (default), fork (native only), or splice inheritance. briefing adds parent evidence. Auto-waits for receipts; detach:true returns ids to collect with monitor. Declare intent on every dispatch. The host commits task worktrees; workers edit files and report, even when the task says 'and commit'. expected_outputs are repository-relative file paths such as src/duration.js, never commit, prose, or '.'.",
		// Composed once per session: council, compete, and adaptive-routing fields
		// are advertised only when the fleet can exercise them (see dispatch-schema.ts).
		parameters: buildDispatchParameters(deps.getSchemaComposition?.() ?? FULL_DISPATCH_SCHEMA_COMPOSITION),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		prepareAdmissionArguments: admission.prepareAdmissionArguments,
		disposeAdmissionArguments: admission.disposeAdmissionArguments,
		prepareArguments: admission.prepareArguments,
		describeDispatchPlan: admission.describeDispatchPlan,
		hostEffectCalls: admission.hostEffectCalls,
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
