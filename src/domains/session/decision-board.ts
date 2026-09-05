import { randomUUID } from "node:crypto";
import type { AskUserToolPolicy } from "../../tools/registry.js";
import type { AutonomyExposure } from "../safety/autonomy.js";
import { type DecisionLedgerEntry, type DecisionRecord, decisionRef } from "./entries.js";

export interface DecisionLedgerEntryFields {
	kind: "decisionLedger";
	parentTurnId: string;
	origin?: "interview" | "agent";
	interviewId: string;
	interviewStatus: "complete" | "cancelled";
	startedAt: string;
	endedAt: string;
	roundCount: number;
	summary?: string;
	transcriptPath?: string;
	exposure?: AutonomyExposure;
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

/** One design choice the model records itself through the `decide` tool. */
export interface AgentDecisionInput {
	key: string;
	value: string;
	alternatives: ReadonlyArray<string>;
	rationale: string;
	label?: string;
}

export interface AgentDecisionOutcome {
	/** The appended agent decision set; `decisionRef(entry.interviewId, key)` cites it. */
	entry: DecisionLedgerEntryFields;
	/** The earlier active record with the same key that this decision superseded, when there was one. */
	superseded: { interviewId: string; key: string } | null;
}

export interface DecisionBoardStore {
	/** Latest snapshot per interview, newest interview first. */
	snapshot(): ReadonlyArray<DecisionLedgerEntry>;
	/** Persist the one host-finalized snapshot for a settled interview. */
	recordFinalizedInterview(policy: AskUserToolPolicy): boolean;
	/**
	 * Append one agent-recorded decision as its own complete set
	 * (`origin: "agent"`, `interviewId: "agent:<uuid>"`, `roundCount: 0`). An
	 * earlier active agent decision with the same key is superseded first with
	 * the new rationale as its correction. An active operator decision with the
	 * same key is never overwritten by the model; that throws.
	 */
	recordAgentDecision(input: AgentDecisionInput): AgentDecisionOutcome;
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
function finalizedInterviewEntryFields(policy: AskUserToolPolicy): DecisionLedgerEntryFields | null {
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
		exposure: policy.exposure ?? "local",
		decisions: [...decisionsByKey.values()],
	};
}

/** Most decision refs one dispatch request, envelope, or receipt carries. */
export const DECISION_REFS_CAP = 32;

/**
 * Refs of every active decision on a board snapshot, sorted and capped at
 * {@link DECISION_REFS_CAP}. Dispatch seals this onto each request it builds;
 * an empty board yields an empty list, which callers leave off the request.
 */
export function activeDecisionRefs(board: ReadonlyArray<DecisionLedgerEntry>): string[] {
	const refs = new Set<string>();
	for (const entry of board) {
		for (const decision of entry.decisions) {
			if (decision.status === "active") refs.add(decisionRef(entry.interviewId, decision.key));
		}
	}
	return [...refs].sort().slice(0, DECISION_REFS_CAP);
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

	const store: DecisionBoardStore = {
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
		recordAgentDecision(input: AgentDecisionInput): AgentDecisionOutcome {
			syncToSession();
			let superseded: AgentDecisionOutcome["superseded"] = null;
			for (const interview of interviews) {
				const prior = interview.decisions.find((decision) => decision.key === input.key && decision.status === "active");
				if (prior === undefined) continue;
				if (interview.origin !== "agent" || prior.source !== "agent") {
					throw new Error(
						`decision board: '${input.key}' is an operator decision (${interview.interviewId}); it can only be revised through ask_user`,
					);
				}
				superseded = { interviewId: interview.interviewId, key: prior.key };
				break;
			}
			if (superseded !== null) store.supersede(superseded.interviewId, superseded.key, input.rationale);
			const now = (deps.now?.() ?? new Date()).toISOString();
			const entries = deps.readEntries?.() ?? [];
			const parentTurnId = deps.getActiveLeafTurnId?.() ?? activeLeafFromEntries(entries);
			if (!parentTurnId) throw new Error("decision board: no active branch leaf is available for the decision");
			const entry: DecisionLedgerEntryFields = {
				kind: "decisionLedger",
				parentTurnId,
				origin: "agent",
				interviewId: `agent:${randomUUID()}`,
				interviewStatus: "complete",
				startedAt: now,
				endedAt: now,
				roundCount: 0,
				exposure: "local",
				decisions: [
					{
						key: input.key,
						value: input.value,
						...(input.label ? { label: input.label } : {}),
						status: "active",
						decidedAt: now,
						source: "agent",
						alternatives: [...input.alternatives],
						rationale: input.rationale,
					},
				],
			};
			append(entry);
			return { entry, superseded };
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
				...(interview.exposure ? { exposure: interview.exposure } : {}),
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
	return store;
}
