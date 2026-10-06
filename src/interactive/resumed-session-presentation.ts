import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { withContinuityReplay } from "../session-control/model-session-replay.js";
import type { ChatPanel } from "./chat-panel.js";
import { rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { lastTurnSummaryFromLedger } from "./session-last-turn.js";
import type { TurnSummary } from "./status/index.js";

/** The orchestrator restores model context; the terminal must replay the same active path visibly. */
export function hydrateResumedSessionPresentation(
	session: SessionContract,
	panel: ChatPanel,
	readEntries: (id: string) => SessionEntry[],
	setSummary: (summary: TurnSummary | null) => void,
): void {
	const meta = session.current();
	if (!meta) return;
	const leaf = session.tree(meta.id).leafId;
	const entries = readEntries(meta.id);
	const options = withContinuityReplay(entries, leaf === null ? {} : { activeLeafTurnId: leaf }, session);
	rehydrateChatPanelFromTurns(panel, entries, options);
	setSummary(lastTurnSummaryFromLedger(entries, { target: meta.target, model: meta.model }, leaf));
}
