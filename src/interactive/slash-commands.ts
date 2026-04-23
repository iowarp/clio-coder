import { BusChannels } from "../core/bus-events.js";
import { settingsPath } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 */

export type SlashCommand =
	| { kind: "quit" }
	| { kind: "help" }
	| { kind: "run"; agentId: string; task: string }
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
 * Endpoint + model are resolved from `settings.workers.default`; when that
 * block is empty, we refuse to dispatch and print an actionable error instead.
 */
export async function handleRun(agentId: string, task: string, deps: HandleRunDeps): Promise<void> {
	const { dispatch, io, workerDefault, bus } = deps;
	if (!workerDefault?.endpoint) {
		io.stderr(
			`[run] no endpoint configured. Edit ${settingsPath()} (workers.default.endpoint + workers.default.model) or launch Clio with CLIO_WORKER_FAUX=1 for a smoke test.\n`,
		);
		return;
	}
	try {
		const handle = await dispatch.dispatch({
			agentId,
			task,
		});
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
		io.stdout(`[run] done exit=${receipt.exitCode} tokens=${receipt.tokenCount}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		io.stderr(`[run] failed: ${msg}\n`);
	}
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
	openProviders: () => void;
	openConnect: (target?: string) => void;
	openDisconnect: (target?: string) => void;
	openCost: () => void;
	openReceipts: () => void;
	openThinking: () => void;
	openModel: () => void;
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
	 * appends a compactionSummary entry. No-op when no session is open — the
	 * handler prints an actionable stderr line instead.
	 */
	runCompact: (instructions: string | undefined) => void;
	/**
	 * Escape hatch for the `receipt verify` entry: verify a receipt file on disk
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
		description: "Quit clio",
		kinds: ["quit"],
		match(trimmed) {
			return trimmed === "/quit" || trimmed === "/exit" ? { kind: "quit" } : null;
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
			const rows = BUILTIN_SLASH_COMMANDS.map((entry) => `  /${entry.name.padEnd(16)} ${entry.description}`);
			ctx.io.stdout(`\ncommands:\n${rows.join("\n")}\n\nRun /hotkeys for the full keyboard + slash-command reference.\n`);
		},
	},
	{
		name: "run",
		description: "Dispatch a run to the configured worker",
		kinds: ["run", "run-usage"],
		match(trimmed) {
			if (trimmed === "/run" || trimmed === "/run ") return { kind: "run-usage" };
			if (trimmed.startsWith("/run ")) {
				const rest = trimmed.slice(5).trim();
				const [agentId, ...taskParts] = rest.split(/\s+/);
				const task = taskParts.join(" ").trim();
				if (!agentId || !task) return { kind: "run-usage" };
				return { kind: "run", agentId, task };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind === "run-usage") {
				ctx.io.stdout("\nusage: /run <agent> <task>\n");
				return;
			}
			if (command.kind !== "run") return;
			const { agentId, task } = command;
			void (async () => {
				await handleRun(agentId, task, {
					dispatch: ctx.dispatch,
					io: ctx.io,
					workerDefault: ctx.workerDefault(),
					bus: ctx.bus,
				});
				ctx.render();
			})();
		},
	},
	{
		name: "providers",
		description: "Open providers overlay",
		kinds: ["providers"],
		match(trimmed) {
			return trimmed === "/providers" ? { kind: "providers" } : null;
		},
		handle(_command, ctx) {
			ctx.openProviders();
		},
	},
	{
		name: "connect",
		description: "Connect a provider or endpoint",
		kinds: ["connect"],
		match(trimmed) {
			if (trimmed === "/connect" || trimmed === "/login") return { kind: "connect" };
			if (trimmed.startsWith("/connect ")) {
				const target = trimmed.slice("/connect ".length).trim();
				return { kind: "connect", ...(target.length > 0 ? { target } : {}) };
			}
			if (trimmed.startsWith("/login ")) {
				const target = trimmed.slice("/login ".length).trim();
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
		description: "Disconnect a provider or endpoint",
		kinds: ["disconnect"],
		match(trimmed) {
			if (trimmed === "/disconnect" || trimmed === "/logout") return { kind: "disconnect" };
			if (trimmed.startsWith("/disconnect ")) {
				const target = trimmed.slice("/disconnect ".length).trim();
				return { kind: "disconnect", ...(target.length > 0 ? { target } : {}) };
			}
			if (trimmed.startsWith("/logout ")) {
				const target = trimmed.slice("/logout ".length).trim();
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
		description: "Open cost overlay",
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
		description: "Open receipts overlay",
		kinds: ["receipts"],
		match(trimmed) {
			return trimmed === "/receipts" ? { kind: "receipts" } : null;
		},
		handle(_command, ctx) {
			ctx.openReceipts();
		},
	},
	{
		name: "receipt",
		description: "Verify a receipt file: /receipt verify <runId>",
		kinds: ["receipt-verify", "receipt-usage"],
		match(trimmed) {
			if (trimmed === "/receipt" || trimmed === "/receipt ") return { kind: "receipt-usage" };
			if (trimmed.startsWith("/receipt ")) {
				const parts = trimmed.slice("/receipt ".length).trim().split(/\s+/);
				if (parts[0] === "verify" && parts[1] && parts.length === 2) {
					return { kind: "receipt-verify", runId: parts[1] };
				}
				return { kind: "receipt-usage" };
			}
			return null;
		},
		handle(command, ctx) {
			if (command.kind === "receipt-usage") {
				ctx.io.stdout("\nusage: /receipt verify <runId>\n");
				return;
			}
			if (command.kind !== "receipt-verify") return;
			const result = ctx.verifyReceipt(command.runId);
			if (result.ok) {
				ctx.io.stdout(`[/receipt verify] ok ${command.runId}\n`);
			} else {
				ctx.io.stdout(`[/receipt verify] fail ${command.runId} ${result.reason}\n`);
			}
		},
	},
	{
		name: "thinking",
		description: "Open thinking-level overlay",
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
		description: "Select orchestrator model",
		kinds: ["model"],
		match(trimmed) {
			return trimmed === "/model" || trimmed === "/models" ? { kind: "model" } : null;
		},
		handle(_command, ctx) {
			ctx.openModel();
		},
	},
	{
		name: "scoped-models",
		description: "Edit the Ctrl+P cycle set",
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
		description: "View and cycle settings",
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
		description: "Pick a past session to resume",
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
		description: "Start a new session",
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
		description: "Open the session tree navigator",
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
		description: "Pick an assistant turn to fork from",
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
		description: "Summarize earlier context to free token budget",
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
		description: "Show the keyboard + slash-command reference",
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
