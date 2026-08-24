import { BusChannels } from "../core/bus-events.js";
import { THINKING_LEVELS } from "../core/defaults.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { parseOracleResult } from "../domains/agents/index.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { ContextInitOptions } from "../domains/context/init-options.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { type AgentRoleFactsResolver, requestExecutionRole } from "../domains/dispatch/execution-role.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import type { InstalledExtension } from "../domains/extensions/index.js";
import type { InteropAgentId, InteropProposal, InteropReport } from "../domains/interop/index.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import { resolveModelReference } from "../domains/providers/index.js";
import type { PromptTemplate, PromptTemplateExpansion, ResourceList } from "../domains/resources/index.js";
import { parseSkillCommand } from "../domains/resources/index.js";
import type { ShareImportPlan } from "../domains/share/index.js";
import type { UserTask } from "../domains/user-tasks/store.js";
import { isToolProfileName, TOOL_PROFILE_NAMES, type ToolProfileName } from "../tools/profiles.js";
import type { NoticeLevel } from "./command-output.js";
import {
	formatOracleAnswer,
	ORACLE_AGENT_ID,
	ORACLE_TASK,
	type OracleDigestSources,
	packOracleDigest,
} from "./oracle.js";
import { SETTINGS_SECTIONS, type SettingsCenterRowId, type SettingsSectionId } from "./overlays/settings.js";
import type { CommandArgsSpec, CommandPositionalSpec, ParsedArgs } from "./slash-spec.js";
import { matchFromSpec, usageLine } from "./slash-spec.js";
import { formatWorkerShareNote, selectWorkerRunToShare, workerShareFactsFromEntry } from "./worker-share.js";
import type { WorkerEntryState } from "./worker-stream.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 */

type ShareCommandVariant =
	| { kind: "share"; action: "export"; path: string }
	| { kind: "share"; action: "import"; path: string; dryRun: boolean; force: boolean }
	/** Put a finished worker run's answer into the main agent's context. Bare `/share` takes the newest one. */
	| { kind: "share"; action: "worker-run"; runId?: string }
	| { kind: "share"; action: "usage"; subcommand?: "export" | "import"; error?: string };

type SlashCommandVariant =
	| { kind: "quit" }
	| { kind: "help"; query?: string }
	| { kind: "init"; options: InitCommandOptions }
	| { kind: "context-clear"; options: ContextClearCommandOptions }
	| { kind: "context-refresh" }
	/** `ref` is the turnId an `[evicted ...]` marker names. */
	| { kind: "context-recall"; ref: string }
	| { kind: "skill-selector" }
	| { kind: "skill-invocation"; text: string }
	| { kind: "prompts" }
	| { kind: "extensions" }
	| { kind: "interop" }
	| ShareCommandVariant
	/** `source` is the line the operator typed, echoed above the run's transcript block. */
	| { kind: "run"; agentId: string; task: string; options: RunCommandOptions; source: string }
	| { kind: "run-usage" }
	| { kind: "delegate"; agentId: string; task: string; source: string; share?: boolean }
	| { kind: "delegate-usage" }
	| { kind: "btw"; question: string }
	| { kind: "btw-usage" }
	/** `/oracle <question>`: one read-only advisory run briefed on the record, never on the transcript. */
	| { kind: "oracle"; question: string }
	| { kind: "oracle-usage" }
	| { kind: "handoff"; goal: string }
	| { kind: "handoff-usage" }
	/** `/fleet run <name>`: compile the plan, show it for approval, dispatch on accept. */
	| { kind: "fleet-run"; name: string; vars: Record<string, string> }
	| { kind: "fleet-run-usage"; reason?: string }
	| { kind: "agents" }
	| { kind: "cost" }
	| { kind: "context-view" }
	| { kind: "tasks" }
	| { kind: "decisions" }
	| { kind: "tasks-add"; text: string }
	| { kind: "tasks-hand"; id: string }
	| { kind: "tasks-done"; id: string }
	| { kind: "tasks-drop"; id: string }
	| { kind: "memory" }
	| { kind: "memory-seed" }
	| { kind: "view"; filter?: string }
	| { kind: "view-verify"; runId: string }
	| { kind: "view-usage" }
	| { kind: "thinking-set"; level: string }
	| { kind: "output-set"; verbosity: string }
	| { kind: "model" }
	| { kind: "model-set"; pattern: string }
	| { kind: "settings"; section?: SettingsSectionId; rowId?: SettingsCenterRowId }
	| { kind: "resume" }
	| { kind: "new" }
	| { kind: "tree" }
	| { kind: "fork" }
	| { kind: "compact"; instructions: string | undefined }
	| { kind: "export"; path: string | undefined }
	| { kind: "unknown"; text: string }
	/** `text` is the whole line, so a token that turns out to name a prompt template keeps its arguments. */
	| { kind: "unknown-command"; token: string; text: string }
	| { kind: "usage-error"; command: string; reason: string }
	| { kind: "empty" };

export type SlashCommand = SlashCommandVariant;

export type SlashCommandKind = SlashCommand["kind"];

export type SlashCommandDispatchResult = "accepted" | "rejected";

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

