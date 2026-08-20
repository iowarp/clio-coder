import type { AskUserToolPolicy } from "../../tools/registry.js";
import type { DecisionLedgerEntry, DecisionRecord } from "./entries.js";

export interface DecisionLedgerEntryFields {
	kind: "decisionLedger";
	parentTurnId: string;
	interviewId: string;
	interviewStatus: "complete" | "cancelled";
	startedAt: string;
	endedAt: string;
	roundCount: number;
	summary?: string;
	transcriptPath?: string;
	decisions: DecisionRecord[];
}

export interface DecisionBoardStoreDeps {
	/** Current session id, used to keep the in-memory fold scoped to one ledger. */
	getSessionId?: () => string | null;
	/** Active-path entries for the current session. */
	readEntries?: () => ReadonlyArray<unknown>;
	/** The current branch leaf used to anchor operator-authored revisions. */
	getActiveLeafTurnId?: () => string | null;
	/** Acknowledged session append. A throw means the board did not change. */
	appendEntry?: (entry: DecisionLedgerEntryFields) => void;
	now?: () => Date;
}

export interface DecisionBoardStore {
	/** Latest snapshot per interview, newest interview first. */
	snapshot(): ReadonlyArray<DecisionLedgerEntry>;
	/** Persist the one host-finalized snapshot for a settled interview. */
	recordFinalizedInterview(policy: AskUserToolPolicy): boolean;
	/** Append an operator revision snapshot anchored to the active branch leaf. */
	supersede(interviewId: string, key: string, correction?: string): DecisionLedgerEntryFields;
	/** Force the next read to refold, including after a same-session tree switch. */
	invalidate(): void;
}

function answeredAtForDecision(policy: AskUserToolPolicy, sourceQuestion: string): string | undefined {
	for (let index = policy.rounds.length - 1; index >= 0; index -= 1) {
		const round = policy.rounds[index];
		if (!round?.answeredAt) continue;
		if (round.answers.some((answer) => answer.question === sourceQuestion)) return round.answeredAt;
		if (round.questions.some((question) => question.question === sourceQuestion)) return round.answeredAt;
	}
	return undefined;
}

/**
 * Convert the settled, host-owned policy into the complete durable snapshot.
 * The policy already keeps last-value-wins decisions; the defensive map also
 * makes conversion deterministic for hand-built policies and older callers.
 */
export function finalizedInterviewEntryFields(policy: AskUserToolPolicy): DecisionLedgerEntryFields | null {
	if (policy.rounds.length === 0 && policy.decisions.length === 0) return null;
	if (!policy.turnId) throw new Error(`decision board: interview ${policy.id} has no originating user turn`);
	if (policy.status !== "complete" && policy.status !== "cancelled") {
		throw new Error(`decision board: interview ${policy.id} finalized with status ${policy.status}`);
	}
	const endedAt = policy.endedAt ?? policy.updatedAt;
	const decisionsByKey = new Map<string, DecisionRecord>();
	for (const decision of policy.decisions) {
		const decidedAt = decision.source_question
			? (answeredAtForDecision(policy, decision.source_question) ?? endedAt)
			: endedAt;
		decisionsByKey.set(decision.key, {
			key: decision.key,
			value: decision.value,
			...(decision.label ? { label: decision.label } : {}),
			...(decision.source_question ? { source_question: decision.source_question } : {}),
			status: "active",
			decidedAt,
		});
	}
	return {
		kind: "decisionLedger",
		parentTurnId: policy.turnId,
		interviewId: policy.id,
		interviewStatus: policy.status,
		startedAt: policy.startedAt,
		endedAt,
		roundCount: policy.rounds.length,
		...(policy.summary ? { summary: policy.summary } : {}),
		...(policy.transcriptPath ? { transcriptPath: policy.transcriptPath } : {}),
		decisions: [...decisionsByKey.values()],
	};
}

function isDecisionLedgerEntry(value: unknown): value is DecisionLedgerEntry {
	return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "decisionLedger";
}

