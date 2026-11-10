import { existsSync } from "node:fs";
import path from "node:path";
import { mcpCommandOutput } from "../cli/mcp.js";
import { acceptanceFromTaskFlags } from "../cli/tasks.js";
import { THINKING_LEVELS } from "../core/defaults.js";
import type { SettingsAreaId } from "../core/settings-areas.js";
import { resolveSettingsArea, SETTINGS_AREAS } from "../core/settings-areas.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { parseCouncilReport, parseOracleResult } from "../domains/agents/index.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { ContextInitOptions } from "../domains/context/init-options.js";
import {
	applyInitImplications,
	CONTEXT_INIT_FLAG_TABLE,
	validateInitOptions,
} from "../domains/context/init-options.js";
import { AdmissionCanceledError } from "../domains/dispatch/admission-error.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import type { AgentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import { requestExecutionRole } from "../domains/dispatch/execution-role.js";
import {
	plainOutcomeLabel,
	STALLED_RUN_HEADLINE,
	workerFailureHeadline,
} from "../domains/dispatch/failure-headline.js";
import type { RunResult } from "../domains/dispatch/types.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import { classifyVerifiability, verifiabilityRoute } from "../domains/evidence/verifiability.js";
import type { InstalledExtension } from "../domains/extensions/index.js";
import { isExtensionCommandToken, promptRefs } from "../domains/extensions/operator-commands.js";
import type { OperatorCommandOutput, OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import { extensionOwnerLabel } from "../domains/extensions/owner-label.js";
import type { InteropAgentId, InteropProposal, InteropReport } from "../domains/interop/index.js";
import { isInteropHeadlessRuntime } from "../domains/interop/peer-modes.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import type { MusicOperations, MusicResult } from "../domains/mux/music-operations.js";
import { describeMusicResult, musicResultTone } from "../domains/mux/music-operations.js";
import type { PanePeerId, PanesOperations, PanesPresetId, PanesStatus } from "../domains/mux/operations.js";
import { PANE_PEER_IDS, PANES_PRESET_IDS, PANES_PRESETS, resolvePanesPresetId } from "../domains/mux/operations.js";
import { isClioHostSocket } from "../domains/mux/workspace/platform.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import { acceptsImageInput, resolveModelCapabilities, resolveModelReference } from "../domains/providers/index.js";
import {
	chooseSecondOpinionRoute,
	type SecondOpinionCandidate,
	secondOpinionIndependence,
} from "../domains/providers/model-lineage.js";
import type { ReportTextDuplicate, ReportTextHost } from "../domains/report/text-flow.js";
import type {
	LibraryEntryKind,
	PromptTemplate,
	PromptTemplateExpansion,
	ResourceList,
} from "../domains/resources/index.js";
import { parseSkillCommand, SKILL_SURFACE_CLEAR_ARG } from "../domains/resources/index.js";
import { isLibraryKind } from "../domains/resources/library-types.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { activeDecisionRefs } from "../domains/session/decision-board.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import type { ShareImportPlan } from "../domains/share/index.js";
import type { UserTaskAcceptance } from "../domains/user-tasks/acceptance.js";
import { formatUserTaskHandoff } from "../domains/user-tasks/handoff.js";
import type { UserTask } from "../domains/user-tasks/store.js";
import type { ExtensionReloadOutcome } from "../entry/extension-reload.js";
import type { JobOperations } from "../tools/job-types.js";
import type { ToolProfileName } from "../tools/profiles.js";
import { isToolProfileName, TOOL_PROFILE_NAMES } from "../tools/profiles.js";
import type { CouncilCommandOptions, CouncilRosters } from "./council.js";
import {
	buildCouncilDispatchArgs,
	COUNCIL_MAX_ROUNDS,
	COUNCIL_SYNTHESIS_LABEL,
	COUNCIL_SYNTHESIS_MODES,
	isCouncilSynthesisMode,
	resolveCouncilRoster,
} from "./council.js";
import { parseDraftArgs } from "./drafts.js";
import {
	LOOP_NO_HOST_NOTICE,
	LOOP_OBSERVE_VERBS,
	LOOP_SUBCOMMAND_DESCRIPTIONS,
	type LoopCommand,
	parseLoopLine,
	runLoopCommand,
} from "./loop-command.js";
import type { NoticeLevel } from "./notice-source.js";
import type { OracleDigestSources } from "./oracle.js";
import { formatOracleAnswer, ORACLE_AGENT_ID, ORACLE_TASK, packOracleDigest } from "./oracle.js";
import { promptSourceLabel } from "./prompt-source-label.js";
import type { ReloadTarget } from "./reload-report.js";
import type { CommandArgsSpec, CommandPositionalSpec, ParsedArgs } from "./slash-spec.js";
import { matchFromSpec, usageLine } from "./slash-spec.js";
import type { WorkerShareFacts } from "./worker-share.js";
import {
	formatCouncilMemberShareNote,
	formatCouncilShareNote,
	formatWorkerShareNote,
	selectWorkerRunToShare,
	workerShareFactsFromEntry,
} from "./worker-share.js";
import type { WorkerEntryState } from "./worker-stream.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 *
 * This module is a CLI seam, which constrains what it may import.
 * `src/cli/run.ts` reaches `parseSlashCommand` here so a headless
 * `clio-coder run "/typo"` refuses the token by the same shape test and the same
 * registry membership the editor uses; a second copy of the parser would drift
 * from this one on the first command added. That makes the CLI a reacher of
 * everything this file statically imports, so nothing here may reach the
 * interactive render graph: no theme, no overlay frame, no overlay module, no
 * `../engine/tui.js`. Those modules share one bundle chunk with the instant
 * shell's Stage 0 closure, and a second, disjoint reacher makes esbuild split
 * it, which is a startup-latency regression rather than a style problem. The
 * parse-time data tables the registry needs live in leaves for that reason,
 * such as `COUNCIL_SYNTHESIS_LABEL` in `./council.js`. Import from those,
 * not from overlays that re-export them.
 *
 * Boundaries rule6 in `tests/boundaries/check-boundaries.ts` refuses a violation
 * at lint time; `tests/contracts/instant-shell-import-graph.test.ts` is the
 * measurement it protects.
 */

/**
 * Put a finished worker run's answer into the main agent's context. Bare
 * `/fleet share` takes the newest one. `oldName` marks the retired `/share`
 * spelling, kept one release for ACP clients.
 */
type ShareCommandVariant = { kind: "share"; runId?: string; oldName?: true };
type ArchiveCommandVariant =
	| { kind: "archive-export"; path: string }
	| { kind: "archive-import"; path: string; dryRun: boolean; force: boolean }
	| { kind: "archive-usage"; subcommand?: "export" | "import"; error?: string };
type ReportCommandVariant =
	| { kind: "report"; report: SlashReportKind; summary?: string }
	| { kind: "report-status" }
	| { kind: "report-send"; draftId: string; duplicate?: ReportTextDuplicate }
	| { kind: "report-forget"; id: string }
	| { kind: "report-security" };

/** The kinds of report `/report` composes; security goes to a private advisory instead. */
export type SlashReportKind = "bug" | "feature" | "question";

/**
 * What `/report` asks the host to open: a new draft of a kind, with the summary as its title, or a saved draft to
 * review and send. `security` opens the private advisory page instead of a public report.
 */
export type SlashReportRequest =
	| { kind: SlashReportKind; summary?: string }
	| { kind: "draft"; draftId: string }
	| { kind: "security" };

export const SETTINGS_AREA_IDS = SETTINGS_AREAS.map((area) => area.id);
export type { SettingsAreaId };

/** What `/library <verb> <ref>` asks the browser to review once it is open. */
export type LibraryBrowseIntent = "install" | "update" | "enable" | "disable" | "remove";

/**
 * How a command opens the Library.
 *
 * A reference is a selection, never a write. `/library install <ref>` opens the
 * browser on that row with its review armed, so the operator reads the plan
 * that command produced before any of it lands.
 */
export interface LibraryBrowseRequest {
	tab?: LibraryEntryKind;
	focus?: string;
	intent?: LibraryBrowseIntent;
	importSource?: string;
	scope?: "user" | "project";
}

type SlashCommandVariant =
	| { kind: "mcp"; argv: string[] }
	| { kind: "doctor"; deep: boolean }
	| { kind: "upgrade" }
	| { kind: "config" }
	| { kind: "quit" }
	| { kind: "reload"; target: ReloadTarget }
	| { kind: "restart" }
	| { kind: "help"; query?: string }
	| { kind: "init"; options: InitCommandOptions }
	| { kind: "context-clear"; options: ContextClearCommandOptions }
	| { kind: "context-refresh" }
	/** `ref` is the turnId an `[evicted ...]` marker names. */
	| { kind: "context-recall"; ref: string }
	| { kind: "context-recover"; handoffId: string; action: "reduce" | "deliver" }
	| {
			kind: "resources";
			family?: "extensions";
			tab?: LibraryEntryKind;
			action?: "dev" | "mute" | "unmute" | "leave";
			/** The folder or extension id a dev, mute or unmute action names. */
			target?: string;
			/** A package ref or resource key the browser selects on open. */
			focus?: string;
			/** An operation to review on that row. Nothing is written before the review. */
			intent?: LibraryBrowseIntent;
			/** A path or URL `/library import` asks the import surface to review. */
			importSource?: string;
			/** Explicit `--user`/`--project`; absent leaves the browser's own selection. */
			scope?: "user" | "project";
	  }
	| { kind: "skill-invocation"; text: string }
	/** `/skill off`: drop the tool surface an activated skill armed for the session. */
	| { kind: "skill-surface-clear" }
	| ShareCommandVariant
	| ArchiveCommandVariant
	| ReportCommandVariant
	/** `source` is the line the operator typed, echoed above the run's transcript block. */
	| { kind: "run"; agentId: string; task: string; options: RunCommandOptions; source: string }
	| { kind: "run-usage" }
	| { kind: "delegate"; agentId: string; task: string; source: string; share?: boolean; readOnly?: boolean }
	| { kind: "delegate-usage" }
	| { kind: "btw"; question: string }
	| { kind: "draft"; request: string; count: number }
	| { kind: "draft-usage"; error?: string }
	| { kind: "btw-usage" }
	/** `/oracle <question>`: one read-only advisory run briefed on the record, never on the transcript. */
	| { kind: "oracle"; question: string }
	| { kind: "oracle-usage" }
	/** `/council <task>`: one read-only council of roster members, dispatched through the dispatch tool. */
	| { kind: "council"; task: string; options: CouncilCommandOptions; source: string }
	| { kind: "council-usage"; reason?: string }
	| { kind: "handoff"; goal: string }
	| { kind: "handoff-usage" }
	/** `/fleet run <playbook>`: compile the plan, show it for approval, dispatch on accept. */
	| { kind: "fleet-run"; name: string; vars: Record<string, string>; resume?: string }
	| { kind: "fleet-run-usage"; reason?: string }
	| { kind: "fleet" }
	/** `/loop`: a bounded recurring job, or one of its control verbs. The words are parsed by loop-command.ts. */
	| { kind: "loop"; command: LoopCommand }
	| { kind: "agents"; connect?: boolean }
	| { kind: "usage"; tab?: UsageTab }
	| { kind: "context-view" }
	| { kind: "tasks" }
	| { kind: "decisions" }
	| { kind: "research" }
	| { kind: "tasks-add"; text: string; expectedOutputs?: string[]; verification?: string[] }
	| { kind: "tasks-hand"; id: string }
	| { kind: "tasks-done"; id: string }
	| { kind: "tasks-drop"; id: string }
	| { kind: "memory" }
	| { kind: "memory-seed" }
	| { kind: "view"; filter?: string }
	| { kind: "view-verify"; runId: string }
	/** `/panes`: mode, health, pane inventory, effective settings. */
	| { kind: "panes" }
	| { kind: "panes-show"; target: string }
	/** A preset the model may also ask for, or operator-only argv. Never both. */
	| { kind: "panes-open"; preset?: PanesPresetId; argv?: ReadonlyArray<string>; once?: boolean }
	| { kind: "peer-pane"; peer: PanePeerId; brief?: string; cwd?: string }
	/** Toggle zoom on a Clio-owned pane; the bare form targets the watch pane. */
	| { kind: "panes-zoom"; target: string }
	| { kind: "panes-close"; target: string }
	| { kind: "panes-usage"; reason?: string; subcommand?: "peer"; listing?: boolean }
	/** `/files`: toggle the files pane; `hide` parks it with Yazi running; `close` ends it; `pick` borrows it for one selection. */
	| { kind: "files"; action: "toggle" | "open" | "hide" | "close" | "pick" }
	| { kind: "files-usage"; reason: string }
	/** `/music`: reveal or hide the music pane, or on, off, pause, next, status, station <name or url>. */
	| { kind: "music"; action: "toggle" | "on" | "off" | "pause" | "next" | "status" }
	| { kind: "music-station"; station: string }
	| { kind: "music-usage"; reason: string }
	| { kind: "thinking-set"; level: string }
	| { kind: "thinking-picker" }
	| { kind: "model" }
	| { kind: "model-set"; pattern: string }
	| { kind: "settings"; area?: SettingsAreaId; group?: "model-picker" }
	/** `target` is an id, unique id prefix, or exact name; absent opens the picker. */
	| { kind: "resume"; target?: string }
	| { kind: "rename"; name?: string }
	| { kind: "new" }
	| { kind: "tree" }
	/** `/rewind`: restore workspace files from a snapshot; `/tree` rewinds the conversation. */
	| { kind: "rewind" }
	| { kind: "fork"; name?: string }
	| { kind: "compact"; instructions: string | undefined }
	| { kind: "export"; path: string | undefined }
	| { kind: "unknown"; text: string }
	/** `text` is the whole line, so a token that turns out to name a prompt template keeps its arguments. */
	| { kind: "unknown-command"; token: string; text: string }
	| { kind: "usage-error"; command: string; reason: string }
	| { kind: "empty" };

/** The `/usage [tab]` values, in the overlay's tab order. */
export const USAGE_TAB_NAMES = ["activity", "accounts", "session", "models", "workers", "health"] as const;
export type UsageTab = (typeof USAGE_TAB_NAMES)[number];

/** `/library <kind>` completes the plurals and also accepts the singular tab ids. */
const LIBRARY_KIND_PLURALS = ["skills", "agents", "prompts", "playbooks", "plugins", "extensions"] as const;
const LIBRARY_KIND_WORDS = new Map<string, LibraryEntryKind>(
	LIBRARY_KIND_PLURALS.flatMap((plural) => {
		const kind = plural.slice(0, -1) as LibraryEntryKind;
		return [
			[plural, kind],
			[kind, kind],
		];
	}),
);

export type SlashCommand =
	| SlashCommandVariant
	| { kind: "eggs"; action: "status" | "off"; id?: string }
	| { kind: "retired"; name: string; rest: string; entry: RetiredCommand };

/**
 * A command name that answers for exactly one release after it is retired
 * (D-TUI 4.1). `to.command` runs its replacement with the old arguments
 * appended; `to.menuLetter` names the Ctrl+G letter of the key that replaced
 * it. The `retired-commands` hygiene check fails once `since` is no longer the
 * current release, so every entry is deleted in the next dev tree.
 */
export interface RetiredCommand {
	/** One word, or two for a retired subcommand such as `library reload`. */
	name: string;
	since: string;
	to: { command: string } | { menuLetter: string; action: string };
	/** The old arguments were the draft itself; they go back to the composer. */
	keepsText?: true;
}

export const RETIRED_COMMANDS: ReadonlyArray<RetiredCommand> = [
	{ name: "background", since: "0.7.1", to: { menuLetter: "d", action: "clio-coder.dispatch.background" } },
	{ name: "branch", since: "0.7.1", to: { command: "/fork" } },
	{ name: "editor", since: "0.7.1", to: { menuLetter: "g", action: "clio-coder.editor.external" }, keepsText: true },
	{
		name: "interrupt",
		since: "0.7.1",
		to: { menuLetter: "s", action: "clio-coder.message.interrupt" },
		keepsText: true,
	},
	{ name: "notifications", since: "0.7.1", to: { menuLetter: "x", action: "clio-coder.notifications.dismiss" } },
	{ name: "health", since: "0.7.1", to: { command: "/usage health" } },
	{ name: "systemone", since: "0.7.1", to: { command: "/usage health" } },
	{ name: "skills", since: "0.7.1", to: { command: "/library skills" } },
	{ name: "prompts", since: "0.7.1", to: { command: "/library prompts" } },
	{ name: "agents", since: "0.7.1", to: { command: "/library agents" } },
	{ name: "interop", since: "0.7.1", to: { command: "/library interop" } },
	{ name: "workspace off", since: "0.7.1", to: { command: "/extensions leave" } },
	{ name: "workspace", since: "0.7.1", to: { command: "/extensions" } },
	{ name: "library reload", since: "0.7.1", to: { command: "/reload library" } },
	{ name: "extensions reload", since: "0.7.1", to: { command: "/reload extensions" } },
	{ name: "peer", since: "0.7.1", to: { command: "/panes peer" } },
];

/** A one-word retired name, typed bare, must reach `dispatchRetiredCommand` rather than a palette row. */
export function isRetiredCommandName(name: string): boolean {
	return RETIRED_COMMANDS.some((entry) => entry.name === name);
}

/** A two-word name such as `library reload` retires a verb of a live command, so it is checked first. */
function matchRetiredCommand(trimmed: string, twoWordOnly = false): SlashCommand | null {
	if (!trimmed.startsWith("/")) return null;
	const [first = "", second = ""] = trimmed.slice(1).split(/\s+/u);
	const twoWord = second ? RETIRED_COMMANDS.find((entry) => entry.name === `${first} ${second}`) : undefined;
	if (twoWordOnly && !twoWord) return null;
	const entry = twoWord ?? RETIRED_COMMANDS.find((candidate) => candidate.name === first);
	if (!entry) return null;
	const rest = trimmed
		.slice(1)
		.replace(twoWord ? /^\S+\s+\S+/u : /^\S+/u, "")
		.trim();
	return { kind: "retired", name: entry.name, rest, entry };
}

function dispatchRetiredCommand(
	command: Extract<SlashCommand, { kind: "retired" }>,
	ctx: SlashCommandContext,
): SlashCommandDispatchResult {
	const { to } = command.entry;
	if ("command" in to) {
		const line = command.rest ? `${to.command} ${command.rest}` : to.command;
		ctx.notice("info", `/${command.name} is now ${to.command}; ran it.`);
		return dispatchSlashCommand(parseSlashCommand(line), ctx);
	}
	const label = ctx.keyboardActions?.menuLabel(to.menuLetter) ?? "a terminal key";
	ctx.notice("info", `/${command.name} is now a key: ${label}.`);
	ctx.render?.();
	return "rejected";
}

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

/**
 * What one admitted dispatch-tool call reports back to `/council`. The council
 * itself is watched on the board and in the transcript, so success is silent;
 * only a refusal or a failure is worth a notice.
 */
export type CouncilDispatchOutcome =
	| { status: "ok" }
	| { status: "blocked"; reason: string }
	| { status: "error"; message: string };

export type TaskMemorySeedCommandResult =
	| { status: "seeded"; seeded: number; skipped: number; source: string; flowRuleIds?: ReadonlyArray<string> }
	| { status: "disabled" }
	| { status: "not-found" }
	| { status: "refused"; reason: string };

export type InitCommandOptions = ContextInitOptions;

export interface ContextClearCommandOptions {
	all?: boolean;
	confirmed?: boolean;
	confirmedAll?: boolean;
}

export interface RunCommandOptions {
	readOnly?: boolean;
	workerProfile?: string;
	workerRuntime?: string;
	target?: string;
	/** Place this run in a Clio-created task worktree and retain it for review. */
	worktree?: boolean;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	toolProfile?: ToolProfileName;
	requiredCapabilities?: string[];
	/** Hand the receipt's answer to the main agent when the run finishes. Off by default. */
	share?: boolean;
}

/** Whether an operator-started run began, waits in the queue for a slot, or never started. */
export type DispatchAdmission = "started" | "queued" | "refused";

export interface HandleRunDeps {
	dispatch: DispatchContract;
	/**
	 * Told once, at admission, whether the run started, was queued or never started, so a surface that answers
	 * before the run ends (ACP) says "started" only for a run that did.
	 */
	onAdmission?: (admission: DispatchAdmission) => void;
	/** Resolve a named target before the external workspace warning is shown. */
	runtimeForTarget?: (targetId: string) => string | null;
	/** Live session board, snapshotted before operator run admission. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/** Strict recipe facts the run's execution role is derived from. */
	getAgentRoleFacts?: AgentRoleFactsResolver;
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	/**
	 * Optional bus for forwarding per-event worker output. When supplied,
	 * every non-heartbeat event is re-emitted on `"run.progressed"`
	 * so UI surfaces (dispatch-board overlay) can update their row as the
	 * stream arrives instead of waiting for the terminal receipt.
	 */
	bus?: TelemetryHub;
	/**
	 * Operator-turn sink for `--share`. Absent means the flag has nowhere to put
	 * the answer, which is reported rather than silently dropped: an operator who
	 * asked for the model to see a result must not be told it did.
	 */
	submitOperatorNote?: (text: string) => void;
	/**
	 * The session's standing tool limits. The run carries them, so a session
	 * started with `--delegate-tools read` never hands a worker write or bash.
	 */
	turnConstraints?: TurnConstraints;
}

/**
 * Hand a finished run's sealed answer to the main agent. The receipt is the
 * terminal truth here rather than the transcript block: the block is a view of
 * this same text, and the caller already holds the receipt.
 */
function shareReceipt(agentId: string, receipt: RunResult, deps: HandleRunDeps): void {
	if (!deps.submitOperatorNote) {
		deps.notice("error", "--share is not wired in this session; the result stayed local");
		return;
	}
	const note = formatWorkerShareNote({
		agentId,
		runId: receipt.runId,
		outcome: receipt.outcome,
		text: receipt.output?.text ?? "",
		...(receipt.runtimeKind === "subprocess" || receipt.delegation
			? receipt.worktree
				? {
						placement: {
							mode: "worktree" as const,
							cwd: receipt.worktree.path,
							branch: receipt.worktree.branch,
							...(receipt.worktree.changedPaths ? { changedPaths: receipt.worktree.changedPaths } : {}),
						},
					}
				: receipt.reproducibility?.cwd
					? {
							placement: {
								mode: "current" as const,
								cwd: receipt.reproducibility.cwd,
								...(receipt.checkoutChanges ? { changedPaths: receipt.checkoutChanges.changedPaths } : {}),
							},
						}
					: {}
			: {}),
	});
	if (note === null) {
		deps.notice("warn", `--share: run ${receipt.runId} produced no text to share`);
		return;
	}
	deps.submitOperatorNote(note);
}

function standingLimits(ctx: SlashCommandContext): { turnConstraints?: TurnConstraints } {
	const turnConstraints = ctx.standingTurnConstraints?.();
	return turnConstraints !== undefined ? { turnConstraints } : {};
}

/** The first admission a run reports; later reports, including the fallback "refused" once it ends, are ignored. */
function admissionSignal(): { promise: Promise<DispatchAdmission>; resolve: (admission: DispatchAdmission) => void } {
	let resolve: (admission: DispatchAdmission) => void = () => {};
	const promise = new Promise<DispatchAdmission>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Longer than an admission that finds a free slot takes, so a run that was never held up says nothing. */
const QUEUED_RUN_NOTICE_MS = 600;

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
	// Admission is told exactly once, so a caller that answers on it never says "started" for a run that never did.
	let admission: DispatchAdmission | null = null;
	const admit = (next: DispatchAdmission): void => {
		if (admission !== null) return;
		admission = next;
		deps.onAdmission?.(next);
	};
	let runId: string | null = null;
	let stopQueueWatch = (): void => {};
	try {
		const progressBus = dispatch.ownsProgressBus?.(bus) === true ? undefined : bus;
		if (deps.turnConstraints !== undefined) request = { ...request, turnConstraints: deps.turnConstraints };
		// Nothing else in the transcript says a run is waiting for a slot, since its card opens when it starts.
		let queuedRunId: string | null = null;
		const stopWatchingQueue = bus?.subscribe("run.enqueued", (payload) => {
			if (payload.agentId === request.agentId && payload.requestOrigin === "user") queuedRunId = payload.runId;
		});
		const stopWatchingStart = bus?.subscribe("run.started", (payload) => {
			if (payload.runId === queuedRunId) queuedRunId = null;
		});
		const queuedNotice = setTimeout(() => {
			if (queuedRunId === null) return;
			notice("info", `${request.agentId} is queued for a worker slot and starts when one frees · /fleet shows the queue`);
			// Every run is enqueued first; one still waiting here was admitted, so its caller need not wait for the slot.
			admit("queued");
		}, QUEUED_RUN_NOTICE_MS);
		queuedNotice.unref?.();
		stopQueueWatch = (): void => {
			clearTimeout(queuedNotice);
			stopWatchingQueue?.();
			stopWatchingStart?.();
		};
		const handle = await dispatch.dispatch(request);
		runId = handle.runId;
		admit("started");
		stopQueueWatch();
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			progressBus?.emit("run.progressed", { runId: handle.runId, agentId: request.agentId, event });
		}
		const receipt = await handle.finalPromise;
		const view = `/view dispatch:${handle.runId}`;
		if (receipt.outcome === "canceled") {
			const why = workerFailureHeadline(receipt.outcomeDetail) ?? "cancelled at your request";
			// A cancel removes an idle worktree but keeps one holding work, which nothing else on screen says.
			const changed = receipt.worktree?.changedPaths?.length ?? 0;
			const kept =
				receipt.worktree === undefined
					? ""
					: changed > 0
						? ` · ${changed} changed ${changed === 1 ? "file stays" : "files stay"} in its worktree on branch ${receipt.worktree.branch}`
						: existsSync(receipt.worktree.path)
							? ` · its worktree stays on branch ${receipt.worktree.branch}`
							: " · its worktree held no changes and was removed";
			notice("info", `${request.agentId} ${why.startsWith("cancelled") ? why : `cancelled: ${why}`}${kept} · ${view}`);
		} else if (receipt.outcome === "stalled") {
			notice("error", `${request.agentId} ${STALLED_RUN_HEADLINE} · ${view}`);
		} else if (receipt.exitCode !== 0 || receipt.failureMessage) {
			const why = workerFailureHeadline(receipt.failureMessage) ?? `exit code ${receipt.exitCode}`;
			// A run that hit its reply limit timed out, as its card header says; `failed` named a second state for it.
			const ended = receipt.outcome === "timed_out" ? "timed out" : "failed";
			notice("error", `${request.agentId} ${ended}: ${why} · ${view}`);
		}
		if (share) shareReceipt(request.agentId, receipt, deps);
	} catch (err) {
		stopQueueWatch();
		const msg = err instanceof Error ? err.message : String(err);
		if (admission === "started" && runId !== null) {
			// The run began, so it has a record to inspect; this is its failure, not a refusal to start.
			notice("error", `${request.agentId} failed: ${msg} · /view dispatch:${runId}`);
		} else if (err instanceof AdmissionCanceledError) {
			notice("info", `${request.agentId} cancelled before it started, so nothing ran`);
		} else {
			// Nothing started, so this is a refusal to start and has no run to inspect.
			notice("error", `${command} refused: ${msg.replace(/^dispatch:\s*/u, "")}`);
		}
	} finally {
		// Whatever ended the attempt before admission, it did not start.
		admit("refused");
	}
}

