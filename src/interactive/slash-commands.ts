import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import type { InstalledExtension } from "../domains/extensions/index.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import { resolveModelReference } from "../domains/providers/index.js";
import type { PromptTemplate, ResourceList, Skill } from "../domains/resources/index.js";
import { getMarketplaceSkills, parseSkillCommand } from "../domains/resources/index.js";
import type { ShareImportPlan } from "../domains/share/index.js";
import { isToolProfileName, TOOL_PROFILE_NAMES, type ToolProfileName } from "../tools/profiles.js";
import type { NoticeLevel } from "./command-output.js";
import type { CommandArgsSpec, ParsedArgs } from "./slash-spec.js";
import { matchFromSpec, usageLine } from "./slash-spec.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 */

export type SlashCommand =
	| { kind: "quit" }
	| { kind: "help"; query?: string }
	| { kind: "init"; options: InitCommandOptions }
	| { kind: "context-clear"; options: ContextClearCommandOptions }
	| { kind: "skills"; query?: string }
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
	| { kind: "connect"; target?: string }
	| { kind: "disconnect"; target?: string }
	| { kind: "cost" }
	| { kind: "context-view" }
	| { kind: "fleet" }
	| { kind: "receipts" }
	| { kind: "receipt-verify"; runId: string }
	| { kind: "receipt-usage" }
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
	| { kind: "unknown"; text: string }
	| { kind: "empty" };

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
	endpoint?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	toolProfile?: ToolProfileName;
	requiredCapabilities?: string[];
}

