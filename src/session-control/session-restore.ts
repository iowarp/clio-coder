import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoop } from "./chat-loop.js";
import { buildModelReplayAgentMessagesFromTurns, withContinuityReplay } from "./model-session-replay.js";

export interface SessionReplayPorts {
	session: Pick<SessionContract, "current" | "tree">;
	chat: Pick<ChatLoop, "resetForSession">;
	readEntries(id: string): ReadonlyArray<SessionEntry>;
	buildMessages?(
		entries: ReadonlyArray<SessionEntry>,
		leaf: string | null,
		scope: "leaf" | "upto",
	): ReadonlyArray<AgentMessage>;
}

export function replayCurrentSession(
	ports: SessionReplayPorts,
	id: string,
	scope: "leaf" | "upto" = "leaf",
	selectedLeaf?: string | null,
	fallbackLeaf: string | null = null,
) {
	if (ports.session.current()?.id !== id) throw new Error("resume identity mismatch");
	let leafTurnId = selectedLeaf !== undefined ? selectedLeaf : fallbackLeaf;
	try {
		if (selectedLeaf === undefined) leafTurnId = ports.session.tree(id).leafId ?? fallbackLeaf;
		const entries = ports.readEntries(id);
		const replayOptions = withContinuityReplay(
			entries,
			leafTurnId === null ? {} : scope === "upto" ? { uptoTurnId: leafTurnId } : { activeLeafTurnId: leafTurnId },
			ports.session,
		);
		const messages =
			ports.buildMessages?.(entries, leafTurnId, scope) ?? buildModelReplayAgentMessagesFromTurns(entries, replayOptions);
		ports.chat.resetForSession(leafTurnId, messages);
		return { entries, leafTurnId, replayOptions, messages };
	} catch (error) {
		// A replay failure must not leave the next turn parented to the session we left.
		ports.chat.resetForSession(leafTurnId, []);
		throw error;
	}
}

export function restoreSession(
	ports: SessionReplayPorts & {
		session: SessionReplayPorts["session"] & Pick<SessionContract, "resume">;
		resume?(id: string): void;
	},
	id: string,
) {
	if (ports.resume) ports.resume(id);
	else ports.session.resume(id);
	return replayCurrentSession(ports, id);
}