export type SetThinkingLevelResult =
	| { status: "applied"; level: string; display: string }
	| { status: "unsupported"; level: string; supported: ReadonlyArray<string> }
	| { status: "unavailable" };

export type SetOutputVerbosityResult =
	| { status: "applied"; verbosity: string }
	| { status: "unsupported"; verbosity: string; supported: ReadonlyArray<string> }
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
	/** Hand the receipt's answer to the main agent when the run finishes. Off by default. */
	share?: boolean;
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
	/**
	 * Operator-turn sink for `--share`. Absent means the flag has nowhere to put
	 * the answer, which is reported rather than silently dropped: an operator who
	 * asked for the model to see a result must not be told it did.
	 */
	submitOperatorNote?: (text: string) => void;
}

/**
 * Hand a finished run's sealed answer to the main agent. The receipt is the
 * terminal truth here rather than the transcript block: the block is a view of
 * this same text, and the caller already holds the receipt.
 */
function shareReceipt(agentId: string, receipt: RunReceipt, deps: HandleRunDeps): void {
	if (!deps.submitOperatorNote) {
		deps.notice("error", "--share is not wired in this session; the result stayed local");
		return;
	}
	const note = formatWorkerShareNote({
		agentId,
		runId: receipt.runId,
		outcome: receipt.outcome,
		text: receipt.output?.text ?? "",
	});
	if (note === null) {
		deps.notice("warn", `--share: run ${receipt.runId} produced no text to share`);
		return;
	}
	deps.submitOperatorNote(note);
}

/**
 * The attributed half every operator-started run shares, whether `/run` or
 * `/delegate` built the request. Dispatch it, forward its events for surfaces
 * that do not share the domain's bus, wait for the receipt, keep the notice bar
 * quiet on success because the transcript block is the success signal, and
 * share the sealed answer only when the operator asked. A failed run is still
 * worth sharing when they did: the failure text is what they would want the
 * main agent to work from.
 */
async function runAttributed(
	command: "run" | "delegate",
	request: DispatchRequest,
	deps: HandleRunDeps,
	share: boolean,
): Promise<void> {
	const { dispatch, notice, bus } = deps;
	const progressBus = dispatch.ownsProgressBus?.(bus) === true ? undefined : bus;
	try {
		const handle = await dispatch.dispatch(request);
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			progressBus?.emit(BusChannels.DispatchProgress, { runId: handle.runId, agentId: request.agentId, event });
		}
		const receipt = await handle.finalPromise;
		if (receipt.exitCode !== 0 || receipt.failureMessage) {
			const failure = receipt.failureMessage ? ` ${receipt.failureMessage}` : "";
			notice("error", `${command} failed: exit=${receipt.exitCode}${failure}`);
		}
		if (share) shareReceipt(request.agentId, receipt, deps);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		notice("error", `${command} failed: ${msg}`);
	}
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
	if (options.target && options.workerProfile) {
		deps.notice(
			"warn",
			`--target ${options.target} takes precedence; --agent-profile ${options.workerProfile} will be ignored`,
		);
	}
	if (options.target && options.workerRuntime) {
		deps.notice(
			"warn",
			`--target ${options.target} takes precedence; --runtime ${options.workerRuntime} will be ignored`,
		);
	}
	await runAttributed(
		"run",
		{
			agentId,
			task,
			executionRole: requestExecutionRole({
				agentId,
				...(deps.getAgentRoleFacts ? { resolveFacts: deps.getAgentRoleFacts } : {}),
			}),
			requestOrigin: "user",
			...(options.workerProfile ? { workerProfile: options.workerProfile } : {}),
			...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
			...(options.target ? { target: options.target } : {}),
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options.toolProfile ? { toolProfile: options.toolProfile } : {}),
			...(options.requiredCapabilities && options.requiredCapabilities.length > 0
				? { requiredCapabilities: options.requiredCapabilities }
				: {}),
		},
		deps,
		options.share === true,
	);
}

async function handleDelegate(
	agentId: string,
	task: string,
	deps: HandleRunDeps,
	options: { share?: boolean } = {},
): Promise<void> {
	await runAttributed(
		"delegate",
		{ agentId, delegationAgentId: agentId, executionRole: "builder", requestOrigin: "user", task },
		deps,
		options.share === true,
	);
}

/**
 * `/oracle <question>`: one advisory run, dispatched like any other.
 *
 * Nothing here is a side channel. The run goes through the ordinary dispatch
 * path, so admission, the receipt, and the Fleet Runs island treat it exactly
 * as they treat a `/run`; `requestOrigin: "internal"` is what lets a shadow
 * recipe be reached at all, and `autonomy: "read-only"` narrows the worker
 * below whatever the session holds. The answer reaches the main agent the way
 * `/share` puts one there: an operator-authored note on the ordinary user-turn
 * path, never a fabricated tool result.
 */
