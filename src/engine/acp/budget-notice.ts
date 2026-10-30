import { renderCostAmount } from "../../domains/observability/cost.js";
import type { AcpBudgetBlock, AcpBudgetCapability } from "./types.js";

export type { AcpBudgetBlock } from "./types.js";

import { ACP_BUDGET_META_KEY, ACP_NOTICE_META_KEY } from "./types.js";

export { ACP_BUDGET_META_KEY } from "./types.js";

import {
	budgetSpendText,
	describeBudgetBlock,
	readBudgetBlock,
	SESSION_COST_CEILING_SETTING,
} from "../../domains/scheduling/index.js";
/**
 * A session cost ceiling stop on the ACP wire. The TUI shows the stop as a
 * transcript notice and replays the durable `budgetBlock` entry after a
 * resume; an ACP client saw neither and watched a prompt wait in silence
 * (#424). Both now cross as one `agent_message_chunk`: the notice text under
 * `clio-coder/notice` for every client, and the stop's figures under
 * `clio-coder/budget` for a client that can offer the raise. Live frames come
 * from the `BudgetAlert` bus channel while the prompt is parked; replay frames
 * come from the ledger entry, so a loaded session shows the same stop.
 */
import type { CustomEntry } from "../../domains/session/entries.js";
import { BUDGET_BLOCK_ENTRY } from "../../domains/session/entries.js";

export const ACP_BUDGET_CAPABILITY: AcpBudgetCapability = {
	version: 1,
	meta: ACP_BUDGET_META_KEY,
	update: "agent_message_chunk",
	setting: SESSION_COST_CEILING_SETTING,
	replay: true,
};

export interface AcpBudgetFrame {
	update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } };
	meta: { [ACP_NOTICE_META_KEY]: { level: "warning" | "error" }; [ACP_BUDGET_META_KEY]: AcpBudgetBlock };
}

/** The frame for one stop, or null when the payload is not a ceiling stop. */
export function budgetBlockFrame(payload: unknown): AcpBudgetFrame | null {
	const block = readBudgetBlock(payload);
	if (block === null) return null;
	const notice = describeBudgetBlock(block);
	return {
		update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${notice.text}\n` } },
		meta: {
			[ACP_NOTICE_META_KEY]: { level: notice.level === "error" ? "error" : "warning" },
			[ACP_BUDGET_META_KEY]: {
				version: 1,
				currentDisplay: budgetSpendText(block.currentUsd, block.pricing),
				ceilingDisplay: renderCostAmount(block.ceilingUsd, "known"),
				raiseDisplay: renderCostAmount(block.raiseToUsd, "known"),
				level: block.level,
				currentUsd: block.currentUsd,
				ceilingUsd: block.ceilingUsd,
				contextTokens: block.contextTokens === undefined ? null : Math.round(block.contextTokens),
				raiseToUsd: block.raiseToUsd,
				setting: SESSION_COST_CEILING_SETTING,
			},
		},
	};
}

/** The replay frame for a durable `budgetBlock` entry; null for any other custom entry or a malformed one. */
export function budgetBlockReplayFrame(entry: CustomEntry): AcpBudgetFrame | null {
	return entry.customType === BUDGET_BLOCK_ENTRY ? budgetBlockFrame(entry.data) : null;
}
