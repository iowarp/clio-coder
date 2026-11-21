import { resolve } from "node:path";
import { incompleteInstallationAdvice } from "../core/incomplete-installation.js";
import { canonicalizeExistingPath } from "../core/path-canonical.js";
import { ToolNames } from "../core/tool-names.js";
import { DISPATCH_JOB_TABLE_TEXT } from "../domains/agents/dispatch-jobs.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { councilJudgeAgentId, gateDeciderAgentId, reviewDeciderAgentId } from "../domains/dispatch/execution-role.js";
import { requestedWriteNone } from "../domains/dispatch/obligation.js";
import { canonicalWriteRoots } from "../domains/dispatch/writer-set.js";
import type { ToolCallDispatchRole, ToolCallDispatchTask, ToolCallLanding } from "../domains/middleware/index.js";
import { createDispatchAdmissionController } from "./dispatch-admission.js";
import type { ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "./dispatch-plan.js";
import { createDispatchRunEventRegistry } from "./dispatch-run-events.js";
import { buildDispatchParameters, FULL_DISPATCH_SCHEMA_COMPOSITION } from "./dispatch-schema.js";
import type { DispatchExecutionSnapshot, DispatchToolDeps } from "./dispatch-types.js";
import type { ToolResult, ToolSpec } from "./registry.js";

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

function landingCwd(cwd: string | undefined): string {
	return canonicalizeExistingPath(resolve(process.cwd(), cwd ?? "."));
}

/**
 * A worker the request names, read-only when the request says so or when its
 * recipe is a read-only class, the same rule admission applies when it builds
 * the worker. The parser never sets request.readOnly for a read-only recipe,
 * so reading the request alone told a hook every scout or oracle could write.
 * A read-only worker lands with no write roots, since admission binds none.
 */
function writerLanding(
	request: DispatchRequest,
	role: ToolCallDispatchRole,
	worktree: boolean,
	capabilityClassOf: (agentId: string) => string | null,
): ToolCallDispatchTask {
	// The envelope's one definition of read-only, over what is known before admission resolves the envelope.
	const readOnly = requestedWriteNone({
		readOnly: request.readOnly,
		capabilityClass: capabilityClassOf(request.agentId),
		hoareContract: false,
	});
	return {
		role,
		agent: request.agentId,
		cwd: landingCwd(request.cwd),
		writeRoots: readOnly ? [] : [...(request.writeRoots ?? request.intent?.writeRoots ?? [])],
		writeBoundaries: readOnly ? [] : canonicalWriteRoots(request),
		worktree,
		readOnly,
	};
}

/** A gate worker the runner builds read-only from the base request, with no write roots of its own. */
function readerLanding(role: ToolCallDispatchRole, agent: string, cwd: string | undefined): ToolCallDispatchTask {
	return { role, agent, cwd: landingCwd(cwd), writeRoots: [], writeBoundaries: [], worktree: false, readOnly: true };
}

/**
 * A dispatch call's workers as admission parsed and sealed them, for the
 * awaited hook phase: every role the runner will start, so a hook judges the
 * agents, directories and write boundaries that will be used instead of
 * re-parsing the model's arguments. A sealed plan's agent for a role wins,
 * as it does when the runner pins the role's request to it.
 */
function dispatchHookLanding(
	snapshot: DispatchExecutionSnapshot | undefined,
	plan: ResolvedDispatchPlanArtifact | undefined,
	capabilityClassOf: (agentId: string) => string | null,
	hasAgent: (agentId: string) => boolean,
): ToolCallLanding | null {
	if (snapshot === undefined) return null;
	if (snapshot.kind === "list") return { dispatch: { kind: "list" } };
	if (snapshot.kind === "apply-winner")
		return { dispatch: { kind: "apply-winner", branch: snapshot.branch, cwd: snapshot.cwd } };
	const planned = (role: string, position?: number): string | undefined =>
		plan?.tasks.find((task) => task.role === role && (position === undefined || task.position === position))?.agent;
	const base = snapshot.requests[0];
	const tasks: ToolCallDispatchTask[] = [];
	if (base !== undefined && snapshot.review !== undefined) {
		tasks.push(writerLanding(base, "builder", base.worktree === true, capabilityClassOf));
		tasks.push(
			readerLanding("reviewer", planned("reviewer") ?? reviewDeciderAgentId(snapshot.review.reviewer, hasAgent), base.cwd),
		);
	} else if (base !== undefined && snapshot.compete !== undefined) {
		// Each candidate runs in a scratch worktree the host creates for it.
		tasks.push(writerLanding(base, "candidate", true, capabilityClassOf));
		tasks.push(readerLanding("judge", planned("judge") ?? gateDeciderAgentId(snapshot.compete.judge?.agent), base.cwd));
	} else if (base !== undefined && snapshot.council !== undefined) {
		const council = snapshot.council;
		council.members.forEach((_member, index) => {
			tasks.push(readerLanding("member", planned("member", index + 1) ?? base.agentId, base.cwd));
		});
		// The synthesis judge's request names no cwd, so it runs where the host does.
		if (council.synthesis === "judge")
			tasks.push(
				readerLanding(
					"synthesis",
					planned("synthesis") ?? councilJudgeAgentId(council.judge?.agent, base.agentId),
					undefined,
				),
			);
	} else {
		for (const request of snapshot.requests)
			tasks.push(writerLanding(request, "task", request.worktree === true, capabilityClassOf));
	}
	return {
		dispatch: {
			kind: "tasks",
			mode: snapshot.mode,
			tasks,
			...(snapshot.compete !== undefined ? { candidates: snapshot.compete.candidates } : {}),
		},
	};
}

function admissionFailureResult(message: string) {
	return {
		kind: "error" as const,
		message: message.startsWith("dispatch: ") ? message : `dispatch: plan admission failed: ${message}`,
	};
}

/**
 * Hands each outside read-root approval the dispatched task that reads the root, matched by root in the
 * order the runner asks, so the card shows that task instead of the operator's last message (CLI-P35).
 */
function withReadRootTasks(deps: DispatchToolDeps, snapshot: DispatchExecutionSnapshot | undefined): DispatchToolDeps {
	const approve = deps.approveExternalRead;
	if (approve === undefined || snapshot?.kind !== "dispatch") return deps;
	const count = snapshot.requests.length + (snapshot.rejectedTasks?.length ?? 0);
	const pending = snapshot.requests.flatMap((request, index) =>
		request.externalReadRoot === undefined
			? []
			: [{ root: request.externalReadRoot, text: request.task, position: snapshot.positions?.[index] ?? index + 1 }],
	);
	if (pending.length === 0) return deps;
	return {
		...deps,
		approveExternalRead: (root, options, task) => {
			const at = pending.findIndex((entry) => entry.root === root);
			const [entry] = at === -1 ? [] : pending.splice(at, 1);
			const served = task ?? (entry === undefined ? undefined : { text: entry.text, position: entry.position, count });
			return approve(root, options, served);
		},
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
		// The job table leads as the selection cue; detailed coordination and
		// evidence discipline live in the role prompt.
		description: `${DISPATCH_JOB_TABLE_TEXT} Delegate work to Clio workers; configured profiles select their models. task sends one assignment; tasks sends a batch and leaves task empty. Waits for run results unless detach:true, which returns ids to collect with monitor before synthesis. Declare intent on every dispatch. The host commits task worktrees; workers edit and report even when the task says 'and commit'. expected_outputs are repository-relative file paths such as src/duration.js, never commit, prose, or '.'.`,
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
		rewriteNarrows: admission.rewriteNarrows,
		describeHookLanding: (args) =>
			dispatchHookLanding(
				admission.state.trustedExecutionSnapshots.get(args),
				admission.state.trustedResolvedPlans.get(args),
				(agentId) => deps.getAgentSpecs().find((spec) => spec.id === agentId)?.capabilityClass ?? null,
				(agentId) => deps.getAgentSpecs().some((spec) => spec.id === agentId),
			),
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
			const snapshot = admission.state.trustedExecutionSnapshots.get(args);
			const result = await runner.runDispatchTool(withReadRootTasks(deps, snapshot), admission.state, args, options);
			const notices = snapshot?.kind === "dispatch" ? (snapshot.notices ?? []) : [];
			const noted: ToolResult =
				notices.length === 0
					? result
					: result.kind === "ok"
						? { ...result, output: `${notices.join("\n")}\n\n${result.output}` }
						: { ...result, message: `${notices.join("\n")}\n\n${result.message}` };
			const rejected = snapshot?.kind === "dispatch" ? snapshot.rejectedTasks : undefined;
			if (rejected === undefined || rejected.length === 0) return noted;
			const failures = rejected.map((task) => `task ${task.position} rejected: ${task.message}`).join("\n");
			return {
				kind: "error",
				message: `${failures}\n\n${noted.kind === "ok" ? noted.output : noted.message}`,
				details: {
					...noted.details,
					rejectedTasks: [
						...structuredClone(rejected),
						...(Array.isArray(result.details?.rejectedTasks) ? result.details.rejectedTasks : []),
					],
				},
			};
		},
	};
}
