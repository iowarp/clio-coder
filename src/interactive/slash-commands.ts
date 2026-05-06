import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import { resolveModelReference } from "../domains/providers/index.js";
import type { PromptTemplate, ResourceList, Skill } from "../domains/resources/index.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 */

export type SlashCommand =
	| { kind: "quit" }
	| { kind: "help" }
	| { kind: "init" }
	| { kind: "skills" }
	| { kind: "prompts" }
	| { kind: "run"; agentId: string; task: string; options: RunCommandOptions }
	| { kind: "run-usage" }
	| { kind: "providers" }
	| { kind: "connect"; target?: string }
	| { kind: "disconnect"; target?: string }
	| { kind: "cost" }
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
	| { kind: "hotkeys" }
	| { kind: "unknown"; text: string }
	| { kind: "empty" };

export type SlashCommandKind = SlashCommand["kind"];

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

export interface RunCommandOptions {
	workerProfile?: string;
	workerRuntime?: string;
	endpoint?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	requiredCapabilities?: string[];
}

export interface HandleRunDeps {
	dispatch: DispatchContract;
	io: RunIo;
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
	const { dispatch, io, bus } = deps;
	if (options.endpoint && options.workerProfile) {
		io.stderr(`[run] --target ${options.endpoint} takes precedence; --worker ${options.workerProfile} will be ignored\n`);
	}
	if (options.endpoint && options.workerRuntime) {
		io.stderr(
			`[run] --target ${options.endpoint} takes precedence; --runtime ${options.workerRuntime} will be ignored\n`,
		);
	}
	try {
		const request = {
			agentId,
			task,
			...(options.workerProfile ? { workerProfile: options.workerProfile } : {}),
			...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
			...(options.endpoint ? { endpoint: options.endpoint } : {}),
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options.requiredCapabilities && options.requiredCapabilities.length > 0
				? { requiredCapabilities: options.requiredCapabilities }
				: {}),
		};
		const handle = await dispatch.dispatch(request);
		io.stdout(`\n[run] runId=${handle.runId}\n`);
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			io.stdout(`[run] ${e.type}\n`);
			bus?.emit(BusChannels.DispatchProgress, {
				runId: handle.runId,
				agentId,
				event,
			});
		}
		const receipt = await handle.finalPromise;
		const reasoning =
			typeof receipt.reasoningTokenCount === "number" && receipt.reasoningTokenCount > 0
				? ` reasoning=${receipt.reasoningTokenCount}`
				: "";
		io.stdout(`[run] done exit=${receipt.exitCode} tokens=${receipt.tokenCount}${reasoning}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		io.stderr(`[run] failed: ${msg}\n`);
	}
}

const VALID_RUN_THINKING = new Set<JobThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseRunCommand(rest: string): SlashCommand {
	const parts = rest.split(/\s+/).filter(Boolean);
	const options: RunCommandOptions = {};
	const requiredCapabilities: string[] = [];
	let i = 0;
	const need = (): string | null => {
		const value = parts[i + 1];
		if (!value) return null;
		i += 1;
		return value;
	};
	while (i < parts.length) {
		const part = parts[i];
		if (!part?.startsWith("--")) break;
		if (part === "--worker-profile" || part === "--worker") {
			const value = need();
			if (!value) return { kind: "run-usage" };
			options.workerProfile = value;
		} else if (part === "--worker-runtime" || part === "--runtime") {
			const value = need();
			if (!value) return { kind: "run-usage" };
			options.workerRuntime = value;
		} else if (part === "--target") {
			const value = need();
			if (!value) return { kind: "run-usage" };
			options.endpoint = value;
		} else if (part === "--model") {
			const value = need();
			if (!value) return { kind: "run-usage" };
			options.model = value;
		} else if (part === "--thinking") {
			const value = need();
			if (!value || !VALID_RUN_THINKING.has(value as JobThinkingLevel)) return { kind: "run-usage" };
			options.thinkingLevel = value as JobThinkingLevel;
		} else if (part === "--require") {
			const value = need();
			if (!value) return { kind: "run-usage" };
			requiredCapabilities.push(value);
		} else {
			return { kind: "run-usage" };
		}
		i += 1;
	}
	const agentId = parts[i];
	const task = parts
		.slice(i + 1)
		.join(" ")
		.trim();
	if (!agentId || !task) return { kind: "run-usage" };
	if (requiredCapabilities.length > 0) options.requiredCapabilities = requiredCapabilities;
	return { kind: "run", agentId, task, options };
}

/**
 * Runtime dependencies every slash-command handler may need. Every field is
 * injected at startInteractive construction time; handlers never reach into
 * the TUI, chat loop, or overlay module graph directly.
 */
export interface SlashCommandContext {
	io: RunIo;
	dispatch: DispatchContract;
	bus: SafeEventBus;
	dataDir: string;
	/** Returns the current `workers.default` block, resolved fresh on every /run. */
	workerDefault: () => { endpoint?: string; model?: string } | undefined;
	/** Fire-and-forget shutdown. Handler must not await. */
	shutdown: () => void;
	runInit: () => void;
	listSkills: () => ResourceList<Skill>;
	listPrompts: () => ResourceList<PromptTemplate>;
	openProviders: () => void;
	openConnect: (target?: string) => void;
	openDisconnect: (target?: string) => void;
	openCost: () => void;
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
	openHotkeys: () => void;
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
	/** Optional usage suffix shown in the slash-command autocomplete dropdown. */
	argumentHint?: string;
	/** The set of SlashCommand kinds this entry is responsible for dispatching. */
	kinds: ReadonlyArray<SlashCommandKind>;
	/** Return the parsed SlashCommand for `trimmed` or null if this entry does not match. */
	match(trimmed: string): SlashCommand | null;
	/** Execute `command` against `ctx`. Called only for kinds declared in `kinds`. */
	handle(command: SlashCommand, ctx: SlashCommandContext): void;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "quit",
		description: "Exit Clio Coder",
		kinds: ["quit"],
		match(trimmed) {
			return trimmed === "/quit" ? { kind: "quit" } : null;
		},
		handle(_command, ctx) {
			ctx.shutdown();
		},
	},
	{
		name: "help",
		description: "Show slash-command help",
		kinds: ["help"],
		match(trimmed) {
			return trimmed === "/help" || trimmed.startsWith("/help ") ? { kind: "help" } : null;
		},
		handle(_command, ctx) {
			const rows = BUILTIN_SLASH_COMMANDS.map((entry) => {
				const usage = `/${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : ""}`;
				return `  ${usage.padEnd(28)} ${entry.description}`;
			});
			ctx.io.stdout(`\ncommands:\n${rows.join("\n")}\n\nRun /hotkeys for the full keyboard + slash-command reference.\n`);
		},
	},
	{
		name: "init",
		description: "Bootstrap or refresh CLIO.md",
		kinds: ["init"],
		match(trimmed) {
			return trimmed === "/init" ? { kind: "init" } : null;
		},
		handle(_command, ctx) {
			ctx.runInit();
		},
	},
	{
		name: "skills",
		description: "List skills",
		kinds: ["skills"],
		match(trimmed) {
			return trimmed === "/skills" ? { kind: "skills" } : null;
		},
		handle(_command, ctx) {
			const list = ctx.listSkills();
			if (list.items.length === 0) {
				ctx.io.stdout("\nskills: none\n");
				return;
			}
			const rows = list.items.map((skill) => {
				const usage = `/skill:${skill.name}`;
				return `  ${usage.padEnd(28)} ${skill.description}`;
			});
			const diagnostics =
				list.diagnostics.length > 0 ? `\n${list.diagnostics.length} skill diagnostic(s) while loading resources.\n` : "\n";
			ctx.io.stdout(`\nskills:\n${rows.join("\n")}\n${diagnostics}`);
		},
	},
	{
		name: "prompts",
		description: "List prompt templates",
		kinds: ["prompts"],
		match(trimmed) {
			return trimmed === "/prompts" ? { kind: "prompts" } : null;
		},
		handle(_command, ctx) {
			const list = ctx.listPrompts();
			if (list.items.length === 0) {
				ctx.io.stdout("\nprompt templates: none\n");
				return;
			}
			const rows = list.items.map((template) => {
				const usage = `/${template.name}${template.argumentHint ? ` ${template.argumentHint}` : ""}`;
				return `  ${usage.padEnd(28)} ${template.description}`;
			});
			const diagnostics =
				list.diagnostics.length > 0
					? `\n${list.diagnostics.length} prompt-template diagnostic(s) while loading resources.\n`
					: "\n";
			ctx.io.stdout(`\nprompt templates:\n${rows.join("\n")}\n${diagnostics}`);
		},
	},
	{
		name: "run",
		description: "Run a worker agent",
		argumentHint: "[options] <agent> <task>",
		kinds: ["run", "run-usage"],
		match(trimmed) {
			if (trimmed === "/run" || trimmed === "/run ") return { kind: "run-usage" };
			if (trimmed.startsWith("/run ")) {
				return parseRunCommand(trimmed.slice(5).trim());
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind === "run-usage") {
				ctx.io.stdout(
					"\nusage: /run [--worker <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--require <cap>] <agent> <task>\n",
				);
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
		name: "targets",
		description: "Show target health, auth, and models",
		kinds: ["providers"],
		match(trimmed) {
			return trimmed === "/targets" ? { kind: "providers" } : null;
		},
		handle(_command, ctx) {
			ctx.openProviders();
		},
	},
	{
		name: "connect",
		description: "Connect a target or choose one",
		argumentHint: "[target]",
		kinds: ["connect"],
		match(trimmed) {
			if (trimmed === "/connect") return { kind: "connect" };
			if (trimmed.startsWith("/connect ")) {
				const target = trimmed.slice("/connect ".length).trim();
				return { kind: "connect", ...(target.length > 0 ? { target } : {}) };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind !== "connect") return;
			ctx.openConnect(command.target);
		},
	},
	{
		name: "disconnect",
		description: "Disconnect a target or choose one",
		argumentHint: "[target]",
		kinds: ["disconnect"],
		match(trimmed) {
			if (trimmed === "/disconnect") return { kind: "disconnect" };
			if (trimmed.startsWith("/disconnect ")) {
				const target = trimmed.slice("/disconnect ".length).trim();
				return { kind: "disconnect", ...(target.length > 0 ? { target } : {}) };
			}
			return null;
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
		match(trimmed) {
			return trimmed === "/cost" ? { kind: "cost" } : null;
		},
		handle(_command, ctx) {
			ctx.openCost();
		},
	},
	{
		name: "receipts",
		description: "Browse or verify run receipts",
		argumentHint: "[verify <runId>]",
		kinds: ["receipts", "receipt-verify", "receipt-usage"],
		match(trimmed) {
			if (trimmed === "/receipts") return { kind: "receipts" };
			if (trimmed.startsWith("/receipts ")) {
				const parts = trimmed.slice("/receipts ".length).trim().split(/\s+/);
				if (parts[0] === "verify" && parts[1] && parts.length === 2) {
					return { kind: "receipt-verify", runId: parts[1] };
				}
				return { kind: "receipt-usage" };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind === "receipts") {
				ctx.openReceipts();
				return;
			}
			if (command.kind === "receipt-usage") {
				ctx.io.stdout("\nusage: /receipts verify <runId>\n");
				return;
			}
			if (command.kind !== "receipt-verify") return;
			const result = ctx.verifyReceipt(command.runId);
			if (result.ok) {
				ctx.io.stdout(`[/receipts verify] ok ${command.runId}\n`);
			} else {
				ctx.io.stdout(`[/receipts verify] fail ${command.runId} ${result.reason}\n`);
			}
		},
	},
	{
		name: "thinking",
		description: "Open thinking-level selector",
		kinds: ["thinking"],
		match(trimmed) {
			return trimmed === "/thinking" ? { kind: "thinking" } : null;
		},
		handle(_command, ctx) {
			ctx.openThinking();
		},
	},
	{
		name: "model",
		description: "Open model selector or set a model",
		argumentHint: "[pattern[:thinking]]",
		kinds: ["model", "model-set"],
		match(trimmed) {
			if (trimmed === "/model") return { kind: "model" };
			if (trimmed.startsWith("/model ")) {
				const pattern = trimmed.slice("/model ".length).trim();
				if (pattern.length > 0) return { kind: "model-set", pattern };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind === "model") {
				ctx.openModel();
				return;
			}
			if (command.kind !== "model-set") return;
			const result = resolveModelReference(command.pattern, ctx.providers);
			if (!result.ref) {
				ctx.io.stderr(`[/model] ${result.error ?? `no match for "${command.pattern}"`}\n`);
				return;
			}
			if (result.warning) ctx.io.stdout(`[/model] ${result.warning}\n`);
			ctx.applyModelRef(result.ref);
			const suffix = result.ref.thinkingLevel ? ` thinking=${result.ref.thinkingLevel}` : "";
			ctx.io.stdout(`[/model] active: ${result.ref.endpoint}/${result.ref.model}${suffix}\n`);
		},
	},
	{
		name: "scoped-models",
		description: "Edit the Ctrl+P model cycle set",
		kinds: ["scoped-models"],
		match(trimmed) {
			return trimmed === "/scoped-models" ? { kind: "scoped-models" } : null;
		},
		handle(_command, ctx) {
			ctx.openScopedModels();
		},
	},
	{
		name: "settings",
		description: "Open interactive settings",
		kinds: ["settings"],
		match(trimmed) {
			return trimmed === "/settings" ? { kind: "settings" } : null;
		},
		handle(_command, ctx) {
			ctx.openSettings();
		},
	},
	{
		name: "resume",
		description: "Resume a past session",
		kinds: ["resume"],
		match(trimmed) {
			return trimmed === "/resume" ? { kind: "resume" } : null;
		},
		handle(_command, ctx) {
			ctx.openResume();
		},
	},
	{
		name: "new",
		description: "Start a fresh session",
		kinds: ["new"],
		match(trimmed) {
			return trimmed === "/new" ? { kind: "new" } : null;
		},
		handle(_command, ctx) {
			ctx.startNewSession();
		},
	},
	{
		name: "tree",
		description: "Open session tree navigator",
		kinds: ["tree"],
		match(trimmed) {
			return trimmed === "/tree" ? { kind: "tree" } : null;
		},
		handle(_command, ctx) {
			ctx.openTree();
		},
	},
	{
		name: "fork",
		description: "Fork from an assistant turn",
		kinds: ["fork"],
		match(trimmed) {
			return trimmed === "/fork" ? { kind: "fork" } : null;
		},
		handle(_command, ctx) {
			ctx.openMessagePicker();
		},
	},
	{
		name: "compact",
		description: "Compact earlier context",
		argumentHint: "[instructions]",
		kinds: ["compact"],
		match(trimmed) {
			if (trimmed === "/compact") return { kind: "compact", instructions: undefined };
			if (trimmed.startsWith("/compact ")) {
				const rest = trimmed.slice("/compact ".length).trim();
				return { kind: "compact", instructions: rest.length > 0 ? rest : undefined };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind !== "compact") return;
			ctx.runCompact(command.instructions);
		},
	},
	{
		name: "hotkeys",
		description: "Show keyboard and command reference",
		kinds: ["hotkeys"],
		match(trimmed) {
			return trimmed === "/hotkeys" ? { kind: "hotkeys" } : null;
		},
		handle(_command, ctx) {
			ctx.openHotkeys();
		},
	},
];

const HANDLER_BY_KIND = new Map<SlashCommandKind, BuiltinSlashCommand>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
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
		const match = entry.match(trimmed);
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
