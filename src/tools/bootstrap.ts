import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { LoadSkillsInput } from "../domains/resources/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import { probeWorkspace } from "../domains/session/workspace/index.js";
import { type AskUserHandler, createAskUserTool } from "./ask-user.js";
import { bashTool } from "./bash.js";
import { codeNavTool } from "./codewiki/code-nav.js";
import { createDispatchBatchTool, createDispatchTool } from "./dispatch.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { assertBuiltinToolPolicy } from "./policy.js";
import { readTool } from "./read.js";
import type { ToolMetadata, ToolRegistry, ToolSourceInfo, ToolSpec } from "./registry.js";
import { gitTool, runTaskTool } from "./safe-exec.js";
import { createReadSkillTool, createSkillTool } from "./skills.js";
import { validateFrontendTool } from "./validate-frontend.js";
import { webFetchTool } from "./web-fetch.js";
import { workspaceContextTool } from "./workspace-context.js";
import { writeTool } from "./write.js";
import { writePlanTool } from "./write-plan.js";
import { writeReviewTool } from "./write-review.js";

export interface ToolBootstrapDeps {
	session?: SessionContract;
	dispatch?: DispatchContract;
	bus?: SafeEventBus;
	askUser?: AskUserHandler;
	/** Agent fleet catalog renderer for the dispatch tool's list action. */
	getAgentCatalog?: () => string;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
}

function withSourceInfo<T extends ToolSpec>(spec: T, sourceInfo: ToolSourceInfo): T {
	return { ...spec, sourceInfo };
}

function withMetadata<T extends ToolSpec>(spec: T, metadata: ToolMetadata): T {
	return { ...spec, metadata };
}

const boundedReadPolicy = {
	kind: "bounded",
	maxBytes: 60_000,
	followUpHint: "Use offset/limit or a narrower locate/search tool call to inspect omitted content.",
} satisfies ToolMetadata["resultSizePolicy"];

const boundedSearchPolicy = {
	kind: "bounded",
	maxBytes: 60_000,
	followUpHint: "Refine the pattern, path, glob, context, or limit to inspect omitted matches.",
} satisfies ToolMetadata["resultSizePolicy"];

const boundedValidationPolicy = {
	kind: "summary",
	maxBytes: 80_000,
	followUpHint: "Rerun the validation with a narrower script or inspect the named failing file/test directly.",
} satisfies ToolMetadata["resultSizePolicy"];

const exactMutationPolicy = {
	kind: "exact",
	maxBytes: 60_000,
	followUpHint: "Inspect the changed file or git diff for exact follow-up context.",
} satisfies ToolMetadata["resultSizePolicy"];

const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = {
	[ToolNames.Read]: {
		objective: "Read exact UTF-8 file content with line and byte bounds.",
		uiLabel: "Read",
		retrySafety: "idempotent",
		resultSizePolicy: boundedReadPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.Write]: {
		objective: "Write a complete UTF-8 file.",
		uiLabel: "Write",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.Edit]: {
		objective: "Apply exact text replacements to one file.",
		uiLabel: "Edit",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.Bash]: {
		objective: "Execute an explicit shell command when narrower tools are insufficient.",
		uiLabel: "Shell",
		retrySafety: "unknown",
		resultSizePolicy: {
			kind: "summary",
			maxBytes: 80_000,
			followUpHint: "Use a narrower command or a dedicated validation/read/search tool to inspect omitted output.",
		},
		costLatency: "local_slow",
	},
	[ToolNames.Grep]: {
		objective: "Search file contents and return line-referenced matches.",
		uiLabel: "Grep",
		retrySafety: "idempotent",
		resultSizePolicy: boundedSearchPolicy,
		costLatency: "local_medium",
	},
	[ToolNames.Find]: {
		objective: "Find paths by glob-like file pattern.",
		uiLabel: "Find",
		retrySafety: "idempotent",
		resultSizePolicy: boundedSearchPolicy,
		costLatency: "local_medium",
	},
	[ToolNames.Glob]: {
		objective: "Find paths by glob pattern with recency ordering.",
		uiLabel: "Glob",
		retrySafety: "idempotent",
		resultSizePolicy: boundedSearchPolicy,
		costLatency: "local_medium",
	},
	[ToolNames.Ls]: {
		objective: "List directory entries.",
		uiLabel: "List",
		retrySafety: "idempotent",
		resultSizePolicy: boundedSearchPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.WebFetch]: {
		objective: "Fetch HTTP(S) text for explicit external research.",
		uiLabel: "Fetch",
		retrySafety: "retry_safe",
		resultSizePolicy: {
			kind: "bounded",
			maxBytes: 80_000,
			followUpHint: "Fetch a narrower URL or lower max_bytes to inspect a specific section.",
		},
		costLatency: "network",
	},
	[ToolNames.Git]: {
		objective: "Read-only git inspection: status, diff, or log.",
		uiLabel: "Git",
		retrySafety: "idempotent",
		resultSizePolicy: boundedSearchPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.RunTask]: {
		objective: "Run one allowlisted package.json validation script.",
		uiLabel: "Task",
		retrySafety: "retry_safe",
		resultSizePolicy: boundedValidationPolicy,
		costLatency: "local_slow",
	},
	[ToolNames.ValidateFrontend]: {
		objective: "Validate frontend artifacts without shell access.",
		uiLabel: "Frontend",
		retrySafety: "retry_safe",
		resultSizePolicy: boundedValidationPolicy,
		costLatency: "local_slow",
	},
	[ToolNames.WritePlan]: {
		objective: "Write a terminal plan artifact.",
		uiLabel: "Plan",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.WriteReview]: {
		objective: "Write a terminal review artifact.",
		uiLabel: "Review",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.CodeNav]: {
		objective: "Navigate the codewiki TypeScript index by symbol, path, or entry points.",
		uiLabel: "Nav",
		retrySafety: "idempotent",
		resultSizePolicy: boundedSearchPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.ReadSkill]: {
		objective: "Read an available coding skill body.",
		uiLabel: "Skill",
		retrySafety: "idempotent",
		resultSizePolicy: boundedReadPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.AskUser]: {
		objective: "Ask the operator structured questions.",
		uiLabel: "Ask",
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 20_000,
			followUpHint: "Proceed with stated assumptions if the operator cancels or no UI is available.",
		},
		costLatency: "local_slow",
	},
	[ToolNames.CreateSkill]: {
		objective: "Create a reusable coding skill file.",
		uiLabel: "Create Skill",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
		costLatency: "local_fast",
	},
	[ToolNames.Dispatch]: {
		objective: "Dispatch a bounded task to a configured Clio worker.",
		uiLabel: "Dispatch",
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "summary",
			maxBytes: 80_000,
			followUpHint: "Use the dispatch receipt path or ask a narrower worker follow-up for omitted output.",
		},
		costLatency: "agent",
	},
	[ToolNames.DispatchBatch]: {
		objective: "Dispatch several bounded tasks to configured Clio workers as one grouped batch.",
		uiLabel: "Dispatch Batch",
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "summary",
			maxBytes: 80_000,
			followUpHint: "Use the batch run ids or receipts for omitted worker details.",
		},
		costLatency: "agent",
	},
	[ToolNames.WorkspaceContext]: {
		objective: "Return structured workspace/git/project facts.",
		uiLabel: "Workspace",
		retrySafety: "idempotent",
		resultSizePolicy: boundedReadPolicy,
		costLatency: "local_fast",
	},
};

