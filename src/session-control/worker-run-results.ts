/**
 * Sealed-result reader for worker transcript blocks. The projection lives in
 * the dispatch domain (`src/domains/dispatch/run-result-facts.ts`) so ACP terminal
 * fleet frames report the same facts the TUI footer renders (#ACP-02).
 */

export {
	readRunResultFacts as readWorkerRunResultFacts,
	readRunResultFactsForReplay as readWorkerRunResultFactsForReplay,
} from "../domains/dispatch/run-result-facts.js";
