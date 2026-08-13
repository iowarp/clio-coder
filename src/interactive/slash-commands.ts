import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { ContextInitOptions } from "../domains/context/init-options.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { type AgentRoleFactsResolver, requestExecutionRole } from "../domains/dispatch/execution-role.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import type { InstalledExtension } from "../domains/extensions/index.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import { resolveModelReference } from "../domains/providers/index.js";
import type { PromptTemplate, ResourceList } from "../domains/resources/index.js";
import { parseSkillCommand } from "../domains/resources/index.js";
import type { ShareImportPlan } from "../domains/share/index.js";
import { isToolProfileName, TOOL_PROFILE_NAMES, type ToolProfileName } from "../tools/profiles.js";
import type { NoticeLevel } from "./command-output.js";
import type { CommandArgsSpec, CommandPositionalSpec, ParsedArgs } from "./slash-spec.js";
import { matchFromSpec, usageLine } from "./slash-spec.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 */

type ShareCommandVariant =
	| { kind: "share"; action: "export"; path: string }
	| { kind: "share"; action: "import"; path: string; dryRun: boolean; force: boolean }
	| { kind: "share"; action: "usage"; subcommand?: "export" | "import"; error?: string };

type SlashCommandVariant =
	| { kind: "quit" }
	| { kind: "help"; query?: string }
	| { kind: "init"; options: InitCommandOptions }
	| { kind: "context-clear"; options: ContextClearCommandOptions }
	| { kind: "context-refresh" }
	| { kind: "skill-selector" }
	| { kind: "skill-invocation"; text: string }
	| { kind: "prompts" }
	| { kind: "extensions" }
	| ShareCommandVariant
	| { kind: "run"; agentId: string; task: string; options: RunCommandOptions }
	| { kind: "run-usage" }
	| { kind: "delegate"; agentId: string; task: string }
	| { kind: "delegate-usage" }
	| { kind: "agents" }
	| { kind: "providers" }
	| { kind: "cost" }
	| { kind: "context-view" }
	| { kind: "fleet" }
	| { kind: "tasks" }
	| { kind: "memory" }
	| { kind: "memory-seed" }
	| { kind: "view"; filter?: string }
	| { kind: "view-verify"; runId: string }
	| { kind: "view-usage" }
	| { kind: "thinking" }
	| { kind: "thinking-set"; level: string }
	| { kind: "output"; verbosity?: "minimal" | "default" | "verbose" }
	| { kind: "model" }
	| { kind: "model-set"; pattern: string }
	| { kind: "scoped-models" }
	| { kind: "settings" }
	| { kind: "resume" }
	| { kind: "new" }
	| { kind: "tree" }
	| { kind: "fork" }
	| { kind: "compact"; instructions: string | undefined }
	| { kind: "export"; path: string | undefined }
	| { kind: "unknown"; text: string }
	| { kind: "unknown-command"; token: string }
	| { kind: "usage-error"; command: string; reason: string }
	| { kind: "empty" };

export type SlashCommand = SlashCommandVariant;

export type SlashCommandKind = SlashCommand["kind"];

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

export type SetThinkingLevelResult =
	| { status: "applied"; level: string; display: string }
	| { status: "unsupported"; level: string; supported: ReadonlyArray<string> }
	| { status: "unavailable" };

export type TaskMemorySeedCommandResult =
	| { status: "seeded"; seeded: number; skipped: number; source: string }
	| { status: "disabled" }
	| { status: "not-found" };

export type InitCommandOptions = ContextInitOptions;

export interface ContextClearCommandOptions {
	all?: boolean;
	confirmed?: boolean;
	confirmedAll?: boolean;
}

export interface RunCommandOptions {
	workerProfile?: string;
	workerRuntime?: string;
	target?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	toolProfile?: ToolProfileName;
	requiredCapabilities?: string[];
}

export interface HandleRunDeps {
	dispatch: DispatchContract;
	/** Strict recipe facts the run's execution role is derived from. */
	getAgentRoleFacts?: AgentRoleFactsResolver;
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	/**
	 * Optional bus for forwarding per-event worker output. When supplied,
	 * every non-heartbeat event is re-emitted on `BusChannels.DispatchProgress`
	 * so UI surfaces (dispatch-board overlay) can update their row as the
	 * stream arrives instead of waiting for the terminal receipt.
	 */
	bus?: SafeEventBus;
}

/**
 * Dispatches /run through the dispatch contract and streams events to stdout.
 * Target + model are resolved by the dispatch domain from request overrides,
 * worker profiles, recipe hints, and `settings.workers.default`.
 */
