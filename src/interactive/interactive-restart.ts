import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { ChatLoop } from "../session-control/chat-loop.js";
import { writeRestartIntent } from "../session-control/restart-intent.js";

export interface InteractiveRestartDeps {
	session?: SessionContract;
	stateDir: string;
	busyReason(): string | null;
	settle(): Promise<void>;
	armHandoff(): void;
	shutdown(): Promise<void>;
	notify(level: "info" | "warning" | "error", text: string): void;
}

export function interactiveRestartBusyReason(deps: {
	chat: Pick<ChatLoop, "isStreaming" | "turnPreparation" | "queuedMessages">;
	dispatch: Pick<DispatchContract, "snapshot">;
	operator: Pick<OperatorExtensions, "busy"> | undefined;
	editorBash: boolean;
	reloading: boolean;
	shuttingDown: boolean;
}): string | null {
	if (deps.shuttingDown) return "shutdown is already in progress";
	if (deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle") return "a turn is running";
	if (deps.dispatch.snapshot().running.length > 0) return "a dispatch is running";
	if (deps.operator?.busy) return "an operator command or extension reload is running";
	if (deps.editorBash) return "an editor shell command is running";
	if (deps.reloading) return "a reload report is running";
	const queue = deps.chat.queuedMessages();
	if (queue.steer.length + queue.followUp.length > 0) return "turns are queued";
	return null;
}

export function createInteractiveRestart(deps: InteractiveRestartDeps): () => void {
	let active = false;
	return () => {
		if (active) {
			deps.notify("warning", "Restart refused: a restart is already in progress.");
			return;
		}
		const reason = deps.busyReason();
		const sessionId = deps.session?.current()?.id;
		if (reason || !sessionId) {
			deps.notify("warning", `Restart refused: ${reason ?? "there is no session to resume; submit a turn first"}.`);
			return;
		}
		active = true;
		void (async () => {
			try {
				await deps.settle();
				await deps.session?.checkpoint("restart");
				const changed = deps.busyReason();
				if (changed || deps.session?.current()?.id !== sessionId) {
					deps.notify("warning", `Restart refused: ${changed ?? "the session changed while it was being saved"}.`);
					return;
				}
				writeRestartIntent(deps.stateDir, sessionId);
				deps.armHandoff();
				await deps.shutdown();
			} catch (error) {
				deps.notify("error", `Restart failed: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				active = false;
			}
		})();
	};
}
