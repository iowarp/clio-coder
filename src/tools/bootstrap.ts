import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { LoadSkillsInput } from "../domains/resources/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import { createTaskBoardStore, type TaskBoardStore } from "../domains/session/task-board.js";
import { probeWorkspace } from "../domains/session/workspace/index.js";
import { createArtifactTool } from "./artifact.js";
import { type AskUserHandler, createAskUserTool } from "./ask-user.js";
import { bashTool } from "./bash.js";
import { codeNavTool } from "./codewiki/code-nav.js";
import { createContextTool } from "./context/index.js";
import { credentialPresentTool } from "./credential-present.js";
import { createDispatchTool } from "./dispatch.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { createMonitorTool } from "./monitor.js";
import { OBSERVATION_POLICY_SLACK_BYTES, OBSERVE_SELF_CAPS } from "./observation.js";
import { assertBuiltinToolPolicy } from "./policy.js";
import { readMaxBytes, readTool } from "./read.js";
import type { ToolMetadata, ToolRegistry, ToolSourceInfo, ToolSpec } from "./registry.js";
import { gitTool } from "./safe-exec.js";
import { createSteerTool } from "./steer.js";
import { createTasksTool } from "./tasks.js";
import { verifyTool } from "./verify/index.js";
import { webFetchTool } from "./web-fetch.js";
import { writeTool } from "./write.js";

