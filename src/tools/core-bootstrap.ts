import type { ContextRecalledPayload } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { RouteProvenance } from "../core/route-provenance.js";
import { ToolNames } from "../core/tool-names.js";
import type { BudgetProvider } from "../domains/context/budget/inspection.js";
import type { WorkerRecall } from "../domains/context/worker/recall.js";
import type { ReadRecallPort } from "../domains/context/working-set/reread.js";
import type { VisionSidecar } from "../domains/providers/vision-sidecar.js";
import type { LoadSkillsInput } from "../domains/resources/index.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { DecisionBoardStore } from "../domains/session/decision-board.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { createTaskBoardStore, type TaskBoardStore } from "../domains/session/task-board.js";
import type { RelevanceRanker } from "../domains/system-one/rank.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { ImageContent } from "../engine/types.js";
import type { AgentLedgerPort } from "../worker/protocol.js";
import { createArtifactTool } from "./artifact.js";
import { type AskUserHandler, createAskUserTool } from "./ask-user.js";
import { bashTool } from "./bash.js";
import { builtin, gatewayPromptHint } from "./builtin-tool-catalog.js";
import { codeNavToolSurface } from "./codewiki/code-nav-surface.js";
import { createConfigureClioTool } from "./configure-clio.js";
import { type ConsultDeps, createConsultTool } from "./consult.js";
import type { ContextSemanticDeps } from "./context/semantic.js";
import { contextToolSurface } from "./context/surface.js";
import { credentialPresentTool } from "./credential-present.js";
import { createDecideTool } from "./decide.js";
import { editTool } from "./edit.js";
import { evidenceTool } from "./evidence.js";
import { findTool } from "./find.js";
import { clioDocsToolSurface, clioLibraryToolSurface } from "./gateway/clio-context-surface.js";
import { dataToolSurface, prepareDataAdmissionArguments } from "./gateway/data-surface.js";
import { capabilityRankerFrom, createGatewayTool, type McpCapabilitySource } from "./gateway/index.js";
import { grepTool } from "./grep.js";
import { lazyTool } from "./lazy-tool.js";
import { createLedgerTool } from "./ledger.js";
import { limitationTool } from "./limitation.js";
import { lsTool } from "./ls.js";
import { networkToolsDisabled } from "./network-policy.js";
import { assertBuiltinToolPolicy } from "./policy.js";
import { createReadTool } from "./read.js";
import type { ToolRegistry } from "./registry.js";
import { runScriptToolSurface } from "./run-script.js";
import { gitTool } from "./safe-exec.js";
import { createTasksTool } from "./tasks.js";
import { verifyToolSurface } from "./verify/surface.js";
import { createVisionTool } from "./vision.js";
import { webFetchToolSurface, webReadToolSurface } from "./web-fetch-surface.js";
import { writeTool } from "./write.js";

export interface CoreToolBootstrapDeps {
	/** Host override for semantic search; the default ownership-scoped bridge stays lazy behind the live settings gate. */
	semantic?: ContextSemanticDeps;
	/** Native session accounting only. Worker registries do not inherit it. */
	getContextBudget?: BudgetProvider;
	getSettings?: () => Readonly<ClioSettings>;
	/** Live source of each active and saved route; absent where no saved layers exist. */
	getRouteProvenance?: () => RouteProvenance;
	workerRecall?: WorkerRecall;
	session?: SessionContract;
	/** Full ledger of the current session; context(scope=recall) folds it. Absent in worker registries. */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** Publishes a successful context(scope=recall) on the bus; absent where no bus is wired. */
	onContextRecalled?: (payload: ContextRecalledPayload) => void;
	/**
	 * The reread interception for the read tool: a fresh read byte-identical to
	 * an evicted read of the same path records a `reread` recall instead of a
	 * second copy. Absent in worker registries, which never fold the working set.
	 */
	readRecall?: ReadRecallPort;
	askUser?: AskUserHandler;
	getAutonomy?: () => AutonomyLevel;
	taskBoard?: TaskBoardStore;
	/** The session decision board the `decide` tool appends to; absent in worker registries, where the tool refuses. */
	decisionBoard?: DecisionBoardStore;
	userTasks?: UserTasksStore;
	agentLedger?: AgentLedgerPort;
	/**
	 * Register the ledger tool even without a port. A worker registry needs
	 * this: `attestedToolSignature` signs the names a bare worker registry
	 * produces, and the orchestrator admits `ledger` for every batch member,
	 * so a registry that dropped the tool for want of a port drifted the
	 * signature and admission refused every batch worker. The session binds its ownership-scoped board selector in registerAllTools.
	 */
	includeLedgerTools?: boolean;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
	skillMarketplace?: boolean;
	/**
	 * Ranks the skills listing by meaning through the `relevance` site. It orders
	 * the listing and never shortens it, so a worker registry that carries none
	 * simply lists in catalog order.
	 */
	rankRelevance?: RelevanceRanker;
	/** A skill the model loaded, so a ranked one can be joined to its ranking as a follow-up. */
	onSkillLoaded?: (name: string) => void;
	/**
	 * Local MCP servers the gateway may launch. The session bootstrap builds
	 * one per process; worker registries carry none, so a worker's gateway
	 * reaches builtin and extension capabilities only.
	 */
	mcpCapabilities?: McpCapabilitySource;
	/** A capability the model called through the gateway, so a ranked one can be joined to its ranking as a follow-up. */
	onCapabilityCalled?: (name: string) => void;
	/**
	 * The `consult` decision site, when it is bound at startup. Only the session
	 * passes it; without it the tool is not registered and the gateway listing,
	 * the tool signature and the prompt are unchanged.
	 */
	consult?: ConsultDeps;
	visionSidecar?: VisionSidecar;
	getRecentVisionImages?: () => ReadonlyArray<ImageContent>;
}

