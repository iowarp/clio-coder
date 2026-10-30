/**
 * What working-set recall put back in front of the model, folded from the
 * `contextRecall` records in one ledger slice (#422).
 *
 * A recall does not restore the evicted body in place: the marker stays in the
 * prefix and the body returns as a new tool result at the tail, where the next
 * request writes it to the prompt cache and every later request reads it again.
 * Before this fold the readmitted size reached only the ledger and the evidence
 * export, so an operator watching the budget saw recall counts and no tokens.
 *
 * Only `tool` (context(scope="recall")) and `reread` (the read tool returning
 * an evicted body byte for byte) recalls are billed. An `operator` recall
 * (`/context recall`) goes to the transcript and never into a request, so it is
 * counted but its tokens are not.
 */

import type { SessionEntry } from "./entries.js";

export interface RecallTelemetry {
	/** `context(scope="recall")` calls the model made. */
	toolRecalls: number;
	/** Read-tool results that were byte-identical to an evicted read. */
	rereads: number;
	/** `/context recall` by the operator; shown in the transcript, never billed. */
	operatorRecalls: number;
	/** Estimated tokens the tool recalls and rereads sent back into the model's context. */
	readmittedTokens: number;
}

export function foldRecallTelemetry(entries: ReadonlyArray<SessionEntry>): RecallTelemetry {
	let toolRecalls = 0;
	let rereads = 0;
	let operatorRecalls = 0;
	let readmittedTokens = 0;
	for (const entry of entries) {
		if (entry.kind !== "contextRecall") continue;
		const tokens = Number.isFinite(entry.tokensReadmitted) ? Math.max(0, entry.tokensReadmitted) : 0;
		switch (entry.trigger) {
			case "tool":
				toolRecalls += 1;
				readmittedTokens += tokens;
				break;
			case "reread":
				rereads += 1;
				readmittedTokens += tokens;
				break;
			case "operator":
				operatorRecalls += 1;
				break;
		}
	}
	return { toolRecalls, rereads, operatorRecalls, readmittedTokens };
}

/** True when the slice holds at least one recall of any trigger. */
export function hasRecallTelemetry(telemetry: RecallTelemetry): boolean {
	return telemetry.toolRecalls > 0 || telemetry.rereads > 0 || telemetry.operatorRecalls > 0;
}

/** `12,345 tokens · 3 recalls · 1 reread`, the shape every surface shares. */
export function formatRecallTelemetry(telemetry: RecallTelemetry): string {
	const parts = [
		`${telemetry.readmittedTokens.toLocaleString("en-US")} tokens`,
		`${telemetry.toolRecalls} recall${telemetry.toolRecalls === 1 ? "" : "s"}`,
	];
	if (telemetry.rereads > 0) parts.push(`${telemetry.rereads} reread${telemetry.rereads === 1 ? "" : "s"}`);
	return parts.join(" · ");
}
