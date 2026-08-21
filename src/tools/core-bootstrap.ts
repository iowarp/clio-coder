import type { ContextRecalledPayload } from "../core/bus-events.js";
import type { LoadSkillsInput } from "../domains/resources/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { createTaskBoardStore, type TaskBoardStore } from "../domains/session/task-board.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { AgentLedgerPort } from "../worker/protocol.js";
import { createArtifactTool } from "./artifact.js";
import { type AskUserHandler, createAskUserTool } from "./ask-user.js";
import { bashTool } from "./bash.js";
import { builtin } from "./builtin-tool-catalog.js";
import { codeNavToolSurface } from "./codewiki/code-nav-surface.js";
import { contextToolSurface } from "./context/surface.js";
import { credentialPresentTool } from "./credential-present.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lazyTool } from "./lazy-tool.js";
import { createLedgerTool } from "./ledger.js";
import { lsTool } from "./ls.js";
import { networkToolsDisabled } from "./network-policy.js";
import { assertBuiltinToolPolicy } from "./policy.js";
import { readTool } from "./read.js";
import type { ToolRegistry } from "./registry.js";
import { gitTool } from "./safe-exec.js";
import { createTasksTool } from "./tasks.js";
import { verifyToolSurface } from "./verify/surface.js";
import { webFetchToolSurface } from "./web-fetch-surface.js";
import { writeTool } from "./write.js";

export interface CoreToolBootstrapDeps {
	session?: SessionContract;
	/** Full ledger of the current session; context(scope=recall) folds it. Absent in worker registries. */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** Publishes a successful context(scope=recall) on the bus; absent where no bus is wired. */
	onContextRecalled?: (payload: ContextRecalledPayload) => void;
	askUser?: AskUserHandler;
	taskBoard?: TaskBoardStore;
	userTasks?: UserTasksStore;
	agentLedger?: AgentLedgerPort;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
	skillMarketplace?: boolean;
}

export interface CoreToolRegistration {
	includeNetworkTools: boolean;
	includeSessionTools: boolean;
	includeInteractiveTools: boolean;
}

export function registerCoreTools(registry: ToolRegistry, deps: CoreToolBootstrapDeps = {}): CoreToolRegistration {
	const includeNetworkTools = !networkToolsDisabled();
	registry.register({
		...builtin(readTool, { path: "src/tools/read.ts", scope: "core" }),
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
	registry.register({
		...builtin(
			lazyTool(codeNavToolSurface, async () => (await import("./codewiki/code-nav.js")).codeNavTool),
			{ path: "src/tools/codewiki/code-nav.ts", scope: "core" },
		),
	});
	const skillToolDeps = {
		getCwd: () => deps.session?.current()?.cwd ?? process.cwd(),
		...(deps.getSkillLoaderOptions ? { getSkillLoaderOptions: deps.getSkillLoaderOptions } : {}),
		...(deps.skillMarketplace !== undefined ? { skillMarketplace: deps.skillMarketplace } : {}),
	};
	if (deps.askUser) {
		registry.register({
			...builtin(createAskUserTool({ askUser: deps.askUser }), {
				path: "src/tools/ask-user.ts",
				scope: "core",
			}),
		});
	}
	registry.register({
		...builtin(credentialPresentTool, { path: "src/tools/credential-present.ts", scope: "core" }),
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
	registry.register({
		...builtin(createLedgerTool(deps.agentLedger ? { agentLedger: deps.agentLedger } : {}), {
			path: "src/tools/ledger.ts",
			scope: "core",
		}),
	});
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
	};
}

export function assertRegisteredBuiltinTools(
	registry: ToolRegistry,
	registration: CoreToolRegistration,
	includeDispatchTools: boolean,
): void {
	assertBuiltinToolPolicy(registry.listAll(), { ...registration, includeDispatchTools });
}