function withBuiltinMetadata<T extends ToolSpec>(spec: T): T {
	const metadata = TOOL_METADATA[spec.name];
	return metadata ? withMetadata(spec, metadata) : spec;
}

function builtin<T extends ToolSpec>(spec: T, sourceInfo: ToolSourceInfo): T {
	return withBuiltinMetadata(withSourceInfo(spec, sourceInfo));
}

/**
 * Registers every tool on the supplied registry. The `workspace_context` tool
 * registers only when a session contract is supplied; workers skip it.
 */
export function registerAllTools(registry: ToolRegistry, deps: ToolBootstrapDeps = {}): void {
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
		...builtin(globTool, { path: "src/tools/glob.ts", scope: "core" }),
	});
	registry.register({
		...builtin(lsTool, { path: "src/tools/ls.ts", scope: "core" }),
	});
	registry.register({
		...builtin(webFetchTool, { path: "src/tools/web-fetch.ts", scope: "core" }),
	});
	registry.register({
		...builtin(gitTool, { path: "src/tools/safe-exec.ts", scope: "core" }),
	});
	registry.register({
		...builtin(runTaskTool, { path: "src/tools/safe-exec.ts", scope: "core" }),
	});
	registry.register({
		...builtin(validateFrontendTool, { path: "src/tools/validate-frontend.ts", scope: "core" }),
	});
	registry.register({
		...builtin(writePlanTool, { path: "src/tools/write-plan.ts", scope: "core" }),
	});
	registry.register({
		...builtin(writeReviewTool, { path: "src/tools/write-review.ts", scope: "core" }),
	});
	registry.register({
		...builtin(codeNavTool, { path: "src/tools/codewiki/code-nav.ts", scope: "core" }),
	});
	const skillToolDeps = {
		getCwd: () => deps.session?.current()?.cwd ?? process.cwd(),
		...(deps.getSkillLoaderOptions ? { getSkillLoaderOptions: deps.getSkillLoaderOptions } : {}),
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
		...builtin(createReadSkillTool(skillToolDeps), { path: "src/tools/skills.ts", scope: "core" }),
	});
	registry.register({
		...builtin(createSkillTool(skillToolDeps), { path: "src/tools/skills.ts", scope: "core" }),
	});
	if (deps.dispatch) {
		const dispatchToolDeps = {
			dispatch: deps.dispatch,
			...(deps.bus ? { bus: deps.bus } : {}),
			...(deps.getAgentCatalog ? { getAgentCatalog: deps.getAgentCatalog } : {}),
		};
		registry.register({
			...builtin(createDispatchTool(dispatchToolDeps), {
				path: "src/tools/dispatch.ts",
				scope: "core",
			}),
		});
		registry.register({
			...builtin(createDispatchBatchTool(dispatchToolDeps), {
				path: "src/tools/dispatch.ts",
				scope: "core",
			}),
		});
	}

	const session = deps.session;
	if (session) {
		registry.register({
			...withBuiltinMetadata(
				workspaceContextTool({
					hasSession: () => session.current() !== null,
					getSnapshot: () => session.current()?.workspace ?? null,
					probeWorkspace: () => probeWorkspace(session.current()?.cwd ?? process.cwd()),
					saveSnapshot: (snap) => {
						const meta = session.current();
						if (meta) meta.workspace = snap;
					},
				}),
			),
			sourceInfo: { path: "src/tools/workspace-context.ts", scope: "core" },
		});
	}

	assertBuiltinToolPolicy(registry.listAll(), {
		includeSessionTools: Boolean(session),
		includeDispatchTools: Boolean(deps.dispatch),
		includeInteractiveTools: Boolean(deps.askUser),
	});
}