/** Last full snapshot wins independently for each interview. */
export function foldDecisionBoard(entries: ReadonlyArray<unknown>): DecisionLedgerEntry[] {
	const lastByInterview = new Map<string, { entry: DecisionLedgerEntry; index: number }>();
	for (let index = 0; index < entries.length; index += 1) {
		const raw = entries[index];
		if (!isDecisionLedgerEntry(raw)) continue;
		lastByInterview.set(raw.interviewId, { entry: raw, index });
	}
	return [...lastByInterview.values()]
		.sort((left, right) => {
			const byEndedAt = right.entry.endedAt.localeCompare(left.entry.endedAt);
			return byEndedAt !== 0 ? byEndedAt : right.index - left.index;
		})
		.map(({ entry }) => entry);
}

function activeLeafFromEntries(entries: ReadonlyArray<unknown>): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry && typeof entry === "object" && (entry as { kind?: unknown }).kind === "message") {
			const turnId = (entry as { turnId?: unknown }).turnId;
			if (typeof turnId === "string" && turnId.length > 0) return turnId;
		}
	}
	return null;
}

export function createDecisionBoardStore(deps: DecisionBoardStoreDeps = {}): DecisionBoardStore {
	let cachedSessionId: string | null | undefined;
	let dirty = true;
	let interviews: DecisionLedgerEntry[] = [];

	const syncToSession = (): void => {
		const sessionId = deps.getSessionId?.() ?? null;
		if (!dirty && sessionId === cachedSessionId) return;
		const entries = deps.readEntries?.() ?? [];
		interviews = foldDecisionBoard(entries);
		cachedSessionId = sessionId;
		dirty = false;
	};

	const append = (entry: DecisionLedgerEntryFields): void => {
		if (!deps.appendEntry) throw new Error("decision board: no session ledger is available");
		deps.appendEntry(entry);
		// Read the acknowledged append back through the active-path source. This
		// never publishes a snapshot the ledger did not accept.
		dirty = true;
	};

	return {
		snapshot(): ReadonlyArray<DecisionLedgerEntry> {
			syncToSession();
			return interviews;
		},
		recordFinalizedInterview(policy: AskUserToolPolicy): boolean {
			const entry = finalizedInterviewEntryFields(policy);
			if (entry === null) return false;
			append(entry);
			return true;
		},
		supersede(interviewId: string, key: string, correction?: string): DecisionLedgerEntryFields {
			syncToSession();
			const interview = interviews.find((candidate) => candidate.interviewId === interviewId);
			if (!interview) throw new Error(`decision board: interview ${interviewId} was not found on the active branch`);
			const selected = interview.decisions.find((decision) => decision.key === key);
			if (!selected) throw new Error(`decision board: decision ${key} was not found in interview ${interviewId}`);
			const revisedAt = (deps.now?.() ?? new Date()).toISOString();
			const normalizedCorrection = correction?.trim();
			const entries = deps.readEntries?.() ?? [];
			const parentTurnId = deps.getActiveLeafTurnId?.() ?? activeLeafFromEntries(entries);
			if (!parentTurnId) throw new Error("decision board: no active branch leaf is available for the revision");
			const revision: DecisionLedgerEntryFields = {
				kind: "decisionLedger",
				parentTurnId,
				interviewId: interview.interviewId,
				interviewStatus: interview.interviewStatus,
				startedAt: interview.startedAt,
				endedAt: interview.endedAt,
				roundCount: interview.roundCount,
				...(interview.summary ? { summary: interview.summary } : {}),
				...(interview.transcriptPath ? { transcriptPath: interview.transcriptPath } : {}),
				decisions: interview.decisions.map((decision) => {
					if (decision.key !== selected.key) return { ...decision };
					const next: DecisionRecord = { ...decision, status: "superseded", revisedAt };
					if (normalizedCorrection) next.correction = normalizedCorrection;
					else delete next.correction;
					return next;
				}),
			};
			append(revision);
			return revision;
		},
		invalidate(): void {
			dirty = true;
		},
	};
}
