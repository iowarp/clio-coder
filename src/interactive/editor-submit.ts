import type { runBashCommand } from "../core/bash-exec.js";
import { combineBashOutput, combineLiveBashOutput } from "../core/bash-exec.js";
import { type ExternalEditResult, editTextExternally, resolveExternalEditor } from "../core/external-editor.js";
import type { PendingSkillRequest } from "../core/skill-activation.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import { runOperatorShellLine } from "../domains/session/operator-shell.js";
import type { ChatLoop, QueuedChatMessage } from "../session-control/chat-loop.js";
import {
	parseSlashCommand,
	type RunIo,
	type SlashCommand,
	type SlashCommandDispatchResult,
} from "../session-control/slash-commands.js";
import type { ChatPanel } from "./chat-panel.js";
import { parseEditorBashCommand, unguardPastedEditorOperator } from "./editor-bash.js";
import {
	formatSteerCandidates,
	parseEditorSteerMention,
	type RunningDispatchRef,
	resolveSteerTarget,
	steerDraftToken,
} from "./editor-steer.js";
import type { ShellSettlement } from "./footer/widgets.js";
import type { ChatDraft } from "./interactive-slash-runtime.js";
import { type BashTranscriptExecution, renderBashTranscriptExecution } from "./renderers/tool-execution.js";

export const RESTORED_DRAFT_NOTICE = "Back in the composer, not sent. A / or ! command first keeps it aside.";

/** Existing bash TERM-to-KILL grace (5s), plus settlement and session append. */
export const EDITOR_BASH_SHUTDOWN_MS = 6000;

/**
 * Command shapes whose text is put back in the editor after the parser rejects
 * them.
 *
 * The terminal engine empties the editor inside its own submit path before
 * `onSubmit` runs, so the text is already gone by the time the notice is
 * written. A command that exists and was called wrong is worth restoring: the
 * operator can see which flag the usage line is complaining about and fix that
 * one token.
 *
 * `unknown-command` cannot be decided here: a prompt template can still claim
 * it during dispatch. Its post-dispatch verdict is handled at the call site.
 *
 * A command that ran and failed has done work, and chat text belongs to the
 * transcript, so both also leave the line empty.
 */
function isRejectedCommand(command: SlashCommand): boolean {
	return command.kind === "usage-error" || (command.kind === "retired" && "menuLetter" in command.entry.to);
}

export interface EditorSubmitExpansion {
	text: string;
	images: ReadonlyArray<unknown>;
	/** Paths the draft referenced inline; the idle path hands them to the chat loop for rule scoping. */
	workingContextPaths?: ReadonlyArray<string>;
	/** Skill requests parsed out of the draft; the idle path hands them to the chat loop as the pending-skill policy. */
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	/** The typed line the transcript paints instead of `text`; see `SubmitExpansion.display`. */
	display?: { text: string; note?: string };
	/** A prompt template's `allowed-tools`; see `SubmitExpansion.constraints`. */
	constraints?: TurnConstraints;
}

export interface EditorSubmitEditor {
	getText(): string;
	/** Draft spelling for an immediate send, including any editor provenance envelope. */
	getTextForSubmit(): string;
	getExpandedText?(): string;
	readonly draftRevision?: number;
	setLiteralText?(text: string): void;
	/** Literal text that came back from the queue, which the next command must not append to. */
	setRestoredText?(text: string): void;
	setText(text: string): void;
	/** The worker a just-submitted line was addressed to from Fleet Runs, when `target` is that hidden address. */
	sentSteerAgent?(target: string): string | null;
	addToHistory(text: string): void;
}

export interface EditorSubmitUi {
	start(): void;
	stop(): void;
	requestRender(force?: boolean): void;
}

type EditorSubmitChat = Pick<
	ChatLoop,
	| "discoverOperatorEgg"
	| "clearQueuedFollowUps"
	| "interruptRefusal"
	| "isStreaming"
	| "queueEntries"
	| "removeQueuedEntry"
	| "runningToolCalls"
	| "submit"
	| "whenSettled"
> &
	Partial<Pick<ChatLoop, "resumeAutonomy">>;

/** What the operator chose when a send-now found a tool still running. */
export type SendNowChoice = "stop" | "wait" | "cancelled";
type EditorSubmitDispatch = Pick<DispatchContract, "snapshot" | "steer">;
type EditorSubmitSession = Pick<SessionContract, "appendEntry" | "current" | "leafId">;

