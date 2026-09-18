/**
 * No-op scoring for one eval item (#378).
 *
 * A headless main-agent run seals `noop` into the receipt it writes to its
 * state journal and prints no receipt on stdout, so the runner's parsed
 * receipt never carries it. The item's own journal does. The journal can hold
 * more than one receipt (dispatched workers, retries), so the receipt is
 * matched to this item's run by the session the run announced in its
 * `--json` header: the one root main-agent receipt sealed for that session.
 * Anything short of exactly one match leaves the item unscored, which keeps
 * the outcome it had before the field existed.
 */

import type { RunReceipt } from "../../dispatch/types.js";
import type { EvalRunJournal } from "./invariants.js";

const MAIN_AGENT_ID = "main-agent";
const REASON_ATTEMPTS_LIMIT = 5;

/** The session id from the first `session` header line of a `run --json` stream. */
function sessionIdFromRunJsonStdout(stdout: string): string | null {
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		if (record.type !== "session") continue;
		return typeof record.id === "string" && record.id.length > 0 ? record.id : null;
	}
	return null;
}

/** The root main-agent receipt this item's run sealed, or null unless exactly one matches. */
export function mainAgentReceiptForRun(journal: EvalRunJournal | null, runnerStdout: string): RunReceipt | null {
	if (journal === null) return null;
	const sessionId = sessionIdFromRunJsonStdout(runnerStdout);
	if (sessionId === null) return null;
	const matches = journal.receipts.filter(
		(receipt) =>
			receipt.agentId === MAIN_AGENT_ID &&
			receipt.sessionId === sessionId &&
			(receipt.lineage === undefined || receipt.lineage.rootRunId === receipt.runId),
	);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Why a no-op receipt changed nothing: its blocked calls when it recorded any. */
export function noopFailureReason(receipt: RunReceipt): string {
	const attempts = receipt.safety?.blockedAttempts ?? [];
	if (attempts.length === 0) return "no-op run: no mutating tool call succeeded";
	const shown = attempts
		.slice(0, REASON_ATTEMPTS_LIMIT)
		.map((attempt) => `${attempt.tool} (${attempt.reason ?? attempt.reasonCode ?? "no reason recorded"})`);
	const hidden = attempts.length - shown.length + (receipt.safety?.blockedAttemptsTruncated ?? 0);
	return `no-op run: blocked ${shown.join("; ")}${hidden > 0 ? `; and ${hidden} more` : ""}`;
}