/**
 * Dispatches /run through the dispatch contract and streams events to stdout.
 * Target + model are resolved by the dispatch domain from request overrides,
 * worker profiles, recipe hints, and `settings.fleet.default`.
 */
export async function handleRun(
	agentId: string,
	task: string,
	deps: HandleRunDeps,
	options: RunCommandOptions = {},
): Promise<void> {
	const decisionRefs = activeDecisionRefs(deps.getDecisionBoard?.() ?? []);
	const selectedRuntime = options.target ? deps.runtimeForTarget?.(options.target) : options.workerRuntime;
	if (selectedRuntime && isInteropHeadlessRuntime(selectedRuntime)) {
		deps.notice(
			"warn",
			options.worktree
				? `External CLI ${selectedRuntime} will run in a Clio-created Git worktree. The worktree separates Git changes but does not confine the peer's filesystem, shell, or network tools.`
				: `External CLI ${selectedRuntime} will run in the current checkout; edits may appear immediately. The peer's own tools may access paths outside this checkout.`,
		);
	}
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
			...(decisionRefs.length > 0 ? { decisionRefs } : {}),
			...(options.workerProfile ? { workerProfile: options.workerProfile } : {}),
			...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
			...(options.target ? { target: options.target } : {}),
			...(options.worktree ? { worktree: true as const, apply: "preserve" as const } : {}),
			...(options.readOnly ? { readOnly: true } : {}),
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
	options: { share?: boolean; readOnly?: boolean } = {},
): Promise<void> {
	await runAttributed(
		"delegate",
		{
			agentId,
			delegationAgentId: agentId,
			executionRole: "builder",
			requestOrigin: "user",
			task,
			...(options.readOnly ? { readOnly: true } : {}),
		},
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
 * recipe be reached at all, and `readOnly: true` narrows the worker
 * below whatever the session holds. The answer reaches the main agent the way
 * `/share` puts one there: an operator-authored note on the ordinary user-turn
 * path, never a fabricated tool result.
 */
/** Commands that refuse rather than queue while a turn streams; the composer's list says so before Enter does. */
export const COMMANDS_REFUSED_DURING_TURN: ReadonlySet<string> = new Set(["config", "council", "oracle"]);
/** The same, for a command that only refuses by subcommand, as `<command> <subcommand>`. */
export const SUBCOMMANDS_REFUSED_DURING_TURN: ReadonlySet<string> = new Set(["fleet run"]);

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
	const turnConstraints = ctx.standingTurnConstraints?.();
	const mainModel = oracleMainModel(ctx);
	const crossLineage = oracleCrossLineageRoute(ctx, mainModel);
	const request: DispatchRequest = {
		agentId: ORACLE_AGENT_ID,
		task: ORACLE_TASK,
		briefing: digest.text,
		executionRole: requestExecutionRole({
			agentId: ORACLE_AGENT_ID,
			...(ctx.getAgentRoleFacts ? { resolveFacts: ctx.getAgentRoleFacts } : {}),
		}),
		requestOrigin: "internal",
		readOnly: true,
		...(crossLineage ? { target: crossLineage.target, model: crossLineage.model } : {}),
		...(turnConstraints !== undefined ? { turnConstraints } : {}),
	};
	const progressBus = ctx.dispatch.ownsProgressBus?.(ctx.bus) === true ? undefined : ctx.bus;
	try {
		let handle: Awaited<ReturnType<typeof ctx.dispatch.dispatch>>;
		try {
			handle = await ctx.dispatch.dispatch(request);
		} catch (err) {
			if (!crossLineage) throw err;
			// The pin is a preference: a route admission refuses must not cost the answer.
			ctx.notice(
				"warn",
				`/oracle could not use ${crossLineage.target}/${crossLineage.model} for an independent opinion (${err instanceof Error ? err.message : String(err)}); asking the default route`,
			);
			const { target: _target, model: _model, ...unpinned } = request;
			handle = await ctx.dispatch.dispatch(unpinned);
		}
		for await (const event of handle.events) {
			const typed = event as { type?: string };
			if (!typed.type || typed.type === "heartbeat") continue;
			progressBus?.emit("run.progressed", { runId: handle.runId, agentId: ORACLE_AGENT_ID, event });
		}
		const receipt = await handle.finalPromise;
		const parsed = parseOracleResult(receipt.output?.text ?? null);
		if (parsed === null) {
			ctx.notice(
				"error",
				`/oracle run ${receipt.runId} returned no usable answer (${plainOutcomeLabel(receipt.outcome)})`,
			);
			return;
		}
		const note = formatWorkerShareNote({
			agentId: ORACLE_AGENT_ID,
			runId: receipt.runId,
			outcome: receipt.outcome,
			text: [
				formatOracleAnswer(parsed),
				oracleIndependenceLine(mainModel.model, receipt.targetId, receipt.wireModelId),
				oracleVerifiabilityLine(question, ctx.getAutonomy?.() ?? "default"),
			].join("\n\n"),
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

/** The main chat route, live: a session-scoped `/model` switch is what the host reports. */
function oracleMainModel(ctx: SlashCommandContext): { target: string | null; model: string | null } {
	const target = ctx.getChatTarget?.() ?? null;
	const model = ctx.getChatModel?.() ?? (target ? (ctx.providers.getTarget(target)?.defaultModel ?? null) : null);
	return { target, model };
}

/**
 * A second opinion from the main model's own family mostly repeats it, so
 * `/oracle` pins a reachable model of another family when one is configured.
 * An operator who bound the oracle to a worker profile keeps that binding; the
 * answer then says whether it was independent.
 */
function oracleCrossLineageRoute(
	ctx: SlashCommandContext,
	main: { target: string | null; model: string | null },
): { target: string; model: string } | null {
	if (ctx.getFleetAgentProfiles?.()[ORACLE_AGENT_ID] !== undefined) return null;
	let statuses: ReturnType<ProvidersContract["list"]>;
	try {
		statuses = ctx.providers.list();
	} catch {
		return null;
	}
	const candidates: SecondOpinionCandidate[] = statuses.flatMap((status) =>
		[...new Set([status.target.defaultModel, ...(status.target.wireModels ?? [])])]
			.filter((model): model is string => typeof model === "string" && model.length > 0)
			.map((model) => ({ target: status.target.id, model, health: status.health.status, available: status.available })),
	);
	return chooseSecondOpinionRoute(main, candidates);
}

/** The line the oracle note closes with, so the main agent weighs agreement by how independent the advisor was. */
function oracleIndependenceLine(mainModel: string | null, advisorTarget: string, advisorModel: string): string {
	const advisor = `${advisorTarget}/${advisorModel}`;
	switch (secondOpinionIndependence(mainModel, advisorModel)) {
		case "independent":
			return `Advisor: ${advisor}, a different model family from the main model; its agreement is independent corroboration.`;
		case "same-lineage":
			return `Advisor: ${advisor}, the same model family as the main model; its agreement is weak corroboration, not independent review.`;
		default:
			return `Advisor: ${advisor}; whether it shares the main model's family is unknown, so do not count its agreement as independent.`;
	}
}

/**
 * What the main agent does with the answer. A question a check settles runs
 * closed-loop: the opinion is a hypothesis until the check runs. A judgment
 * call goes to the operator, or under yolo the advisor's view stands in.
 */
function oracleVerifiabilityLine(question: string, autonomy: AutonomyLevel): string {
	const verifiability = classifyVerifiability(question);
	switch (verifiabilityRoute(verifiability.kind, autonomy)) {
		case "closed-loop":
			return `Verifiability: ${verifiability.kind}, ${verifiability.reason}. Run that check and act on its result; until it runs, this answer is a hypothesis.`;
		case "second-opinion":
			return `Verifiability: judgment, ${verifiability.reason}. Autonomy is yolo, so this advice stands in for the operator; weigh it by the advisor line above.`;
		default:
			return `Verifiability: judgment, ${verifiability.reason}. Confirm the decision with the operator before acting on it.`;
	}
}

/**
 * `/council <task>`: one council, dispatched exactly as the model dispatches one.
 *
 * The command builds dispatch-tool arguments and hands them to the tool
 * registry. That is the whole of it, and it is deliberate: a council is a
 * plan-scale dispatch, so supervised autonomy parks the call and the approval
 * overlay shows the same artifact it shows for a model-asked council, naming
 * every member's label, target, model, node, round count, and synthesis mode.
 * A private path would have had to reproduce that, and would eventually have
 * reproduced it wrongly.
 */
/**
 * A council's failure in the words a person acts on. The dispatch tool's result opens with the note its approval
 * leaves for the model (`[operator approval] The operator approved this dispatch call once …`), which the operator,
 * who gave that approval, has no use for; what follows is the failure itself, read through the shared headline.
 */
function councilFailureWords(message: string): string {
	const lines = message.split("\n");
	const body = (/^\[(?:operator )?approval\]/u.test(lines[0] ?? "") ? lines.slice(1) : lines).join(" ").trim();
	const headline = workerFailureHeadline(body);
	// Admission takes a council whole, so one unreachable member target keeps every member from starting.
	const unreachable = /^its target (\S+) is not reachable/u.exec(headline ?? "");
	if (unreachable !== null) return `a member's target ${unreachable[1]} is not reachable, so no member ran`;
	return headline ?? (body.length > 0 ? body : "the council stopped before any member answered");
}

/**
 * A council the operator refused at its approval card, said to the operator. The reason is written for the model
 * (`User denied this call at the permission prompt…`), and the person reading it is that user.
 */
function councilRefusalWords(reason: string): string {
	if (/^User denied\b/u.test(reason)) return "/council did not run: you denied it at its approval card";
	if (/^User stopped\b/u.test(reason)) return "/council did not run: you stopped it at its approval card";
	return `/council did not run: ${reason}`;
}

async function handleCouncil(task: string, options: CouncilCommandOptions, ctx: SlashCommandContext): Promise<void> {
	// Refused, never queued, exactly as `/oracle` and `/fleet run` are. An
	// approved council describes the workspace as it stands, and a turn in
	// flight is about to change it.
	if (ctx.isTurnInFlight?.() === true) {
		ctx.notice("warn", "a turn is in flight; /council is refused rather than queued");
		return;
	}
	if (!ctx.runCouncilDispatch) {
		ctx.notice("error", "/council is not wired in this session");
		return;
	}
	const rosters = ctx.getWorkerRosters?.();
	if (rosters === undefined) {
		ctx.notice("error", "/council needs fleet.rosters, which is not wired in this session");
		return;
	}
	const resolved = resolveCouncilRoster(options.roster, rosters);
	if (!resolved.ok) {
		ctx.notice("error", resolved.reason);
		return;
	}
	try {
		const outcome = await ctx.runCouncilDispatch(
			buildCouncilDispatchArgs(task, resolved.roster, options),
			ctx.standingTurnConstraints?.(),
		);
		if (outcome.status === "blocked") ctx.notice("warn", councilRefusalWords(outcome.reason));
		else if (outcome.status === "error") ctx.notice("error", `/council failed: ${councilFailureWords(outcome.message)}`);
	} catch (err) {
		ctx.notice("error", `/council failed: ${councilFailureWords(err instanceof Error ? err.message : String(err))}`);
	}
}

/**
 * The note a run becomes, with a council run treated as what it is.
 *
 * A council synthesis run seals the whole `council-report`, so sharing its id
 * shares the council: every final member's labelled answer and the synthesis,
 * as one bounded block. A member run seals one voice, so it travels under the
 * roster label the operator watched it under. Every other run keeps the note it
 * has always had. A synthesis whose sealed text does not parse as a report is
 * shared verbatim rather than dropped: the operator asked for that run.
 */
function councilAwareShareNote(facts: WorkerShareFacts, entry: WorkerEntryState): string | null {
	const council = entry.council;
	if (council === undefined) return formatWorkerShareNote(facts);
	if (council.label !== COUNCIL_SYNTHESIS_LABEL) return formatCouncilMemberShareNote(facts, council.label);
	const report = parseCouncilReport(facts.text);
	return report === null ? formatWorkerShareNote(facts) : formatCouncilShareNote(facts, report);
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
				? "no finished /run or /delegate result for /fleet share yet"
				: `no finished run ${runId} in this session`,
		);
		return;
	}
	const facts = workerShareFactsFromEntry(entry);
	const note = facts === null ? null : councilAwareShareNote(facts, entry);
	if (note === null) {
		ctx.notice("error", `run ${entry.runId} produced no text to share`);
		return;
	}
	ctx.submitOperatorNote(note);
}

/** What the transcript shows for a display-only prompt template. */
export interface PromptReferenceCard {
	/** Command name as typed, without the slash: `materio:help`. */
	command: string;
	/** Where the template came from, in operator words: `plugin materio`. */
	source: string;
	/** The body to show, already reduced to its reference block. */
	text: string;
	/** What the card is, beside its source; `reference` when absent. An extension's answer is a `result`. */
	kind?: string;
}

/**
 * Runtime dependencies every slash-command handler may need. Every field is
 * injected at startInteractive construction time; handlers never reach into
 * the TUI, chat loop, or overlay module graph directly.
 */
/** How `/fleet run` starts: a fresh run, or one that resumes a prior root's successful prefix. */
export interface FleetRunStartOptions {
	resume?: string;
}

export interface SessionCommandContext {
	eggsCommand?: (action: "status" | "off", id?: string) => string;
	keyboardActions?: {
		/** The key, and its Ctrl+G letter, for the action behind a menu letter. */
		menuLabel(letter: string): string;
	};
	operatorExtensions?: OperatorExtensions;
	/** The terminal's dev scope: `/extensions dev [folder]`, `mute <id>`, `unmute <id>`. */
	extensionDev?: (action: "dev" | "mute" | "unmute", argument: string | undefined) => void;
	/** `extensionId` comes from the command row: an alias such as a prompt takeover carries no `ext:<id>:` prefix. */
	showExtensionOutput?: (invocation: string, output: OperatorCommandOutput, extensionId: string) => void;
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	dispatch: DispatchContract;
	getDecisionBoard?: HandleRunDeps["getDecisionBoard"];
	bus: TelemetryHub;
	/** Strict recipe facts used to keep interactive /run role-equivalent with the CLI. */
	getAgentRoleFacts?: AgentRoleFactsResolver;
	/**
	 * Echo the typed command line into the transcript, dimmed, before the block
	 * it starts. `/run` and `/delegate` use it so a worker's attributed block has
	 * the request above it. Transcript-only; the line never enters model context.
	 */
	echoOperatorCommand?: (text: string) => void;
	/**
	 * Render a display-only prompt template as an operator card in the
	 * transcript. Transcript-only, like the echo: the host that has no chat
	 * panel leaves it unset and the card falls back to `io.stdout`.
	 */
	showReference?: (card: PromptReferenceCard) => void;
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
	shutdown?: () => void;
	reloadClasses?: (target: ReloadTarget) => void;
	restart?: () => void;
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
	openSkillsHub?: (request?: LibraryBrowseRequest) => void;
	/**
	 * `/skill off`: drop the tool surface an activated skill armed for the
	 * session. Returns the names that were armed. Absent on a host with no
	 * chat loop, where nothing can be armed in the first place.
	 */
	clearSkillSurface?: () => ReadonlyArray<string>;
	/**
	 * The host's transcript states every change to the skill surface itself
	 * (the TUI's `§` rows), so `/skill off` adds no reply of its own when it
	 * cleared something. A host without that row prints the reply.
	 */
	statesSkillSurface?: boolean;
	listPrompts?: () => ResourceList<PromptTemplate>;
	/**
	 * Prompt templates from the committed plugin snapshot, without re-verifying
	 * plugin trees. For views that only name templates, such as /help and the
	 * /extensions detail. Absent means {@link listPrompts}. Nothing that runs a
	 * template or an extension command may read from it.
	 */
	listPromptsForDisplay?: () => ResourceList<PromptTemplate>;
	/**
	 * Resolve a `/name` against the loaded prompt templates. Absent when the host
	 * wired no resources, in which case a command-shaped token that names no
	 * builtin is simply not a command.
	 */
	expandPromptTemplate?: (text: string) => PromptTemplateExpansion;
	listExtensions?: () => ReadonlyArray<InstalledExtension>;
	/**
	 * `/extensions reload`: build, validate, and commit the next
	 * extension generation together with its user hooks, or report why it was
	 * refused. Absent on a host without the reload coordinator, in which case
	 * the command says so instead of pretending.
	 */
	reloadExtensions?: () => ExtensionReloadOutcome;
	reloadPlugins?: () => { generation: number };
	/** Detection report, pending proposals, and the two consent actions `/interop` drives. */
	interop?: {
		report: () => InteropReport | null;
		proposals: () => ReadonlyArray<InteropProposal>;
		configured: () => ReadonlyArray<{ id: string; command: string; args: ReadonlyArray<string> }>;
		accept: (kind: InteropAgentId) => void;
		decline: (kind: InteropAgentId) => void;
	};
	listAgents?: () => ReadonlyArray<AgentSpec>;
	exportShareArchive?: (outPath: string) => { fileCount: number; path: string };
	importShareArchive?: (path: string, options: { dryRun?: boolean; force?: boolean }) => ShareImportPlan;
	/** `/usage [tab]`; the Health tab shows journal losses, event-loop lag, transport, quota and breakers. */
	openUsage?: (tab?: UsageTab) => void;
	/**
	 * `/doctor [deep]`: the CLI doctor's findings, rendered as one notice.
	 * `deep` adds the live tool probe on the session's targets and the
	 * validation-contract dry run at the session's autonomy. Absent on a host
	 * with no providers, in which case the command says so.
	 */
	showDoctor?: (findings: ReadonlyArray<DoctorFinding>) => void;
	runDoctor?: (options: {
		deep: boolean;
	}) => Promise<{ level: NoticeLevel; text: string; findings?: ReadonlyArray<DoctorFinding> }>;
	/**
	 * `/upgrade`: review the available release, ask for explicit approval, and
	 * run the package lifecycle outside model context. Absent on non-interactive
	 * hosts, which refuse the command rather than treating it as chat text.
	 */
	startUpgrade?: () => void;
	/**
	 * `/btw <question>`: one model round beside the session, answered in an
	 * overlay. Nothing about it enters the transcript, the ledger, or the task
	 * board, so the workers a fleet run briefs never see the question or its
	 * answer.
	 */
	openSideQuestion?: (question: string) => void;
	/** `/draft [N] <request>`: N candidates side by side, judged by a decision model. */
	openDraft?: (request: string, count: number) => void;
	/**
	 * The record `/oracle` briefs its advisor on: settled decisions, the task
	 * board, and the last compaction summary. Absent on a host with no session,
	 * in which case `/oracle` says so instead of briefing on nothing.
	 */
	oracleBriefing?: () => Omit<OracleDigestSources, "question">;
	/**
	 * Configured `fleet.rosters`, which is what `/council` seats a council
	 * from. Absent on a host with no settings, in which case the command says so
	 * rather than dispatching a roster name it could not check.
	 */
	getWorkerRosters?: () => CouncilRosters;
	/**
	 * Run one dispatch-tool call with prepared council arguments through the
	 * ordinary tool-admission path. The council command owns no dispatch path of
	 * its own, so admission, the approval overlay, receipts, and the board treat
	 * an operator council exactly as they treat a model-asked one.
	 */
	runCouncilDispatch?: (
		args: Readonly<Record<string, unknown>>,
		turnConstraints?: TurnConstraints,
	) => Promise<CouncilDispatchOutcome>;
	/**
	 * True while a turn is streaming. `/oracle` is refused then, never queued:
	 * the digest describes the record as it stands and an in-flight turn is
	 * about to change it.
	 */
	isTurnInFlight?: () => boolean;
	/**
	 * The session's standing tool limits, which an ACP client ceiling narrows.
	 * A dispatch /run, /delegate, /oracle or /council starts outside a turn
	 * carries them, or it would run wider than the session it was started from (Z1).
	 */
	standingTurnConstraints?: () => TurnConstraints | undefined;
	/**
	 * `/handoff <goal>`: extract this session's working state for a stated goal,
	 * review the document, and seed a successor session with it. A session
	 * operation only. It writes no memory promotion candidate and never calls
	 * the task-memory bank.
	 */
	startHandoff?: (goal: string) => void;
	/**
	 * `/report`: open the report review over the session, never sending until the operator presses the send key on
	 * its send step. Absent on a surface without that review; the command then names `clio-coder report`.
	 */
	openReport?: (request: SlashReportRequest) => void;
	/** `/report status`: the reports and drafts on this machine. */
	showReportStatus?: () => void;
	/** `/report forget <id>`: delete a local draft; a report that already left this machine is refused. */
	forgetReport?: (id: string) => void;
	/**
	 * `/report` with no review to press send in (ACP): a kind previews the draft as text and saves it, and only
	 * `/report send <id>` sends. Used when {@link openReport} is absent.
	 */
	reportHost?: ReportTextHost;
	/**
	 * `/fleet run <playbook>`: compile the playbook's plan, show every wave, agent,
	 * target, boundary, budget, and code-step argv for approval, and dispatch
	 * only what the operator accepted. Absent on a host with no fleet wiring.
	 */
	startFleetRun?: (name: string, vars: Readonly<Record<string, string>>, options?: FleetRunStartOptions) => void;
	/** Open the read-only `/context` overlay: categorized context-window ledger. */
	openContextView?: () => void;
	/** Open the read-only `/tasks` overlay: the session task board with receipts. */
	openTasks?: () => void;
	/** Open the settled, branch-local interview decision board. */
	openDecisions?: () => void;
	/** Open the read-only `/research` overlay: this project's research campaigns and their timelines. */
	openResearch?: () => void;
	/** Project-scoped operator task inbox backing `/tasks` mutations. */
	userTasks?: {
		add(title: string, acceptance?: UserTaskAcceptance): UserTask;
		hand(id: string): UserTask;
		done(id: string): UserTask;
		drop(id: string): UserTask;
	};
	/** Open `/memory` for approved lessons, the live task bank, and reviewed promotion. */
	openMemory?: () => void;
	/** Opt-in import from the newest structured handoff; absent when the host has no task bank. */
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	/** Open `/view`, the full observability artifact viewer. */
	openView?: (filter?: string) => void;
	/**
	 * The pane layer's operator surface. It remains present when mux resolves to
	 * `none` because the Yazi preset can borrow the terminal for one selection;
	 * absent only when the host did not compose pane operations at all.
	 */
	panes?: PanesOperations;
	/** The music pane. Absent when the session started without panes. */
	music?: MusicOperations;
	/** The shared job control behind `/loop`. Absent where no session-owned job host exists. */
	jobs?: JobOperations;
	/** Serialize a local async command so the next admitted slash command observes its committed state. */
	runLocalOperation?: (operation: () => Promise<void>) => void;
	/**
	 * A command whose work outlives its handler (`/oracle`, `/council`) hands
	 * that work here. A host that answers when the work ends, as ACP does, waits
	 * for it; the terminal leaves this absent and the work runs on beside the
	 * prompt, as it always has.
	 */
	holdReplyFor?: (operation: Promise<void>) => void;
	/**
	 * A surface that answers before a dispatch command's run ends (ACP) waits on its admission, so a run that never
	 * started reads as the refusal its notice states, never as started.
	 */
	awaitDispatchStart?: (admission: Promise<DispatchAdmission>) => void;
	/**
	 * Apply a thinking level named on the command line. Returns why it was
	 * refused so the caller can say so, because the level the operator typed may
	 * not be one the active target supports.
	 */
	setThinkingLevel?: (level: string) => SetThinkingLevelResult;
	thinkingLevelChoices?: () => ReadonlyArray<{ value: string; label: string }>;
	openThinkingPicker?: () => void;
	/** Open the model picker when no model pattern was supplied. */
	openModel?: () => void;
	/** Live providers contract used by `/model <pattern>` to resolve directly. */
	providers: ProvidersContract;
	getChatTarget?: () => string | null | undefined;
	/** The live chat model, including a session-scoped `/model` switch. */
	getChatModel?: () => string | null | undefined;
	/** `fleet.agentProfiles`: recipes the operator bound to a worker profile. */
	getFleetAgentProfiles?: () => Readonly<Record<string, string>>;
	/** The session's effective autonomy level. */
	getAutonomy?: () => AutonomyLevel;
	/**
	 * Apply a resolved model reference for this session. "reported" means the
	 * host applied it and already said what landed, so no second notice is due.
	 */
	applyModelRef?: (ref: ResolvedModelRef) => "applied" | "reported";
	openConfigure?: () => void;
	openSettings?: (area?: SettingsAreaId, group?: "model-picker") => void;
	openFleetRuns?: () => void;
	/** Resume `target` (an id, unique id prefix or exact name) directly, or open the picker. */
	openResume?: (target?: string) => void;
	renameSession?: (name?: string) => void;
	startNewSession?: () => void;
	openTree?: () => void;
	/** Open `/rewind`, the workspace snapshot list. Absent on a host with no overlay layer. */
	openRewind?: () => void;
	/** Open the `/fork` picker; `name` names the new session when a turn is picked. */
	openMessagePicker?: (name?: string) => void;
	openHelp?: (query?: string) => void;
	openExtensions?: () => void;
	openInterop?: () => void;
	setEditorText?: (text: string) => void;
	/**
	 * Run compaction for the current session. Handler resolves the target
	 * model, reads session entries, calls session/compaction/compact, and
	 * appends a compactionSummary entry. No-op when no session is open, so the
	 * handler prints an actionable stderr line instead.
	 */
	runHandoffRecovery?: (handoffId: string, action: "reduce" | "deliver") => void;
	runCompact: (instructions: string | undefined) => void;
	/**
	 * Escape hatch for the `view verify` entry: verify a run's sealed run scope
	 * and emit an actionable verification block. Kept on the context so the registry does
	 * not import the overlay module.
	 */
	verifyRun?: (runId: string) => ({ ok: true } | { ok: false; reason: string }) & {
		sealedDigest?: string | null;
		trustSummary?: string | null;
		verificationSummary?: string | null;
		compromised?: boolean;
		checks?: ReadonlyArray<{ name: string; ok: boolean; evidence: string }>;
	};
	/**
	 * Handles the "unknown" case: append the text to the chat panel as a user
	 * turn, submit to the chat loop, and schedule a re-render. Handlers for
	 * {kind:"unknown"} defer to this so the chat-panel reference stays scoped
	 * to startInteractive.
	 */
	submitChat: (text: string) => void;
	/** Re-render request; wraps tui.requestRender so handlers do not import TUI. */
	render?: () => void;
}

export type SlashCommandContext = SessionCommandContext;

type SlashRunVerification = ReturnType<NonNullable<SlashCommandContext["verifyRun"]>>;

/** The full receipt and individual checks remain in the viewer's details. */
function formatRunVerificationBlock(runId: string, result: SlashRunVerification): string {
	const verdict = result.ok
		? (result.verificationSummary ?? result.trustSummary ?? "run seal verified; result validation unknown")
		: `failed. ${result.reason}`;
	return `Verification for ${runId}: ${verdict}\n/view run:${runId} · press i for full details and checks.`;
}

/** The verb a command performs, in the order /help lists the groups. */
export const SLASH_COMMAND_GROUPS = ["Work", "Inspect", "Configure", "Session"] as const;
export type SlashCommandGroup = (typeof SLASH_COMMAND_GROUPS)[number];

export interface CommandAcpAdmission {
	subcommands?: ReadonlyArray<string>;
	streams?: "dispatch";
	injectsUserTurn?: true;
	/** First arguments that do not submit a turn, so an active prompt does not refuse them. */
	injectsUserTurnExcept?: ReadonlyArray<string>;
	promptTurn?: true;
	promptTurnSubcommands?: ReadonlyArray<string>;
	/**
	 * First arguments that only read, with `""` for the bare form. Under an ACP
	 * client or operator ceiling only these and turn-injecting commands run (Z1).
	 */
	reads?: ReadonlyArray<string>;
	/**
	 * First arguments that only stop, pause or reshape the session's own context
	 * and write no project or operator file. A ceiling admits them as it admits
	 * {@link reads}: a client held to read-only must still be able to stop a loop.
	 */
	sessionOnly?: ReadonlyArray<string>;
	/**
	 * The whole command, or these first arguments, write project or session
	 * state or start a worker outside any tool call. A read-only ceiling denies
	 * every write and delegation, so it refuses them even when they submit a turn.
	 */
	readOnlyRefuses?: true | ReadonlyArray<string>;
}

export type CommandRank = 1 | 2 | 3;

export interface CommandAlias {
	name: string;
	args?: string;
}

export interface BuiltinSlashCommand {
	acp: false | CommandAcpAdmission;
	name: string;
	description: string;
	group: SlashCommandGroup;
	/** Palette order: 1 everyday, 2 regular, 3 rare. Required so a new command cannot be left unranked. */
	rank: CommandRank;
	/** Names other agents taught people, each resolving to this command with optional leading args. */
	aliases?: ReadonlyArray<CommandAlias>;
	/** Excluded from /help, autocomplete, and the docs command table. */
	hidden?: boolean;
	/**
	 * Release that retired this name. A hidden entry kept only so ACP clients can
	 * still call an old name; the `retired-commands` hygiene check expires it.
	 */
	retiredSince?: string;
	args?: CommandArgsSpec;
	/** Stable copy shown beside first-token subcommand completions. */
	subcommandDescriptions?: Readonly<Record<string, string>>;
	/** The set of SlashCommand kinds this entry is responsible for dispatching. */
	kinds: ReadonlyArray<SlashCommandKind>;
	/** Return the parsed SlashCommand for `trimmed` or null if this entry does not match. */
	match?(trimmed: string): SlashCommand | null;
	fromArgs?(parsed: ParsedArgs, trimmed: string): SlashCommand;
	/** Execute `command` against `ctx`. Called only for kinds declared in `kinds`. */
	handle(command: SlashCommand, ctx: SlashCommandContext): undefined | "rejected";
}

const RUN_THINKING_LEVELS: ReadonlyArray<JobThinkingLevel> = THINKING_LEVELS;

function isRunThinkingLevel(value: string): value is JobThinkingLevel {
	return RUN_THINKING_LEVELS.some((level) => level === value);
}

/** Both compact spellings keep a free-form optional instruction tail. */
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

/** `/panes peer <peer> [brief] [--cwd <path>]`; a bare verb lists the peers this machine can open. */
function panesPeerFromArgs(parsed: ParsedArgs): SlashCommand {
	if (parsed.error)
		return {
			kind: "panes-usage",
			subcommand: "peer",
			...(parsed.positionals.length === 0 ? { listing: true } : {}),
			// The one required argument is the peer, so name the choices rather than the parser's field.
			reason:
				parsed.positionals.length === 0
					? `Name the coding agent to open beside Clio: ${PANE_PEER_IDS.join(", ")}. A brief after it becomes its first prompt.`
					: parsed.error,
		};
	const peer = parsed.positionals[0] ?? "";
	if (!(PANE_PEER_IDS as ReadonlyArray<string>).includes(peer)) {
		return {
			kind: "panes-usage",
			subcommand: "peer",
			reason: `${peer} is not a peer Clio can open. Name one of ${PANE_PEER_IDS.join(", ")}.`,
		};
	}
	const cwd = parsed.flags.get("--cwd");
	return {
		kind: "peer-pane",
		peer: peer as PanePeerId,
		...(parsed.rest?.trim() ? { brief: parsed.rest.trim() } : {}),
		...(typeof cwd === "string" ? { cwd } : {}),
	};
}

function usageNotice(entry: BuiltinSlashCommand, subcommand?: string): string {
	return usageLine(entry, subcommand).trim();
}

/**
 * `/panes` output, as plain lines. Pure so the contract test asserts the text
 * an operator reads rather than the object behind it, and so the registry keeps
 * its promise not to reach a renderer.
 */
function formatPanesStatus(status: PanesStatus): ReadonlyArray<string> {
	// What an operator asks first: can Clio open panes here, and which are open.
	// The settings and wire facts follow on one details line, in words.
	const host = status.server ? `Herdr ${status.server.version}` : "the pane host";
	const lead = status.available
		? `Panes: ${host} is available. Clio opens panes beside this one, ${status.mode === "embedded" || isClioHostSocket(status.socketPath ?? undefined) ? "in its own workspace" : "as a guest in this workspace"}.`
		: `Panes: unavailable. ${status.reason}`;
	const row = (label: string, value: string): string => `  ${label.padEnd(12)} ${value}`;
	const files =
		status.yazi.mode === "closed" || status.yazi.paneId === null
			? status.settings.yazi.enabled
				? "closed · /files opens it"
				: "off · turn on Files pane in /settings (Workspace & Files), then /files opens it"
			: `open${status.yazi.paneCwd ? ` in ${status.yazi.paneCwd}` : ""} · picks land in the composer as @ mentions${status.yazi.droppedLines > 0 ? ` · ${status.yazi.droppedLines} picks dropped` : ""}`;
	const lines = [lead, row("Files pane", files)];
	for (const dock of status.docks) {
		const share = `${(dock.targetShare * 100).toFixed(0)}% of the window`;
		const slot = `${dock.slot[0]?.toUpperCase() ?? ""}${dock.slot.slice(1)} dock`;
		lines.push(
			row(
				slot,
				dock.hidden
					? `hidden; it takes ${share} when shown${dock.slot === "music" ? " · /music shows it" : ""}`
					: `shown · ${share}`,
			),
		);
	}
	if (status.panes.length === 0) lines.push(row("Open now", "none"));
	else
		for (const [index, pane] of status.panes.entries()) {
			const notes = [pane.adopted ? "adopted from an earlier session" : "", pane.pending ? "opening" : ""].filter(Boolean);
			lines.push(row(index === 0 ? "Open now" : "", `${pane.label}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`));
		}
	// One preset per row, command first, so each reads as something to type.
	for (const [index, preset] of PANES_PRESETS.entries())
		lines.push(row(index === 0 ? "Open one" : "", `/panes open ${preset.id} · ${preset.summary}`));
	if (status.available) {
		const alerts =
			status.settings.notifications === "failures"
				? "Herdr toasts for failed runs"
				: status.settings.notifications === "all"
					? "Herdr toasts for every finished run"
					: "no Herdr toasts";
		lines.push(
			row(
				"Details",
				`${status.socketPath ? `socket ${status.socketPath} · ` : ""}${status.server ? `protocol ${status.server.protocol} · ` : ""}${alerts} · journal ${status.settings.journal ? "on" : "off"}`,
			),
		);
	}
	return lines;
}

const CANONICAL_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "eggs",
		rank: 3,
		acp: { reads: ["", "status"], sessionOnly: ["off"] },
		description: "Show active conversation eggs or turn them off",
		group: "Inspect",
		hidden: true,
		kinds: ["eggs"],
		args: { subcommands: { status: {}, off: { positionals: [{ name: "id", required: false }] } } },
		match(text) {
			if (!/^\/eggs(?:\s|$)/u.test(text)) return null;
			const match = /^\/eggs(?:\s+(status|off)(?:\s+([a-z][a-z0-9_-]*))?)?$/u.exec(text);
			if (!match || (match[1] !== "off" && match[2]))
				return { kind: "usage-error", command: "eggs", reason: "Use /eggs [status] or /eggs off [id]" };
			return { kind: "eggs", action: match[1] === "off" ? "off" : "status", ...(match[2] ? { id: match[2] } : {}) };
		},
		handle(command, ctx) {
			if (command.kind === "eggs") ctx.notice("info", ctx.eggsCommand?.(command.action, command.id) ?? "No active eggs.");
		},
	},
	{
		name: "reload",
		rank: 3,
		acp: false,
		description: "Reload settings, library resources and extension runtimes with one report",
		group: "Session",
		kinds: ["reload"],
		args: { positionals: [{ name: "target", required: false, values: ["settings", "library", "extensions", "all"] }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "reload", reason: parsed.error };
			const target = parsed.positionals[0] ?? "all";
			if (target !== "settings" && target !== "library" && target !== "extensions" && target !== "all")
				return { kind: "usage-error", command: "reload", reason: "Choose settings, library, extensions or all" };
			return { kind: "reload", target };
		},
		handle(command, ctx) {
			if (!ctx.reloadClasses) {
				ctx.notice("warn", "/reload is available only in an interactive terminal.");
				return;
			}
			if (command.kind === "reload") ctx.reloadClasses(command.target);
		},
	},
	{
		name: "restart",
		rank: 3,
		acp: false,
		description: "Save and restart into this session and workspace",
		group: "Session",
		kinds: ["restart"],
		args: {},
		fromArgs: fromArgsOrUsage("restart", { kind: "restart" }),
		handle(_command, ctx) {
			if (!ctx.restart) {
				ctx.notice("warn", "/restart is available only in an interactive terminal.");
				return;
			}
			ctx.restart();
		},
	},
	{
		name: "quit",
		rank: 1,
		aliases: [{ name: "exit" }],
		acp: false,
		description: "Exit Clio Coder",
		group: "Session",
		kinds: ["quit"],
		args: {},
		fromArgs: fromArgsOrUsage("quit", { kind: "quit" }),
		handle(_command, ctx) {
			ctx.shutdown?.();
		},
	},
	{
		name: "help",
		rank: 1,
		acp: false,
		description: "Open the help center for commands and keys",
		group: "Inspect",
		kinds: ["help"],
		args: {
			positionals: [{ name: "query", required: false, rest: true }],
		},
		fromArgs(parsed) {
			return { kind: "help", ...(parsed.rest ? { query: parsed.rest } : {}) };
		},
		handle(command, ctx) {
			ctx.openHelp?.(command.kind === "help" ? command.query : undefined);
		},
	},
	{
		name: "skill",
		rank: 2,
		acp: { injectsUserTurn: true },
		description: "Invoke a skill, or use `off` to clear active skill tools",
		group: "Work",
		kinds: ["skill-invocation", "skill-surface-clear"],
		args: {
			positionals: [
				{ name: "name", required: true },
				{ name: "task", required: false, rest: true },
			],
		},
		match(trimmed) {
			if (trimmed === "/skill") return { kind: "resources", tab: "skill" };
			const command = parseSkillCommand(trimmed);
			if (!command) return null;
			// `off` is the one reserved name: an installed skill called `off`
			// would still be reachable from the hub, and clearing the armed
			// surface has to stay typeable without a second command.
			if (command.name === SKILL_SURFACE_CLEAR_ARG && command.args.length === 0) {
				return { kind: "skill-surface-clear" };
			}
			return { kind: "skill-invocation", text: trimmed };
		},
		handle(command, ctx) {
			if (command.kind === "skill-invocation") {
				ctx.submitChat(command.text);
			} else if (command.kind === "skill-surface-clear") {
				const cleared = ctx.clearSkillSurface?.() ?? [];
				if (cleared.length === 0) ctx.notice("info", "No skill tool surface is active.");
				else if (ctx.statesSkillSurface !== true) ctx.notice("info", `Skill tool surface cleared: ${cleared.join(", ")}.`);
			}
		},
	},
	{
		name: "library",
		rank: 2,
		acp: false,
		description: "Browse skills, agents, prompts, playbooks, plugins and extensions, or review an install or removal",
		group: "Inspect",
		kinds: ["resources", "agents"],
		// The same verbs as `clio-coder library`; each opens the review that command would apply.
		subcommandDescriptions: {
			inspect: "Open the Library on one package or component",
			install: "Review installing one package, then apply it",
			update: "Review updating one installed package, then apply it",
			enable: "Review enabling one installed package, then apply it",
			disable: "Review disabling one installed package, then apply it",
			remove: "Review removing one package, then apply it",
			import: "Review a plugin source from a path or URL",
			interop: "Inspect local coding agents and adopt safe resources",
		},
		args: {
			positionals: [{ name: "kind", required: false, values: [...LIBRARY_KIND_PLURALS] }],
			subcommands: {
				inspect: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				install: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				update: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				enable: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				disable: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				remove: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				import: {
					positionals: [{ name: "path-or-url", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				interop: {},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "library", reason: parsed.error };
			if (parsed.flags.has("--user") && parsed.flags.has("--project"))
				return { kind: "usage-error", command: "library", reason: "Choose one destination: --user or --project" };
			const scope = parsed.flags.has("--project")
				? ("project" as const)
				: parsed.flags.has("--user")
					? ("user" as const)
					: undefined;
			const subcommand = parsed.subcommand;
			if (subcommand === "interop") return { kind: "agents", connect: true };
			if (subcommand === "import") {
				const source = parsed.rest ?? parsed.positionals[0];
				if (!source)
					return {
						kind: "usage-error",
						command: "library",
						reason: "/library import needs a directory path or a source URL to review",
					};
				return { kind: "resources", tab: "plugin", importSource: source, ...(scope ? { scope } : {}) };
			}
			if (
				subcommand === "inspect" ||
				subcommand === "install" ||
				subcommand === "update" ||
				subcommand === "enable" ||
				subcommand === "disable" ||
				subcommand === "remove"
			) {
				const ref = parsed.positionals[0];
				if (!ref)
					return {
						kind: "usage-error",
						command: "library",
						reason: `/library ${subcommand} needs a kind:name reference, such as plugin:materio, or a component name`,
					};
				const prefix = ref.split(":", 1)[0] ?? "";
				return {
					kind: "resources",
					tab: isLibraryKind(prefix) && ref.includes(":") ? prefix : "plugin",
					focus: ref,
					...(subcommand === "inspect" ? {} : { intent: subcommand as LibraryBrowseIntent }),
					...(scope ? { scope } : {}),
				};
			}
			const [word, extra] = parsed.positionals;
			const tab = word === undefined ? "plugin" : LIBRARY_KIND_WORDS.get(word);
			if (!tab || extra !== undefined)
				return {
					kind: "usage-error",
					command: "library",
					reason:
						"Use /library [skills|agents|prompts|playbooks|plugins|extensions] to browse, /library inspect|install|update|enable|disable|remove <ref>, /library import <path-or-url>, or /library interop",
				};
			return { kind: "resources", tab };
		},
		handle(command, ctx) {
			if (command.kind === "agents") {
				ctx.openInterop?.();
				return;
			}
			if (command.kind !== "resources") return;
			if (command.family === "extensions") {
				extensionsCommand(command, ctx);
				return;
			}
			ctx.openSkillsHub?.({
				...(command.tab ? { tab: command.tab } : {}),
				...(command.focus ? { focus: command.focus } : {}),
				...(command.intent ? { intent: command.intent } : {}),
				...(command.importSource ? { importSource: command.importSource } : {}),
				...(command.scope ? { scope: command.scope } : {}),
			});
		},
	},
	{
		name: "mcp",
		rank: 3,
		acp: { reads: ["", "list"] },
		description: "List MCP servers, or trust or untrust one by id",
		group: "Inspect",
		kinds: ["mcp"],
		args: {
			positionals: [
				{ name: "action", required: false, values: ["list", "trust", "untrust"] },
				{ name: "id", required: false },
				{ name: "class", required: false },
			],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "mcp", reason: parsed.error };
			const [action = "list", id, actionClass] = parsed.positionals;
			return { kind: "mcp", argv: [action, ...(id ? [id] : []), ...(actionClass ? ["--action-class", actionClass] : [])] };
		},
		handle(command, ctx) {
			if (command.kind !== "mcp") return;
			const result = mcpCommandOutput(command.argv);
			ctx.notice(result.code ? "error" : "info", result.text);
		},
	},
	{
		name: "doctor",
		rank: 3,
		acp: { reads: [""] },
		description: "Check this install; `deep` adds live tool probes and a contract dry run",
		group: "Inspect",
		kinds: ["doctor"],
		args: { positionals: [{ name: "deep", required: false, values: ["deep"] }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "doctor", reason: parsed.error };
			if (parsed.positionals[0] && parsed.positionals[0] !== "deep")
				return { kind: "usage-error", command: "doctor", reason: "doctor accepts only deep" };
			return { kind: "doctor", deep: parsed.positionals[0] === "deep" };
		},
		handle(command, ctx) {
			if (command.kind !== "doctor") return;
			const runDoctor = ctx.runDoctor;
			if (!runDoctor) {
				ctx.notice("error", "doctor is not wired in this session; run clio-coder doctor from a shell");
				return;
			}
			ctx.notice(
				"info",
				command.deep
					? "doctor: running deep checks; the tool probe can load a cold local model and releases only that one"
					: "doctor: running checks",
			);
			void (async () => {
				try {
					const report = await runDoctor({ deep: command.deep });
					if (ctx.showDoctor && report.findings) ctx.showDoctor(report.findings);
					else ctx.notice(report.level, report.text);
				} catch (error) {
					ctx.notice("error", `doctor failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				ctx.render?.();
			})();
		},
	},
	{
		name: "upgrade",
		rank: 3,
		acp: false,
		description: "Review and approve a Clio Coder update, then restart when it succeeds",
		group: "Configure",
		kinds: ["upgrade"],
		args: {},
		fromArgs: fromArgsOrUsage("upgrade", { kind: "upgrade" }),
		handle(_command, ctx) {
			if (!ctx.startUpgrade) {
				ctx.notice("error", "in-session upgrade is unavailable; run clio-coder upgrade from a shell");
				return "rejected";
			}
			ctx.startUpgrade();
		},
	},
	{
		name: "extensions",
		rank: 3,
		acp: false,
		description: "Inspect extensions, manage dev and muted ones for this session, or leave a workspace",
		group: "Inspect",
		// Harness navigation uses the shared overlay dispatcher, independently of component reload.
		kinds: [],
		args: {
			subcommands: {
				dev: { positionals: [{ name: "target", required: false, rest: true }] },
				mute: { positionals: [{ name: "target", required: false, rest: true }] },
				unmute: { positionals: [{ name: "target", required: false, rest: true }] },
				leave: {},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "extensions", reason: parsed.error };
			const action = parsed.subcommand;
			const target = (parsed.rest ?? parsed.positionals[0])?.trim();
			if (action === undefined) {
				if (parsed.positionals.length > 0)
					return { kind: "usage-error", command: "extensions", reason: "extensions accepts dev, mute, unmute or leave" };
				return { kind: "resources", family: "extensions" };
			}
			if (action !== "dev" && action !== "mute" && action !== "unmute" && action !== "leave")
				return { kind: "usage-error", command: "extensions", reason: "extensions accepts dev, mute, unmute or leave" };
			if (action === "leave" && (target || parsed.positionals.length > 0))
				return { kind: "usage-error", command: "extensions", reason: "extensions leave takes no argument" };
			return { kind: "resources", family: "extensions", action, ...(target ? { target } : {}) };
		},
		handle(command, ctx) {
			if (command.kind === "resources" && command.family === "extensions") extensionsCommand(command, ctx);
		},
	},
	{
		name: "share",
		rank: 3,
		acp: { injectsUserTurn: true },
		description: "Share a worker result with the main agent (now /fleet share)",
		group: "Work",
		// Kept one release so ACP clients that call `share` keep working; /fleet owns the kind.
		hidden: true,
		retiredSince: "0.7.1",
		kinds: [],
		args: { positionals: [{ name: "run-id", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "share", reason: parsed.error };
			return { kind: "share", ...(parsed.positionals[0] ? { runId: parsed.positionals[0] } : {}), oldName: true };
		},
		handle() {},
	},
	{
		name: "archive",
		rank: 3,
		acp: {},
		description: "Export or import a full Clio archive",
		group: "Session",
		hidden: true,
		kinds: ["archive-export", "archive-import", "archive-usage"],
		subcommandDescriptions: { export: "Export a full Clio archive", import: "Import a full Clio archive" },
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
					kind: "archive-usage",
					...(subcommand !== undefined ? { subcommand } : {}),
					error: parsed.error,
				};
			}
			const path = parsed.positionals[0];
			if (subcommand === "export" && path !== undefined) return { kind: "archive-export", path };
			if (subcommand === "import" && path !== undefined) {
				return {
					kind: "archive-import",
					path,
					dryRun: parsed.flags.has("--dry-run"),
					force: parsed.flags.has("--force"),
				};
			}
			return { kind: "archive-usage", ...(subcommand !== undefined ? { subcommand } : {}) };
		},
		handle(command, ctx) {
			if (command.kind === "archive-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "archive");
				if (!entry) return;
				const usage = usageNotice(entry, command.subcommand);
				ctx.notice("info", command.error ? `${command.error}\n${usage}` : usage);
				return;
			}
			if (command.kind === "archive-export") {
				if (!ctx.exportShareArchive) {
					ctx.notice("error", "archive export is not wired");
					return;
				}
				const result = ctx.exportShareArchive(command.path);
				ctx.notice("success", `exported ${result.fileCount} item(s) to ${result.path}`);
				return;
			}
			if (command.kind === "archive-import") {
				if (!ctx.importShareArchive) {
					ctx.notice("error", "archive import is not wired");
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
		rank: 1,
		acp: { streams: "dispatch" },
		description: "Run a fleet agent on a task",
		group: "Work",
		kinds: ["run", "run-usage"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--agent-profile", takesValue: true, valueName: "profile" },
				{ name: "--runtime", takesValue: true, valueName: "runtimeId" },
				{ name: "--target", takesValue: true, valueName: "id" },
				{ name: "--worktree" },
				{ name: "--read-only" },
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
			if (parsed.flags.has("--worktree")) options.worktree = true;
			if (parsed.flags.has("--read-only")) options.readOnly = true;

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
			const start = admissionSignal();
			void (async () => {
				try {
					await handleRun(
						agentId,
						task,
						{
							onAdmission: start.resolve,
							dispatch: ctx.dispatch,
							...(ctx.getDecisionBoard ? { getDecisionBoard: ctx.getDecisionBoard } : {}),
							...(ctx.getAgentRoleFacts ? { getAgentRoleFacts: ctx.getAgentRoleFacts } : {}),
							io: ctx.io,
							notice: ctx.notice,
							runtimeForTarget: (id) => ctx.providers.getTarget(id)?.runtime ?? null,
							bus: ctx.bus,
							...(ctx.submitOperatorNote ? { submitOperatorNote: ctx.submitOperatorNote } : {}),
							...standingLimits(ctx),
						},
						options,
					);
				} catch (error) {
					// A throw before admission is a run that never started; say so instead of losing it.
					ctx.notice("error", `run did not start: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					start.resolve("refused");
				}
				ctx.render?.();
			})();
			ctx.awaitDispatchStart?.(start.promise);
		},
	},
	{
		name: "delegate",
		rank: 2,
		acp: { streams: "dispatch" },
		description: "Hand a task to an external ACP agent",
		group: "Work",
		kinds: ["delegate", "delegate-usage"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [{ name: "--share" }, { name: "--read-only" }],
			positionals: [
				{ name: "agent-id", required: true },
				{ name: "task", required: true, rest: true },
			],
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return { kind: "delegate-usage" };
			const agentId = parsed.positionals[0] ?? "";
			const task = parsed.positionals[1] ?? "";
			return {
				kind: "delegate",
				agentId,
				task,
				source: trimmed,
				...(parsed.flags.has("--share") ? { share: true } : {}),
				...(parsed.flags.has("--read-only") ? { readOnly: true } : {}),
			};
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
			const start = admissionSignal();
			void (async () => {
				try {
					await handleDelegate(
						command.agentId,
						command.task,
						{
							onAdmission: start.resolve,
							dispatch: ctx.dispatch,
							io: ctx.io,
							notice: ctx.notice,
							bus: ctx.bus,
							...(ctx.submitOperatorNote ? { submitOperatorNote: ctx.submitOperatorNote } : {}),
							...standingLimits(ctx),
						},
						{ share, readOnly: command.readOnly === true },
					);
				} catch (error) {
					// A throw before admission is a delegation that never started; say so instead of losing it.
					ctx.notice("error", `delegate did not start: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					start.resolve("refused");
				}
				ctx.render?.();
			})();
			ctx.awaitDispatchStart?.(start.promise);
		},
	},
	{
		name: "btw",
		rank: 3,
		acp: false,
		description: "Ask a side question that never enters the session transcript",
		group: "Work",
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
			ctx.openSideQuestion?.(command.question);
		},
	},
	{
		name: "draft",
		rank: 3,
		acp: false,
		description: "Draft 2-4 answers in parallel and pick the strongest",
		group: "Work",
		kinds: ["draft", "draft-usage"],
		args: {
			positionals: [{ name: "request", required: true, rest: true }],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "draft-usage" };
			const read = parseDraftArgs(parsed.rest ?? "");
			if ("error" in read) return { kind: "draft-usage", error: read.error };
			return { kind: "draft", request: read.request, count: read.count };
		},
		handle(command, ctx) {
			if (command.kind === "draft-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "draft");
				if (command.error) ctx.notice("warn", `/draft: ${command.error}`);
				if (entry) ctx.notice("info", usageNotice(entry));
				return;
			}
			if (command.kind !== "draft") return;
			ctx.openDraft?.(command.request, command.count);
		},
	},
	{
		name: "oracle",
		rank: 3,
		acp: { streams: "dispatch", injectsUserTurn: true, readOnlyRefuses: true },
		description: "Have a read-only advisor challenge a question against settled decisions",
		group: "Work",
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
			const operation = (async () => {
				await handleOracle(command.question, ctx);
				ctx.render?.();
			})();
			ctx.holdReplyFor?.(operation);
		},
	},
	{
		name: "council",
		rank: 3,
		acp: { streams: "dispatch", promptTurn: true },
		description: "Ask several read-only agents the same task, then vote or synthesize",
		group: "Work",
		kinds: ["council", "council-usage"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--roster", takesValue: true, valueName: "name" },
				{ name: "--rounds", takesValue: true, valueName: "n" },
				{ name: "--synthesis", takesValue: true, values: COUNCIL_SYNTHESIS_MODES },
				{ name: "--agent", takesValue: true, valueName: "id" },
			],
			positionals: [{ name: "task", required: true, rest: true }],
		},
		fromArgs(parsed, trimmed) {
			const task = parsed.rest?.trim() ?? "";
			if (parsed.error) return { kind: "council-usage", reason: parsed.error };
			if (task.length === 0) return { kind: "council-usage" };
			const options: CouncilCommandOptions = {};
			const roster = parsed.flags.get("--roster");
			if (typeof roster === "string") options.roster = roster;
			const agent = parsed.flags.get("--agent");
			if (typeof agent === "string" && agent.trim().length > 0) options.agent = agent.trim();
			const rounds = parsed.flags.get("--rounds");
			if (typeof rounds === "string") {
				const parsedRounds = Number(rounds);
				// The tool bounds rounds at one to three, and a council that is
				// refused after admission has already shown the operator a plan it
				// cannot run, so the same bound is enforced where it was typed.
				if (!Number.isInteger(parsedRounds) || parsedRounds < 1 || parsedRounds > COUNCIL_MAX_ROUNDS) {
					return { kind: "council-usage", reason: `--rounds must be an integer 1..${COUNCIL_MAX_ROUNDS}` };
				}
				options.rounds = parsedRounds;
			}
			const synthesis = parsed.flags.get("--synthesis");
			if (typeof synthesis === "string") {
				if (!isCouncilSynthesisMode(synthesis)) return { kind: "council-usage" };
				options.synthesis = synthesis;
			}
			return { kind: "council", task, options, source: trimmed };
		},
		handle(command, ctx) {
			if (command.kind === "council-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "council");
				const usage = entry ? usageNotice(entry) : "usage: /council <task>";
				ctx.notice("info", command.reason ? `${command.reason}\n${usage}` : usage);
				return;
			}
			if (command.kind !== "council") return;
			// The question the round answers sits above its cards, as a /run's does.
			ctx.echoOperatorCommand?.(command.source);
			const operation = (async () => {
				await handleCouncil(command.task, command.options, ctx);
				ctx.render?.();
			})();
			ctx.holdReplyFor?.(operation);
		},
	},
	{
		name: "loop",
		rank: 2,
		// Its jobs fire user turns later, outside any prompt, which is what this marker tells a client.
		// Listing and controlling jobs submits nothing, so those verbs stay available while a prompt runs.
		acp: {
			injectsUserTurn: true,
			injectsUserTurnExcept: LOOP_OBSERVE_VERBS,
			reads: ["list", "status"],
			// Resume restarts jobs that fire turns, so a ceiling does not admit it.
			sessionOnly: ["stop", "cancel", "pause"],
		},
		description: "Run a bounded recurring job: a main-context task or a typed command",
		group: "Work",
		kinds: ["loop"],
		args: {
			flags: [
				{ name: "--count", takesValue: true, valueName: "runs" },
				{ name: "--for", takesValue: true, valueName: "duration" },
				{ name: "--until-stopped", takesValue: false },
				{ name: "--timeout", takesValue: true, valueName: "duration" },
				{ name: "--until", takesValue: true, valueName: "json.path == value" },
				{ name: "--on-match", takesValue: true, values: ["notice", "main_turn"] },
				{ name: "--follow-up", takesValue: true, valueName: "text" },
				{ name: "--command", takesValue: true, valueName: "program [args...]" },
			],
			positionals: [
				{ name: "every", required: false },
				{ name: "task", required: false, rest: true },
			],
			subcommands: {
				list: {},
				status: { positionals: [{ name: "id", required: false }] },
				pause: { positionals: [{ name: "id", required: true }] },
				resume: { positionals: [{ name: "id", required: true }] },
				stop: { positionals: [{ name: "id", required: true }] },
				cancel: { positionals: [{ name: "id", required: true }] },
			},
		},
		subcommandDescriptions: LOOP_SUBCOMMAND_DESCRIPTIONS,
		match(text) {
			if (!/^\/loop(?:\s|$)/u.test(text)) return null;
			const parsed = parseLoopLine(text.slice("/loop".length));
			return parsed.ok
				? { kind: "loop", command: parsed.command }
				: { kind: "usage-error", command: "loop", reason: parsed.reason };
		},
		handle(command, ctx) {
			if (command.kind !== "loop") return;
			if (ctx.jobs === undefined) {
				ctx.notice("warn", LOOP_NO_HOST_NOTICE);
				return "rejected";
			}
			const output = (lines: ReadonlyArray<string>) => ctx.io.stdout(`${lines.join("\n")}\n`);
			const run = () => runLoopCommand(command.command, { jobs: ctx.jobs, notice: ctx.notice, output, now: Date.now });
			// The reply waits for acceptance where the host answers when the work ends (ACP); the
			// terminal queues it behind earlier local operations so `/loop list` sees a just-made job.
			if (ctx.holdReplyFor) {
				ctx.holdReplyFor(run());
				return;
			}
			(ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation()))(run);
		},
	},
	{
		name: "usage",
		rank: 1,
		aliases: [{ name: "cost" }, { name: "status" }],
		acp: false,
		description: "Show quota, credits, session tokens and cost, workers, and health",
		group: "Inspect",
		kinds: ["usage"],
		args: { positionals: [{ name: "tab", required: false, values: [...USAGE_TAB_NAMES] }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "usage", reason: parsed.error };
			const tab = parsed.positionals[0];
			if (tab === undefined) return { kind: "usage" };
			if (!(USAGE_TAB_NAMES as ReadonlyArray<string>).includes(tab))
				return { kind: "usage-error", command: "usage", reason: `Choose ${USAGE_TAB_NAMES.join(", ")}` };
			return { kind: "usage", tab: tab as UsageTab };
		},
		handle(command, ctx) {
			if (command.kind !== "usage") return;
			ctx.openUsage?.(command.tab);
		},
	},
	{
		name: "context",
		rank: 1,
		aliases: [{ name: "init", args: "init" }],
		acp: {
			subcommands: ["compact", "recall", "init", "refresh", "reset", "recover"],
			promptTurnSubcommands: ["recover"],
			// Reset deletes project context files, so a ceiling refuses it.
			sessionOnly: ["compact", "recall"],
		},
		description: "Show the context window, or manage session and project context",
		group: "Inspect",
		kinds: ["context-view", "compact", "context-recover", "context-recall", "init", "context-clear", "context-refresh"],
		subcommandDescriptions: {
			compact: "Shrink the session context to free room",
			recover: "Resume a paused handoff by reducing or delivering it",
			recall: "Bring back a result evicted from context",
			init: "Initialize project context",
			refresh: "Refresh project context",
			reset: "Reset project context",
		},
		args: {
			subcommands: {
				compact: { positionals: [...COMPACT_POSITIONALS] },
				recover: {
					positionals: [
						{ name: "handoffId", required: true },
						{ name: "action", required: true, values: ["reduce", "deliver"] },
					],
				},
				recall: { positionals: [...RECALL_POSITIONALS] },
				init: {
					flags: [
						...CONTEXT_INIT_FLAG_TABLE.flatMap(({ flag, aliases = [] }) => [flag, ...aliases].map((name) => ({ name }))),
						{ name: "--depth", takesValue: true, values: ["quick", "standard", "deep"] },
					],
				},
				refresh: {},
				// The terminal confirms a reset in its own chooser. A host with no chooser
				// takes the confirmation as flags, and refuses a reset that carries none.
				reset: { flags: [{ name: "--yes" }, { name: "--all" }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "context", reason: parsed.error };
			switch (parsed.subcommand) {
				case "compact":
					return { kind: "compact", instructions: parsed.rest };
				case "recover": {
					const [handoffId, action] = parsed.positionals;
					return handoffId && (action === "reduce" || action === "deliver")
						? { kind: "context-recover", handoffId, action }
						: { kind: "usage-error", command: "context", reason: "Use /context recover <handoffId> <reduce|deliver>" };
				}
				case "recall":
					return { kind: "context-recall", ref: parsed.positionals[0] ?? "" };
				case "init": {
					const options: ContextInitOptions = {};
					const depth = parsed.flags.get("--depth");
					if (depth === "quick" || depth === "standard" || depth === "deep") options.depth = depth;
					for (const { flag, aliases = [], field } of CONTEXT_INIT_FLAG_TABLE) {
						if ([flag, ...aliases].some((name) => parsed.flags.has(name))) options[field] = true;
					}
					const reason = validateInitOptions(options);
					return reason
						? { kind: "usage-error", command: "context", reason }
						: { kind: "init", options: applyInitImplications(options) };
				}
				case "refresh":
					return { kind: "context-refresh" };
				case "reset": {
					const confirmed = parsed.flags.has("--yes");
					const all = parsed.flags.has("--all");
					return {
						kind: "context-clear",
						options: {
							...(all ? { all: true } : {}),
							...(confirmed ? { confirmed: true } : {}),
							...(all && confirmed ? { confirmedAll: true } : {}),
						},
					};
				}
				default:
					return { kind: "context-view" };
			}
		},
		handle(command, ctx) {
			switch (command.kind) {
				case "context-view":
					ctx.openContextView?.();
					return;
				case "compact":
					ctx.runCompact(command.instructions);
					return;
				case "context-recover":
					if (ctx.runHandoffRecovery) ctx.runHandoffRecovery(command.handoffId, command.action);
					else ctx.notice("error", "native handoff recovery is unavailable");
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
						ctx.notice("error", "context refresh is not wired in this session");
					}
					return;
				default:
					return;
			}
		},
	},
	{
		name: "fleet",
		rank: 2,
		// Only `share` crosses ACP; bare /fleet and /fleet run stay TUI-only.
		acp: { subcommands: ["share"], injectsUserTurn: true },
		description: "Show live fleet runs, share a worker result, or preview and run a playbook",
		group: "Work",
		kinds: ["fleet", "fleet-run", "fleet-run-usage", "share"],
		subcommandDescriptions: {
			run: "Preview and run a repo-owned playbook",
			share: "Share a finished worker result with the main agent",
		},
		args: {
			subcommands: {
				share: { positionals: [{ name: "run-id", required: false }] },
				run: {
					flags: [
						{ name: "--var", takesValue: true, repeatable: true, valueName: "key=value" },
						{ name: "--resume", takesValue: true, valueName: "runId" },
					],
					positionals: [{ name: "playbook", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			if (parsed.subcommand === "share") {
				if (parsed.error) return { kind: "usage-error", command: "fleet", reason: parsed.error };
				return { kind: "share", ...(parsed.positionals[0] ? { runId: parsed.positionals[0] } : {}) };
			}
			if (parsed.subcommand !== "run") {
				return parsed.error ? { kind: "usage-error", command: "fleet", reason: parsed.error } : { kind: "fleet" };
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
			const resume = parsed.flagValues.get("--resume")?.[0];
			if (resume !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resume)) {
				return { kind: "fleet-run-usage", reason: "--resume requires a fleet run id" };
			}
			return { kind: "fleet-run", name, vars, ...(resume !== undefined ? { resume } : {}) };
		},
		handle(command, ctx) {
			if (command.kind === "share") {
				if (command.oldName && ctx.keyboardActions) ctx.notice("info", "/share is now /fleet share");
				shareWorkerRun(command.runId, ctx);
				return;
			}
			if (command.kind === "fleet") {
				if (ctx.openFleetRuns) ctx.openFleetRuns();
				else ctx.notice("error", "Fleet Runs is not wired in this session");
				return;
			}
			if (command.kind === "fleet-run-usage") {
				const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "fleet");
				const usage = entry
					? usageNotice(entry, "run")
					: "usage: /fleet run <playbook> [--var key=value ...] [--resume runId]";
				ctx.notice("info", command.reason ? `${command.reason}\n${usage}` : usage);
				return;
			}
			if (command.kind !== "fleet-run") return;
			if (!ctx.startFleetRun) {
				ctx.notice("error", "/fleet run is not wired in this session");
				return;
			}
			ctx.startFleetRun(command.name, command.vars, command.resume !== undefined ? { resume: command.resume } : {});
		},
	},
	{
		name: "decisions",
		rank: 3,
		acp: false,
		description: "Show settled interview decisions and operator revisions",
		group: "Inspect",
		kinds: ["decisions"],
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "decisions", reason: parsed.error };
			return { kind: "decisions" };
		},
		handle(_command, ctx) {
			ctx.openDecisions?.();
		},
	},
	{
		name: "research",
		rank: 3,
		acp: false,
		description: "Show this project's research campaigns and their iteration timelines",
		group: "Inspect",
		kinds: ["research"],
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "research", reason: parsed.error };
			return { kind: "research" };
		},
		handle(_command, ctx) {
			if (!ctx.openResearch) {
				ctx.notice("info", "/research is not wired in this session; run clio-coder research status");
				return;
			}
			ctx.openResearch();
		},
	},
	{
		name: "tasks",
		rank: 1,
		acp: {
			subcommands: ["add", "hand", "done", "drop"],
			injectsUserTurn: true,
			readOnlyRefuses: ["add", "hand", "done", "drop"],
		},
		description: "Show the session task board, or manage project tasks",
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
				add: {
					parseFlagsInRest: true,
					flags: [
						{ name: "--expect", takesValue: true, repeatable: true, valueName: "path" },
						{ name: "--verify", takesValue: true, repeatable: true, valueName: "checkId[:timeoutMs]" },
					],
					positionals: [{ name: "text", required: true, rest: true }],
				},
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
						? {
								kind: "tasks-add",
								text: parsed.rest,
								...(parsed.flagValues.has("--expect") ? { expectedOutputs: parsed.flagValues.get("--expect") ?? [] } : {}),
								...(parsed.flagValues.has("--verify") ? { verification: parsed.flagValues.get("--verify") ?? [] } : {}),
							}
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
				ctx.openTasks?.();
				return;
			}
			if (!ctx.userTasks) {
				ctx.notice("error", "operator task inbox is not wired in this session");
				return;
			}
			try {
				if (command.kind === "tasks-add") {
					const task = ctx.userTasks.add(
						command.text,
						acceptanceFromTaskFlags(process.cwd(), command.expectedOutputs ?? [], command.verification ?? []),
					);
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
		rank: 2,
		acp: { subcommands: ["seed"] },
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
				ctx.openMemory?.();
				return;
			}
			if (command.kind !== "memory-seed") return;
			const result = ctx.seedTaskMemory?.() ?? { status: "not-found" as const };
			switch (result.status) {
				case "seeded":
					ctx.notice(
						"success",
						`task memory seeded ${result.seeded} entr${result.seeded === 1 ? "y" : "ies"} from ${result.source}${result.skipped > 0 ? `; skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}` : ""}${(result.flowRuleIds?.length ?? 0) > 0 ? `. This session now carries the source's information-flow restrictions (${result.flowRuleIds?.join(", ")}), so a route they refuse fails on the next prompt` : ""}`,
					);
					return;
				case "disabled":
					ctx.notice("warn", "task memory is disabled; enable context.memory.enabled before seeding");
					return;
				case "not-found":
					ctx.notice("info", "no structured task-memory snapshot found in the newest handoff");
					return;
				case "refused":
					ctx.notice("warn", `task memory not seeded: ${result.reason}`);
			}
		},
	},
	{
		name: "view",
		rank: 2,
		acp: false,
		description: "Browse session artifacts and verify run records",
		group: "Inspect",
		kinds: ["view", "view-verify"],
		args: {
			positionals: [{ name: "filter", required: false, rest: true }],
			subcommands: {
				verify: {
					positionals: [{ name: "runId", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "view", reason: parsed.error };
			if (parsed.subcommand === "verify") {
				const runId = parsed.positionals[0] ?? "";
				return { kind: "view-verify", runId };
			}
			return parsed.rest ? { kind: "view", filter: parsed.rest } : { kind: "view" };
		},
		handle(command, ctx) {
			if (command.kind === "view") {
				ctx.openView?.(command.filter);
				return;
			}
			if (command.kind !== "view-verify") return;
			if (!ctx.verifyRun) {
				ctx.notice("warn", "Run verification is unavailable on this surface");
				return "rejected";
			}
			const result = ctx.verifyRun(command.runId);
			const block = formatRunVerificationBlock(command.runId, result);
			if (result.ok) ctx.notice(result.compromised ? "warn" : "success", block);
			else ctx.notice("error", block);
		},
	},
	{
		name: "panes",
		rank: 3,
		acp: false,
		description: "Show pane status, watch a run, open a utility pane or a coding peer",
		group: "Inspect",
		kinds: ["panes", "panes-show", "panes-open", "panes-zoom", "panes-close", "panes-usage", "peer-pane"],
		args: {
			subcommands: {
				peer: {
					parseFlagsBeforeRest: true,
					flags: [{ name: "--cwd", takesValue: true, valueName: "path" }],
					positionals: [
						{ name: "peer", required: true },
						{ name: "brief", required: false, rest: true },
					],
				},
				show: { positionals: [{ name: "run-or-agent", required: true }] },
				// A rest positional, so an argv pane keeps its own flags: the parser
				// would otherwise refuse `--follow` as an unknown flag of `/panes`.
				open: { positionals: [{ name: "preset-or-argv", required: true, rest: true }] },
				zoom: { positionals: [{ name: "target", required: false }] },
				close: { positionals: [{ name: "target", required: false }] },
			},
		},
		subcommandDescriptions: {
			peer: "Open a coding peer in a Clio-owned interactive pane",
			show: "Watch a live run or agent in the watch pane",
			open: `Open a utility pane (${PANES_PRESET_IDS.join(", ")}, \`files --once\` for one pick, or a command)`,
			zoom: "Toggle zoom on a Clio-owned pane (default: the watch pane)",
			close: "Close a Clio-owned pane, or all of them",
		},
		fromArgs(parsed) {
			if (parsed.subcommand === "peer") return panesPeerFromArgs(parsed);
			if (parsed.error) return { kind: "panes-usage", reason: parsed.error };
			if (parsed.subcommand === "show") {
				return { kind: "panes-show", target: parsed.positionals[0] ?? "" };
			}
			if (parsed.subcommand === "open") {
				const rest = (parsed.rest ?? "").trim();
				if (rest.length === 0) return { kind: "panes-usage", reason: "Missing required argument: preset-or-argv" };
				const argv = rest.split(/\s+/).filter((token) => token.length > 0);
				const first = argv[0] ?? "";
				// A bare preset name is a preset; anything else is operator argv,
				// which the tool surface deliberately cannot ask for.
				const preset = resolvePanesPresetId(first);
				if (argv.length === 1 && preset !== null) return { kind: "panes-open", preset };
				if (argv.length === 2 && preset === "files" && argv[1] === "--once") {
					return { kind: "panes-open", preset: "files", once: true };
				}
				return { kind: "panes-open", argv };
			}
			if (parsed.subcommand === "zoom") {
				return { kind: "panes-zoom", target: parsed.positionals[0] ?? "" };
			}
			if (parsed.subcommand === "close") {
				return { kind: "panes-close", target: parsed.positionals[0] ?? "all" };
			}
			if (parsed.positionals.length > 0) {
				return { kind: "panes-usage", reason: `Unexpected argument: ${parsed.positionals[0]}` };
			}
			return { kind: "panes" };
		},
		handle(command, ctx) {
			const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "panes");
			if (command.kind === "panes-usage") {
				const listing = command.listing ? ctx.panes?.peers?.() : undefined;
				if (listing && ctx.panes) {
					// The bare verb answers "which agents would open here?" with what is on this machine.
					const status = ctx.panes.status();
					const width = Math.max(...listing.map((row) => row.peer.length));
					const lines = [
						status.available
							? "Peers: coding agents Clio can open in a pane beside this one. Clio does not track or review their work."
							: `Peers: none can open now. ${status.reason}`,
						...listing.map(
							(row) =>
								`  ${row.peer.padEnd(width)}  ${row.found ? "installed" : `not found; install ${row.binary} to use it`}`,
						),
						`  ${"Open one".padEnd(width)}  /panes peer <agent> [brief]; the brief becomes its first prompt, and --cwd <path> picks its folder`,
					];
					// One write is one block: a write per line drew a spacer between rows wherever a row wrapped.
					ctx.io.stdout(`${lines.join("\n")}\n`);
					ctx.render?.();
					return;
				}
				// usageNotice trims the leading newline usageLine carries, so the reason
				// and the usage line need their own separator or they run together as
				// `Missing required argument: run-or-agentusage: /panes show ...`.
				if (entry) {
					const usage = usageNotice(entry, command.subcommand);
					ctx.notice("info", command.reason ? `${command.reason}\n${usage}` : usage);
				}
				return;
			}
			const panes = ctx.panes;
			if (!panes) {
				// Inactive by choice, not unavailable: the operations object exists in
				// every `--with-panes` session, even one where no pane host answered.
				ctx.notice(
					"info",
					"panes are inactive: this session started without them. Restart `clio-coder` in a plain terminal to open its own pane host, or run `clio-coder --with-panes` inside herdr",
				);
				return;
			}
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			if (command.kind === "peer-pane") {
				runLocal(async () => {
					const result = await panes.handoff({
						peer: command.peer,
						...(command.brief ? { brief: command.brief } : {}),
						...(command.cwd ? { cwd: command.cwd } : {}),
					});
					if (result.status === "opened") {
						ctx.notice(
							"success",
							`Opened ${command.peer} in a pane beside this one, working in ${result.cwd}. It runs on its own: Clio keeps no run record of it and does not review its changes.`,
						);
					} else if (result.status === "missing-binary") {
						ctx.notice("warn", result.detail);
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind === "panes") {
				runLocal(async () => {
					ctx.io.stdout(`${formatPanesStatus(panes.status()).join("\n")}\n`);
					ctx.render?.();
				});
				return;
			}
			if (command.kind === "panes-show") {
				runLocal(async () => {
					const result = await panes.show(command.target);
					if (result.status === "watching") {
						ctx.notice("success", `the workers dock is following ${result.agentId} (${result.runId})`);
					} else if (result.status === "not-found") {
						const known = result.candidates.length > 0 ? `; live runs: ${result.candidates.join(", ")}` : "";
						ctx.notice("warn", `no live run matches ${result.target}${known}`);
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind === "panes-open") {
				runLocal(async () => {
					const result = await panes.open({
						...(command.preset ? { preset: command.preset } : {}),
						...(command.argv ? { argv: command.argv } : {}),
						...(command.once ? { once: true } : {}),
					});
					if (result.status === "opened") {
						// The in-terminal chooser has already restored the TUI by the
						// time this resolves. A pick emitted its composer notice; an empty
						// chooser was cancellation and deliberately stays silent.
						if (result.paneId !== null) {
							ctx.notice(
								"success",
								result.existing
									? `focused pane ${result.label} (${result.paneId})`
									: `opened pane ${result.label} (${result.paneId})`,
							);
						}
					} else if (result.status === "missing-binary") {
						// This is a synchronous slash-surface line, not a transient pane-host
						// notification. It remains visible when no pane was ever created and
						// reuses the exact doctor/tools diagnostic including the install hint.
						ctx.io.stdout(`${result.detail}\n`);
						ctx.render?.();
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind === "panes-zoom") {
				runLocal(async () => {
					const result = await panes.zoom(command.target);
					if (result.status === "zoomed") {
						ctx.notice("success", `toggled zoom on ${result.label} (${result.paneId})`);
					} else if (result.status === "not-found") {
						ctx.notice("warn", `no Clio-owned pane matches ${result.target}`);
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind !== "panes-close") return;
			runLocal(async () => {
				const result = await panes.close(command.target);
				if (result.status === "closed") {
					const what = result.labels.length > 0 ? `: ${result.labels.join(", ")}` : "";
					ctx.notice(result.closed > 0 ? "success" : "info", `closed ${result.closed} pane(s)${what}`);
				} else if (result.status === "not-found") {
					ctx.notice("warn", `no Clio-owned pane matches ${result.target}`);
				} else {
					ctx.notice("warn", result.reason);
				}
			});
		},
	},
	{
		name: "files",
		rank: 3,
		acp: false,
		description: "Show or hide the files pane; picks land in the composer as @ mentions",
		group: "Inspect",
		kinds: ["files", "files-usage"],
		args: { positionals: [{ name: "action", required: false }] },
		subcommandDescriptions: {
			open: "Open or reveal the files pane and move the keyboard into it",
			hide: "Hide the files pane; Yazi keeps running and keeps its directory",
			close: "Close the files pane and end Yazi",
			pick: "Borrow the files pane for one selection, then close it",
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "files-usage", reason: parsed.error };
			const action = parsed.positionals[0];
			if (action === undefined) return { kind: "files", action: "toggle" };
			if (action === "open" || action === "hide" || action === "close" || action === "pick" || action === "toggle") {
				return { kind: "files", action };
			}
			return { kind: "files-usage", reason: `Unexpected argument: ${action}` };
		},
		handle(command, ctx) {
			if (command.kind === "files-usage") {
				ctx.notice("info", `${command.reason}\nusage: /files [open|hide|close|pick]`);
				return;
			}
			if (command.kind !== "files") return;
			const panes = ctx.panes;
			if (!panes) {
				ctx.notice(
					"info",
					"the files pane is inactive: this session started without panes. Restart `clio-coder` in a plain terminal to open its own pane host, or run `clio-coder --with-panes` inside herdr",
				);
				return;
			}
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			runLocal(async () => {
				const result = await panes.files(command.action);
				if (result.status === "opened") {
					// The in-terminal chooser reports through its own composer notice.
					if (result.paneId !== null) {
						ctx.notice(
							"success",
							`${result.revealed ? "Files pane shown" : result.existing ? "Files pane focused" : "Files pane opened"} beside this one. Picks land in the composer as @ mentions; /files hides it.`,
						);
					}
				} else if (result.status === "hidden") {
					ctx.notice("info", "Files pane hidden; /files shows it again in the same directory.");
				} else if (result.status === "closed") {
					ctx.notice("info", "Files pane closed.");
				} else if (result.status === "missing-binary") {
					ctx.io.stdout(`${result.detail}\n`);
					ctx.render?.();
				} else if (result.status === "refused" && /interface\.panes\.files\.enabled/u.test(result.reason)) {
					// The gate's reason names the key; the operator also needs where to flip it.
					ctx.notice(
						"warn",
						"The files pane is off. Turn on Files pane in /settings (Workspace & Files), or set interface.panes.files.enabled: true, then run /files again.",
					);
				} else {
					ctx.notice("warn", result.reason);
				}
			});
		},
	},
	{
		name: "music",
		rank: 3,
		acp: false,
		description: "Show or hide the focus-radio music pane (cliamp in a herdr dock)",
		group: "Inspect",
		kinds: ["music", "music-station", "music-usage"],
		args: {
			positionals: [
				{ name: "action", required: false },
				{ name: "station", required: false, rest: true },
			],
		},
		subcommandDescriptions: {
			on: "Play, opening or revealing the music pane first",
			off: "Stop the music and close the pane",
			pause: "Silence the music and keep the pane",
			next: "Skip to the next station",
			status: "Say what is playing",
			station: "Play a stream URL or a station by name",
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "music-usage", reason: parsed.error };
			const action = parsed.positionals[0];
			if (action === undefined) return { kind: "music", action: "toggle" };
			if (action === "station") {
				const station = parsed.rest?.trim() ?? "";
				return station.length > 0
					? { kind: "music-station", station }
					: { kind: "music-usage", reason: "name a station or paste a stream URL" };
			}
			if (
				action === "on" ||
				action === "off" ||
				action === "pause" ||
				action === "next" ||
				action === "status" ||
				action === "toggle"
			) {
				return { kind: "music", action };
			}
			return { kind: "music-usage", reason: `Unexpected argument: ${action}` };
		},
		handle(command, ctx) {
			if (command.kind === "music-usage") {
				ctx.notice("info", `${command.reason}\nusage: /music [on|off|pause|next|status|station <name or url>]`);
				return;
			}
			const music = ctx.music;
			if (!music) {
				ctx.notice(
					"info",
					"music needs the pane layer and this session started without panes: set integrations.music.enabled: true in settings.yaml, install cliamp with `clio-coder tools install cliamp`, then restart inside herdr with `clio-coder --with-panes`",
				);
				return;
			}
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			runLocal(async () => {
				let result: MusicResult;
				if (command.kind === "music-station") result = await music.station(command.station);
				else if (command.kind !== "music") return;
				else if (command.action === "toggle") result = await music.toggle();
				else result = await music[command.action]();
				const tone = musicResultTone(result);
				ctx.notice(tone === "problem" ? "warn" : tone, describeMusicResult(result));
			});
		},
	},
	{
		name: "thinking",
		rank: 2,
		acp: false,
		description: "Set the chat thinking level",
		group: "Configure",
		kinds: ["thinking-set", "thinking-picker"],
		args: { positionals: [{ name: "level", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "thinking", reason: parsed.error };
			const level = parsed.positionals[0];
			return level ? { kind: "thinking-set", level } : { kind: "thinking-picker" };
		},
		handle(command, ctx) {
			if (command.kind === "thinking-picker") {
				if (ctx.openThinkingPicker) ctx.openThinkingPicker();
				else ctx.notice("error", "thinking picker is not wired in this session");
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
			ctx.render?.();
		},
	},
	{
		name: "model",
		rank: 1,
		acp: false,
		description: "Pick a model, or set one by name",
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
				ctx.openModel?.();
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
				const chatTarget = ctx.getChatTarget?.();
				const result = resolveModelReference(command.pattern, ctx.providers, {
					use: "chat",
					...(chatTarget != null ? { preferTarget: chatTarget } : {}),
				});
				if (!result.ref) {
					ctx.notice("error", result.error ?? `no match for "${command.pattern}"`);
					ctx.render?.();
					return;
				}
				if (result.warning) ctx.notice("warn", result.warning);
				// "reported" means the host's own notice already said what landed.
				if (ctx.applyModelRef?.(result.ref) === "applied") {
					const suffix = result.ref.thinkingLevel ? ` thinking=${result.ref.thinkingLevel}` : "";
					const status = ctx.providers.list().find((candidate) => candidate.target.id === result.ref?.target);
					const caps = status ? resolveModelCapabilities(status, result.ref.model, ctx.providers.knowledgeBase) : null;
					const imageInput = caps === null ? "unknown" : acceptsImageInput({ vision: caps.vision }) ? "yes" : "no";
					ctx.notice(
						"success",
						`active this session: ${result.ref.target}/${result.ref.model}${suffix} · image input ${imageInput}`,
					);
				}
				ctx.render?.();
			})().catch((error: unknown) => {
				// A switch that threw did not happen; say so rather than leave the old model looking chosen.
				ctx.notice("error", `model not changed: ${error instanceof Error ? error.message : String(error)}`);
				ctx.render?.();
			});
		},
	},
	{
		name: "config",
		rank: 2,
		acp: false,
		description: "Run setup and apply saved changes to this session",
		group: "Configure",
		kinds: ["config"],
		args: {},
		fromArgs: fromArgsOrUsage("config", { kind: "config" }),
		handle(_command, ctx) {
			if (ctx.isTurnInFlight?.()) {
				ctx.notice("warn", "A turn is running. Press Esc first, then run /config.");
				return;
			}
			if (!ctx.openConfigure) {
				ctx.notice("warn", "/config needs an interactive terminal.");
				return;
			}
			ctx.openConfigure();
		},
	},
	{
		name: "settings",
		rank: 1,
		aliases: [{ name: "login", args: "connections" }],
		acp: false,
		description: "Open interactive settings",
		group: "Configure",
		kinds: ["settings"],
		args: {
			positionals: [
				{ name: "area", required: false },
				{ name: "group", required: false },
			],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "settings", reason: parsed.error };
			const name = parsed.positionals[0];
			if (name === undefined) return { kind: "settings" };
			const area = resolveSettingsArea(name);
			if (!area) {
				return {
					kind: "usage-error",
					command: "settings",
					reason: `Unknown area: ${name} (one of ${SETTINGS_AREA_IDS.join(", ")})`,
				};
			}
			const group = parsed.positionals[1];
			if (group === undefined) return { kind: "settings", area };
			// `/settings chat model-picker` predates the Models & Inference area; it is the only second word kept.
			if (group === "model-picker" && (area === "chat" || area === "models")) {
				return { kind: "settings", area, group };
			}
			return { kind: "usage-error", command: "settings", reason: `Use /settings [area]; ${group} is not an area option` };
		},
		handle(command, ctx) {
			if (command.kind === "settings") ctx.openSettings?.(command.area, command.group);
		},
	},
	{
		name: "resume",
		rank: 1,
		acp: false,
		description: "Resume by id, unique id prefix, or exact unique name",
		group: "Session",
		kinds: ["resume"],
		args: { positionals: [{ name: "id|prefix|name", required: false, rest: true }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "resume", reason: parsed.error };
			const target = sessionNameArgument(parsed.rest ?? "");
			return target ? { kind: "resume", target } : { kind: "resume" };
		},
		handle(command, ctx) {
			if (command.kind === "resume") ctx.openResume?.(command.target);
		},
	},
	{
		name: "rename",
		rank: 2,
		acp: false,
		description: "Name this session, or confirm a local suggestion from the conversation",
		group: "Session",
		kinds: ["rename"],
		args: { positionals: [{ name: "name", required: false, rest: true }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "rename", reason: parsed.error };
			if (parsed.rest === undefined) return { kind: "rename" };
			const name = sessionNameArgument(parsed.rest);
			return name
				? { kind: "rename", name }
				: { kind: "usage-error", command: "rename", reason: "Session name must not be empty or whitespace-only" };
		},
		handle(command, ctx) {
			if (command.kind !== "rename") return;
			if (ctx.renameSession) ctx.renameSession(command.name);
			else ctx.notice("error", "/rename needs an interactive session");
		},
	},
	{
		name: "new",
		rank: 1,
		aliases: [{ name: "clear" }],
		acp: false,
		description: "Start a fresh session",
		group: "Session",
		kinds: ["new"],
		args: {},
		fromArgs: fromArgsOrUsage("new", { kind: "new" }),
		handle(_command, ctx) {
			ctx.startNewSession?.();
		},
	},
	{
		name: "report",
		rank: 3,
		acp: {
			subcommands: ["bug", "feature", "question", "status", "send", "forget", "security"],
			reads: ["status", "security"],
			readOnlyRefuses: ["send", "forget"],
		},
		description: "Preview, then send a bug, feature request or question to Clio Coder's maintainers",
		group: "Session",
		kinds: ["report", "report-status", "report-send", "report-forget", "report-security"],
		subcommandDescriptions: {
			bug: "Report a bug; the summary becomes the title",
			feature: "Ask for a feature",
			question: "Ask the maintainers a question",
			security: "Report a security problem privately",
			status: "List your reports and saved drafts",
			send: "Review and send a saved draft",
			forget: "Delete a saved draft",
		},
		args: {
			subcommands: {
				bug: { positionals: [{ name: "summary", required: false, rest: true }] },
				feature: { positionals: [{ name: "summary", required: false, rest: true }] },
				question: { positionals: [{ name: "summary", required: false, rest: true }] },
				security: {},
				status: {},
				send: {
					positionals: [{ name: "draft", required: true }],
					flags: [{ name: "--comment", takesValue: true, valueName: "n" }, { name: "--new" }],
				},
				forget: { positionals: [{ name: "id", required: true }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "report", reason: parsed.error };
			const sub = parsed.subcommand;
			if (sub === "status") return { kind: "report-status" };
			if (sub === "security") return { kind: "report-security" };
			if (sub === "send") {
				const draftId = parsed.positionals[0] ?? "";
				const comment = parsed.flags.get("--comment");
				if (comment !== undefined && parsed.flags.has("--new"))
					return { kind: "usage-error", command: "report", reason: "--comment and --new are alternatives; pass one" };
				if (comment !== undefined) {
					if (typeof comment !== "string" || !/^[1-9]\d*$/u.test(comment))
						return { kind: "usage-error", command: "report", reason: "--comment takes an issue number" };
					return { kind: "report-send", draftId, duplicate: { comment: Number(comment) } };
				}
				return { kind: "report-send", draftId, ...(parsed.flags.has("--new") ? { duplicate: "new" as const } : {}) };
			}
			if (sub === "forget") return { kind: "report-forget", id: parsed.positionals[0] ?? "" };
			const report: SlashReportKind = sub === "feature" || sub === "question" ? sub : "bug";
			const summary = parsed.rest?.trim() ?? "";
			return { kind: "report", report, ...(summary.length > 0 ? { summary } : {}) };
		},
		// Not refused during a turn: a hung turn is a reason to report, and the review never touches the turn.
		handle(command, ctx) {
			const unavailable = () => ctx.notice("info", "reporting is not available on this surface; run `clio-coder report`");
			const text = ctx.openReport ? undefined : ctx.reportHost;
			if (text) {
				let reply: ReturnType<ReportTextHost["status"]>;
				if (command.kind === "report-status") reply = text.status();
				else if (command.kind === "report-forget") reply = text.forget(command.id);
				else if (command.kind === "report-send")
					reply = text.send(command.draftId, command.duplicate !== undefined ? { duplicate: command.duplicate } : {});
				else if (command.kind === "report-security") reply = text.plan({ kind: "security" });
				else if (command.kind === "report")
					reply = text.plan({
						kind: command.report,
						...(command.summary !== undefined ? { summary: command.summary } : {}),
					});
				else return;
				const shown = reply.then((answer) => ctx.notice(answer.level, answer.text));
				if (ctx.holdReplyFor) ctx.holdReplyFor(shown);
				else
					shown.catch((error: unknown) =>
						ctx.notice("error", `report failed: ${error instanceof Error ? error.message : String(error)}`),
					);
				return;
			}
			if (command.kind === "report-status") {
				if (ctx.showReportStatus) ctx.showReportStatus();
				else unavailable();
				return;
			}
			if (command.kind === "report-forget") {
				if (ctx.forgetReport) ctx.forgetReport(command.id);
				else unavailable();
				return;
			}
			if (!ctx.openReport) {
				unavailable();
				return;
			}
			if (command.kind === "report-send") ctx.openReport({ kind: "draft", draftId: command.draftId });
			else if (command.kind === "report-security") ctx.openReport({ kind: "security" });
			else if (command.kind === "report")
				ctx.openReport({ kind: command.report, ...(command.summary !== undefined ? { summary: command.summary } : {}) });
		},
	},
	{
		name: "handoff",
		rank: 2,
		acp: false,
		description: "Hand this session's working state to a fresh session for a stated goal",
		group: "Session",
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
			ctx.startHandoff?.(command.goal);
		},
	},
	{
		name: "tree",
		rank: 2,
		acp: false,
		description: "Open session tree navigator",
		group: "Session",
		kinds: ["tree"],
		args: {},
		fromArgs: fromArgsOrUsage("tree", { kind: "tree" }),
		handle(_command, ctx) {
			ctx.openTree?.();
		},
	},
	{
		name: "rewind",
		rank: 1,
		aliases: [{ name: "undo" }],
		acp: false,
		description: "Restore workspace files from a snapshot taken before Clio's changes; /tree rewinds the conversation",
		group: "Session",
		kinds: ["rewind"],
		args: {},
		fromArgs: fromArgsOrUsage("rewind", { kind: "rewind" }),
		handle(_command, ctx) {
			ctx.openRewind?.();
		},
	},
	{
		name: "fork",
		rank: 2,
		acp: false,
		description: "Fork from an assistant turn into a new session; optionally name it",
		group: "Session",
		kinds: ["fork"],
		args: { positionals: [{ name: "name", required: false, rest: true }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "fork", reason: parsed.error };
			const name = sessionNameArgument(parsed.rest ?? "");
			return name ? { kind: "fork", name } : { kind: "fork" };
		},
		handle(command, ctx) {
			if (command.kind === "fork") ctx.openMessagePicker?.(command.name);
		},
	},
	{
		name: "export",
		rank: 2,
		acp: {},
		description: "Export the transcript as HTML, or as Markdown for a .md path",
		group: "Session",
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

const contextCommand = CANONICAL_SLASH_COMMANDS.find((entry) => entry.name === "context");
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	...CANONICAL_SLASH_COMMANDS,
	...(contextCommand
		? [
				{
					...contextCommand,
					aliases: [],
					name: "compact",
					rank: 1 as const,
					acp: false as const,
					kinds: [],
					description: "Shrink session context (alias for /context compact)",
					args: { positionals: [...COMPACT_POSITIONALS] },
					subcommandDescriptions: {},
					fromArgs: (parsed: ParsedArgs): SlashCommand =>
						parsed.error
							? { kind: "usage-error", command: "compact", reason: parsed.error }
							: { kind: "compact", instructions: parsed.rest },
				},
			]
		: []),
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

/** Alias name to the command line it stands for, without the leading slash. */
const ALIAS_TARGETS = new Map<string, { command: string; line: string }>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
	for (const alias of entry.aliases ?? []) {
		if (COMMAND_NAMES.has(alias.name)) {
			throw new Error(`BUILTIN_SLASH_COMMANDS: alias "${alias.name}" of /${entry.name} equals the command /${alias.name}`);
		}
		const other = ALIAS_TARGETS.get(alias.name);
		if (other) {
			throw new Error(
				`BUILTIN_SLASH_COMMANDS: alias "${alias.name}" is claimed by both /${other.command} and /${entry.name}`,
			);
		}
		ALIAS_TARGETS.set(alias.name, {
			command: entry.name,
			line: alias.args ? `${entry.name} ${alias.args}` : entry.name,
		});
	}
}

/** `/clear foo` becomes `/new foo`; anything that is not an alias comes back unchanged. */
function resolveAlias(trimmed: string): string {
	const match = /^\/([A-Za-z][A-Za-z0-9-]*)(?=\s|$)/u.exec(trimmed);
	const target = match ? ALIAS_TARGETS.get(match[1] ?? "") : undefined;
	if (!match || !target) return trimmed;
	const rest = trimmed.slice(match[0].length).trim();
	return `/${target.line}${rest ? ` ${rest}` : ""}`;
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
/**
 * One notice line for a reload outcome. Success when the generation committed
 * cleanly; warn when it committed with dropped hooks or declaration issues;
 * error when it was refused and the previous generation stays active.
 */
export function formatExtensionReloadNotice(outcome: ExtensionReloadOutcome): [NoticeLevel, string] {
	if (outcome.status !== "committed") {
		return ["error", `extensions: reload rejected (${outcome.reason}); generation ${outcome.generation} stays active`];
	}
	const delta = outcome.changed
		? `changed: +${outcome.added.length} -${outcome.removed.length} ~${outcome.modified.length}`
		: "unchanged";
	const issueCount = outcome.hooks.fileIssues + outcome.hooks.issues;
	const hookParts = [`${outcome.hooks.registered} registered`];
	if (outcome.hooks.dropped > 0) hookParts.push(`${outcome.hooks.dropped} dropped`);
	if (issueCount > 0) hookParts.push(`${issueCount} issue${issueCount === 1 ? "" : "s"}`);
	if (outcome.hooks.overridden > 0) hookParts.push(`${outcome.hooks.overridden} overridden`);
	const level: NoticeLevel = outcome.hooks.dropped > 0 || issueCount > 0 ? "warn" : "success";
	return [level, `extensions: generation ${outcome.generation} committed (${delta}); hooks: ${hookParts.join(", ")}`];
}

function extensionsCommand(command: Extract<SlashCommand, { kind: "resources" }>, ctx: SlashCommandContext): void {
	if (command.action === "leave") {
		if (!ctx.operatorExtensions?.leaveWorkspace()) ctx.notice("info", "No extension workspace is active");
		ctx.render?.();
	} else if (command.action !== undefined) {
		if (ctx.extensionDev) ctx.extensionDev(command.action, command.target);
		else ctx.notice("warn", "extensions: dev and mute are available in the terminal only");
	} else ctx.openExtensions?.();
}

function sessionNameArgument(raw: string): string {
	const text = raw.trim();
	return (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
		? text.slice(1, -1).trim()
		: text;
}

export function parseSlashCommand(input: string): SlashCommand {
	if (/^\s*\/rename\s+$/u.test(input)) {
		return { kind: "usage-error", command: "rename", reason: "Session name must not be empty or whitespace-only" };
	}
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (trimmed.startsWith(COMMAND_ESCAPE)) return { kind: "unknown", text: trimmed.slice(1) };
	const retiredVerb = matchRetiredCommand(trimmed, true);
	if (retiredVerb) return retiredVerb;
	const resolved = resolveAlias(trimmed);
	for (const entry of BUILTIN_SLASH_COMMANDS) {
		const match = entry.match ? entry.match(resolved) : matchFromSpec(entry, resolved);
		if (match) return match;
	}
	const retired = matchRetiredCommand(trimmed);
	if (retired) return retired;
	if (trimmed.startsWith("/")) {
		const token = trimmed.slice(1).split(/\s+/u)[0] ?? "";
		if (COMMAND_SHAPED_TOKEN.test(token) || isExtensionCommandToken(token))
			return { kind: "unknown-command", token, text: trimmed };
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
		const runtime = ctx.operatorExtensions;
		// Only names decide a takeover, and this runs before a typo's notice can paint.
		const promptNames = promptRefs((ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items ?? []);
		const takeovers = (runtime?.commands(promptNames) ?? []).filter(
			(row) => row.invocation === command.token && row.replaces === "prompt",
		);
		const replacement = takeovers.find((row) => row.available);
		// A takeover whose runtime is only restarting is not an absent extension: handing its prompt
		// to the model would answer with a model turn the operator did not ask for. Refuse and keep the draft.
		const settling = takeovers.find((row) => !row.available && row.transient === true);
		if (settling) {
			ctx.notice(
				"warn",
				`/${command.token}: ${settling.reason ?? "extension runtime is restarting"}; send it again in a moment`,
			);
			ctx.render?.();
			return "rejected";
		}
		const expansion = replacement ? undefined : ctx.expandPromptTemplate?.(command.text);
		if (expansion?.expanded === true) {
			ctx.submitChat(command.text);
			return "accepted";
		}
		// A display-only template is answered here, for the operator, and the
		// model is never told it was asked: no turn, no session entry, no tokens.
		if (expansion?.expanded === false && expansion.display) {
			const { template, text } = expansion.display;
			const card: PromptReferenceCard = {
				command: template.name,
				source: promptSourceLabel(template.sourceInfo),
				text,
			};
			if (ctx.showReference) ctx.showReference(card);
			else ctx.io.stdout(`/${card.command} (${card.source})\n${card.text}\n`);
			ctx.render?.();
			return "accepted";
		}
		// A template that exists and refused is not a typo. Its reason reaches the
		// operator and nothing reaches the model.
		const refusal = expansion?.expanded === false ? expansion.refusal : undefined;
		if (!refusal && (isExtensionCommandToken(command.token) || replacement) && ctx.operatorExtensions) {
			const runtime = ctx.operatorExtensions;
			const promptNames = promptRefs(ctx.listPrompts?.().items ?? []);
			const row = runtime.commands(promptNames).find((row) => row.invocation === command.token);
			if (!row?.available) {
				ctx.notice("error", row?.reason ?? `/${command.token} is not an available extension command`);
				ctx.render?.();
				return "rejected";
			}
			const args = command.text.slice(command.token.length + 1).trim();
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			runLocal(async () => {
				try {
					const output = await runtime.invoke(command.token, args, promptRefs(ctx.listPrompts?.().items ?? []));
					if (ctx.showExtensionOutput) ctx.showExtensionOutput(command.token, output, row.extensionId);
					else ctx.io.stdout(`${output.text}\n`);
				} catch (error) {
					// A deferred runtime can become unavailable while starting on first use.
					// Re-enter ordinary prompt dispatch only after the manager withdraws the alias.
					if (
						replacement &&
						!runtime
							.commands(promptRefs(ctx.listPrompts?.().items ?? []))
							.some((row) => row.invocation === command.token && row.available)
					) {
						dispatchSlashCommand(command, ctx);
						return;
					}
					// What failed, whether the extension survived it, and the next step. A
					// runtime that rethrows keeps its own "Error:" prefix; one is enough.
					const raw = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, "");
					const owner = extensionOwnerLabel(row.extensionId);
					const reason = raw.startsWith(`/${command.token} is not an available`)
						? "it is not available now"
						: plainExtensionError(raw, owner);
					const state = runtime.entries().find((entry) => entry.id === row.extensionId)?.state;
					const next =
						state === "ready"
							? "It is still running; correct the command and run it again."
							: state === "failed" || state === undefined
								? "It stopped; /extensions shows why, and r there restarts it."
								: `It is ${state}; /extensions shows its state, and r there restarts it.`;
					ctx.notice("error", `/${command.token} failed: ${sentence(reason)} ${next}`);
				}
			});
			return "accepted";
		}
		const closest = refusal ? null : closestCommand(command.token);
		ctx.notice(
			"error",
			refusal
				? refusal.message
				: closest
					? `\`/${command.token}\` is not a command. Closest: \`/${closest.typed}\`${closest.runs ? ` (runs \`/${closest.runs}\`)` : ""}. \`/help\` lists them all.`
					: `/${command.token} is not a command. Type /help for the list.`,
		);
		ctx.render?.();
		return "rejected";
	}
	if (command.kind === "usage-error") {
		const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === command.command);
		const usage = entry ? ` ${usageNotice(entry)}` : "";
		ctx.notice("error", `${command.reason}.${usage}`);
		ctx.render?.();
		return "rejected";
	}
	if (command.kind === "retired") return dispatchRetiredCommand(command, ctx);
	const entry = HANDLER_BY_KIND.get(command.kind);
	if (!entry) return "rejected";
	return entry.handle(command, ctx) === "rejected" ? "rejected" : "accepted";
}

export interface CommandReferenceEntry {
	name: string;
	usage: string;
	description: string;
	group: SlashCommandGroup;
	rank: CommandRank;
	aliases?: ReadonlyArray<CommandAlias>;
	/** The command's args grammar, carried through for argument autocomplete. */
	args?: CommandArgsSpec;
	/** Stable copy shown beside first-token subcommand completions. */
	subcommandDescriptions?: Readonly<Record<string, string>>;
}

/** `includeHidden` is for ACP, which still admits hidden commands such as `/archive` and `/eggs`. */
export function commandReference(options: { includeHidden?: boolean } = {}): ReadonlyArray<CommandReferenceEntry> {
	return BUILTIN_SLASH_COMMANDS.filter((entry) => options.includeHidden === true || entry.hidden !== true)
		.slice()
		.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
		.map((entry) => {
			const usage = usageLine(entry)
				.replace(/^\nusage:\s*/, "")
				.replace(/\n$/, "");
			return {
				name: entry.name,
				usage,
				description: entry.description,
				group: entry.group,
				rank: entry.rank,
				...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
				...(entry.args ? { args: entry.args } : {}),
				...(entry.subcommandDescriptions ? { subcommandDescriptions: entry.subcommandDescriptions } : {}),
			};
		});
}

/** Match classes, best first. */
export type CommandMatchClass = "exact" | "name" | "alias" | "verb" | "letters" | "description";

export interface CommandMatch {
	ref: CommandReferenceEntry;
	class: CommandMatchClass;
	/** Set for an alias row: the alias the query matched. */
	alias?: CommandAlias;
	/** Set for a verb row: the subcommand the query matched. */
	verb?: string;
}

export function lettersInOrder(query: string, name: string): boolean {
	let at = 0;
	for (const letter of name) if (letter === query[at]) at++;
	return at === query.length;
}

/**
 * Commands for a typed `/query`, best class first and within a class by rank
 * then name: exact name, name prefix, alias prefix, verb prefix, letters in
 * order within the name (two or more letters), then a description word that
 * starts with the query (three or more letters). A command appears once, in its
 * best class, except that several of its verbs may match.
 */
export function matchCommandReference(
	query: string,
	reference: ReadonlyArray<CommandReferenceEntry> = commandReference(),
): CommandMatch[] {
	const q = query.toLowerCase();
	if (q.length === 0) return reference.map((ref) => ({ ref, class: "name" }));
	const out: CommandMatch[] = [];
	const taken = new Set<string>();
	const pass = (test: (ref: CommandReferenceEntry) => Omit<CommandMatch, "ref"> | null): void => {
		for (const ref of reference) {
			if (taken.has(ref.name)) continue;
			const hit = test(ref);
			if (!hit) continue;
			out.push({ ref, ...hit });
			taken.add(ref.name);
		}
	};
	pass((ref) => (ref.name === q ? { class: "exact" } : null));
	pass((ref) => (ref.name.startsWith(q) ? { class: "name" } : null));
	pass((ref) => {
		const alias = ref.aliases?.find((candidate) => candidate.name.startsWith(q));
		return alias ? { class: "alias", alias } : null;
	});
	for (const ref of reference) {
		if (taken.has(ref.name)) continue;
		for (const verb of Object.keys(ref.args?.subcommands ?? {})) {
			if (verb.startsWith(q)) out.push({ ref, class: "verb", verb });
		}
	}
	for (const match of out) taken.add(match.ref.name);
	if (q.length >= 2) pass((ref) => (lettersInOrder(q, ref.name) ? { class: "letters" } : null));
	if (q.length >= 3) {
		pass((ref) =>
			ref.description
				.toLowerCase()
				.split(/[^a-z0-9]+/u)
				.some((word) => word.startsWith(q))
				? { class: "description" }
				: null,
		);
	}
	return out;
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length] ?? Number.POSITIVE_INFINITY;
}

/**
 * The spelling an unknown `/token` most likely meant, with what it runs when
 * that differs: the palette's best row, else the nearest name or alias within
 * two edits.
 */
export function closestCommand(token: string): { typed: string; runs?: string } | null {
	const reference = commandReference();
	const best = matchCommandReference(token, reference)[0];
	if (best?.alias) return { typed: best.alias.name, runs: aliasLine(best.ref.name, best.alias) };
	if (best?.verb) return { typed: `${best.ref.name} ${best.verb}` };
	if (best) return { typed: best.ref.name };
	const q = token.toLowerCase();
	let nearest: { typed: string; runs?: string; distance: number } | null = null;
	for (const ref of reference) {
		const candidates: Array<{ typed: string; runs?: string }> = [
			{ typed: ref.name },
			...(ref.aliases ?? []).map((alias) => ({ typed: alias.name, runs: aliasLine(ref.name, alias) })),
		];
		for (const candidate of candidates) {
			const distance = editDistance(q, candidate.typed);
			if (distance <= 2 && (nearest === null || distance < nearest.distance)) nearest = { ...candidate, distance };
		}
	}
	if (!nearest) return null;
	return nearest.runs ? { typed: nearest.typed, runs: nearest.runs } : { typed: nearest.typed };
}

function aliasLine(command: string, alias: CommandAlias): string {
	return alias.args ? `${command} ${alias.args}` : command;
}

/** A reason as one sentence: capitalised, with closing punctuation. */
function sentence(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "";
	const head = trimmed[0]?.toUpperCase() + trimmed.slice(1);
	return /[.!?]$/u.test(head) ? head : `${head}.`;
}

/**
 * A Node file error from an extension, in words. "ENOENT: no such file or
 * directory, open '/abs/project/missing.json'" names the code and an absolute
 * path; the operator needs which file and what went wrong with it.
 */
function plainExtensionError(raw: string, owner: string, cwd: string = process.cwd()): string {
	const match = /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR): [^,]*, \w+ '([^']+)'$/u.exec(raw.trim());
	if (!match) return raw;
	const [, code, target = ""] = match;
	const relative = path.isAbsolute(target) ? path.relative(cwd, target) : target;
	const shown = relative && !relative.startsWith("..") ? relative : target;
	switch (code) {
		case "ENOENT":
			return `${owner} could not find ${shown}`;
		case "EISDIR":
			return `${owner} expected a file but ${shown} is a folder`;
		case "ENOTDIR":
			return `${owner} expected a folder on the way to ${shown}`;
		default:
			return `${owner} is not allowed to read or write ${shown}`;
	}
}
