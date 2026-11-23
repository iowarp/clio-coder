/**
 * The compaction lines the chat loop raises, re-exported for the interactive surfaces.
 *
 * `renderCompactionSummaryLine` is the one-liner the chat loop raises after an automatic or `/compact` run; the
 * settled operation keeps it as its notice. A persisted `CompactionSummaryEntry` is the model's checkpoint, not a
 * transcript row: the settled context operation card (`renderContextOperationResult`) is the one place a compaction
 * shows, live and on resume, so a resumed session reads the same rows the live one did.
 */

export type {
	CompactionSummaryLineInput,
	EvictionSkipLineInput,
	EvictionSkipReason,
} from "../../session-control/compaction-lines.js";
export { renderCompactionSummaryLine, renderEvictionSkipLine } from "../../session-control/compaction-lines.js";