export interface ToolBootstrapDeps {
	session?: SessionContract;
	dispatch?: DispatchContract;
	bus?: SafeEventBus;
	askUser?: AskUserHandler;
	/**
	 * Shared task-board store so the tool, the turn-end nudge, and the TUI all
	 * read one board. Absent (workers, headless without a session) the tool
	 * gets a private in-memory board without ledger persistence.
	 */
	taskBoard?: TaskBoardStore;
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

// Registry-backstop caps derive from the OBSERVE self-caps in
// src/tools/observation.ts: policy cap = self cap + slack, so a tool's own
// envelope notice (with its exact continuation call) survives shaping instead
// of being cut again and replaced by a generic hint. The 16KB summary
// policies are the explicit overrides for tools whose output is inherently
// aggregate (shell, verification runs, git, dispatch receipts, web pages).
const policyCap = (selfCapBytes: number): number => selfCapBytes + OBSERVATION_POLICY_SLACK_BYTES;

const observePolicy = (selfCapBytes: number, followUpHint: string) =>
	({ kind: "bounded", maxBytes: policyCap(selfCapBytes), followUpHint }) satisfies ToolMetadata["resultSizePolicy"];

const summaryPolicy = (followUpHint: string) =>
	({ kind: "summary", maxBytes: 16_384, followUpHint }) satisfies ToolMetadata["resultSizePolicy"];

const exactMutationPolicy = {
	kind: "exact",
	maxBytes: 8_192,
	followUpHint: "Inspect the changed file or git diff for exact follow-up context.",
} satisfies ToolMetadata["resultSizePolicy"];

// Per-tool metadata, organized by plane. OBSERVE tools share the observation
// envelope, the turn budget pool, and derived policy caps; every other plane
// declares its posture explicitly.
const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = {
	// OBSERVE: read-class, parallel, envelope + shared turn budget.
	[ToolNames.Read]: {
		objective: "Read exact UTF-8 file content with line and byte bounds.",
		uiLabel: "Read",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			readMaxBytes(),
			"Use offset/limit or a narrower locate/search tool call to inspect omitted content.",
		),
		costLatency: "local_fast",
	},
	[ToolNames.Grep]: {
		objective: "Search file contents and return line-referenced matches.",
		uiLabel: "Grep",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			OBSERVE_SELF_CAPS.grepContent,
			"Refine the pattern, path, glob, context, or limit, or use mode=files, to inspect omitted matches.",
		),
		costLatency: "local_medium",
	},
	[ToolNames.Find]: {
		objective: "Find paths by glob pattern with optional mtime ordering.",
		uiLabel: "Find",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			OBSERVE_SELF_CAPS.find,
			"Refine the pattern, path, or limit to inspect omitted paths.",
		),
		costLatency: "local_medium",
	},
	[ToolNames.Ls]: {
		objective: "List directory entries.",
		uiLabel: "List",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(OBSERVE_SELF_CAPS.ls, "Raise limit or list a narrower directory."),
		costLatency: "local_fast",
	},
	[ToolNames.CodeNav]: {
		objective: "Navigate the codewiki index by symbol, path, entry points, outline, imports, or importers.",
		uiLabel: "Nav",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(OBSERVE_SELF_CAPS.codeNav, "Raise limit or use a narrower mode/query."),
		costLatency: "local_fast",
		promptHint:
			"Use code_nav for indexed code navigation (modes: symbol, path, entries, outline, deps, dependents, wiki).",
	},
	[ToolNames.Context]: {
		objective: "Return workspace, bundled-docs, or skill context.",
		uiLabel: "Context",
		retrySafety: "idempotent",
		resultSizePolicy: observePolicy(
			Math.max(OBSERVE_SELF_CAPS.contextDocs, OBSERVE_SELF_CAPS.contextSkills, OBSERVE_SELF_CAPS.contextWorkspace),
			"Use a narrower query or scope to inspect omitted content.",
		),
		costLatency: "local_fast",
		promptHint:
			'Call context with scope="skills" to list available skills; when one matches the task, suggest the operator run /skill:<name> and never load it uninvited. When the user message carries a skill request, first load that skill via context (scope="skills", name=<skill>) before doing anything else.',
	},
	[ToolNames.CredentialPresent]: {
		objective: "Check whether a credential key is present without returning its value.",
		uiLabel: "Credential",
		retrySafety: "idempotent",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 4_096,
			followUpHint: "Use the boolean result only; never ask to print the credential value.",
		},
		costLatency: "local_fast",
	},
	// MUTATE: write-class, sequential, file-mutation queue.
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
	// EXECUTE: the safe-exec spine (bash offloads its own overflow).
	[ToolNames.Bash]: {
		objective: "Execute an explicit shell command when narrower tools are insufficient.",
		uiLabel: "Shell",
		retrySafety: "unknown",
		resultSizePolicy: summaryPolicy(
			"Use a narrower command or a dedicated verification/read/search tool to inspect omitted output.",
		),
		costLatency: "local_slow",
	},
	[ToolNames.Git]: {
		objective: "Read-only git inspection: status, diff, or log.",
		uiLabel: "Git",
		retrySafety: "idempotent",
		resultSizePolicy: summaryPolicy("Limit the diff/log to one path or fewer commits."),
		costLatency: "local_fast",
	},
	[ToolNames.Verify]: {
		objective: "Run declared verification checks (scripts or frontend artifacts).",
		uiLabel: "Verify",
		retrySafety: "retry_safe",
		resultSizePolicy: summaryPolicy(
			"Rerun the check with narrower args or inspect the named failing file/test directly.",
		),
		costLatency: "local_slow",
	},
	// ORCHESTRATE: agent-class, receipts as evidence.
	[ToolNames.Tasks]: {
		objective: "Declare and track the session task board with evidence-carrying completions.",
		uiLabel: "Tasks",
		// A repeated plan/start/done lands on the same board state; a repeated
		// add duplicates a task, so the surface as a whole is not retry safe.
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 8_192,
			followUpHint: 'Call tasks with action="list" to re-read the board.',
		},
		costLatency: "local_fast",
		promptHint:
			'Before multi-step work, declare a task board: tasks action="plan" with a title and the task list. ' +
			'Mark one task active with "start" before working it, close it with "done" plus an evidence note ' +
			'(what proves it works), and use "block" with a reason instead of silently stalling.',
	},
	[ToolNames.Dispatch]: {
		objective: "Dispatch bounded tasks to configured Clio workers.",
		uiLabel: "Dispatch",
		retrySafety: "not_retry_safe",
		resultSizePolicy: summaryPolicy(
			"Use the dispatch receipt paths or ask a narrower worker follow-up for omitted output.",
		),
		costLatency: "agent",
		promptHint: "Call dispatch with list:true to see the agent fleet.",
	},
	[ToolNames.Monitor]: {
		objective: "Inspect dispatched runs: state, recent events, receipts.",
		uiLabel: "Monitor",
		retrySafety: "idempotent",
		resultSizePolicy: summaryPolicy("Use monitor(mode=receipt) or read the receipt path for full details."),
		costLatency: "local_fast",
	},
	[ToolNames.Steer]: {
		objective: "Guide or cancel a running dispatched worker.",
		uiLabel: "Steer",
		retrySafety: "not_retry_safe",
		resultSizePolicy: {
			kind: "exact",
			maxBytes: 4_096,
			followUpHint: "Use monitor(mode=status) to confirm the run state after steering.",
		},
		costLatency: "local_fast",
	},
	// RETRIEVE: network-class.
	[ToolNames.WebFetch]: {
		objective: "Fetch HTTP(S) text for explicit external research.",
		uiLabel: "Fetch",
		retrySafety: "retry_safe",
		resultSizePolicy: {
			kind: "bounded",
			maxBytes: 16_384,
			followUpHint: "Fetch a narrower URL or lower max_bytes to inspect a specific section.",
		},
		costLatency: "network",
	},
	// INTERACT: operator dialogue.
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
		promptHint:
			'Use ask_user for operator interviews, confirmations, and choices: one question per round in interview workflows, up to four tightly related questions otherwise, recommended option first. Finish with action="complete" and a compact decisions array before final prose. If cancelled, continue with defaults and do not ask again.',
	},
	// ARTIFACT: terminal writers.
	[ToolNames.Artifact]: {
		objective: "Write terminal plan/review/report documents that complete the turn.",
		uiLabel: "Artifact",
		retrySafety: "not_retry_safe",
		resultSizePolicy: exactMutationPolicy,
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
 * Registers every tool on the supplied registry, grouped by plane. The
 * context tool gains its workspace scope only when a session contract is
 * supplied; dispatch/monitor/steer register only with a dispatch contract.
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
		...builtin(lsTool, { path: "src/tools/ls.ts", scope: "core" }),
	});
	registry.register({
		...builtin(webFetchTool, { path: "src/tools/web-fetch.ts", scope: "core" }),
	});
	registry.register({
		...builtin(gitTool, { path: "src/tools/safe-exec.ts", scope: "core" }),
	});
	registry.register({
		...builtin(verifyTool, { path: "src/tools/verify/index.ts", scope: "core" }),
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
		...builtin(credentialPresentTool, { path: "src/tools/credential-present.ts", scope: "core" }),
	});
	const session = deps.session;
	registry.register({
		...builtin(
			createContextTool({
				...skillToolDeps,
				...(session
					? {
							workspace: {
								hasSession: () => session.current() !== null,
								getSnapshot: () => session.current()?.workspace ?? null,
								probeWorkspace: () => probeWorkspace(session.current()?.cwd ?? process.cwd()),
								saveSnapshot: (snap) => {
									const meta = session.current();
									if (meta) meta.workspace = snap;
								},
							},
						}
					: {}),
			}),
			{ path: "src/tools/context/index.ts", scope: "core" },
		),
	});
	registry.register({
		...builtin(createArtifactTool({ getCwd: skillToolDeps.getCwd }), { path: "src/tools/artifact.ts", scope: "core" }),
	});
	registry.register({
		...builtin(createTasksTool({ board: deps.taskBoard ?? createTaskBoardStore() }), {
			path: "src/tools/tasks.ts",
			scope: "core",
		}),
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
			...builtin(createMonitorTool({ dispatch: deps.dispatch }), {
				path: "src/tools/monitor.ts",
				scope: "core",
			}),
		});
		registry.register({
			...builtin(createSteerTool({ dispatch: deps.dispatch }), {
				path: "src/tools/steer.ts",
				scope: "core",
			}),
		});
	}

	assertBuiltinToolPolicy(registry.listAll(), {
		includeSessionTools: Boolean(session),
		includeDispatchTools: Boolean(deps.dispatch),
		includeInteractiveTools: Boolean(deps.askUser),
	});
}