export interface EditorSubmitSessionTranscript {
	ensureSessionForLocalEntry(): void;
	refreshChatContextFromSession(leafTurnId: string | null): void;
	/** Count a prompt the operator submitted; the idle path does this through the slash runtime. */
	recordSubmittedTurn(): void;
}

export interface EditorSubmitDeps {
	askEgg?: import("../tools/ask-user.js").AskUserHandler;
	/** Opens the arcade egg when the text is its trigger phrase; true means the text was consumed. */
	arcadeEgg?: (text: string) => boolean;
	onLocalEntry?: (entry: SessionEntry) => void;
	onLocalBashRunning?: (running: boolean, command?: string, settled?: ShellSettlement) => void;
	onLocalBashCancelling?: () => void;
	/** A steer was handed to a worker's queue; the transcript tracks it from here. */
	onSteerSent?: (run: RunningDispatchRef, text: string) => void;
	/** Note a harness feature the operator used, for demo guidance; see recordOperatorFeature. */
	recordFeature?: (feature: string) => void;
	/** Bring a fullscreen transcript back to its live edge before a local command's block lands. */
	returnToLiveEdge?: () => void;
	editor: EditorSubmitEditor;
	ui: EditorSubmitUi;
	io: RunIo;
	chat: EditorSubmitChat;
	dispatch: EditorSubmitDispatch;
	session?: EditorSubmitSession;
	sessionTranscript: EditorSubmitSessionTranscript;
	chatPanel: Pick<ChatPanel, "appendReplayBlock">;
	beforeSemanticBoundary?: (reason: string) => void;
	settleVisibleFrame?: (reason: string) => Promise<void>;
	dispatchCommand: (text: string, draft?: ChatDraft) => SlashCommandDispatchResult;
	dispatchCommandAsync?: (text: string, signal?: AbortSignal) => Promise<void>;
	/** Idempotently collapses a fresh-session launchpad before any handler can append output. */
	collapseLaunchpadBeforeSubmit?: () => void;
	expandSubmit: (text: string) => Promise<EditorSubmitExpansion>;
	notify: (level: "info" | "warning" | "error", text: string, key: string) => void;
	/**
	 * A send-now while a tool call is running asks the operator whether to stop
	 * the tool or wait for it. Absent, the send-now stops it, as Esc would.
	 */
	askSendNow?: (runningTools: number) => Promise<SendNowChoice>;
	getCwd?: () => string;
	/**
	 * Labels the information-flow sources a `!` command names before its output
	 * joins the context. Returns why the label could not be recorded, and the
	 * output then stays out of context.
	 */
	labelOperatorCommand?: (command: string, cwd: string) => string | null;
	/** Runs before an operator shell line reaches the ledger, so a ledger fact can precede it. */
	beforeShellEntryRecorded?: () => void;
	runBash?: typeof runBashCommand;
	resolveEditor?: () => string | null;
	editExternally?: (initialText: string, command: string) => ExternalEditResult;
	nowIso?: () => string;
}

export interface EditorSubmitController {
	runEditorBash(text: string): boolean;
	openExternalEditorForInput(text?: string): boolean;
	handleEditorSteerMention(mention: { target: string; text: string }): boolean;
	submitEditorText(text: string): void;
	/** Admit an immutable boot record without reading or mutating the live draft. */
	admitCapturedText(text: string, signal?: AbortSignal): Promise<void>;
	/**
	 * Interrupt mode: cancel the active run and deliver the draft now. Idle, it
	 * is a plain send. The chat loop owns cancel → settle → submit and the two
	 * refusals (attached dispatch, parked permission ask), which degrade the
	 * message to next-slot delivery with a notice.
	 */
	/** `entry` names the queued entry `text` came from; it leaves the queue only when its prompt is sent. */
	interruptFromEditor(text?: string, entry?: QueuedChatMessage): void;
	restoreQueuedFollowUpsToEditor(): void;
	hasActiveEditorBash(): boolean;
	cancelActiveEditorBash(): boolean;
	/** Stop shell admission, cancel the owned command, and await its persisted result. */
	shutdownEditorBash(): Promise<void>;
}

type EditorSteerSubmission = "accepted" | "rejected";

