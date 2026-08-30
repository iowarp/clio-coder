/**
 * The bridge between the session task bank and the durable memory store.
 *
 * Through 0.3.9 these were two stores where only one was ever written. The
 * background plane filled the bank on every step, and nothing but an explicit
 * `clio-coder memory propose` created a record, so `<dataDir>/memory/records.json`
 * on the operator's machine did not exist at all: the tier's own output was
 * discarded with the session that produced it, and the next session's first
 * step read an empty bank and recorded `bank_empty` (#229).
 *
 * A reminder that actually reached the operator is the strongest signal the
 * tier produces, so its cited entries are proposed here for review. They are
 * written unapproved, under the repository the session is working in, and
 * approval stays a separate operator action, exactly as it is for a promotion
 * made by hand from `/memory`.
 */

import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import { proposeMemoryPromotion } from "./promotion.js";
import type { TaskMemoryEntry } from "./task-bank.js";
import type { MemoryRecord } from "./types.js";

export interface ProposeInjectedTaskMemoryInput {
	/** Session the reminder was produced in. Without one there is no provenance to file under. */
	sessionId: string | null;
	/** Working directory of that session, used for the repository scope. */
	cwd: string;
	entries: ReadonlyArray<TaskMemoryEntry>;
	now?: Date;
}

export interface ProposeInjectedTaskMemoryResult {
	records: MemoryRecord[];
	/** One message per entry the store refused, for the caller to report. */
	errors: string[];
}

export async function proposeInjectedTaskMemory(
	dataDir: string,
	input: ProposeInjectedTaskMemoryInput,
): Promise<ProposeInjectedTaskMemoryResult> {
	const result: ProposeInjectedTaskMemoryResult = { records: [], errors: [] };
	const sessionId = input.sessionId;
	const repository = canonicalMemoryRepositoryIdentity(input.cwd);
	// No session means no provenance. No canonical repository leaves only global
	// scope, which broadens applicability to every future session and is a claim
	// a background step may never make on the operator's behalf.
	if (sessionId === null || sessionId.length === 0 || repository === null) return result;
	for (const entry of input.entries) {
		if (entry.kind === "status") continue;
		try {
			const proposal = await proposeMemoryPromotion(
				dataDir,
				{ kind: "task-bank-entry", sessionId, evidenceRefs: [`session:${sessionId}`], entry },
				{ scope: "repo", repository },
				input.now ?? new Date(),
			);
			result.records.push(proposal.record);
		} catch (error) {
			result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}