export interface CoreToolRegistration {
	includeNetworkTools: boolean;
	includeSessionTools: boolean;
	includeInteractiveTools: boolean;
	/** True only when a worker bound its dispatch's agent-ledger port; the session never does. */
	includeLedgerTools: boolean;
}

export function registerCoreTools(registry: ToolRegistry, deps: CoreToolBootstrapDeps = {}): CoreToolRegistration {
	const includeNetworkTools = !networkToolsDisabled();
	registry.register(builtin(evidenceTool, { path: "src/tools/evidence.ts", scope: "core" }));
	registry.register({
		...builtin(createReadTool(deps.readRecall), { path: "src/tools/read.ts", scope: "core" }),
	});
	registry.register({
		...builtin(writeTool, { path: "src/tools/write.ts", scope: "core" }),
	});
	registry.register({
		...builtin(editTool, { path: "src/tools/edit.ts", scope: "core" }),
	});
	registry.register({
		...builtin(bashTool, { path: "src/tools/bash.ts", scope: "core" }),
	});
	registry.register({
		...builtin(grepTool, { path: "src/tools/grep.ts", scope: "core" }),
	});
	registry.register({
		...builtin(findTool, { path: "src/tools/find.ts", scope: "core" }),
	});
	registry.register({
		...builtin(lsTool, { path: "src/tools/ls.ts", scope: "core" }),
	});
	if (includeNetworkTools) {
		// Both halves of the web split share one implementation module; the
		// read half never carries a method, headers, or a body.
		registry.register({
			...builtin(
				lazyTool(webReadToolSurface, async () => (await import("./web-fetch.js")).webReadTool),
				{ path: "src/tools/web-fetch.ts", scope: "core" },
			),
		});
		registry.register({
			...builtin(
				lazyTool(webFetchToolSurface, async () => (await import("./web-fetch.js")).webFetchTool),
				{ path: "src/tools/web-fetch.ts", scope: "core" },
			),
		});
	}
	registry.register({
		...builtin(gitTool, { path: "src/tools/safe-exec.ts", scope: "core" }),
	});
	registry.register({
		...builtin(
			lazyTool(verifyToolSurface, async () => (await import("./verify/index.js")).verifyTool),
			{ path: "src/tools/verify/index.ts", scope: "core" },
		),
	});
	const getWorkspaceRoot = (): string => deps.session?.current()?.cwd ?? process.cwd();
	// run_script's module exports its name as a dynamic tool name; it registers
	// under the canonical builtin so the plane table and classifier own it.
	registry.register({
		...builtin(
			lazyTool({ ...runScriptToolSurface, name: ToolNames.RunScript }, async () => ({
				...(await import("./run-script.js")).createRunScriptTool({ getWorkspaceRoot }),
				name: ToolNames.RunScript,
			})),
			{ path: "src/tools/run-script.ts", scope: "core" },
		),
	});
	registry.register({
		...builtin(
			lazyTool(
				{
					...dataToolSurface,
					prepareAdmissionArguments: (args) => prepareDataAdmissionArguments(args, getWorkspaceRoot()),
				},
				async () => (await import("./gateway/data-tool.js")).createDataTool({ getCwd: getWorkspaceRoot }),
			),
			{ path: "src/tools/gateway/data-tool.ts", scope: "core" },
		),
	});
	registry.register({
		...builtin(
			lazyTool(codeNavToolSurface, async () => (await import("./codewiki/code-nav.js")).codeNavTool),
			{ path: "src/tools/codewiki/code-nav.ts", scope: "core" },
		),
	});
	const semantic: ContextSemanticDeps = deps.semantic ?? {
		isEnabled: () => {
			// Older/worker settings snapshots do not carry this opt-in setting.
			const context = deps.getSettings?.().context as { semantic?: { enabled?: boolean } } | undefined;
			return context?.semantic?.enabled === true;
		},
		loadSearch: async () => {
			if (!semantic.isEnabled()) throw new Error("Semantic search is disabled");
			const { searchSemantic } = await import("../domains/semantic-app/index.js");
			return (request, context) => {
				if (!semantic.isEnabled()) throw new Error("Semantic search is disabled");
				const { query, ...filters } = request;
				const settings = deps.getSettings?.();
				return searchSemantic(
					{ projectRoot: context.cwd, ...(settings ? { settings } : {}) },
					query,
					filters,
					context.signal,
				);
			};
		},
	};
	const skillToolDeps = {
		semantic,
		...(deps.getContextBudget ? { getContextBudget: deps.getContextBudget } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.getRouteProvenance ? { getRouteProvenance: deps.getRouteProvenance } : {}),
		...(deps.workerRecall ? { workerRecall: deps.workerRecall } : {}),
		getCwd: () => deps.session?.current()?.cwd ?? process.cwd(),
		...(deps.getSkillLoaderOptions ? { getSkillLoaderOptions: deps.getSkillLoaderOptions } : {}),
		...(deps.skillMarketplace !== undefined ? { skillMarketplace: deps.skillMarketplace } : {}),
		...(deps.rankRelevance ? { rankRelevance: deps.rankRelevance } : {}),
		...(deps.onSkillLoaded ? { onSkillLoaded: deps.onSkillLoaded } : {}),
	};
	if (deps.askUser) {
		registry.register({
			...builtin(createAskUserTool({ askUser: deps.askUser }), {
				path: "src/tools/ask-user.ts",
				scope: "core",
			}),
		});
		registry.register({
			...builtin(
				createConfigureClioTool({ askUser: deps.askUser, ...(deps.getAutonomy ? { getAutonomy: deps.getAutonomy } : {}) }),
				{
					path: "src/tools/configure-clio.ts",
					scope: "core",
				},
			),
		});
	}
	registry.register({
		...builtin(credentialPresentTool, { path: "src/tools/credential-present.ts", scope: "core" }),
	});
	registry.register({
		...builtin(limitationTool, { path: "src/tools/limitation.ts", scope: "core" }),
	});
	registry.register({
		...builtin(createDecideTool(deps.decisionBoard ? { decisionBoard: deps.decisionBoard } : {}), {
			path: "src/tools/decide.ts",
			scope: "core",
		}),
	});
	const session = deps.session;
	const readSessionEntries = deps.readSessionEntries;
	registry.register({
		...builtin(
			lazyTool(contextToolSurface, async () => {
				const { createContextTool } = await import("./context/index.js");
				if (!session) return createContextTool(skillToolDeps);
				const { probeWorkspace } = await import("../domains/session/workspace/index.js");
				return createContextTool({
					...skillToolDeps,
					...(readSessionEntries
						? {
								session: {
									hasSession: () => session.current() !== null,
									readEntries: readSessionEntries,
									activeLeafTurnId: () => {
										const meta = session.current();
										return meta ? (session.tree(meta.id).leafId ?? undefined) : undefined;
									},
									cwd: () => session.current()?.cwd ?? null,
									appendEntry: (entry) => session.appendEntry(entry),
									...(deps.onContextRecalled ? { onRecalled: deps.onContextRecalled } : {}),
								},
							}
						: {}),
					workspace: {
						hasSession: () => session.current() !== null,
						getSnapshot: () => session.current()?.workspace ?? null,
						probeWorkspace: () => probeWorkspace(session.current()?.cwd ?? process.cwd()),
						saveSnapshot: (snap) => {
							const meta = session.current();
							if (meta) meta.workspace = snap;
						},
					},
				});
			}),
			{ path: "src/tools/context/index.ts", scope: "core" },
		),
	});
	registry.register({
		...builtin(createArtifactTool({ getCwd: skillToolDeps.getCwd }), { path: "src/tools/artifact.ts", scope: "core" }),
	});
	// The two Clio-internal reads that left the context schema, under their
	// own names behind the gateway; same scope functions, same worker refusal.
	registry.register({
		...builtin(
			lazyTool(clioDocsToolSurface, async () => (await import("./gateway/clio-context-tools.js")).createClioDocsTool()),
			{ path: "src/tools/gateway/clio-context-tools.ts", scope: "core" },
		),
	});
	registry.register({
		...builtin(
			lazyTool(clioLibraryToolSurface, async () =>
				(await import("./gateway/clio-context-tools.js")).createClioLibraryTool({
					getCwd: skillToolDeps.getCwd,
					...(deps.skillMarketplace !== undefined ? { skillMarketplace: deps.skillMarketplace } : {}),
					...(deps.getSkillLoaderOptions ? { getSkillLoaderOptions: deps.getSkillLoaderOptions } : {}),
				}),
			),
			{ path: "src/tools/gateway/clio-context-tools.ts", scope: "core" },
		),
	});
	if (deps.consult) {
		registry.register(builtin(createConsultTool(deps.consult), { path: "src/tools/consult.ts", scope: "core" }));
	}
	if (deps.visionSidecar) {
		registry.register(
			builtin(
				createVisionTool(
					deps.visionSidecar,
					deps.getRecentVisionImages ? { getRecentImages: deps.getRecentVisionImages } : {},
				),
				{ path: "src/tools/vision.ts", scope: "core" },
			),
		);
	}
	// The gateway itself: direct, one fixed schema, reaching every
	// gateway-placed spec above through the registry's own admission.
	const gateway = builtin(
		createGatewayTool({
			registry,
			...(deps.mcpCapabilities ? { mcp: deps.mcpCapabilities } : {}),
			...(deps.rankRelevance ? { rankCapabilities: capabilityRankerFrom(deps.rankRelevance) } : {}),
			...(deps.onCapabilityCalled ? { onCapabilityCalled: deps.onCapabilityCalled } : {}),
		}),
		{
			path: "src/tools/gateway/index.ts",
			scope: "core",
		},
	);
	registry.register(
		(deps.consult || deps.visionSidecar) && gateway.metadata
			? {
					...gateway,
					metadata: {
						...gateway.metadata,
						promptHint: gatewayPromptHint(Boolean(deps.consult), Boolean(deps.visionSidecar)),
					},
				}
			: gateway,
	);
	// The coordination board exists only inside a dispatch: a worker process
	// binds the port; registerAllTools supplies the session selector separately.
	// Without either, the tool can only answer "no ledger";
	// a worker registry asks for it explicitly, port or no port, because its
	// attested surface must not depend on whether this run bound one.
	const includeLedgerTools = deps.includeLedgerTools === true || deps.agentLedger !== undefined;
	if (includeLedgerTools) {
		registry.register({
			...builtin(createLedgerTool(deps.agentLedger ? { agentLedger: deps.agentLedger } : {}), {
				path: "src/tools/ledger.ts",
				scope: "core",
			}),
		});
	}
	registry.register({
		...builtin(
			createTasksTool({
				board: deps.taskBoard ?? createTaskBoardStore(),
				...(deps.userTasks ? { userTasks: deps.userTasks } : {}),
				getSessionId: () => deps.session?.current()?.id ?? null,
			}),
			{
				path: "src/tools/tasks.ts",
				scope: "core",
			},
		),
	});
	return {
		includeNetworkTools,
		includeSessionTools: Boolean(session),
		includeInteractiveTools: Boolean(deps.askUser),
		includeLedgerTools,
	};
}

export function assertRegisteredBuiltinTools(
	registry: ToolRegistry,
	registration: CoreToolRegistration,
	includeDispatchTools: boolean,
	includePanesTools = false,
): void {
	assertBuiltinToolPolicy(registry.listAll(), { ...registration, includeDispatchTools, includePanesTools });
}