async function handleOracle(question: string, ctx: SlashCommandContext): Promise<void> {
	if (!ctx.submitOperatorNote) {
		ctx.notice("error", "/oracle is not wired in this session; there is nowhere to put the answer");
		return;
	}
	// Refused, never queued. The digest describes the record as it stands and a
	// turn still in flight is about to change it, so an answer written against
	// the old record would be advice about a session that no longer exists.
	if (ctx.isTurnInFlight?.() === true) {
		ctx.notice("warn", "a turn is in flight; /oracle is refused rather than queued");
		return;
	}
	const sources = ctx.oracleBriefing?.();
	if (!sources) {
		ctx.notice("error", "/oracle needs the session record, which is not wired in this session");
		return;
	}
	const digest = packOracleDigest({ ...sources, question });
	const request: DispatchRequest = {
		agentId: ORACLE_AGENT_ID,
		task: ORACLE_TASK,
		briefing: digest.text,
		executionRole: requestExecutionRole({
			agentId: ORACLE_AGENT_ID,
			...(ctx.getAgentRoleFacts ? { resolveFacts: ctx.getAgentRoleFacts } : {}),
		}),
		requestOrigin: "internal",
		autonomy: "read-only",
	};
	const progressBus = ctx.dispatch.ownsProgressBus?.(ctx.bus) === true ? undefined : ctx.bus;
	try {
		const handle = await ctx.dispatch.dispatch(request);
		for await (const event of handle.events) {
			const typed = event as { type?: string };
			if (!typed.type || typed.type === "heartbeat") continue;
			progressBus?.emit(BusChannels.DispatchProgress, { runId: handle.runId, agentId: ORACLE_AGENT_ID, event });
		}
		const receipt = await handle.finalPromise;
		const parsed = parseOracleResult(receipt.output?.text ?? null);
		if (parsed === null) {
			ctx.notice("error", `/oracle run ${receipt.runId} returned no usable answer (${receipt.outcome})`);
			return;
		}
		const note = formatWorkerShareNote({
			agentId: ORACLE_AGENT_ID,
			runId: receipt.runId,
			outcome: receipt.outcome,
			text: formatOracleAnswer(parsed),
		});
		if (note === null) {
			ctx.notice("error", `/oracle run ${receipt.runId} produced no text to share`);
			return;
		}
		ctx.submitOperatorNote(note);
	} catch (err) {
		ctx.notice("error", `/oracle failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * `/share [runId]`: hand a finished worker run's answer to the main agent.
 *
 * Nothing here is implicit. The operator either typed the command or passed
 * `--share`, and the note travels the ordinary user-turn path, so the model
 * receives it exactly as it receives anything else the operator writes.
 */
function shareWorkerRun(runId: string | undefined, ctx: SlashCommandContext): void {
	if (!ctx.submitOperatorNote) {
		ctx.notice("error", "share is not wired; the worker transcript is unavailable in this session");
		return;
	}
	const entry = selectWorkerRunToShare(ctx.listWorkerRuns?.() ?? [], runId);
	if (!entry) {
		ctx.notice(
			"error",
			runId === undefined
				? "no finished /run or /delegate result to share yet"
				: `no finished run ${runId} in this session`,
		);
		return;
	}
	const facts = workerShareFactsFromEntry(entry);
	const note = facts === null ? null : formatWorkerShareNote(facts);
	if (note === null) {
		ctx.notice("error", `run ${entry.runId} produced no text to share`);
		return;
	}
	ctx.submitOperatorNote(note);
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
	/**
	 * Echo the typed command line into the transcript, dimmed, before the block
	 * it starts. `/run` and `/delegate` use it so a worker's attributed block has
	 * the request above it. Transcript-only; the line never enters model context.
	 */
	echoOperatorCommand?: (text: string) => void;
	/**
	 * Put operator-authored text into the session the way typed text enters it:
	 * a user turn, persisted in the ledger, visible in the transcript. Used only
	 * by `--share` and `/share`, and never with expansion, because a worker's
	 * answer is literal text and must not be re-read as file or skill syntax.
	 */
	submitOperatorNote?: (text: string) => void;
	/** Worker blocks this session folded, oldest first. `/share` picks from these. */
	listWorkerRuns?: () => ReadonlyArray<WorkerEntryState>;
	/** Fire-and-forget shutdown. Handler must not await. */
	shutdown: () => void;
	runInit: (options: InitCommandOptions) => void;
	/** Write the current session transcript (all tool segments expanded, ANSI-stripped) to a Markdown file. */
	exportTranscript: (path?: string) => void;
	runContextClear: (options: ContextClearCommandOptions) => void;
	/**
	 * Re-index the codewiki and refresh `.clio-coder` state without touching CLIO-CODER.md.
	 * Optional until the host wires onContextRefresh.
	 */
	runContextRefresh?: () => void;
	/**
	 * Read an evicted tool-result body back into the transcript by ref, and
	 * record the `contextRecall` entry. Transcript-only: an operator recall
	 * answers the person, so the body never becomes model context. Optional
	 * until the host wires a session.
	 */
	runContextRecall?: (ref: string) => void;
	openSkillsHub?: () => void;
	listPrompts: () => ResourceList<PromptTemplate>;
	/**
	 * Resolve a `/name` against the loaded prompt templates. Absent when the host
	 * wired no resources, in which case a command-shaped token that names no
	 * builtin is simply not a command.
	 */
	expandPromptTemplate?: (text: string) => PromptTemplateExpansion;
	listExtensions?: () => ReadonlyArray<InstalledExtension>;
	/** Detection report, pending proposals, and the two consent actions `/interop` drives. */
	interop?: {
		report: () => InteropReport | null;
		proposals: () => ReadonlyArray<InteropProposal>;
		configured: () => ReadonlyArray<{ id: string; command: string; args: ReadonlyArray<string> }>;
		accept: (kind: InteropAgentId) => void;
		decline: (kind: InteropAgentId) => void;
	};
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
	openCost: () => void;
	/**
	 * `/btw <question>`: one model round beside the session, answered in an
	 * overlay. Nothing about it enters the transcript, the ledger, or the task
	 * board, so the workers a fleet run briefs never see the question or its
	 * answer.
	 */
	openSideQuestion: (question: string) => void;
	/**
	 * The record `/oracle` briefs its advisor on: settled decisions, the task
	 * board, and the last compaction summary. Absent on a host with no session,
	 * in which case `/oracle` says so instead of briefing on nothing.
	 */
	oracleBriefing?: () => Omit<OracleDigestSources, "question">;
	/**
	 * True while a turn is streaming. `/oracle` is refused then, never queued:
	 * the digest describes the record as it stands and an in-flight turn is
	 * about to change it.
	 */
	isTurnInFlight?: () => boolean;
	/**
	 * `/handoff <goal>`: extract this session's working state for a stated goal,
	 * review the document, and seed a successor session with it. A session
	 * operation only. It writes no memory promotion candidate and never calls
	 * the task-memory bank.
	 */
	startHandoff: (goal: string) => void;
	/**
	 * `/fleet run <name>`: compile the contract's plan, show every wave, agent,
	 * target, boundary, budget, and code-step argv for approval, and dispatch
	 * only what the operator accepted. Absent on a host with no fleet wiring.
	 */
	startFleetRun?: (name: string, vars: Readonly<Record<string, string>>) => void;
	/** Open the read-only `/context` overlay: categorized context-window ledger. */
	openContextView: () => void;
	/** Open the read-only `/tasks` overlay: the session task board with receipts. */
	openTasks: () => void;
	/** Open the settled, branch-local interview decision board. */
	openDecisions: () => void;
	/** Project-scoped operator task inbox backing `/tasks` mutations. */
	userTasks?: {
		add(title: string): UserTask;
		hand(id: string): UserTask;
		done(id: string): UserTask;
		drop(id: string): UserTask;
	};
	/** Open `/memory` for approved lessons, the live task bank, and reviewed promotion. */
	openMemory: () => void;
	/** Opt-in import from the newest structured handoff; absent when the host has no task bank. */
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	/** Open `/view`, the full observability artifact viewer. */
	openView: (filter?: string) => void;
	/**
	 * Apply a thinking level named on the command line. Returns why it was
	 * refused so the caller can say so, because the level the operator typed may
	 * not be one the active target supports.
	 */
	setThinkingLevel?: (level: string) => SetThinkingLevelResult;
	/** Apply a transcript verbosity named on the command line; refused values are reported by the caller. */
	setOutputVerbosity?: (verbosity: string) => SetOutputVerbosityResult;
	openModel: () => void;
	/** Live providers contract used by `/model <pattern>` to resolve directly. */
	providers: ProvidersContract;
	/** Apply a resolved model reference to settings (and optionally thinking level). */
	applyModelRef: (ref: ResolvedModelRef) => void;
	openSettings: (section?: SettingsSectionId, rowId?: SettingsCenterRowId) => void;
	openResume: () => void;
	startNewSession: () => void;
	openTree: () => void;
	openMessagePicker: () => void;
	openHelp: (query?: string) => void;
	openAgents: () => void;
	openPrompts: () => void;
	openExtensions: () => void;
	openInterop?: () => void;
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

/** The one operator-authored turn used by slash and overlay handoff paths. */
export function formatUserTaskHandoff(task: Pick<UserTask, "id" | "title" | "note">): string {
	const note = task.note ? ` ${task.note}.` : "";
	return `Operator task ${task.id}: ${task.title}.${note} Pick it up with tasks action="pick" id="${task.id}" and work it when appropriate.`;
}

/** The verb a command performs, in the order /help lists the groups. */
export const SLASH_COMMAND_GROUPS = ["Run", "Inspect", "Configure", "Sessions"] as const;
export type SlashCommandGroup = (typeof SLASH_COMMAND_GROUPS)[number];

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	group: SlashCommandGroup;
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

const RUN_THINKING_LEVELS: ReadonlyArray<JobThinkingLevel> = THINKING_LEVELS;

function isRunThinkingLevel(value: string): value is JobThinkingLevel {
	return RUN_THINKING_LEVELS.some((level) => level === value);
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
	return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** `/context compact` alone keeps a free-form optional instruction tail. */
const COMPACT_POSITIONALS: ReadonlyArray<CommandPositionalSpec> = [
	{ name: "instructions", required: false, rest: true },
];

/**
 * `/context recall <ref>` takes exactly one ref, not a rest tail: a ref is a
 * single turnId, and a second token is a mistake worth reporting rather than
 * text to fold into the first.
 */
const RECALL_POSITIONALS: ReadonlyArray<CommandPositionalSpec> = [{ name: "ref", required: true }];

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

/**
 * A configuration-shaped command that is a shortcut into one settings section.
 * It parses to the same `settings` command `/settings <section>` produces, so
 * the settings entry dispatches it and this entry owns no kind of its own.
 */
function settingsDeepLink(
	name: string,
	section: SettingsSectionId,
	description: string,
	rowId?: SettingsCenterRowId,
): BuiltinSlashCommand {
	return {
		name,
		description,
		group: "Configure",
		kinds: [],
		args: {},
		fromArgs: fromArgsOrUsage(name, { kind: "settings", section, ...(rowId ? { rowId } : {}) }),
		handle: () => undefined,
	};
}

function usageNotice(entry: BuiltinSlashCommand, subcommand?: string): string {
	return usageLine(entry, subcommand).trim();
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "quit",
		description: "Exit Clio Coder",
		group: "Sessions",
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
		group: "Inspect",
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
		group: "Run",
		kinds: ["skill-selector", "skill-invocation"],
		args: {
			positionals: [
				{ name: "name", required: false },
				{ name: "task", required: false, rest: true },
			],
		},
		match(trimmed) {
			if (trimmed === "/skill") {
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
		group: "Inspect",
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
		group: "Inspect",
		kinds: ["extensions"],
		args: {},
		fromArgs: fromArgsOrUsage("extensions", { kind: "extensions" }),
		handle(_command, ctx) {
			ctx.openExtensions?.();
		},
	},
	{
		name: "interop",
		description: "Review other coding agents detected on this machine",
		group: "Inspect",
		kinds: ["interop"],
		args: {},
		fromArgs: fromArgsOrUsage("interop", { kind: "interop" }),
		handle(_command, ctx) {
			ctx.openInterop?.();
		},
	},
	{
		name: "share",
		description: "Share a worker result with the main agent, or export and import Clio archives",
		group: "Sessions",
		kinds: ["share"],
		args: {
			positionals: [{ name: "runId", required: false }],
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
			// No subcommand means the worker-result sense of the word, with or
			// without a run id. `export` and `import` are the archive senses and are
			// matched above, so neither reading can swallow the other.
			if (subcommand === undefined) {
				return { kind: "share", action: "worker-run", ...(path !== undefined ? { runId: path } : {}) };
			}
			return { kind: "share", action: "usage", ...(subcommand !== undefined ? { subcommand } : {}) };
		},
		handle(command, ctx) {
			if (command.kind !== "share") return;
			if (command.action === "worker-run") {
				shareWorkerRun(command.runId, ctx);
				return;
			}
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
		group: "Run",
		kinds: ["run", "run-usage"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--agent-profile", takesValue: true, valueName: "profile" },
				{ name: "--runtime", takesValue: true, valueName: "runtimeId" },
				{ name: "--target", takesValue: true, valueName: "id" },
				{ name: "--model", takesValue: true, valueName: "id" },
				{ name: "--thinking", takesValue: true, values: RUN_THINKING_LEVELS, valueName: "level" },
				{ name: "--tool-profile", takesValue: true, values: TOOL_PROFILE_NAMES },
				{ name: "--require", takesValue: true, repeatable: true, valueName: "cap" },
				{ name: "--share" },
			],
			positionals: [
				{ name: "agent", required: true },
				{ name: "task", required: true, rest: true },
			],
		},
		fromArgs(parsed, trimmed) {
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

			if (parsed.flags.has("--share")) options.share = true;

			const agentId = parsed.positionals[0] ?? "";
			const task = parsed.positionals[1] ?? "";

			return { kind: "run", agentId, task, options, source: trimmed };
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
			ctx.echoOperatorCommand?.(command.source);
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
						...(ctx.submitOperatorNote ? { submitOperatorNote: ctx.submitOperatorNote } : {}),
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
		group: "Run",
		kinds: ["delegate", "delegate-usage"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [{ name: "--share" }],
			positionals: [
				{ name: "agent-id", required: true },
				{ name: "task", required: true, rest: true },
			],
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "delegate-usage" };
			const agentId = parsed.positionals[0] ?? "";
			const task = parsed.positionals[1] ?? "";
			return { kind: "delegate", agentId, task, source: trimmed, ...(parsed.flags.has("--share") ? { share: true } : {}) };
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
			ctx.echoOperatorCommand?.(command.source);
			const share = command.share === true;
			void (async () => {
				await handleDelegate(
					command.agentId,
					command.task,
					{
						dispatch: ctx.dispatch,
						io: ctx.io,
						notice: ctx.notice,
						bus: ctx.bus,
						...(ctx.submitOperatorNote ? { submitOperatorNote: ctx.submitOperatorNote } : {}),
					},
					{ share },
				);
				ctx.render();
			})();
		},
	},
	{
		name: "btw",
		description: "Ask a side question that never enters the session transcript",
		group: "Run",
		kinds: ["btw", "btw-usage"],
		args: {
			positionals: [{ name: "question", required: true, rest: true }],
		},
		fromArgs(parsed) {
			const question = parsed.rest?.trim() ?? "";
			if (parsed.error || question.length === 0) return { kind: "btw-usage" };
			return { kind: "btw", question };
		},
		handle(command, ctx) {
			if (command.kind === "btw-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "btw");
				if (entry) ctx.notice("info", usageNotice(entry));
				return;
			}
			if (command.kind !== "btw") return;
			ctx.openSideQuestion(command.question);
		},
	},
	{
		name: "oracle",
		description: "Ask a read-only advisor to challenge a question against this session's settled decisions",
		group: "Run",
		kinds: ["oracle", "oracle-usage"],
		args: {
			positionals: [{ name: "question", required: true, rest: true }],
		},
		fromArgs(parsed) {
			const question = parsed.rest?.trim() ?? "";
			if (parsed.error || question.length === 0) return { kind: "oracle-usage" };
			return { kind: "oracle", question };
		},
		handle(command, ctx) {
			if (command.kind === "oracle-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "oracle");
				if (entry) ctx.notice("info", usageNotice(entry));
				return;
			}
			if (command.kind !== "oracle") return;
			void (async () => {
				await handleOracle(command.question, ctx);
				ctx.render();
			})();
		},
	},
	{
		name: "agents",
		description: "List Clio agents and ACP delegation agents",
		group: "Inspect",
		kinds: ["agents"],
		args: {},
		fromArgs: fromArgsOrUsage("agents", { kind: "agents" }),
		handle(_command, ctx) {
			ctx.openAgents();
		},
	},
	settingsDeepLink("targets", "targets", "Open Settings → Targets: health, use, connect, probe, remove"),
	{
		name: "cost",
		description: "Show session token and cost totals",
		group: "Inspect",
		kinds: ["cost"],
		args: {},
		fromArgs: fromArgsOrUsage("cost", { kind: "cost" }),
		handle(_command, ctx) {
			ctx.openCost();
		},
	},
	{
		name: "context",
		description: "Context hub: window overlay plus compact, recall, init, refresh, and reset",
		group: "Inspect",
		kinds: ["context-view", "compact", "context-recall", "init", "context-clear", "context-refresh"],
		subcommandDescriptions: {
			compact: "Compact session context",
			recall: "Recall an evicted result",
			init: "Initialize project context",
			refresh: "Refresh project context",
			reset: "Reset project context",
		},
		args: {
			subcommands: {
				compact: { positionals: [...COMPACT_POSITIONALS] },
				recall: { positionals: [...RECALL_POSITIONALS] },
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
				case "recall":
					return { kind: "context-recall", ref: parsed.positionals[0] ?? "" };
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
				case "context-recall":
					if (ctx.runContextRecall) {
						ctx.runContextRecall(command.ref);
					} else {
						ctx.notice("error", "context recall is not wired; no session is bound to this process");
					}
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
		description: "Open Settings → Fleet, or run a fleet contract with an approval preview",
		group: "Configure",
		kinds: ["fleet-run", "fleet-run-usage"],
		subcommandDescriptions: { run: "Preview and run a repo-owned fleet contract" },
		args: {
			subcommands: {
				run: {
					flags: [{ name: "--var", takesValue: true, repeatable: true, valueName: "key=value" }],
					positionals: [{ name: "name", required: true }],
				},
			},
		},
		/**
		 * `/fleet` alone keeps the settings deep link it has always been, and
		 * only `run` parses as a command of its own, so an operator who types
		 * `/fleet` out of habit still lands in Settings → Fleet. Anything else
		 * on the line stays the usage error every other deep link reports.
		 */
		fromArgs(parsed) {
			if (parsed.subcommand !== "run") {
				return parsed.error
					? { kind: "usage-error", command: "fleet", reason: parsed.error }
					: { kind: "settings", section: "fleet" };
			}
			if (parsed.error) return { kind: "fleet-run-usage", reason: parsed.error };
			const name = parsed.positionals[0] ?? "";
			if (name.length === 0) return { kind: "fleet-run-usage" };
			const vars: Record<string, string> = {};
			for (const pair of parsed.flagValues.get("--var") ?? []) {
				const eq = pair.indexOf("=");
				const key = eq < 0 ? "" : pair.slice(0, eq).trim();
				if (key.length === 0) return { kind: "fleet-run-usage", reason: "--var requires key=value" };
				vars[key] = pair.slice(eq + 1);
			}
			return { kind: "fleet-run", name, vars };
		},
		handle(command, ctx) {
			if (command.kind === "fleet-run-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "fleet");
				const usage = entry ? usageNotice(entry, "run") : "usage: /fleet run <name> [--var key=value ...]";
				ctx.notice("info", command.reason ? `${command.reason}\n${usage}` : usage);
				return;
			}
			if (command.kind !== "fleet-run") return;
			if (!ctx.startFleetRun) {
				ctx.notice("error", "/fleet run is not wired in this session");
				return;
			}
			ctx.startFleetRun(command.name, command.vars);
		},
	},
	{
		name: "decisions",
		description: "Show settled interview decisions and operator revisions",
		group: "Inspect",
		kinds: ["decisions"],
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "decisions", reason: parsed.error };
			return { kind: "decisions" };
		},
		handle(_command, ctx) {
			ctx.openDecisions();
		},
	},
	{
		name: "tasks",
		description: "Show the session board or manage project operator tasks",
		group: "Inspect",
		kinds: ["tasks", "tasks-add", "tasks-hand", "tasks-done", "tasks-drop"],
		subcommandDescriptions: {
			add: "Log a project task without notifying the agent",
			hand: "Hand an operator task to the agent",
			done: "Mark an operator task done",
			drop: "Drop an operator task",
		},
		args: {
			subcommands: {
				add: { positionals: [{ name: "text", required: true, rest: true }] },
				hand: { positionals: [{ name: "id", required: true }] },
				done: { positionals: [{ name: "id", required: true }] },
				drop: { positionals: [{ name: "id", required: true }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "tasks", reason: parsed.error };
			switch (parsed.subcommand) {
				case "add":
					return parsed.rest
						? { kind: "tasks-add", text: parsed.rest }
						: { kind: "usage-error", command: "tasks", reason: "add requires task text" };
				case "hand":
				case "done":
				case "drop": {
					const id = parsed.positionals[0];
					if (!id || !/^u[1-9]\d*$/.test(id)) {
						return { kind: "usage-error", command: "tasks", reason: `${parsed.subcommand} requires a uN id` };
					}
					if (parsed.subcommand === "hand") return { kind: "tasks-hand", id };
					if (parsed.subcommand === "done") return { kind: "tasks-done", id };
					return { kind: "tasks-drop", id };
				}
				default:
					return { kind: "tasks" };
			}
		},
		handle(command, ctx) {
			if (command.kind === "tasks") {
				ctx.openTasks();
				return;
			}
			if (!ctx.userTasks) {
				ctx.notice("error", "operator task inbox is not wired in this session");
				return;
			}
			try {
				if (command.kind === "tasks-add") {
					const task = ctx.userTasks.add(command.text);
					ctx.notice("success", `logged operator task ${task.id}: ${task.title}`);
					return;
				}
				if (command.kind === "tasks-hand") {
					const task = ctx.userTasks.hand(command.id);
					ctx.submitChat(formatUserTaskHandoff(task));
					return;
				}
				if (command.kind === "tasks-done") {
					const task = ctx.userTasks.done(command.id);
					ctx.notice("success", `marked operator task ${task.id} done`);
					return;
				}
				if (command.kind === "tasks-drop") {
					const task = ctx.userTasks.drop(command.id);
					ctx.notice("success", `dropped operator task ${task.id}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.notice("error", message);
			}
		},
	},
	{
		name: "memory",
		description: "Inspect, promote, or seed task memory",
		group: "Inspect",
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
		group: "Inspect",
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
		description: "Set the chat thinking level, or open Settings → Orchestrator",
		group: "Configure",
		kinds: ["thinking-set"],
		args: { positionals: [{ name: "level", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "thinking", reason: parsed.error };
			const level = parsed.positionals[0];
			return level
				? { kind: "thinking-set", level }
				: { kind: "settings", section: "orchestrator", rowId: "orchestrator.thinkingLevel" };
		},
		handle(command, ctx) {
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
		description: "Set transcript detail (minimal, default, verbose), or open Settings → Terminal",
		group: "Configure",
		kinds: ["output-set"],
		args: { positionals: [{ name: "verbosity", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "output", reason: parsed.error };
			const verbosity = parsed.positionals[0];
			return verbosity
				? { kind: "output-set", verbosity }
				: { kind: "settings", section: "terminal", rowId: "terminal.outputVerbosity" };
		},
		handle(command, ctx) {
			if (command.kind !== "output-set") return;
			const result = ctx.setOutputVerbosity?.(command.verbosity) ?? { status: "unavailable" as const };
			if (result.status === "applied") {
				ctx.notice("success", `output detail: ${result.verbosity}`);
			} else if (result.status === "unsupported") {
				ctx.notice("error", `output detail "${result.verbosity}" is not one of ${result.supported.join(", ")}`);
			} else {
				ctx.notice("error", "output detail cannot be set right now");
			}
			ctx.render();
		},
	},
	{
		name: "model",
		description: "Open model selector or set a model",
		group: "Configure",
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
	settingsDeepLink(
		"scoped-models",
		"models",
		"Open Settings → Models: the Alt+J / Alt+K cycle set and favorites",
		"scope",
	),
	{
		name: "settings",
		description: "Open interactive settings",
		group: "Configure",
		kinds: ["settings"],
		args: { positionals: [{ name: "section", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "settings", reason: parsed.error };
			const section = parsed.positionals[0];
			if (section === undefined) return { kind: "settings" };
			if (!isSettingsSectionId(section)) {
				const known = SETTINGS_SECTIONS.map((entry) => entry.id).join(", ");
				return { kind: "usage-error", command: "settings", reason: `Unknown section: ${section} (one of ${known})` };
			}
			return { kind: "settings", section };
		},
		handle(command, ctx) {
			if (command.kind === "settings") ctx.openSettings(command.section, command.rowId);
		},
	},
	{
		name: "resume",
		description: "Resume a past session",
		group: "Sessions",
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
		group: "Sessions",
		kinds: ["new"],
		args: {},
		fromArgs: fromArgsOrUsage("new", { kind: "new" }),
		handle(_command, ctx) {
			ctx.startNewSession();
		},
	},
	{
		name: "handoff",
		description: "Hand this session's working state to a fresh session for a stated goal",
		group: "Sessions",
		kinds: ["handoff", "handoff-usage"],
		args: {
			positionals: [{ name: "goal", required: true, rest: true }],
		},
		fromArgs(parsed) {
			const goal = parsed.rest?.trim() ?? "";
			if (parsed.error || goal.length === 0) return { kind: "handoff-usage" };
			return { kind: "handoff", goal };
		},
		handle(command, ctx) {
			if (command.kind === "handoff-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "handoff");
				if (entry) ctx.notice("info", usageNotice(entry));
				return;
			}
			if (command.kind !== "handoff") return;
			ctx.startHandoff(command.goal);
		},
	},
	{
		name: "tree",
		description: "Open session tree navigator",
		group: "Sessions",
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
		group: "Sessions",
		kinds: ["fork"],
		args: {},
		fromArgs: fromArgsOrUsage("fork", { kind: "fork" }),
		handle(_command, ctx) {
			ctx.openMessagePicker();
		},
	},
	{
		name: "export",
		description: "Export a self-contained HTML transcript by default; a .md path writes Markdown",
		group: "Sessions",
		kinds: ["export"],
		args: {
			positionals: [{ name: "path", required: false }],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "export", reason: parsed.error };
			return { kind: "export", path: parsed.positionals[0] };
		},
		handle(command, ctx) {
			if (command.kind !== "export") return;
			ctx.exportTranscript(command.path);
		},
	},
];

const HANDLER_BY_KIND = new Map<SlashCommandKind, BuiltinSlashCommand>();
const COMMAND_NAMES = new Set<string>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
	if (COMMAND_NAMES.has(entry.name)) {
		throw new Error(`BUILTIN_SLASH_COMMANDS: command name "${entry.name}" is registered more than once`);
	}
	COMMAND_NAMES.add(entry.name);
	for (const kind of entry.kinds) {
		if (HANDLER_BY_KIND.has(kind)) {
			throw new Error(`BUILTIN_SLASH_COMMANDS: kind "${kind}" is owned by multiple entries`);
		}
		HANDLER_BY_KIND.set(kind, entry);
	}
}

/**
 * A token that could only have been meant as a command: one word of letters,
 * digits, hyphens, or colons after the leading slash. Colons are included so
 * retired compact forms such as `/skill:name` fail closed instead of becoming
 * model input.
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
 * leading slash is also how an absolute path starts. `/home/user/notes` and
 * `/not/a/command` carry a separator, so they are not one word and still reach
 * the model unchanged.
 *
 * One word followed by prose stays ambiguous: `/status please` is the defect
 * and `/tmp is full` is a sentence, and nothing in the text separates them. It
 * resolves as a command, so a sentence that has to open this way needs
 * COMMAND_ESCAPE.
 */
const COMMAND_SHAPED_TOKEN = /^[A-Za-z][A-Za-z0-9:-]*$/u;

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
		if (COMMAND_SHAPED_TOKEN.test(token)) return { kind: "unknown-command", token, text: trimmed };
	}
	return { kind: "unknown", text: trimmed };
}

