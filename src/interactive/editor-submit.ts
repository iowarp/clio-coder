import { combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import type { PendingSkillRequest } from "../core/skill-activation.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import type { ChatLoop } from "./chat-loop.js";
import type { ChatPanel } from "./chat-panel.js";
import { bashExecutionEntryInput, parseEditorBashCommand } from "./editor-bash.js";
import {
	formatSteerCandidates,
	parseEditorSteerMention,
	type RunningDispatchRef,
	resolveSteerTarget,
} from "./editor-steer.js";
import { type ExternalEditResult, editTextExternally, resolveExternalEditor } from "./external-editor.js";
import { type BashTranscriptExecution, renderBashTranscriptExecution } from "./renderers/tool-execution.js";
import { parseSlashCommand, type RunIo, type SlashCommand } from "./slash-commands.js";

const EDITOR_BASH_TIMEOUT_MS = 300_000;

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
 * `unknown-command` used to be restored on the same reasoning and it does not
 * hold. The token matched no command at all, so there is nothing to correct
 * against, and the restored text has no cursor placement of its own: the next
 * keystrokes land in front of the leftover `/token`, which no longer parses as
 * a command, so the whole concatenation goes to the model as a chat message the
 * operator never wrote. An empty line after "is not a command" costs a retype
 * and says exactly what happened.
 *
 * A command that ran and failed has done work, and chat text belongs to the
 * transcript, so both also leave the line empty.
 */
function isRejectedCommand(command: SlashCommand): boolean {
	return command.kind === "usage-error";
}

export interface EditorSubmitExpansion {
	text: string;
	images: ReadonlyArray<unknown>;
	/** Paths the draft referenced inline; the idle path hands them to the chat loop for rule scoping. */
	workingContextPaths?: ReadonlyArray<string>;
	/** Skill requests parsed out of the draft; the idle path hands them to the chat loop as the pending-skill policy. */
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
}

export interface EditorSubmitEditor {
	getText(): string;
	setText(text: string): void;
	addToHistory(text: string): void;
}

export interface EditorSubmitUi {
	start(): void;
	stop(): void;
	requestRender(force?: boolean): void;
}

type EditorSubmitChat = Pick<
	ChatLoop,
	"clearQueuedFollowUps" | "interruptRefusal" | "isStreaming" | "queueFollowUp" | "submit"
>;
type EditorSubmitDispatch = Pick<DispatchContract, "snapshot" | "steer">;
type EditorSubmitSession = Pick<SessionContract, "appendEntry" | "current" | "tree">;

export interface EditorSubmitSessionTranscript {
	ensureSessionForLocalEntry(): void;
	refreshChatContextFromSession(leafTurnId: string | null): void;
	/** Count a prompt the operator submitted; the idle path does this through the slash runtime. */
	recordSubmittedTurn(): void;
}

export interface EditorSubmitDeps {
	editor: EditorSubmitEditor;
	ui: EditorSubmitUi;
	io: RunIo;
	chat: EditorSubmitChat;
	dispatch: EditorSubmitDispatch;
	session?: EditorSubmitSession;
	sessionTranscript: EditorSubmitSessionTranscript;
	chatPanel: Pick<ChatPanel, "appendReplayBlock">;
	dispatchCommand: (text: string) => void;
	/** Idempotently collapses a fresh-session launchpad before any handler can append output. */
	collapseLaunchpadBeforeSubmit?: () => void;
	expandSubmit: (text: string) => Promise<EditorSubmitExpansion>;
	notify: (level: "info" | "warning" | "error", text: string, key: string) => void;
	getCwd?: () => string;
	runBash?: typeof runBashCommand;
	resolveEditor?: () => string | null;
	editExternally?: (initialText: string, command: string) => ExternalEditResult;
	nowIso?: () => string;
}

export interface EditorSubmitController {
	runEditorBash(text: string): boolean;
	openExternalEditorForInput(): void;
	handleEditorSteerMention(mention: { target: string; text: string }): boolean;
	submitEditorText(text: string): void;
	queueFollowUpFromEditor(): void;
	/**
	 * Interrupt mode: cancel the active run and deliver the draft now. Idle, it
	 * is a plain send. The chat loop owns cancel → settle → submit and the two
	 * refusals (attached dispatch, parked permission ask), which degrade the
	 * message to next-slot delivery with a notice.
	 */
	interruptFromEditor(): void;
	restoreQueuedFollowUpsToEditor(): void;
	hasActiveEditorBash(): boolean;
	cancelActiveEditorBash(): boolean;
}

type EditorSteerSubmission = "unhandled" | "accepted" | "rejected";

/** Owns editor submission and the one local bash process attached to it. */
export function createEditorSubmitController(deps: EditorSubmitDeps): EditorSubmitController {
	let activeEditorBash: AbortController | null = null;

	const runEditorBash = (text: string): boolean => {
		const parsed = parseEditorBashCommand(text);
		if (!parsed) return false;
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
		let parentTurnId: string | null = null;
		try {
			deps.sessionTranscript.ensureSessionForLocalEntry();
			parentTurnId = deps.session?.tree().leafId ?? null;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.io.stderr(`[bash] session setup failed: ${msg}\n`);
			activeEditorBash = null;
			return true;
		}
		const startedAt = performance.now();
		const execution: BashTranscriptExecution = {
			command: parsed.command,
			output: "",
			running: true,
			totalBytes: 0,
			excludeFromContext: parsed.excludeFromContext,
		};
		deps.chatPanel.appendReplayBlock((width) =>
			renderBashTranscriptExecution(
				{
					...execution,
					...(execution.running ? { elapsedMs: Math.max(0, performance.now() - startedAt) } : {}),
				},
				width,
			),
		);
		deps.ui.requestRender();

		void (async () => {
			try {
				const result = await (deps.runBash ?? runBashCommand)(parsed.command, {
					cwd: deps.getCwd?.() ?? process.cwd(),
					timeoutMs: EDITOR_BASH_TIMEOUT_MS,
					signal: abort.signal,
					onUpdate: (progress) => {
						execution.output = combineBashOutput(progress);
						execution.totalBytes = progress.outputBytes;
						deps.ui.requestRender();
					},
				});
				const input = bashExecutionEntryInput({
					command: parsed.command,
					result,
					parentTurnId,
					excludeFromContext: parsed.excludeFromContext,
					timeoutMs: EDITOR_BASH_TIMEOUT_MS,
				});
				const entry = deps.session?.current()
					? deps.session.appendEntry(input)
					: ({
							...input,
							turnId: "local-bash-preview",
							timestamp: deps.nowIso?.() ?? new Date().toISOString(),
						} as SessionEntry);
				if (entry.kind === "bashExecution") {
					execution.output = entry.output;
					execution.running = false;
					execution.exitCode = entry.exitCode;
					execution.cancelled = entry.cancelled;
					execution.truncated = entry.truncated;
					execution.fullOutputPath = entry.fullOutputPath;
					execution.totalBytes = Math.max(execution.totalBytes ?? 0, Buffer.byteLength(combineBashOutput(result), "utf8"));
				}
				// `parentTurnId` was the leaf when the command started and stays the
				// entry's anchor. The chat leaf is a different question: a prompt
				// may have landed while the command ran, so restore the leaf the
				// session has now, not the one captured then. Restoring the stale
				// one wedged every later submit on a parent that was no longer
				// the leaf.
				deps.sessionTranscript.refreshChatContextFromSession(deps.session?.tree().leafId ?? parentTurnId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				execution.running = false;
				execution.error = msg;
				deps.io.stderr(`[bash] ${msg}\n`);
			} finally {
				if (activeEditorBash === abort) activeEditorBash = null;
				deps.ui.requestRender();
			}
		})();
		return true;
	};

	const openExternalEditorForInput = (): void => {
		const command = (deps.resolveEditor ?? resolveExternalEditor)();
		if (!command) {
			deps.io.stderr("[editor] no external editor configured; set VISUAL or EDITOR\n");
			return;
		}
		const currentText = deps.editor.getText();
		let result: ExternalEditResult;
		try {
			deps.ui.stop();
			result = (deps.editExternally ?? editTextExternally)(currentText, command);
		} finally {
			deps.ui.start();
			deps.ui.requestRender(true);
		}
		if (result.ok) {
			deps.editor.setText(result.text ?? "");
		} else if (result.error) {
			deps.io.stderr(`[editor] ${result.error}\n`);
		}
		deps.ui.requestRender(true);
	};

	const submitEditorSteerMention = (mention: { target: string; text: string }): EditorSteerSubmission => {
		let running: RunningDispatchRef[] = [];
		try {
			running = deps.dispatch.snapshot().running.map((run) => ({ runId: run.runId, agentId: run.agentId }));
		} catch {
			running = [];
		}
		if (running.length === 0) return "unhandled";
		const resolution = resolveSteerTarget(mention.target, running);
		if (resolution.kind === "match") {
			try {
				deps.dispatch.steer(resolution.run.runId, mention.text);
				deps.notify(
					"info",
					`steer queued for ${resolution.run.agentId} (${resolution.run.runId}); awaiting worker acknowledgement`,
					`steer:${resolution.run.runId}`,
				);
				return "accepted";
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				deps.notify("error", `steer to @${mention.target} failed: ${msg}`, `steer:${mention.target}`);
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
		deps.notify(
			"warning",
			`no running dispatch matches @${mention.target}; running: ${formatSteerCandidates(running)}`,
			`steer:${mention.target}`,
		);
		return "rejected";
	};

	const handleEditorSteerMention = (mention: { target: string; text: string }): boolean =>
		submitEditorSteerMention(mention) !== "unhandled";

	const submitEditorText = (text: string): void => {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		deps.collapseLaunchpadBeforeSubmit?.();
		if (parseEditorBashCommand(text)) {
			if (!deps.chat.isStreaming() && !activeEditorBash) {
				deps.editor.addToHistory(text);
				deps.editor.setText("");
			} else {
				// Pi Editor clears the buffer before invoking onSubmit. A command
				// refused by either admission guard is still a draft, so put it back
				// for the operator instead of silently discarding it.
				deps.editor.setText(text);
			}
			if (runEditorBash(text)) deps.ui.requestRender();
			return;
		}
		const steerMention = parseEditorSteerMention(trimmed);
		if (steerMention) {
			const submission = submitEditorSteerMention(steerMention);
			if (submission !== "unhandled") {
				if (submission === "accepted") {
					deps.editor.addToHistory(text);
					deps.editor.setText("");
				} else {
					// Resolution and dispatch failures are correctable rejections. Pi
					// has already cleared the editor, so explicitly restore the draft.
					deps.editor.setText(text);
				}
				deps.ui.requestRender();
				return;
			}
		}
		const command = parseSlashCommand(trimmed);
		if (isRejectedCommand(command)) {
			deps.editor.setText(text);
		} else {
			deps.editor.addToHistory(text);
			deps.editor.setText("");
		}
		deps.dispatchCommand(trimmed);
		deps.ui.requestRender();
	};

	const queueFollowUpFromEditor = (): void => {
		const text = deps.editor.getText().trim();
		if (text.length === 0) return;
		if (!deps.chat.isStreaming()) {
			deps.editor.setText("");
			submitEditorText(text);
			deps.ui.requestRender();
			return;
		}
		void (async () => {
			const submitted = await deps.expandSubmit(text);
			if (submitted.images.length > 0) {
				deps.io.stderr("[follow-up] image references cannot be queued while a response is streaming\n");
				return;
			}
			if (!deps.chat.queueFollowUp(submitted.text)) {
				deps.io.stderr("[follow-up] no active response to queue against\n");
				return;
			}
			deps.editor.addToHistory(text);
			deps.editor.setText("");
			deps.ui.requestRender();
		})().catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			deps.io.stderr(`[follow-up] ${msg}\n`);
		});
	};

	const interruptFromEditor = (): void => {
		const text = deps.editor.getText().trim();
		if (text.length === 0) return;
		if (!deps.chat.isStreaming()) {
			deps.editor.setText("");
			submitEditorText(text);
			deps.ui.requestRender();
			return;
		}
		void (async () => {
			const submitted = await deps.expandSubmit(text);
			if (submitted.images.length > 0) {
				deps.io.stderr("[interrupt] image references cannot be sent while a response is streaming\n");
				return;
			}
			deps.editor.addToHistory(text);
			// Same restore Esc performs: when the interrupt will really cancel the
			// run, the queued steers and follow-ups come back to the editor rather
			// than vanishing with the cancelled run. A refused interrupt cancels
			// nothing, so the queue stays put.
			const restored = deps.chat.interruptRefusal() === null ? deps.chat.clearQueuedFollowUps() : [];
			deps.editor.setText(restored.join("\n\n"));
			deps.ui.requestRender();
			// An interrupt is a fresh prompt, so it carries what the idle path
			// carries: the launchpad collapse, the submitted-turn count, and the
			// expansion's working-context paths and pending skill requests. Only
			// images stay behind, rejected above, as they are for a follow-up.
			deps.collapseLaunchpadBeforeSubmit?.();
			deps.sessionTranscript.recordSubmittedTurn();
			const paths = submitted.workingContextPaths ?? [];
			const skillRequests = submitted.pendingSkillRequests ?? [];
			await deps.chat.submit(submitted.text, {
				steering: "interrupt",
				...(paths.length > 0 ? { workingContextPaths: paths } : {}),
				...(skillRequests.length > 0 ? { pendingSkillRequests: skillRequests } : {}),
			});
		})().catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			deps.io.stderr(`[interrupt] ${msg}\n`);
		});
	};

	const restoreQueuedFollowUpsToEditor = (): void => {
		const restored = deps.chat.clearQueuedFollowUps();
		if (restored.length === 0) {
			deps.io.stderr("[follow-up] no queued messages to restore\n");
			return;
		}
		const currentText = deps.editor.getText();
		const queuedText = restored.join("\n\n");
		deps.editor.setText([queuedText, currentText].filter((part) => part.trim().length > 0).join("\n\n"));
		deps.ui.requestRender();
	};

	return {
		runEditorBash,
		openExternalEditorForInput,
		handleEditorSteerMention,
		submitEditorText,
		queueFollowUpFromEditor,
		interruptFromEditor,
		restoreQueuedFollowUpsToEditor,
		hasActiveEditorBash: () => activeEditorBash !== null,
		cancelActiveEditorBash: () => {
			if (!activeEditorBash) return false;
			activeEditorBash.abort();
			return true;
		},
	};
}
