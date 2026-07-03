import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import type { InstalledExtension } from "../domains/extensions/index.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import { resolveModelReference } from "../domains/providers/index.js";
import type { PromptTemplate, ResourceList } from "../domains/resources/index.js";
import { parseSkillCommand } from "../domains/resources/index.js";
import type { ShareImportPlan } from "../domains/share/index.js";
import { isToolProfileName, TOOL_PROFILE_NAMES, type ToolProfileName } from "../tools/profiles.js";
import type { NoticeLevel } from "./command-output.js";
import type { CommandArgsSpec, CommandFlagSpec, CommandPositionalSpec, ParsedArgs } from "./slash-spec.js";
import { matchFromSpec, usageLine } from "./slash-spec.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 */

/**
 * Present when the command was typed through a deprecated spelling. The
 * dispatcher emits one notice pointing at the replacement before routing.
 * Both fields omit the leading slash.
 */
export interface SlashDeprecation {
	from: string;
	to: string;
}

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
	| { kind: "share"; args: string }
	| { kind: "run"; agentId: string; task: string; options: RunCommandOptions }
	| { kind: "run-usage" }
	| { kind: "delegate"; agentId: string; task: string }
	| { kind: "delegate-usage" }
	| { kind: "agents" }
	| { kind: "providers" }
	| { kind: "cost" }
	| { kind: "context-view" }
	| { kind: "fleet" }
	| { kind: "view"; filter?: string }
	| { kind: "view-verify"; runId: string }
	| { kind: "view-usage" }
	| { kind: "thinking" }
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
	| { kind: "empty" };

export type SlashCommand = SlashCommandVariant & { deprecation?: SlashDeprecation };

export type SlashCommandKind = SlashCommand["kind"];

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