export async function handleRun(
	agentId: string,
	task: string,
	deps: HandleRunDeps,
	options: RunCommandOptions = {},
): Promise<void> {
	const { dispatch, notice, bus } = deps;
	const progressBus = dispatch.ownsProgressBus?.(bus) === true ? undefined : bus;
	if (options.target && options.workerProfile) {
		notice("warn", `--target ${options.target} takes precedence; --worker ${options.workerProfile} will be ignored`);
	}
	if (options.target && options.workerRuntime) {
		notice("warn", `--target ${options.target} takes precedence; --runtime ${options.workerRuntime} will be ignored`);
	}
	try {
		const request = {
			agentId,
			task,
			executionRole: requestExecutionRole({
				agentId,
				...(deps.getAgentRoleFacts ? { resolveFacts: deps.getAgentRoleFacts } : {}),
			}),
			requestOrigin: "user" as const,
			...(options.workerProfile ? { workerProfile: options.workerProfile } : {}),
			...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
			...(options.target ? { target: options.target } : {}),
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options.toolProfile ? { toolProfile: options.toolProfile } : {}),
			...(options.requiredCapabilities && options.requiredCapabilities.length > 0
				? { requiredCapabilities: options.requiredCapabilities }
				: {}),
		};
		const handle = await dispatch.dispatch(request);
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			progressBus?.emit(BusChannels.DispatchProgress, {
				runId: handle.runId,
				agentId,
				event,
			});
		}
		const receipt = await handle.finalPromise;
		if (receipt.exitCode !== 0 || receipt.failureMessage) {
			const failure = receipt.failureMessage ? ` ${receipt.failureMessage}` : "";
			notice("error", `run failed: exit=${receipt.exitCode}${failure}`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		notice("error", `run failed: ${msg}`);
	}
}