/**
 * Dispatches a parsed SlashCommand to its owning registry entry. `empty` is a
 * no-op and `unknown` falls through to chat submission; every other kind
 * resolves to exactly one registry entry at module load. The result tells the
 * editor whether dispatch accepted the line or left it as a correctable draft.
 */
export function dispatchSlashCommand(command: SlashCommand, ctx: SlashCommandContext): SlashCommandDispatchResult {
	if (command.kind === "empty") return "rejected";
	if (command.kind === "unknown") {
		ctx.submitChat(command.text);
		return "accepted";
	}
	if (command.kind === "unknown-command") {
		// The registry does not own the token, but a prompt template might. The
		// parser stays pure, so the lookup happens here, and only for a spelling
		// that matched no command: `/name` is how every other agent invokes the
		// commands sitting in the roots Clio reads, and answering "not a command"
		// for one that is loaded made the whole foreign prompt surface unreachable.
		const expansion = ctx.expandPromptTemplate?.(command.text);
		if (expansion?.expanded === true) {
			ctx.submitChat(command.text);
			return "accepted";
		}
		// A template that exists and refused is not a typo. Its reason reaches the
		// operator and nothing reaches the model.
		const refusal = expansion?.expanded === false ? expansion.refusal : undefined;
		ctx.notice("error", refusal ? refusal.message : `/${command.token} is not a command. Type /help for the list.`);
		ctx.render();
		return "rejected";
	}
	if (command.kind === "usage-error") {
		const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === command.command);
		const usage = entry ? ` ${usageNotice(entry)}` : "";
		ctx.notice("error", `${command.reason}.${usage}`);
		ctx.render();
		return "rejected";
	}
	const entry = HANDLER_BY_KIND.get(command.kind);
	if (!entry) return "rejected";
	entry.handle(command, ctx);
	return "accepted";
}

export interface CommandReferenceEntry {
	name: string;
	usage: string;
	description: string;
	group: SlashCommandGroup;
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
			usage,
			description: entry.description,
			group: entry.group,
			...(entry.args ? { args: entry.args } : {}),
			...(entry.subcommandDescriptions ? { subcommandDescriptions: entry.subcommandDescriptions } : {}),
		};
	});
}