export interface InitCommandOptions {
	preview?: boolean;
	adopt?: boolean;
	applyClioMd?: boolean;
	proposeClioMd?: boolean;
	includeGlobalImports?: boolean;
	/** Skip model-driven exploration and use the deterministic heuristic generator. */
	heuristic?: boolean;
}

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
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	workerDefault?: { target?: string; model?: string } | undefined;
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
			bus?.emit(BusChannels.DispatchProgress, {
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

export async function handleDelegate(agentId: string, task: string, deps: HandleRunDeps): Promise<void> {
	const { dispatch, notice, bus } = deps;
	try {
		const handle = await dispatch.dispatch({
			agentId,
			delegationAgentId: agentId,
			requestOrigin: "user",
			task,
		});
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			bus?.emit(BusChannels.DispatchProgress, {
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
	/** Returns the current `workers.default` block, resolved fresh on every /run. */
	workerDefault: () => { target?: string; model?: string } | undefined;
	/** Fire-and-forget shutdown. Handler must not await. */
	shutdown: () => void;
	runInit: (options: InitCommandOptions) => void;
	/** Write the current session transcript (all tool segments expanded, ANSI-stripped) to a Markdown file. */
	exportTranscript: (path?: string) => void;
	runContextClear: (options: ContextClearCommandOptions) => void;
	/**
	 * Re-index the codewiki and restamp the CLIO.md fingerprint footer without
	 * touching handbook prose. Optional until the host wires onContextRefresh.
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
	/** Open the read-only `/fleet` overlay: running, retrying, and totals. */
	openFleet: () => void;
	/** Open `/view`, the full observability artifact viewer. */
	openView: (filter?: string) => void;
	openThinking: () => void;
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
	verifyReceipt: (runId: string) => { ok: true } | { ok: false; reason: string };
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
	 * Excluded from /help, autocomplete, and the docs command table. Used for
	 * deprecated spellings kept parseable for one release.
	 */
	hidden?: boolean;
	args?: CommandArgsSpec;
	/** The set of SlashCommand kinds this entry is responsible for dispatching. */
	kinds: ReadonlyArray<SlashCommandKind>;
	/** Return the parsed SlashCommand for `trimmed` or null if this entry does not match. */
	match?(trimmed: string): SlashCommand | null;
	fromArgs?(parsed: ParsedArgs, trimmed: string): SlashCommand;
	/** Execute `command` against `ctx`. Called only for kinds declared in `kinds`. */
	handle(command: SlashCommand, ctx: SlashCommandContext): void;
}

const RUN_THINKING_LEVELS: ReadonlyArray<JobThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isRunThinkingLevel(value: string): value is JobThinkingLevel {
	return RUN_THINKING_LEVELS.some((level) => level === value);
}

/** Flag set shared by `/context init` and the deprecated `/context-init`. */
const CONTEXT_INIT_FLAGS: ReadonlyArray<CommandFlagSpec> = [
	{ name: "--preview" },
	{ name: "--adopt" },
	{ name: "--apply", aliases: ["--rewrite"] },
	{ name: "--propose" },
	{ name: "--global", aliases: ["--include-global"] },
	{ name: "--heuristic", aliases: ["--no-generate"] },
];

/** Flag set shared by `/context reset` and the deprecated `/context-clear`. */
const CONTEXT_RESET_FLAGS: ReadonlyArray<CommandFlagSpec> = [
	{ name: "--all" },
	{ name: "--confirm" },
	{ name: "--confirm-all" },
];

/** Positional shape shared by `/context compact` and the deprecated `/compact`. */
const COMPACT_POSITIONALS: ReadonlyArray<CommandPositionalSpec> = [
	{ name: "instructions", required: false, rest: true },
];

function initOptionsFromParsed(parsed: ParsedArgs): InitCommandOptions {
	const options: InitCommandOptions = {};
	if (parsed.flags.has("--preview")) options.preview = true;
	if (parsed.flags.has("--adopt")) options.adopt = true;
	if (parsed.flags.has("--apply")) options.applyClioMd = true;
	if (parsed.flags.has("--propose")) options.proposeClioMd = true;
	if (parsed.flags.has("--global")) options.includeGlobalImports = true;
	if (parsed.flags.has("--heuristic")) options.heuristic = true;
	return options;
}

function contextClearOptionsFromParsed(parsed: ParsedArgs): ContextClearCommandOptions {
	const options: ContextClearCommandOptions = {};
	if (parsed.flags.has("--all")) options.all = true;
	if (parsed.flags.has("--confirm")) options.confirmed = true;
	if (parsed.flags.has("--confirm-all")) options.confirmedAll = true;
	return options;
}

function fromArgsOrUnknown(command: SlashCommand): (parsed: ParsedArgs, trimmed: string) => SlashCommand {
	return (parsed, trimmed) => (parsed.error ? { kind: "unknown", text: trimmed } : command);
}

function usageNotice(entry: BuiltinSlashCommand, subcommand?: string): string {
	return usageLine(entry, subcommand).trim();
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "quit",
		description: "Exit Clio Coder",
		kinds: ["quit"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "quit" }),
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
		fromArgs: fromArgsOrUnknown({ kind: "prompts" }),
		handle(_command, ctx) {
			ctx.openPrompts();
		},
	},
	{
		name: "extensions",
		description: "List installed extensions",
		kinds: ["extensions"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "extensions" }),
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
		fromArgs(_parsed, trimmed) {
			const prefix = "/share";
			const args = trimmed === prefix ? "" : trimmed.slice(prefix.length).trim();
			return { kind: "share", args };
		},
		handle(command, ctx) {
			if (command.kind !== "share") return;
			const parts = command.args.split(/\s+/).filter(Boolean);
			const sub = parts.shift();
			const entry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "share");
			if (!entry) return;
			if (sub === "export") {
				const out = parts[0];
				if (!out || parts.length !== 1) {
					ctx.notice("info", usageNotice(entry, "export"));
					return;
				}
				if (!ctx.exportShareArchive) {
					ctx.notice("error", "share export is not wired");
					return;
				}
				const result = ctx.exportShareArchive(out);
				ctx.notice("success", `exported ${result.fileCount} item(s) to ${result.path}`);
				return;
			}
			if (sub === "import") {
				const dryRun = parts.includes("--dry-run");
				const force = parts.includes("--force");
				const archivePath = parts.find((part) => !part.startsWith("--"));
				if (!archivePath) {
					ctx.notice("info", usageNotice(entry, "import"));
					return;
				}
				if (!ctx.importShareArchive) {
					ctx.notice("error", "share import is not wired");
					return;
				}
				const plan = ctx.importShareArchive(archivePath, { dryRun, force });
				for (const diag of plan.diagnostics) {
					const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
					ctx.notice("warn", `${diag.type}: ${detail}`);
				}
				const write = plan.actions.filter((action) => action.action === "write").length;
				const overwrite = plan.actions.filter((action) => action.action === "overwrite").length;
				const skip = plan.actions.filter((action) => action.action === "skip").length;
				ctx.notice(
					dryRun ? "info" : "success",
					`${dryRun ? "dry-run" : "import"} write=${write} overwrite=${overwrite} skip=${skip} settings=${plan.actions.filter((action) => action.action === "settings").length}`,
				);
				return;
			}
			ctx.notice("info", usageNotice(entry));
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
						io: ctx.io,
						notice: ctx.notice,
						workerDefault: ctx.workerDefault(),
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
					workerDefault: ctx.workerDefault(),
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
		fromArgs: fromArgsOrUnknown({ kind: "agents" }),
		handle(_command, ctx) {
			ctx.openAgents();
		},
	},
	{
		name: "targets",
		description: "Show target hub for health, auth, models, and actions",
		kinds: ["providers"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "providers" }),
		handle(_command, ctx) {
			ctx.openProviders();
		},
	},
	{
		name: "cost",
		description: "Show session token and cost totals",
		kinds: ["cost"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "cost" }),
		handle(_command, ctx) {
			ctx.openCost();
		},
	},
	{
		name: "context",
		description: "Context hub: window overlay plus compact, init, refresh, and reset",
		aliases: ["ctx"],
		kinds: ["context-view", "compact", "init", "context-clear", "context-refresh"],
		args: {
			subcommands: {
				compact: { positionals: [...COMPACT_POSITIONALS] },
				init: { flags: CONTEXT_INIT_FLAGS },
				refresh: {},
				reset: { flags: CONTEXT_RESET_FLAGS },
			},
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "unknown", text: trimmed };
			switch (parsed.subcommand) {
				case "compact":
					return { kind: "compact", instructions: parsed.rest };
				case "init":
					return { kind: "init", options: initOptionsFromParsed(parsed) };
				case "refresh":
					return { kind: "context-refresh" };
				case "reset":
					return { kind: "context-clear", options: contextClearOptionsFromParsed(parsed) };
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
		fromArgs: fromArgsOrUnknown({ kind: "fleet" }),
		handle(_command, ctx) {
			ctx.openFleet();
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
		description: "Open thinking-level selector",
		kinds: ["thinking"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "thinking" }),
		handle(_command, ctx) {
			ctx.openThinking();
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
		fromArgs: fromArgsOrUnknown({ kind: "scoped-models" }),
		handle(_command, ctx) {
			ctx.openScopedModels();
		},
	},
	{
		name: "settings",
		description: "Open interactive settings",
		kinds: ["settings"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "settings" }),
		handle(_command, ctx) {
			ctx.openSettings();
		},
	},
	{
		name: "resume",
		description: "Resume a past session",
		kinds: ["resume"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "resume" }),
		handle(_command, ctx) {
			ctx.openResume();
		},
	},
	{
		name: "new",
		description: "Start a fresh session",
		kinds: ["new"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "new" }),
		handle(_command, ctx) {
			ctx.startNewSession();
		},
	},
	{
		name: "tree",
		description: "Open session tree navigator",
		kinds: ["tree"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "tree" }),
		handle(_command, ctx) {
			ctx.openTree();
		},
	},
	{
		name: "fork",
		description: "Fork from an assistant turn",
		kinds: ["fork"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "fork" }),
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
	// Deprecated spellings: hidden from /help, autocomplete, and docs. They
	// parse exactly like their /context replacements, own no kinds (the hub
	// entry handles dispatch), and stamp a deprecation notice on the parse.
	// Scheduled for removal one release after the /context hub ships.
	{
		name: "compact",
		description: "Deprecated spelling of /context compact",
		hidden: true,
		kinds: [],
		args: {
			positionals: [...COMPACT_POSITIONALS],
		},
		fromArgs(parsed) {
			return {
				kind: "compact",
				instructions: parsed.rest,
				deprecation: { from: "compact", to: "context compact" },
			};
		},
		handle() {},
	},
	{
		name: "context-init",
		description: "Deprecated spelling of /context init",
		hidden: true,
		kinds: [],
		args: { flags: CONTEXT_INIT_FLAGS },
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "unknown", text: trimmed };
			return {
				kind: "init",
				options: initOptionsFromParsed(parsed),
				deprecation: { from: "context-init", to: "context init" },
			};
		},
		handle() {},
	},
	{
		name: "context-clear",
		description: "Deprecated spelling of /context reset",
		hidden: true,
		kinds: [],
		args: { flags: CONTEXT_RESET_FLAGS },
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "unknown", text: trimmed };
			return {
				kind: "context-clear",
				options: contextClearOptionsFromParsed(parsed),
				deprecation: { from: "context-clear", to: "context reset" },
			};
		},
		handle() {},
	},
	{
		name: "context-view",
		description: "Deprecated spelling of /context",
		hidden: true,
		kinds: [],
		args: {},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "unknown", text: trimmed };
			return { kind: "context-view", deprecation: { from: "context-view", to: "context" } };
		},
		handle() {},
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

