import { BusChannels } from "../core/bus-events.js";
import type { WorkerRosters } from "../core/defaults.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { getTerminationCoordinator } from "../core/termination.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { WorkerContextSnapshot } from "../domains/context/worker/contract.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { AgentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import { DEFAULT_KILL_GRACE_MS, DEFAULT_TEARDOWN_BOUND_MS } from "../domains/gateway/mcp/index.js";
import type { PanesOperations } from "../domains/mux/operations.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import { builtin, toolPromptHintsForNames } from "./builtin-tool-catalog.js";
import type { CompeteMuxWorktrees } from "./compete-worktrees.js";
import { assertRegisteredBuiltinTools, type CoreToolBootstrapDeps, registerCoreTools } from "./core-bootstrap.js";
import { createDispatchRunEventRegistry, createDispatchTool } from "./dispatch.js";
import type { DispatchBackgroundRegistry } from "./dispatch-background.js";
import type { DispatchSchemaComposition } from "./dispatch-schema.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "./gateway/index.js";
import { registerHarnessExtensionTools } from "./harness-extensions.js";
import { lazyTool } from "./lazy-tool.js";
import { monitorToolSurface } from "./monitor-surface.js";
import { panesToolSurface } from "./panes-surface.js";
import type { ToolRegistry } from "./registry.js";
import { steerToolSurface } from "./steer-surface.js";

export { toolPromptHintsForNames };

export interface ToolBootstrapDeps extends Omit<CoreToolBootstrapDeps, "mcpCapabilities"> {
	captureWorkerContext?: () => WorkerContextSnapshot | null;
	dispatch?: DispatchContract;
	bus?: SafeEventBus;
	termination?: Pick<ReturnType<typeof getTerminationCoordinator>, "onTerminate">;
	getAgentCatalog?: () => string;
	getAgentSpecs?: () => ReadonlyArray<AgentSpec>;
	getAgentRoleFacts?: AgentRoleFactsResolver;
	getAutonomy?: () => AutonomyLevel;
	getCostCeilingUsd?: () => number;
	getWorkerRosters?: () => WorkerRosters;
	/** Which optional `dispatch` schema blocks this session advertises; absent means every block. */
	getDispatchSchemaComposition?: () => DispatchSchemaComposition;
	dispatchBackground?: DispatchBackgroundRegistry;
	/** Live decision board snapshot; dispatch seals its active refs onto every request. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/** Optional herdr worktree lifecycle for compete candidates. */
	competeMuxWorktrees?: CompeteMuxWorktrees;
	/**
	 * Pane operations. Present only when a pane host answered detection, which
	 * is what keeps the `panes` tool out of the prompt on a machine with none.
	 */
	panes?: PanesOperations;
	/**
	 * Local MCP servers for the gateway. Absent means one is built for the
	 * session cwd; `false` registers none (a registry that must never launch a
	 * child process, such as a test's).
	 */
	mcpCapabilities?: McpCapabilitySource | false;
}

export interface ToolBootstrapHandle {
	/** The MCP capability source the gateway launches servers through, when one was registered. */
	mcpCapabilities: McpCapabilitySource | null;
	/** Close every launched MCP client. Idempotent; also bound to session end and shutdown on the bus. */
	close(): Promise<void>;
}

/**
 * Registers the stable core surface first, then the orchestrator-only dispatch
 * controls in their canonical order. Worker registries call registerCoreTools
 * directly so their boot graph never evaluates dispatch implementations.
 */
export function registerAllTools(registry: ToolRegistry, deps: ToolBootstrapDeps = {}): ToolBootstrapHandle {
	const cwd = deps.session?.current()?.cwd ?? process.cwd();
	const { mcpCapabilities: requestedMcp, ...coreDeps } = deps;
	const mcpCapabilities = requestedMcp === false ? null : (requestedMcp ?? createMcpCapabilitySource({ cwd, registry }));
	const registration = registerCoreTools(registry, {
		...coreDeps,
		...(mcpCapabilities ? { mcpCapabilities } : {}),
	});
	if (deps.dispatch) {
		const dispatch = deps.dispatch;
		// Display tail only. In a composed process the dispatch domain writes the
		// durable journal off its own progress channel, which covers every run
		// rather than only the ones the model dispatched through this tool, so a
		// second sink here would transcribe a tool-path run twice.
		const dispatchRunEvents = createDispatchRunEventRegistry({ journal: null });
		const dispatchToolDeps = {
			dispatch,
			...(deps.captureWorkerContext ? { captureWorkerContext: deps.captureWorkerContext } : {}),
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
			...(deps.getDecisionBoard ? { getDecisionBoard: deps.getDecisionBoard } : {}),
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
	for (const diagnostic of registerHarnessExtensionTools(registry, cwd)) {
		deps.bus?.emit(BusChannels.ExtensionsLoadIssue, { message: diagnostic.message });
	}
	// Every MCP client the gateway launched closes with the session: a
	// detached server must not outlive the process that trusted it.
	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closePromise ??= Promise.resolve(mcpCapabilities?.close()).then(() => undefined);
		return closePromise;
	};
	if (mcpCapabilities) {
		deps.termination?.onTerminate(close, { timeoutMs: DEFAULT_KILL_GRACE_MS + DEFAULT_TEARDOWN_BOUND_MS + 1_000 });
	}
	if (mcpCapabilities && deps.bus) {
		deps.bus.on(BusChannels.SessionEnd, () => void close());
		deps.bus.on(BusChannels.ShutdownRequested, () => void close());
	}
	return { mcpCapabilities, close };
}