async function handleDelegate(agentId: string, task: string, deps: HandleRunDeps): Promise<void> {
	const { dispatch, notice, bus } = deps;
	const progressBus = dispatch.ownsProgressBus?.(bus) === true ? undefined : bus;
	try {
		const handle = await dispatch.dispatch({
			agentId,
			delegationAgentId: agentId,
			executionRole: "builder",
			requestOrigin: "user",
			task,
		});
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			progressBus?.emit(BusChannels.DispatchProgress, {
				runId: handle.runId,
				agentId,
				event,
			});
		}
		const receipt = await handle.finalPromise;
		if (receipt.exitCode !== 0 || receipt.failureMessage) {
			const failure = receipt.failureMessage ? ` ${receipt.failureMessage}` : "";
			notice("error", `delegate failed: exit=${receipt.exitCode}${failure}`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		notice("error", `delegate failed: ${msg}`);
	}
}

/**
 * Runtime dependencies every slash-command handler may need. Every field is
 * injected at startInteractive construction time; handlers never reach into
 * the TUI, chat loop, or overlay module graph directly.
 */
export interface SlashCommandContext {
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	dispatch: DispatchContract;
	bus: SafeEventBus;
	/** Strict recipe facts used to keep interactive /run role-equivalent with the CLI. */
	getAgentRoleFacts?: AgentRoleFactsResolver;
	/** Fire-and-forget shutdown. Handler must not await. */
	shutdown: () => void;
	runInit: (options: InitCommandOptions) => void;
	/** Write the current session transcript (all tool segments expanded, ANSI-stripped) to a Markdown file. */
	exportTranscript: (path?: string) => void;
	runContextClear: (options: ContextClearCommandOptions) => void;
	/**
	 * Re-index the codewiki and refresh `.clio` state without touching CLIO.md.
	 * Optional until the host wires onContextRefresh.
	 */
	runContextRefresh?: () => void;
	openSkillsHub?: () => void;
	listPrompts: () => ResourceList<PromptTemplate>;
	listExtensions?: () => ReadonlyArray<InstalledExtension>;
	listAgents: () => ReadonlyArray<AgentSpec>;
	listDelegationAgents: () => ReadonlyArray<{
		id: string;
		command: string;
		args: ReadonlyArray<string>;
		toolGovernance?: string;
		labels?: Record<string, string>;
	}>;
	exportShareArchive?: (outPath: string) => { fileCount: number; path: string };
	importShareArchive?: (path: string, options: { dryRun?: boolean; force?: boolean }) => ShareImportPlan;
	openProviders: () => void;
	openCost: () => void;
	/** Open the read-only `/context` overlay: categorized context-window ledger. */
	openContextView: () => void;
	/** Open `/fleet`: running workers plus worker profile and agent-binding settings. */
	openFleet: () => void;
	/** Open the read-only `/tasks` overlay: the session task board with receipts. */
	openTasks: () => void;
	/** Open the read-only `/memory` overlay: approved lessons and the live task bank. */
	openMemory: () => void;
	/** Opt-in import from the newest structured handoff; absent when the host has no task bank. */
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	/** Open `/view`, the full observability artifact viewer. */
	openView: (filter?: string) => void;
	openThinking: () => void;
	/**
	 * Apply a thinking level named on the command line. Returns why it was
	 * refused so the caller can say so, because the level the operator typed may
	 * not be one the active target supports.
	 */
	setThinkingLevel?: (level: string) => SetThinkingLevelResult;
	setOutputVerbosity?: (verbosity?: "minimal" | "default" | "verbose") => void;
	openModel: () => void;
	/** Live providers contract used by `/model <pattern>` to resolve directly. */
	providers: ProvidersContract;
	/** Apply a resolved model reference to settings (and optionally thinking level). */
	applyModelRef: (ref: ResolvedModelRef) => void;
	openScopedModels: () => void;
	openSettings: () => void;
	openResume: () => void;
	startNewSession: () => void;
	openTree: () => void;
	openMessagePicker: () => void;
	openHelp: (query?: string) => void;
	openAgents: () => void;
	openPrompts: () => void;
	openExtensions: () => void;
	setEditorText?: (text: string) => void;
	/**
	 * Run compaction for the current session. Handler resolves the target
	 * model, reads session entries, calls session/compaction/compact, and
	 * appends a compactionSummary entry. No-op when no session is open, so the
	 * handler prints an actionable stderr line instead.
	 */
	runCompact: (instructions: string | undefined) => void;
	/**
	 * Escape hatch for the `view verify` entry: verify a receipt file on disk
	 * and emit a single status line. Kept on the context so the registry does
	 * not import the overlay module.
	 */
	verifyReceipt: (runId: string) => ReceiptIntegrityResult;
	/**
	 * Handles the "unknown" case: append the text to the chat panel as a user
	 * turn, submit to the chat loop, and schedule a re-render. Handlers for
	 * {kind:"unknown"} defer to this so the chat-panel reference stays scoped
	 * to startInteractive.
	 */
	submitChat: (text: string) => void;
	/** Re-render request; wraps tui.requestRender so handlers do not import TUI. */
	render: () => void;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	aliases?: ReadonlyArray<string>;
	/**
	 * Argument text an alias stands in for, prepended to whatever the operator
	 * typed after it. `/compact` names a subcommand of `/context`, not the
	 * command itself, so it cannot be spelled as a bare alias.
	 */
	aliasArgs?: Readonly<Record<string, string>>;
	/** Excluded from /help, autocomplete, and the docs command table. */
	hidden?: boolean;
	args?: CommandArgsSpec;
	/** Stable copy shown beside first-token subcommand completions. */
	subcommandDescriptions?: Readonly<Record<string, string>>;
	/** The set of SlashCommand kinds this entry is responsible for dispatching. */
	kinds: ReadonlyArray<SlashCommandKind>;
	/** Return the parsed SlashCommand for `trimmed` or null if this entry does not match. */
	match?(trimmed: string): SlashCommand | null;
	fromArgs?(parsed: ParsedArgs, trimmed: string): SlashCommand;
	/** Execute `command` against `ctx`. Called only for kinds declared in `kinds`. */
	handle(command: SlashCommand, ctx: SlashCommandContext): void;
}

const RUN_THINKING_LEVELS: ReadonlyArray<JobThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function isRunThinkingLevel(value: string): value is JobThinkingLevel {
	return RUN_THINKING_LEVELS.some((level) => level === value);
}

/** `/context compact` alone keeps a free-form optional instruction tail. */
const COMPACT_POSITIONALS: ReadonlyArray<CommandPositionalSpec> = [
	{ name: "instructions", required: false, rest: true },
];

/**
 * A registered command whose arguments do not parse is a mistake to report,
 * not a chat message to send. Falling through to `unknown` submitted the raw
 * text to the model, which then answered it conversationally while the
 * operator believed a setting had changed and nothing had. `unknown` stays
 * reserved for input that matched no command at all, so pasted text beginning
 * with a slash still reaches the model.
 */
function fromArgsOrUsage(name: string, command: SlashCommand): (parsed: ParsedArgs) => SlashCommand {
	return (parsed) => (parsed.error ? { kind: "usage-error", command: name, reason: parsed.error } : command);
}

function usageNotice(entry: BuiltinSlashCommand, subcommand?: string): string {
	return usageLine(entry, subcommand).trim();
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "quit",
		description: "Exit Clio Coder",
		aliases: ["exit"],
		kinds: ["quit"],
		args: {},
		fromArgs: fromArgsOrUsage("quit", { kind: "quit" }),
		handle(_command, ctx) {
			ctx.shutdown();
		},
	},
	{
		name: "help",
		description: "Open the interactive help center showing commands and keys",
		kinds: ["help"],
		args: {
			positionals: [{ name: "query", required: false, rest: true }],
		},
		fromArgs(parsed) {
			return { kind: "help", ...(parsed.rest ? { query: parsed.rest } : {}) };
		},
		handle(command, ctx) {
			ctx.openHelp(command.kind === "help" ? command.query : undefined);
		},
	},
	{
		name: "skill",
		description: "Open the Skills Hub or invoke a skill",
		aliases: ["skill:", "skills:"],
		kinds: ["skill-selector", "skill-invocation"],
		args: {
			positionals: [
				{ name: "name", required: false },
				{ name: "task", required: false, rest: true },
			],
		},
		match(trimmed) {
			if (trimmed === "/skill" || trimmed === "/skill:" || trimmed === "/skills:") {
				return { kind: "skill-selector" };
			}
			const command = parseSkillCommand(trimmed);
			if (command) {
				return { kind: "skill-invocation", text: trimmed };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind === "skill-selector") {
				ctx.openSkillsHub?.();
			} else if (command.kind === "skill-invocation") {
				ctx.submitChat(command.text);
			}
		},
	},
	{
		name: "prompts",
		description: "List prompt templates",
		kinds: ["prompts"],
		args: {},
		fromArgs: fromArgsOrUsage("prompts", { kind: "prompts" }),
		handle(_command, ctx) {
			ctx.openPrompts();
		},
	},
	{
		name: "extensions",
		description: "List installed extensions",
		kinds: ["extensions"],
		args: {},
		fromArgs: fromArgsOrUsage("extensions", { kind: "extensions" }),
		handle(_command, ctx) {
			ctx.openExtensions?.();
		},
	},
	{
		name: "share",
		description: "Export or import Clio archives",
		kinds: ["share"],
		args: {
			subcommands: {
				export: {
					positionals: [{ name: "path", required: true }],
				},
				import: {
					flags: [{ name: "--dry-run" }, { name: "--force" }],
					positionals: [{ name: "path", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			const subcommand = parsed.subcommand === "export" || parsed.subcommand === "import" ? parsed.subcommand : undefined;
			if (parsed.error) {
				return {
					kind: "share",
					action: "usage",
					...(subcommand !== undefined ? { subcommand } : {}),
					error: parsed.error,
				};
			}
			const path = parsed.positionals[0];
			if (subcommand === "export" && path !== undefined) return { kind: "share", action: "export", path };
			if (subcommand === "import" && path !== undefined) {
				return {
					kind: "share",
					action: "import",
					path,
					dryRun: parsed.flags.has("--dry-run"),
					force: parsed.flags.has("--force"),
				};
			}
			return { kind: "share", action: "usage", ...(subcommand !== undefined ? { subcommand } : {}) };
		},
		handle(command, ctx) {
			if (command.kind !== "share") return;
			if (command.action === "usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "share");
				if (!entry) return;
				const usage = usageNotice(entry, command.subcommand);
				ctx.notice("info", command.error ? `${command.error}\n${usage}` : usage);
				return;
			}
			if (command.action === "export") {
				if (!ctx.exportShareArchive) {
					ctx.notice("error", "share export is not wired");
					return;
				}
				const result = ctx.exportShareArchive(command.path);
				ctx.notice("success", `exported ${result.fileCount} item(s) to ${result.path}`);
				return;
			}
			if (command.action === "import") {
				if (!ctx.importShareArchive) {
					ctx.notice("error", "share import is not wired");
					return;
				}
				const plan = ctx.importShareArchive(command.path, { dryRun: command.dryRun, force: command.force });
				for (const diag of plan.diagnostics) {
					const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
					ctx.notice("warn", `${diag.type}: ${detail}`);
				}
				const write = plan.actions.filter((action) => action.action === "write").length;
				const overwrite = plan.actions.filter((action) => action.action === "overwrite").length;
				const skip = plan.actions.filter((action) => action.action === "skip").length;
				ctx.notice(
					command.dryRun ? "info" : "success",
					`${command.dryRun ? "dry-run" : "import"} write=${write} overwrite=${overwrite} skip=${skip} settings=${plan.actions.filter((action) => action.action === "settings").length}`,
				);
			}
		},
	},
	{
		name: "run",
		description: "Run a fleet agent",
		kinds: ["run", "run-usage"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--agent-profile", aliases: ["--worker-profile", "--worker"], takesValue: true, valueName: "profile" },
				{ name: "--runtime", aliases: ["--agent-runtime", "--worker-runtime"], takesValue: true, valueName: "runtimeId" },
				{ name: "--target", takesValue: true, valueName: "id" },
				{ name: "--model", takesValue: true, valueName: "id" },
				{ name: "--thinking", takesValue: true, values: RUN_THINKING_LEVELS, valueName: "level" },
				{ name: "--tool-profile", takesValue: true, values: TOOL_PROFILE_NAMES },
				{ name: "--require", takesValue: true, repeatable: true, valueName: "cap" },
			],
			positionals: [
				{ name: "agent", required: true },
				{ name: "task", required: true, rest: true },
			],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "run-usage" };
			const options: RunCommandOptions = {};

			const workerProfile = parsed.flags.get("--agent-profile");
			if (typeof workerProfile === "string") options.workerProfile = workerProfile;

			const workerRuntime = parsed.flags.get("--runtime");
			if (typeof workerRuntime === "string") options.workerRuntime = workerRuntime;

			const target = parsed.flags.get("--target");
			if (typeof target === "string") options.target = target;

			const model = parsed.flags.get("--model");
			if (typeof model === "string") options.model = model;

			const thinking = parsed.flags.get("--thinking");
			if (typeof thinking === "string") {
				if (!isRunThinkingLevel(thinking)) return { kind: "run-usage" };
				options.thinkingLevel = thinking;
			}

			const toolProfile = parsed.flags.get("--tool-profile");
			if (typeof toolProfile === "string") {
				if (!isToolProfileName(toolProfile)) return { kind: "run-usage" };
				options.toolProfile = toolProfile;
			}

			const requiredCapabilities = parsed.flagValues.get("--require");
			if (requiredCapabilities && requiredCapabilities.length > 0) {
				options.requiredCapabilities = [...requiredCapabilities];
			}

			const agentId = parsed.positionals[0] ?? "";
			const task = parsed.positionals[1] ?? "";

			return { kind: "run", agentId, task, options };
		},
		handle(command, ctx) {
			if (command.kind === "run-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "run");
				if (entry) {
					ctx.notice("info", usageNotice(entry));
				}
				return;
			}
			if (command.kind !== "run") return;
			const { agentId, task, options } = command;
			void (async () => {
				await handleRun(
					agentId,
					task,
					{
						dispatch: ctx.dispatch,
						...(ctx.getAgentRoleFacts ? { getAgentRoleFacts: ctx.getAgentRoleFacts } : {}),
						io: ctx.io,
						notice: ctx.notice,
						bus: ctx.bus,
					},
					options,
				);
				ctx.render();
			})();
		},
	},
	{
		name: "delegate",
		description: "Run an ACP delegation agent",
		kinds: ["delegate", "delegate-usage"],
		args: {
			positionals: [
				{ name: "agent-id", required: true },
				{ name: "task", required: true, rest: true },
			],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "delegate-usage" };
			const agentId = parsed.positionals[0] ?? "";
			const task = parsed.positionals[1] ?? "";
			return { kind: "delegate", agentId, task };
		},
		handle(command, ctx) {
			if (command.kind === "delegate-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "delegate");
				if (entry) {
					ctx.notice("info", usageNotice(entry));
				}
				return;
			}
			if (command.kind !== "delegate") return;
			void (async () => {
				await handleDelegate(command.agentId, command.task, {
					dispatch: ctx.dispatch,
					io: ctx.io,
					notice: ctx.notice,
					bus: ctx.bus,
				});
				ctx.render();
			})();
		},
	},
	{
		name: "agents",
		description: "List Clio agents and ACP delegation agents",
		kinds: ["agents"],
		args: {},
		fromArgs: fromArgsOrUsage("agents", { kind: "agents" }),
		handle(_command, ctx) {
			ctx.openAgents();
		},
	},
	{
		name: "targets",
		description: "Show target hub for health, auth, models, and actions",
		kinds: ["providers"],
		args: {},
		fromArgs: fromArgsOrUsage("targets", { kind: "providers" }),
		handle(_command, ctx) {
			ctx.openProviders();
		},
	},
	{
		name: "cost",
		description: "Show session token and cost totals",
		kinds: ["cost"],
		args: {},
		fromArgs: fromArgsOrUsage("cost", { kind: "cost" }),
		handle(_command, ctx) {
			ctx.openCost();
		},
	},
	{
		name: "context",
		description: "Context hub: window overlay plus compact, init, refresh, and reset",
		aliases: ["ctx", "compact"],
		aliasArgs: { compact: "compact" },
		kinds: ["context-view", "compact", "init", "context-clear", "context-refresh"],
		subcommandDescriptions: {
			compact: "Compact session context",
			init: "Initialize project context",
			refresh: "Refresh project context",
			reset: "Reset project context",
		},
		args: {
			subcommands: {
				compact: { positionals: [...COMPACT_POSITIONALS] },
				init: {},
				refresh: {},
				reset: {},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "context", reason: parsed.error };
			switch (parsed.subcommand) {
				case "compact":
					return { kind: "compact", instructions: parsed.rest };
				case "init":
					return { kind: "init", options: {} };
				case "refresh":
					return { kind: "context-refresh" };
				case "reset":
					return { kind: "context-clear", options: {} };
				default:
					return { kind: "context-view" };
			}
		},
		handle(command, ctx) {
			switch (command.kind) {
				case "context-view":
					ctx.openContextView();
					return;
				case "compact":
					ctx.runCompact(command.instructions);
					return;
				case "init":
					ctx.runInit(command.options);
					return;
				case "context-clear":
					ctx.runContextClear(command.options);
					return;
				case "context-refresh":
					if (ctx.runContextRefresh) {
						ctx.runContextRefresh();
					} else {
						ctx.notice("error", "context refresh is not wired; pass onContextRefresh to startInteractive");
					}
					return;
				default:
					return;
			}
		},
	},
	{
		name: "fleet",
		description: "Show in-process dispatch running/retry status",
		kinds: ["fleet"],
		args: {},
		fromArgs: fromArgsOrUsage("fleet", { kind: "fleet" }),
		handle(_command, ctx) {
			ctx.openFleet();
		},
	},
	{
		name: "tasks",
		description: "Show the session task board the agent tracks with the tasks tool",
		kinds: ["tasks"],
		args: {},
		fromArgs: fromArgsOrUsage("tasks", { kind: "tasks" }),
		handle(_command, ctx) {
			ctx.openTasks();
		},
	},
	{
		name: "memory",
		description: "Inspect task memory or seed it from the newest handoff",
		kinds: ["memory", "memory-seed"],
		subcommandDescriptions: { seed: "Seed the task bank from the newest handoff" },
		args: { subcommands: { seed: {} } },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "memory", reason: parsed.error };
			return parsed.subcommand === "seed" ? { kind: "memory-seed" } : { kind: "memory" };
		},
		handle(command, ctx) {
			if (command.kind === "memory") {
				ctx.openMemory();
				return;
			}
			if (command.kind !== "memory-seed") return;
			const result = ctx.seedTaskMemory?.() ?? { status: "not-found" as const };
			switch (result.status) {
				case "seeded":
					ctx.notice(
						"success",
						`task memory seeded ${result.seeded} entr${result.seeded === 1 ? "y" : "ies"} from ${result.source}${result.skipped > 0 ? `; skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}` : ""}`,
					);
					return;
				case "disabled":
					ctx.notice("warn", "task memory is disabled; enable memory.intervention before seeding");
					return;
				case "not-found":
					ctx.notice("info", "no structured task-memory snapshot found in the newest handoff");
			}
		},
	},
	{
		name: "view",
		description: "Browse session artifacts and verify receipts",
		kinds: ["view", "view-verify", "view-usage"],
		args: {
			positionals: [{ name: "filter", required: false, rest: true }],
			subcommands: {
				verify: {
					positionals: [{ name: "runId", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "view-usage" };
			if (parsed.subcommand === "verify") {
				const runId = parsed.positionals[0] ?? "";
				return { kind: "view-verify", runId };
			}
			return parsed.rest ? { kind: "view", filter: parsed.rest } : { kind: "view" };
		},
		handle(command, ctx) {
			const entry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "view");
			if (!entry) return;
			if (command.kind === "view") {
				ctx.openView(command.filter);
				return;
			}
			if (command.kind === "view-usage") {
				ctx.notice("info", usageNotice(entry, "verify"));
				return;
			}
			if (command.kind !== "view-verify") return;
			const result = ctx.verifyReceipt(command.runId);
			if (result.ok) {
				ctx.notice("success", `verify ok ${command.runId}`);
			} else {
				ctx.notice("error", `verify fail ${command.runId} ${result.reason}`);
			}
		},
	},
	{
		name: "thinking",
		description: "Open thinking-level selector, or set a level directly",
		kinds: ["thinking", "thinking-set"],
		args: { positionals: [{ name: "level", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "thinking", reason: parsed.error };
			const level = parsed.positionals[0];
			return level ? { kind: "thinking-set", level } : { kind: "thinking" };
		},
		handle(command, ctx) {
			if (command.kind === "thinking") {
				ctx.openThinking();
				return;
			}
			if (command.kind !== "thinking-set") return;
			const result = ctx.setThinkingLevel?.(command.level) ?? { status: "unavailable" as const };
			if (result.status === "applied") {
				ctx.notice("success", `thinking: ${result.display}`);
			} else if (result.status === "unsupported") {
				ctx.notice("error", `thinking level "${result.level}" is not available here; try ${result.supported.join(", ")}`);
			} else {
				ctx.notice("error", "thinking level cannot be set right now");
			}
			ctx.render();
		},
	},
	{
		name: "output",
		description: "Set transcript detail: minimal, default, or verbose",
		kinds: ["output"],
		args: { positionals: [{ name: "verbosity", required: false }] },
		fromArgs(parsed) {
			const value = parsed.positionals[0];
			return { kind: "output", ...(value ? { verbosity: value as "minimal" | "default" | "verbose" } : {}) };
		},
		handle(command, ctx) {
			if (command.kind !== "output") return;
			ctx.setOutputVerbosity?.(command.verbosity);
		},
	},
	{
		name: "model",
		description: "Open model selector or set a model",
		aliases: ["models"],
		kinds: ["model", "model-set"],
		args: {
			positionals: [{ name: "pattern", required: false, rest: true }],
		},
		fromArgs(parsed) {
			const pattern = parsed.positionals[0];
			if (pattern) {
				return { kind: "model-set", pattern };
			}
			return { kind: "model" };
		},
		handle(command, ctx) {
			if (command.kind === "model") {
				ctx.openModel();
				return;
			}
			if (command.kind !== "model-set") return;
			void (async () => {
				try {
					await ctx.providers.probeAllLive();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.notice("warn", `model refresh failed; resolving cached catalog: ${msg}`);
				}
				const result = resolveModelReference(command.pattern, ctx.providers);
				if (!result.ref) {
					ctx.notice("error", result.error ?? `no match for "${command.pattern}"`);
					ctx.render();
					return;
				}
				if (result.warning) ctx.notice("warn", result.warning);
				ctx.applyModelRef(result.ref);
				const suffix = result.ref.thinkingLevel ? ` thinking=${result.ref.thinkingLevel}` : "";
				ctx.notice("success", `active: ${result.ref.target}/${result.ref.model}${suffix}`);
				ctx.render();
			})();
		},
	},
	{
		name: "scoped-models",
		description: "Edit the Alt+J / Alt+K model cycle set",
		kinds: ["scoped-models"],
		args: {},
		fromArgs: fromArgsOrUsage("scoped-models", { kind: "scoped-models" }),
		handle(_command, ctx) {
			ctx.openScopedModels();
		},
	},
	{
		name: "settings",
		description: "Open interactive settings",
		aliases: ["config"],
		kinds: ["settings"],
		args: {},
		fromArgs: fromArgsOrUsage("settings", { kind: "settings" }),
		handle(_command, ctx) {
			ctx.openSettings();
		},
	},
	{
		name: "resume",
		description: "Resume a past session",
		kinds: ["resume"],
		args: {},
		fromArgs: fromArgsOrUsage("resume", { kind: "resume" }),
		handle(_command, ctx) {
			ctx.openResume();
		},
	},
	{
		name: "new",
		description: "Start a fresh session",
		kinds: ["new"],
		args: {},
		fromArgs: fromArgsOrUsage("new", { kind: "new" }),
		handle(_command, ctx) {
			ctx.startNewSession();
		},
	},
	{
		name: "tree",
		description: "Open session tree navigator",
		kinds: ["tree"],
		args: {},
		fromArgs: fromArgsOrUsage("tree", { kind: "tree" }),
		handle(_command, ctx) {
			ctx.openTree();
		},
	},
	{
		name: "fork",
		description: "Fork from an assistant turn",
		kinds: ["fork"],
		args: {},
		fromArgs: fromArgsOrUsage("fork", { kind: "fork" }),
		handle(_command, ctx) {
			ctx.openMessagePicker();
		},
	},
	{
		name: "export",
		description: "Export the session transcript to Markdown",
		kinds: ["export"],
		args: {
			positionals: [{ name: "path", required: false }],
		},
		fromArgs(parsed) {
			return { kind: "export", path: parsed.positionals[0] };
		},
		handle(command, ctx) {
			if (command.kind !== "export") return;
			ctx.exportTranscript(command.path);
		},
	},
];

const HANDLER_BY_KIND = new Map<SlashCommandKind, BuiltinSlashCommand>();
const COMMAND_TERM_OWNER = new Map<string, string>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
	for (const term of [entry.name, ...(entry.aliases ?? [])]) {
		const owner = COMMAND_TERM_OWNER.get(term);
		if (owner) {
			throw new Error(`BUILTIN_SLASH_COMMANDS: command term "${term}" is owned by both "${owner}" and "${entry.name}"`);
		}
		COMMAND_TERM_OWNER.set(term, entry.name);
	}
	for (const kind of entry.kinds) {
		if (HANDLER_BY_KIND.has(kind)) {
			throw new Error(`BUILTIN_SLASH_COMMANDS: kind "${kind}" is owned by multiple entries`);
		}
		HANDLER_BY_KIND.set(kind, entry);
	}
}

/**
 * A token that could only have been meant as a command: one word of letters,
 * digits, and hyphens after the leading slash.
 *
 * A spelling that names no command used to match nothing and fall through to
 * the model as prose. Measured: `/compact` was answered "/compact (completed)"
 * in six output tokens while context stayed at 9%, no compaction summary was
 * written, and no hook fired. The operator read a completion that never
 * happened, which is the same failure `/thinking off` had. Only active commands
 * run, so anything command-shaped that the registry does not claim fails here
 * rather than being answered by a model that will invent a result.
 *
 * The shape test is what keeps that from swallowing ordinary text, because a
 * leading slash is also how an absolute path starts. `/home/akougkas/notes` and
 * `/not/a/command` carry a separator, so they are not one word and still reach
 * the model unchanged.
 *
 * One word followed by prose stays ambiguous: `/compact tidy up` is the defect
 * and `/tmp is full` is a sentence, and nothing in the text separates them. It
 * resolves as a command, so a sentence that has to open this way needs
 * COMMAND_ESCAPE.
 */
const COMMAND_SHAPED_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/u;

/**
 * Prefix that sends a command-shaped line to the model as text.
 *
 * This used to be a leading space, guarded by testing the raw input rather than
 * the trimmed one. No operator could ever reach it: the terminal engine trims
 * the submitted line inside its own submit path, so the parser only ever sees
 * text with the whitespace already gone. Typing ` /tmp is full` in the TUI
 * failed with "/tmp is not a command" exactly like the unescaped spelling, and
 * a contract test asserted the unreachable branch.
 *
 * A backslash survives the trim. It claims one character and only in front of a
 * slash, so `\\server\share` and `\note to self` are still ordinary text.
 */
const COMMAND_ESCAPE = "\\/";

/** Pure slash-command parser: no I/O, no side effects. Walks the registry in order. */
export function parseSlashCommand(input: string): SlashCommand {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (trimmed.startsWith(COMMAND_ESCAPE)) return { kind: "unknown", text: trimmed.slice(1) };
	for (const entry of BUILTIN_SLASH_COMMANDS) {
		const match = entry.match ? entry.match(trimmed) : matchFromSpec(entry, trimmed);
		if (match) return match;
	}
	if (trimmed.startsWith("/")) {
		const token = trimmed.slice(1).split(/\s+/u)[0] ?? "";
		if (COMMAND_SHAPED_TOKEN.test(token)) return { kind: "unknown-command", token };
	}
	return { kind: "unknown", text: trimmed };
}

/**
 * Dispatches a parsed SlashCommand to its owning registry entry. `empty` is a
 * no-op and `unknown` falls through to chat submission; every other kind
 * resolves to exactly one registry entry at module load.
 */
export function dispatchSlashCommand(command: SlashCommand, ctx: SlashCommandContext): void {
	if (command.kind === "empty") return;
	if (command.kind === "unknown") {
		ctx.submitChat(command.text);
		return;
	}
	if (command.kind === "unknown-command") {
		ctx.notice("error", `/${command.token} is not a command. Type /help for the list.`);
		ctx.render();
		return;
	}
	if (command.kind === "usage-error") {
		const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === command.command);
		const usage = entry ? ` ${usageNotice(entry)}` : "";
		ctx.notice("error", `${command.reason}.${usage}`);
		ctx.render();
		return;
	}
	const entry = HANDLER_BY_KIND.get(command.kind);
	if (!entry) return;
	entry.handle(command, ctx);
}

export interface CommandReferenceEntry {
	name: string;
	aliases: ReadonlyArray<string>;
	/** Argument text each alias in `aliases` stands in for, when it stands for any. */
	aliasArgs?: Readonly<Record<string, string>>;
	usage: string;
	description: string;
	/** The command's args grammar, carried through for argument autocomplete. */
	args?: CommandArgsSpec;
	/** Stable copy shown beside first-token subcommand completions. */
	subcommandDescriptions?: Readonly<Record<string, string>>;
}

export function commandReference(): ReadonlyArray<CommandReferenceEntry> {
	return BUILTIN_SLASH_COMMANDS.filter((entry) => entry.hidden !== true).map((entry) => {
		const usage = usageLine(entry)
			.replace(/^\nusage:\s*/, "")
			.replace(/\n$/, "");
		return {
			name: entry.name,
			aliases: entry.aliases ?? [],
			...(entry.aliasArgs ? { aliasArgs: entry.aliasArgs } : {}),
			usage,
			description: entry.description,
			...(entry.args ? { args: entry.args } : {}),
			...(entry.subcommandDescriptions ? { subcommandDescriptions: entry.subcommandDescriptions } : {}),
		};
	});
}
