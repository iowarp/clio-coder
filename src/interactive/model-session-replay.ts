import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { projectWorkingSet } from "../domains/context/working-set/project.js";
import type { SessionEntry } from "../domains/session/entries.js";
import type { AgentMessage } from "../engine/types.js";
import { buildReplayAgentMessagesFromTurns, type RehydrateChatPanelOptions } from "./chat-renderer.js";

/**
 * Build provider-facing replay messages from the durable session ledger.
 * Projection always honors existing eviction and recall entries; the enabled
 * setting gates creation of new evictions, not replay of durable state.
 * Visible transcript and export callers intentionally keep using the raw
 * rehydration helpers so eviction remains a model projection, not data loss.
 */
export function buildModelReplayAgentMessagesFromTurns(
	entries: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): AgentMessage[] {
	const activeLeafTurnId = options.activeLeafTurnId ?? options.uptoTurnId;
	const projected = projectWorkingSet(entries, foldWorkingSet(entries, activeLeafTurnId));
	return buildReplayAgentMessagesFromTurns(projected, options);
}
