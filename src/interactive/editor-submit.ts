import { runBashCommand } from "../core/bash-exec.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import type { ChatLoop } from "./chat-loop.js";
import type { ChatPanel } from "./chat-panel.js";
import { renderBashExecutionEntry } from "./chat-renderer.js";
import { bashExecutionEntryInput, parseEditorBashCommand } from "./editor-bash.js";
import {
	formatSteerCandidates,
	parseEditorSteerMention,
	type RunningDispatchRef,
	resolveSteerTarget,
} from "./editor-steer.js";
import { type ExternalEditResult, editTextExternally, resolveExternalEditor } from "./external-editor.js";
import { parseSlashCommand, type RunIo, type SlashCommand } from "./slash-commands.js";

const EDITOR_BASH_TIMEOUT_MS = 300_000;

/**
 * Command shapes that are rejected by the parser and never reach a handler.
 *
 * The terminal engine empties the editor inside its own submit path before
 * `onSubmit` runs, so the text is already gone by the time the notice is
 * written. An operator who mistyped one character of a long command got an
 * error naming a spelling they could no longer see and had to retype the whole
 * line. Putting the text back leaves the correction one keystroke away.
 *
 * Only parse-time rejections qualify. A command that ran and failed has done
 * work, and chat text belongs to the transcript, so both leave the line empty.
 */
function isRejectedCommand(command: SlashCommand): boolean {
	return command.kind === "unknown-command" || command.kind === "usage-error";
}

export interface EditorSubmitExpansion {
	text: string;
	images: ReadonlyArray<unknown>;
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

type EditorSubmitChat = Pick<ChatLoop, "clearQueuedFollowUps" | "isStreaming" | "queueFollowUp">;
type EditorSubmitDispatch = Pick<DispatchContract, "snapshot" | "steer">;
type EditorSubmitSession = Pick<SessionContract, "appendEntry" | "current" | "tree">;

export interface EditorSubmitSessionTranscript {
	ensureSessionForLocalEntry(): void;
	refreshChatContextFromSession(leafTurnId: string | null): void;
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
	restoreQueuedFollowUpsToEditor(): void;
	hasActiveEditorBash(): boolean;
	cancelActiveEditorBash(): boolean;
}

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

		void (async () => {
			try {
				const result = await (deps.runBash ?? runBashCommand)(parsed.command, {
					cwd: deps.getCwd?.() ?? process.cwd(),
					timeoutMs: EDITOR_BASH_TIMEOUT_MS,
					signal: abort.signal,
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
					deps.chatPanel.appendReplayBlock((width) => renderBashExecutionEntry(entry, width));
				}
				deps.sessionTranscript.refreshChatContextFromSession(parentTurnId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
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

	const handleEditorSteerMention = (mention: { target: string; text: string }): boolean => {
		let running: RunningDispatchRef[] = [];
		try {
			running = deps.dispatch.snapshot().running.map((run) => ({ runId: run.runId, agentId: run.agentId }));
		} catch {
			running = [];
		}
		if (running.length === 0) return false;
		const resolution = resolveSteerTarget(mention.target, running);
		if (resolution.kind === "match") {
			try {
				deps.dispatch.steer(resolution.run.runId, mention.text);
				deps.notify(
					"info",
					`steer queued for ${resolution.run.agentId} (${resolution.run.runId}); awaiting worker acknowledgement`,
					`steer:${resolution.run.runId}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				deps.notify("error", `steer to @${mention.target} failed: ${msg}`, `steer:${mention.target}`);
			}
			return true;
		}
		if (resolution.kind === "ambiguous") {
			deps.notify(
				"warning",
				`@${mention.target} matches ${resolution.candidates.length} runs: ${formatSteerCandidates(resolution.candidates)}; use a runId prefix`,
				`steer:${mention.target}`,
			);
			return true;
		}
		deps.notify(
			"warning",
			`no running dispatch matches @${mention.target}; running: ${formatSteerCandidates(running)}`,
			`steer:${mention.target}`,
		);
		return true;
	};

	const submitEditorText = (text: string): void => {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		if (parseEditorBashCommand(text)) {
			if (!deps.chat.isStreaming() && !activeEditorBash) deps.editor.setText("");
			if (runEditorBash(text)) deps.ui.requestRender();
			return;
		}
		const steerMention = parseEditorSteerMention(trimmed);
		if (steerMention && handleEditorSteerMention(steerMention)) {
			deps.editor.addToHistory(text);
			deps.editor.setText("");
			deps.ui.requestRender();
			return;
		}
		deps.editor.setText(isRejectedCommand(parseSlashCommand(trimmed)) ? text : "");
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
		restoreQueuedFollowUpsToEditor,
		hasActiveEditorBash: () => activeEditorBash !== null,
		cancelActiveEditorBash: () => {
			if (!activeEditorBash) return false;
			activeEditorBash.abort();
			return true;
		},
	};
}
