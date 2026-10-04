/**
 * Sealed-receipt reader for worker transcript blocks. The projection lives in
 * the dispatch domain (`src/domains/dispatch/receipt-facts.ts`) so ACP terminal
 * fleet frames report the same facts the TUI footer renders (#ACP-02).
 */

export {
	readRunReceiptFacts as readWorkerReceiptFacts,
	readRunReceiptFactsForReplay as readWorkerReceiptFactsForReplay,
} from "../domains/dispatch/receipt-facts.js";