/** Pure slash-command parser: no I/O, no side effects. Walks the registry in order. */
export function parseSlashCommand(input: string): SlashCommand {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	for (const entry of BUILTIN_SLASH_COMMANDS) {
		const match = entry.match ? entry.match(trimmed) : matchFromSpec(entry, trimmed);
		if (match) return match;
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
	if (command.deprecation) {
		ctx.notice("info", `/${command.deprecation.from} is deprecated; use /${command.deprecation.to}`);
	}
	const entry = HANDLER_BY_KIND.get(command.kind);
	if (!entry) return;
	entry.handle(command, ctx);
}

export interface CommandReferenceEntry {
	name: string;
	aliases: ReadonlyArray<string>;
	usage: string;
	description: string;
	/** The command's args grammar, carried through for argument autocomplete. */
	args?: CommandArgsSpec;
}

export function commandReference(): ReadonlyArray<CommandReferenceEntry> {
	return BUILTIN_SLASH_COMMANDS.filter((entry) => entry.hidden !== true).map((entry) => {
		const usage = usageLine(entry)
			.replace(/^\nusage:\s*/, "")
			.replace(/\n$/, "");
		return {
			name: entry.name,
			aliases: entry.aliases ?? [],
			usage,
			description: entry.description,
			...(entry.args ? { args: entry.args } : {}),
		};
	});
}