/** Owns editor submission and the one local bash process attached to it. */
export function createEditorSubmitController(deps: EditorSubmitDeps): EditorSubmitController {
	let shuttingDown = false;
	let activeEditorBash: AbortController | null = null;
	/** Marks the running line's stop request, so its card says the stop went out while the process still runs (HS18). */
	let markEditorBashStop: (() => void) | null = null;
	let activeEditorBashSettlement: Promise<void> | null = null;

	const runEditorBash = (text: string): boolean => {
		const parsed = parseEditorBashCommand(text);
		if (!parsed) return false;
		if (shuttingDown) return true;
		if (deps.chat.isStreaming()) {
			deps.io.stderr("[bash] response in progress. Press Esc to cancel the active run before running a local command.\n");
			return true;
		}
		if (activeEditorBash) {
			deps.io.stderr("[bash] command already running. Press Esc to cancel it first.\n");
			return true;
		}
		const abort = new AbortController();
		activeEditorBash = abort;
		deps.recordFeature?.("!");
		let parentTurnId: string | null = null;
		try {
			deps.sessionTranscript.ensureSessionForLocalEntry();
			parentTurnId = deps.session?.leafId() ?? null;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.io.stderr(`[bash] session setup failed: ${msg}\n`);
			activeEditorBash = null;
			return true;
		}
		deps.returnToLiveEdge?.();
		const startedAt = performance.now();
		const execution: BashTranscriptExecution = {
			command: parsed.command,
			output: "",
			running: true,
			totalBytes: 0,
			excludeFromContext: parsed.excludeFromContext,
		};
		let stopRequestedAt: number | null = null;
		markEditorBashStop = () => {
			stopRequestedAt ??= performance.now();
		};
		deps.chatPanel.appendReplayBlock(
			(width, detail, unbounded) =>
				renderBashTranscriptExecution(
					{
						...execution,
						...(execution.running ? { elapsedMs: Math.max(0, performance.now() - startedAt) } : {}),
						...(execution.running && stopRequestedAt !== null
							? { stopWaitMs: Math.max(0, performance.now() - stopRequestedAt) }
							: {}),
					},
					width,
					undefined,
					{ detail, ...(unbounded ? { unbounded } : {}) },
				),
			() => execution.running,
		);
		deps.ui.requestRender();

		deps.onLocalBashRunning?.(true, parsed.command);
		let settlement!: Promise<void>;
		settlement = (async () => {
			try {
				const {
					result,
					entry: input,
					unlabeled,
				} = await runOperatorShellLine({
					command: parsed.command,
					cwd: deps.getCwd?.() ?? process.cwd(),
					excludeFromContext: parsed.excludeFromContext,
					parentTurnId,
					signal: abort.signal,
					onUpdate: (progress) => {
						execution.output = combineLiveBashOutput(progress);
						execution.totalBytes = progress.outputBytes;
						deps.ui.requestRender();
					},
					...(deps.labelOperatorCommand ? { label: deps.labelOperatorCommand } : {}),
					...(deps.runBash ? { runBash: deps.runBash } : {}),
				});
				if (unlabeled !== null) deps.io.stderr(`[bash] output kept out of context: ${unlabeled}\n`);
				if (deps.session?.current()) deps.beforeShellEntryRecorded?.();
				const entry = deps.session?.current()
					? deps.session.appendEntry(input)
					: ({
							...input,
							turnId: "local-bash-preview",
							timestamp: deps.nowIso?.() ?? new Date().toISOString(),
						} as SessionEntry);
				if (entry.kind === "bashExecution") {
					deps.onLocalEntry?.(entry);
					execution.output = entry.output;
					execution.running = false;
					if (stopRequestedAt !== null) execution.stopWaitMs = Math.max(0, performance.now() - stopRequestedAt);
					execution.exitCode = entry.exitCode;
					execution.cancelled = entry.cancelled;
					execution.truncated = entry.truncated;
					execution.fullOutputPath = entry.fullOutputPath;
					// The record is masked, so a credential it hides changes its size. Only a capped run has bytes the card cannot show.
					execution.totalBytes = entry.truncated
						? Math.max(execution.totalBytes ?? 0, Buffer.byteLength(combineBashOutput(result), "utf8"))
						: Buffer.byteLength(entry.output, "utf8");
				}
				// `parentTurnId` was the leaf when the command started and stays the
				// entry's anchor. The chat leaf is a different question: a prompt
				// may have landed while the command ran, so restore the leaf the
				// session has now, not the one captured then. Restoring the stale
				// one wedged every later submit on a parent that was no longer
				// the leaf. The refresh resets the chat loop, which aborts a live
				// turn, so a turn that started during the line finishes first.
				const refresh = () => deps.sessionTranscript.refreshChatContextFromSession(deps.session?.leafId() ?? parentTurnId);
				if (!deps.chat.isStreaming()) refresh();
				else
					void (async () => {
						// A macrotask between checks: a stream not owned by a submit
						// would otherwise spin on an already settled promise.
						while (deps.chat.isStreaming()) {
							await deps.chat.whenSettled();
							await new Promise((resolve) => setTimeout(resolve, 50));
						}
						if (!shuttingDown) refresh();
					})().catch((err) => {
						deps.io.stderr(`[bash] context refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
					});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				execution.running = false;
				execution.error = msg;
				deps.io.stderr(`[bash] ${msg}\n`);
			} finally {
				deps.onLocalBashRunning?.(false, parsed.command, {
					command: parsed.command,
					exitCode: typeof execution.exitCode === "number" ? execution.exitCode : null,
					cancelled: execution.cancelled === true,
					killed: execution.cancelled === true && /^\[command terminated by SIGKILL\]$/mu.test(execution.output),
					error: execution.error !== undefined,
				});
				if (activeEditorBash === abort) {
					activeEditorBash = null;
					markEditorBashStop = null;
				}
				if (activeEditorBashSettlement === settlement) activeEditorBashSettlement = null;
				deps.ui.requestRender();
			}
		})();
		activeEditorBashSettlement = settlement;
		void settlement;
		return true;
	};

	const setLiteralText = (text: string): void => {
		if (deps.editor.setLiteralText) deps.editor.setLiteralText(text);
		else deps.editor.setText(text);
	};
	const openExternalEditorForInput = (explicitText?: string): boolean => {
		const command = (deps.resolveEditor ?? resolveExternalEditor)();
		if (!command) {
			deps.io.stderr("[editor] no external editor configured; set VISUAL or EDITOR\n");
			return false;
		}
		const currentText =
			explicitText ?? deps.editor.getExpandedText?.() ?? unguardPastedEditorOperator(deps.editor.getTextForSubmit());
		let result: ExternalEditResult;
		try {
			deps.ui.stop();
			result = (deps.editExternally ?? editTextExternally)(currentText, command);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			deps.ui.start();
			deps.ui.requestRender(true);
		}
		if (result.ok) setLiteralText(result.text ?? "");
		else if (result.error) deps.io.stderr(`[editor] ${result.error}\n`);
		deps.ui.requestRender(true);
		return result.ok;
	};

	// A snapshot remains owned until expansion and admission finish. A second
	// press on that same snapshot is inert; a newer draft has its own identity.
	const pendingDrafts = new Set<string>();
	const captureDraft = () => {
		const text = deps.editor.getText();
		const revision = deps.editor.draftRevision;
		const key = JSON.stringify([revision, text]);
		return {
			key,
			owns: () => deps.editor.getText() === text && deps.editor.draftRevision === revision,
		};
	};

	const runningDispatchRefs = (): RunningDispatchRef[] => {
		try {
			return deps.dispatch.snapshot().running.map((run) => ({ runId: run.runId, agentId: run.agentId }));
		} catch {
			// Only the bare-address check reads this; without a fleet the line goes on as a prompt.
			return [];
		}
	};

	const submitEditorSteerMention = (mention: { target: string; text: string }): EditorSteerSubmission => {
		// A draft addressed from Fleet Runs never showed its run id, so its notices name the worker.
		const boardAgent = deps.editor.sentSteerAgent?.(mention.target) ?? null;
		const addressee = boardAgent ?? `@${mention.target}`;
		let running: RunningDispatchRef[] = [];
		try {
			running = deps.dispatch.snapshot().running.map((run) => ({
				runId: run.runId,
				agentId: run.agentId,
				...(run.outcomePhase === "queued" ? { queued: true } : {}),
			}));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.notify(
				"error",
				`cannot resolve steer to ${addressee}: ${msg}; retry when Fleet Runs is available`,
				`steer:${mention.target}`,
			);
			return "rejected";
		}
		// The parser owns addressed syntax even after the last worker exits.
		// File completion quotes bare filenames that would otherwise match it.
		const resolution = resolveSteerTarget(mention.target, running);
		// The dispatch refuses guidance before a run starts, and its refusal names a run id the operator never saw.
		if (resolution.kind === "match" && resolution.run.queued === true) {
			deps.notify(
				"warning",
				`${resolution.run.agentId} is queued and can take a message once it starts`,
				`steer:${resolution.run.runId}`,
			);
			return "rejected";
		}
		if (resolution.kind === "match") {
			try {
				deps.dispatch.steer(resolution.run.runId, mention.text);
				deps.onSteerSent?.(resolution.run, mention.text);
				deps.notify(
					"info",
					`Message queued for ${resolution.run.agentId}, waiting for it to take it`,
					`steer:${resolution.run.runId}`,
				);
				return "accepted";
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				deps.notify(
					"error",
					boardAgent !== null
						? `${boardAgent} is not taking messages now, so this was not sent. Esc keeps your text as a draft for Clio.`
						: `steer to ${addressee} failed: ${msg}`,
					`steer:${mention.target}`,
				);
				return "rejected";
			}
		}
		if (resolution.kind === "ambiguous") {
			deps.notify(
				"warning",
				`@${mention.target} matches ${resolution.candidates.length} runs: ${formatSteerCandidates(resolution.candidates)}; use a runId prefix`,
				`steer:${mention.target}`,
			);
			return "rejected";
		}
		if (boardAgent !== null) {
			deps.notify(
				"warning",
				`${boardAgent} already ended, so this was not sent. Esc keeps your text as a draft for Clio.`,
				`steer:${mention.target}`,
			);
			return "rejected";
		}
		deps.notify(
			"warning",
			`no running dispatch matches @${mention.target}; running: ${formatSteerCandidates(running) || "none"}; choose an active target in Fleet Runs or remove the @target to send to the main agent`,
			`steer:${mention.target}`,
		);
		return "rejected";
	};

	const handleEditorSteerMention = (mention: { target: string; text: string }): boolean => {
		submitEditorSteerMention(mention);
		return true;
	};

	// A chat line enters history only once its attachments expand; a cancelled
	// expansion returns it to the editor Pi cleared at Enter, unless the operator
	// has started another line since.
	const chatDraft = (literalText: string): ChatDraft => ({
		claimed: false,
		admitted: () => deps.editor.addToHistory(literalText),
		cancelled: () => {
			if (deps.editor.getText().trim().length === 0) setLiteralText(literalText);
			deps.ui.requestRender();
		},
	});

	const submitEditorText = (text: string): void => {
		const literalText = unguardPastedEditorOperator(text);
		const trimmed = literalText.trim();
		if (trimmed.length === 0) {
			// Enter on an empty composer continues a paused yolo run (ob-yolo D6).
			if (deps.chat.resumeAutonomy?.() === true) deps.ui.requestRender();
			return;
		}
		// The arcade egg draws over the TUI and hands it back untouched, launchpad included.
		if (deps.arcadeEgg?.(literalText)) return;
		deps.collapseLaunchpadBeforeSubmit?.();
		// An @ mention of a path, not an @agent steer: the token has a / or a dot.
		if (/(?:^|\s)@[\w~-]*[./][\w./-]+/u.test(literalText)) deps.recordFeature?.("@");
		if (parseEditorBashCommand(text)) {
			if (!deps.chat.isStreaming() && !activeEditorBash) {
				deps.editor.addToHistory(literalText);
				deps.editor.setText("");
			} else {
				// Pi Editor clears the buffer before invoking onSubmit. A command
				// refused by either admission guard is still a draft, so put it back
				// for the operator instead of silently discarding it.
				deps.editor.setText(literalText);
			}
			if (runEditorBash(text)) deps.ui.requestRender();
			return;
		}
		// A bare `@run-id` from the board with nothing typed would reach the model as
		// a prompt. A bare `@name` stays chat: only the exact run id is an address.
		const bareToken = steerDraftToken(trimmed);
		const addressed =
			bareToken === trimmed.slice(1) ? runningDispatchRefs().find((run) => run.runId === bareToken) : undefined;
		if (addressed) {
			const hidden = deps.editor.sentSteerAgent?.(addressed.runId) ?? null;
			deps.notify(
				"info",
				`Type the guidance for ${addressed.agentId}${hidden === null ? " after the address" : ""}, then Enter`,
				`steer:${addressed.runId}`,
			);
			deps.editor.setText(`${literalText.trimEnd()} `);
			deps.ui.requestRender();
			return;
		}
		// The same empty draft after its worker ended is still no prompt for the model.
		const endedAgent = bareToken === trimmed.slice(1) ? deps.editor.sentSteerAgent?.(bareToken) : null;
		if (endedAgent) {
			deps.notify(
				"warning",
				`${endedAgent} already ended, so there is nothing to send. Esc clears it.`,
				`steer:${bareToken}`,
			);
			deps.editor.setText(literalText);
			deps.ui.requestRender();
			return;
		}
		const steerMention = parseEditorSteerMention(trimmed);
		if (steerMention) {
			const hiddenAddress = deps.editor.sentSteerAgent?.(steerMention.target) ?? null;
			const submission = submitEditorSteerMention(steerMention);
			if (submission === "accepted") {
				// Recalled later, a line with a hidden address is just its words.
				deps.editor.addToHistory(hiddenAddress !== null ? steerMention.text : literalText);
				deps.editor.setText("");
			} else {
				// Resolution and dispatch failures are correctable rejections. Pi
				// has already cleared the editor, so explicitly restore the draft.
				deps.editor.setText(literalText);
			}
			deps.ui.requestRender();
			return;
		}
		// Explicit blank arguments must reach the parser before trimming (#443).
		const command = parseSlashCommand(literalText);
		if (isRejectedCommand(command)) {
			// A retired key command whose arguments were the draft hands them back for the key.
			deps.editor.setText(
				command.kind === "retired" && command.entry.keepsText && command.rest ? command.rest : literalText,
			);
			deps.dispatchCommand(literalText);
		} else if (command.kind === "unknown-command") {
			const draft = chatDraft(literalText);
			const result = deps.dispatchCommand(literalText, draft);
			if (result === "rejected") {
				deps.editor.setText(literalText);
			} else {
				if (!draft.claimed) deps.editor.addToHistory(literalText);
				deps.editor.setText("");
			}
		} else {
			const draft = chatDraft(literalText);
			deps.editor.setText("");
			deps.dispatchCommand(literalText, draft);
			if (!draft.claimed) deps.editor.addToHistory(literalText);
		}
		deps.ui.requestRender();
	};

	const awaitWithAbort = async (promise: Promise<void>, signal?: AbortSignal): Promise<void> => {
		if (!signal) return await promise;
		signal.throwIfAborted();
		let abort: (() => void) | null = null;
		try {
			await Promise.race([
				promise,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
					signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
		}
	};

	const admitCapturedText = async (text: string, signal?: AbortSignal): Promise<void> => {
		const literalText = unguardPastedEditorOperator(text);
		const trimmed = literalText.trim();
		if (trimmed.length === 0) return;
		if (shuttingDown) throw new Error("editor is shutting down");
		signal?.throwIfAborted();
		deps.collapseLaunchpadBeforeSubmit?.();
		if (parseEditorBashCommand(text)) {
			while (deps.chat.isStreaming()) await awaitWithAbort(deps.chat.whenSettled(), signal);
			while (activeEditorBashSettlement) await awaitWithAbort(activeEditorBashSettlement, signal);
			signal?.throwIfAborted();
			if (shuttingDown) throw new Error("editor is shutting down");
			deps.editor.addToHistory(literalText);
			runEditorBash(text);
			deps.ui.requestRender();
			return;
		}
		const steerMention = parseEditorSteerMention(trimmed);
		if (steerMention) {
			const submission = submitEditorSteerMention(steerMention);
			if (submission === "rejected") {
				throw new Error("queued boot steer was not admitted; preserving it for recovery");
			}
			deps.editor.addToHistory(literalText);
			deps.ui.requestRender();
			return;
		}
		const command = parseSlashCommand(literalText);
		if (isRejectedCommand(command)) {
			signal?.throwIfAborted();
			if (deps.dispatchCommandAsync) await deps.dispatchCommandAsync(literalText, signal);
			else deps.dispatchCommand(literalText);
			deps.ui.requestRender();
			throw new Error("queued boot command needs correction; preserving it for recovery");
		}
		deps.editor.addToHistory(literalText);
		signal?.throwIfAborted();
		if (deps.dispatchCommandAsync) await deps.dispatchCommandAsync(literalText, signal);
		else deps.dispatchCommand(literalText);
		deps.ui.requestRender();
	};

	/**
	 * A slash command is not chat text. Queued or sent as an interrupt it would
	 * reach the model as a literal "/new" and never run, so while a run is active
	 * it is refused with a notice and the draft stays in the editor (flywheel p7/A2).
	 */
	const refuseBusyCommand = (text: string, via: string): boolean => {
		const kind = parseSlashCommand(text).kind;
		if (kind === "unknown" || kind === "empty" || kind === "unknown-command") return false;
		deps.notify(
			"warning",
			`${text.split(/\s+/u)[0]} is a command, so ${via} cannot hold it for after the run; press Enter to run it now, which cancels the active run`,
			"command:busy",
		);
		return true;
	};

	const interruptFromEditor = (explicitText?: string, entry?: QueuedChatMessage): void => {
		const streaming = deps.chat.isStreaming();
		const snapshot = captureDraft();
		let text = (explicitText ?? deps.editor.getTextForSubmit()).trim();
		let flushed = entry;
		const flushQueue = text.length === 0;
		if (flushQueue) {
			// An empty draft with a queue means "send the queue now", running or held
			// after a stop (#447): the first entry becomes the fresh prompt and the
			// rest ride the engine's opening poll, so all of them reach the first
			// model call of the new run, each as its own user message.
			// A peer's queued prompt is not the operator's to send as their own.
			const first = deps.chat.queueEntries().find((queued) => queued.origin === undefined);
			if (!first) return;
			const refusal = deps.chat.interruptRefusal();
			if (refusal !== null) {
				deps.notify("warning", `send now refused: ${refusal}`, "steer:refused");
				return;
			}
			text = first.text;
			flushed = first;
		}
		if (streaming && refuseBusyCommand(text, "a send-now")) return;
		if (!streaming && !flushed) {
			deps.editor.setText("");
			submitEditorText(text);
			deps.ui.requestRender();
			return;
		}
		if (pendingDrafts.has(snapshot.key)) return;
		pendingDrafts.add(snapshot.key);
		void (async () => {
			// A flushed entry was expanded when it was queued; its display and the
			// paths it inlined travel with it instead of being expanded again.
			if (
				!flushed &&
				(deps.arcadeEgg?.(unguardPastedEditorOperator(text)) ||
					(await deps.chat.discoverOperatorEgg?.(unguardPastedEditorOperator(text), deps.askEgg)))
			) {
				if (snapshot.owns()) setLiteralText("");
				return;
			}
			const submitted: EditorSubmitExpansion = flushed
				? {
						text,
						images: [],
						...(flushed.display ? { display: flushed.display } : {}),
						...(flushed.referencedPaths ? { workingContextPaths: flushed.referencedPaths } : {}),
					}
				: await deps.expandSubmit(unguardPastedEditorOperator(text));
			if (submitted.images.length > 0) {
				deps.io.stderr("[interrupt] image references cannot be sent while a response is streaming\n");
				return;
			}
			if (!flushed) deps.editor.addToHistory(text);
			// The queue stays queued: a send-now does not undo what the operator
			// already asked for. Held through the cancel, it lands at the new run's
			// first slot (or with its first model call, for a flush).
			// A queued entry sent from the navigator leaves the composer alone: a draft there is other work.
			let cleared: ReturnType<typeof captureDraft> | undefined;
			if (!flushed && snapshot.owns()) {
				setLiteralText("");
				cleared = captureDraft();
			}
			deps.ui.requestRender();
			// Put the draft back only into the editor this send-now emptied; a
			// draft the operator started since is theirs.
			const restoreDraft = (): void => {
				if (cleared?.owns() && !flushed) setLiteralText(text);
				deps.ui.requestRender();
			};
			// A constrained submission while a turn is live is refused by the chat
			// loop rather than queued; the operator keeps the draft and sees no
			// queued notice for it.
			let refused = false;
			const paths = submitted.workingContextPaths ?? [];
			const skillRequests = submitted.pendingSkillRequests ?? [];
			const common = {
				...(submitted.display ? { display: submitted.display } : {}),
				...(paths.length > 0 ? { workingContextPaths: paths } : {}),
				...(skillRequests.length > 0 ? { pendingSkillRequests: skillRequests } : {}),
				...(submitted.constraints ? { constraints: submitted.constraints } : {}),
				onRefused: () => {
					refused = true;
				},
			};
			// A tool call in flight is the one case where "now" has a cost the
			// operator may not want to pay: ask whether to stop it or to wait for
			// it. A refused interrupt never reaches the tool, so it is not asked.
			if (deps.chat.interruptRefusal() === null && deps.chat.runningToolCalls() > 0 && deps.askSendNow) {
				const choice = await deps.askSendNow(deps.chat.runningToolCalls());
				if (choice === "cancelled") {
					restoreDraft();
					return;
				}
				if (choice === "wait") {
					// The choice promises the head of the queue, whichever slot a queued entry was in.
					const taken = flushed ? deps.chat.removeQueuedEntry(flushed.id, "sent-now") : null;
					if (flushed && taken === null) return;
					deps.beforeSemanticBoundary?.("send-now-wait");
					await deps.chat.submit(submitted.text, { ...common, queueFront: true, ...(taken ? { queued: taken } : {}) });
					if (refused) restoreDraft();
					else
						deps.notify(
							"info",
							"queued ahead of everything else; it lands as soon as the running tool returns",
							"steer:wait",
						);
					return;
				}
			}
			// An interrupt is a fresh prompt, so it carries what the idle path
			// carries: the launchpad collapse, the submitted-turn count, and the
			// expansion's working-context paths and pending skill requests. Only
			// images stay behind, rejected above, as they are for a follow-up.
			// Taken only now: until here an entry the operator kept stays where it was,
			// and from here the chat loop returns it if the prompt never starts (#447).
			const taken = flushed ? deps.chat.removeQueuedEntry(flushed.id, "sent-now") : null;
			if (flushed && taken === null) return;
			deps.collapseLaunchpadBeforeSubmit?.();
			deps.sessionTranscript.recordSubmittedTurn();
			deps.beforeSemanticBoundary?.("interrupt-submit");
			await deps.chat.submit(submitted.text, {
				steering: "interrupt",
				...common,
				...(taken ? { queued: taken, flushQueue } : {}),
			});
			if (refused) restoreDraft();
			await deps.settleVisibleFrame?.("interrupt-submit-return");
		})()
			.catch((err) => {
				// A cancelled attachment read sent nothing and left the draft in the editor.
				if (err instanceof Error && err.name === "AbortError") return;
				const msg = err instanceof Error ? err.message : String(err);
				deps.io.stderr(`[interrupt] ${msg}\n`);
			})
			.finally(() => pendingDrafts.delete(snapshot.key));
	};

	const restoreQueuedFollowUpsToEditor = (): void => {
		const restored = deps.chat.clearQueuedFollowUps();
		if (restored.length === 0) {
			deps.notify("info", "nothing is queued to restore", "queue:empty");
			return;
		}
		const currentText = deps.editor.getExpandedText?.() ?? deps.editor.getText();
		const queuedText = restored.join("\n\n");
		const text = [queuedText, currentText].filter((part) => part.trim().length > 0).join("\n\n");
		if (deps.editor.setRestoredText) deps.editor.setRestoredText(text);
		else setLiteralText(text);
		deps.notify("info", RESTORED_DRAFT_NOTICE, "queue:restored");
		deps.ui.requestRender();
	};

	return {
		runEditorBash,
		openExternalEditorForInput,
		handleEditorSteerMention,
		submitEditorText,
		admitCapturedText,
		interruptFromEditor,
		restoreQueuedFollowUpsToEditor,
		hasActiveEditorBash: () => activeEditorBash !== null,
		shutdownEditorBash: async () => {
			shuttingDown = true;
			activeEditorBash?.abort();
			await activeEditorBashSettlement;
		},
		cancelActiveEditorBash: () => {
			if (!activeEditorBash) return false;
			deps.onLocalBashCancelling?.();
			markEditorBashStop?.();
			activeEditorBash.abort();
			return true;
		},
	};
}