export interface HandleRunDeps {
	dispatch: DispatchContract;
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	workerDefault?: { endpoint?: string; model?: string } | undefined;
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
	if (options.endpoint && options.workerProfile) {
		notice("warn", `--target ${options.endpoint} takes precedence; --worker ${options.workerProfile} will be ignored`);
	}
	if (options.endpoint && options.workerRuntime) {
		notice("warn", `--target ${options.endpoint} takes precedence; --runtime ${options.workerRuntime} will be ignored`);
	}
	try {
		const request = {
			agentId,
			task,
			requestOrigin: "user" as const,
			...(options.workerProfile ? { workerProfile: options.workerProfile } : {}),
			...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
			...(options.endpoint ? { endpoint: options.endpoint } : {}),
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
	dataDir: string;
	/** Returns the current `workers.default` block, resolved fresh on every /run. */
	workerDefault: () => { endpoint?: string; model?: string } | undefined;
	/** Fire-and-forget shutdown. Handler must not await. */
	shutdown: () => void;
	runInit: (options: InitCommandOptions) => void;
	runContextClear: (options: ContextClearCommandOptions) => void;
	listSkills: () => ResourceList<Skill>;
	openSkillSelector?: () => void;
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
	openConnect: (target?: string) => void;
	openDisconnect: (target?: string) => void;
	openCost: () => void;
	/** Open the read-only `/context` overlay: categorized context-window ledger. */
	openContextView: () => void;
	/** Open the read-only `/fleet` overlay: running, retrying, and totals. */
	openFleet: () => void;
	openReceipts: () => void;
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
	 * Escape hatch for the `receipts verify` entry: verify a receipt file on disk
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
		name: "context-init",
		description: "Explore the repo and bootstrap project context: CLIO.md, codewiki, handoff",
		kinds: ["init"],
		args: {
			flags: [
				{ name: "--preview" },
				{ name: "--adopt" },
				{ name: "--apply", aliases: ["--rewrite"] },
				{ name: "--propose" },
				{ name: "--global", aliases: ["--include-global"] },
				{ name: "--heuristic", aliases: ["--no-generate"] },
			],
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "unknown", text: trimmed };
			const options: InitCommandOptions = {};
			if (parsed.flags.has("--preview")) options.preview = true;
			if (parsed.flags.has("--adopt")) options.adopt = true;
			if (parsed.flags.has("--apply")) options.applyClioMd = true;
			if (parsed.flags.has("--propose")) options.proposeClioMd = true;
			if (parsed.flags.has("--global")) options.includeGlobalImports = true;
			if (parsed.flags.has("--heuristic")) options.heuristic = true;
			return { kind: "init", options };
		},
		handle(command, ctx) {
			if (command.kind !== "init") return;
			ctx.runInit(command.options);
		},
	},
	{
		name: "context-clear",
		description: "Clear accumulated project context artifacts",
		kinds: ["context-clear"],
		args: {
			flags: [{ name: "--all" }, { name: "--confirm" }, { name: "--confirm-all" }],
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "unknown", text: trimmed };
			const options: ContextClearCommandOptions = {};
			if (parsed.flags.has("--all")) options.all = true;
			if (parsed.flags.has("--confirm")) options.confirmed = true;
			if (parsed.flags.has("--confirm-all")) options.confirmedAll = true;
			return { kind: "context-clear", options };
		},
		handle(command, ctx) {
			if (command.kind !== "context-clear") return;
			ctx.runContextClear(command.options);
		},
	},
	{
		name: "skill",
		description: "Open interactive skill selector or invoke a skill",
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
				if (ctx.openSkillSelector) {
					ctx.openSkillSelector();
				}
			} else if (command.kind === "skill-invocation") {
				ctx.submitChat(command.text);
			}
		},
	},
	{
		name: "skills",
		description: "Browse or search skills",
		kinds: ["skills"],
		args: {
			positionals: [{ name: "query", required: false, rest: true }],
		},
		fromArgs(parsed) {
			const query = parsed.positionals[0];
			return { kind: "skills", ...(query ? { query } : {}) };
		},
		handle(command, ctx) {
			if (command.kind !== "skills") return;
			const list = ctx.listSkills();
			const query = command.query?.toLowerCase();
			const matches = (name: string, description: string): boolean =>
				!query || name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
			const items = list.items.filter((skill) => matches(skill.name, skill.description));
			const installedNames = new Set(list.items.map((skill) => skill.name));
			const marketplace = getMarketplaceSkills().filter(
				(skill) => !installedNames.has(skill.name) && matches(skill.name, skill.description),
			);
			if (items.length === 0 && marketplace.length === 0) {
				// v023-M04
				ctx.io.stdout(query ? `\nskills: no matches for "${command.query}"\n` : "\nskills: none\n");
				return;
			}
			const rows = items.map((skill) => {
				const usage = `/skill:${skill.name}`;
				const origin = `${skill.scope}/${skill.source}${skill.trusted ? "" : ", untrusted"}`;
				return `  ${usage.padEnd(26)} ${skill.description}  (${origin})`;
			});
			const marketplaceRows = marketplace.map((skill) => {
				const usage = `/skill:${skill.name}`;
				const origin = [skill.origin, ...(skill.audit ? [`audit: ${skill.audit}`] : [])].join(", ");
				return `  ${usage.padEnd(26)} ${skill.description}  (marketplace: ${origin})`;
			});
			const sections = [
				...(rows.length > 0 ? [`skills:\n${rows.join("\n")}`] : []),
				...(marketplaceRows.length > 0
					? [`marketplace (installs on first /skill:<name> use):\n${marketplaceRows.join("\n")}`]
					: []),
			];
			const diagnostics =
				list.diagnostics.length > 0 ? `\n${list.diagnostics.length} skill diagnostic(s) while loading resources.\n` : "\n";
			// v023-M04
			ctx.io.stdout(`\n${sections.join("\n\n")}\n${diagnostics}`);
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

			const endpoint = parsed.flags.get("--target");
			if (typeof endpoint === "string") options.endpoint = endpoint;

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
		description: "Show target health, auth, and models",
		kinds: ["providers"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "providers" }),
		handle(_command, ctx) {
			ctx.openProviders();
		},
	},
	{
		name: "connect",
		description: "Connect a target or choose one",
		kinds: ["connect"],
		args: {
			positionals: [{ name: "target", required: false, rest: true }],
		},
		fromArgs(parsed) {
			const target = parsed.positionals[0];
			return { kind: "connect", ...(target ? { target } : {}) };
		},
		handle(command, ctx) {
			if (command.kind !== "connect") return;
			ctx.openConnect(command.target);
		},
	},
	{
		name: "disconnect",
		description: "Disconnect a target or choose one",
		kinds: ["disconnect"],
		args: {
			positionals: [{ name: "target", required: false, rest: true }],
		},
		fromArgs(parsed) {
			const target = parsed.positionals[0];
			return { kind: "disconnect", ...(target ? { target } : {}) };
		},
		handle(command, ctx) {
			if (command.kind !== "disconnect") return;
			ctx.openDisconnect(command.target);
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
		name: "context-view",
		description: "Visualize the active context window and its breakdown",
		aliases: ["context", "ctx"],
		kinds: ["context-view"],
		args: {},
		fromArgs: fromArgsOrUnknown({ kind: "context-view" }),
		handle(_command, ctx) {
			ctx.openContextView();
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
		name: "receipts",
		description: "Browse or verify run receipts",
		kinds: ["receipts", "receipt-verify", "receipt-usage"],
		args: {
			subcommands: {
				verify: {
					positionals: [{ name: "runId", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "receipt-usage" };
			if (parsed.subcommand === "verify") {
				const runId = parsed.positionals[0] ?? "";
				return { kind: "receipt-verify", runId };
			}
			return { kind: "receipts" };
		},
		handle(command, ctx) {
			const entry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "receipts");
			if (!entry) return;
			if (command.kind === "receipts") {
				ctx.openReceipts();
				return;
			}
			if (command.kind === "receipt-usage") {
				ctx.notice("info", usageNotice(entry, "verify"));
				return;
			}
			if (command.kind !== "receipt-verify") return;
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
			const result = resolveModelReference(command.pattern, ctx.providers);
			if (!result.ref) {
				ctx.notice("error", result.error ?? `no match for "${command.pattern}"`);
				return;
			}
			if (result.warning) ctx.notice("warn", result.warning);
			ctx.applyModelRef(result.ref);
			const suffix = result.ref.thinkingLevel ? ` thinking=${result.ref.thinkingLevel}` : "";
			ctx.notice("success", `active: ${result.ref.endpoint}/${result.ref.model}${suffix}`);
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
		name: "compact",
		description: "Compact earlier context",
		kinds: ["compact"],
		args: {
			positionals: [{ name: "instructions", required: false, rest: true }],
		},
		fromArgs(parsed) {
			const instructions = parsed.positionals[0];
			return { kind: "compact", instructions };
		},
		handle(command, ctx) {
			if (command.kind !== "compact") return;
			ctx.runCompact(command.instructions);
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
	const entry = HANDLER_BY_KIND.get(command.kind);
	if (!entry) return;
	entry.handle(command, ctx);
}

export interface CommandReferenceEntry {
	name: string;
	aliases: ReadonlyArray<string>;
	usage: string;
	description: string;
}

export function commandReference(): ReadonlyArray<CommandReferenceEntry> {
	return BUILTIN_SLASH_COMMANDS.map((entry) => {
		const usage = usageLine(entry)
			.replace(/^\nusage:\s*/, "")
			.replace(/\n$/, "");
		return {
			name: entry.name,
			aliases: entry.aliases ?? [],
			usage,
			description: entry.description,
		};
	});
}
