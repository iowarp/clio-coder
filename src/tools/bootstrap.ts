import type { WorkerRosters } from "../core/defaults.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { AgentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import type { PanesOperations } from "../domains/mux/operations.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { builtin, toolPromptHintsForNames } from "./builtin-tool-catalog.js";
import type { CompeteMuxWorktrees } from "./compete-worktrees.js";
import { assertRegisteredBuiltinTools, type CoreToolBootstrapDeps, registerCoreTools } from "./core-bootstrap.js";
import { createDispatchRunEventRegistry, createDispatchTool } from "./dispatch.js";
import type { DispatchBackgroundRegistry } from "./dispatch-background.js";
import type { DispatchSchemaComposition } from "./dispatch-schema.js";
import { lazyTool } from "./lazy-tool.js";
import { monitorToolSurface } from "./monitor-surface.js";
import { panesToolSurface } from "./panes-surface.js";
import type { ToolRegistry } from "./registry.js";
import { steerToolSurface } from "./steer-surface.js";

export { toolPromptHintsForNames };

export interface ToolBootstrapDeps extends CoreToolBootstrapDeps {
	dispatch?: DispatchContract;
	bus?: SafeEventBus;
	getAgentCatalog?: () => string;
	getAgentSpecs?: () => ReadonlyArray<AgentSpec>;
	getAgentRoleFacts?: AgentRoleFactsResolver;
	getAutonomy?: () => AutonomyLevel;
	getCostCeilingUsd?: () => number;
	getWorkerRosters?: () => WorkerRosters;
	/** Which optional `dispatch` schema blocks this session advertises; absent means every block. */
	getDispatchSchemaComposition?: () => DispatchSchemaComposition;
	dispatchBackground?: DispatchBackgroundRegistry;
	/** Optional herdr worktree lifecycle for compete candidates. */
	competeMuxWorktrees?: CompeteMuxWorktrees;
	/**
	 * Pane operations. Present only when a pane host answered detection, which
	 * is what keeps the `panes` tool out of the prompt on a machine with none.
	 */
	panes?: PanesOperations;
}

/**
 * Registers the stable core surface first, then the orchestrator-only dispatch
 * controls in their canonical order. Worker registries call registerCoreTools
 * directly so their boot graph never evaluates dispatch implementations.
 */
export function registerAllTools(registry: ToolRegistry, deps: ToolBootstrapDeps = {}): void {
	const registration = registerCoreTools(registry, deps);
	if (deps.dispatch) {
		const dispatch = deps.dispatch;
		// Display tail only. In a composed process the dispatch domain writes the
		// durable journal off its own progress channel, which covers every run
		// rather than only the ones the model dispatched through this tool, so a
		// second sink here would transcribe a tool-path run twice.
		const dispatchRunEvents = createDispatchRunEventRegistry({ journal: null });
		const dispatchToolDeps = {
			dispatch,
			runEvents: dispatchRunEvents,
			getAgentSpecs: deps.getAgentSpecs ?? (() => []),
			...(deps.bus ? { bus: deps.bus } : {}),
			...(deps.getAgentCatalog ? { getAgentCatalog: deps.getAgentCatalog } : {}),
			...(deps.getAgentRoleFacts ? { getAgentRoleFacts: deps.getAgentRoleFacts } : {}),
			...(deps.getAutonomy ? { getAutonomy: deps.getAutonomy } : {}),
			...(deps.getCostCeilingUsd ? { getCostCeilingUsd: deps.getCostCeilingUsd } : {}),
			...(deps.getWorkerRosters ? { getWorkerRosters: deps.getWorkerRosters } : {}),
			...(deps.getDispatchSchemaComposition ? { getSchemaComposition: deps.getDispatchSchemaComposition } : {}),
			...(deps.dispatchBackground ? { background: deps.dispatchBackground } : {}),
			...(deps.competeMuxWorktrees ? { competeWorktrees: { mux: deps.competeMuxWorktrees } } : {}),
		};
		registry.register({
			...builtin(createDispatchTool(dispatchToolDeps), {
				path: "src/tools/dispatch.ts",
				scope: "core",
			}),
		});
		registry.register({
			...builtin(
				lazyTool(monitorToolSurface, async () =>
					(await import("./monitor.js")).createMonitorTool({ dispatch, runEvents: dispatchRunEvents }),
				),
				{
					path: "src/tools/monitor.ts",
					scope: "core",
				},
			),
		});
		registry.register({
			...builtin(
				lazyTool(steerToolSurface, async () => (await import("./steer.js")).createSteerTool({ dispatch })),
				{
					path: "src/tools/steer.ts",
					scope: "core",
				},
			),
		});
	}
	if (deps.panes) {
		const panes = deps.panes;
		registry.register({
			...builtin(
				lazyTool(panesToolSurface, async () => (await import("./panes.js")).createPanesTool({ panes })),
				{ path: "src/tools/panes.ts", scope: "core" },
			),
		});
	}
	assertRegisteredBuiltinTools(registry, registration, Boolean(deps.dispatch), Boolean(deps.panes));
}
