import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDecisionBoardStore,
	type DecisionLedgerEntryFields,
	finalizedInterviewEntryFields,
	foldDecisionBoard,
} from "../../src/domains/session/decision-board.js";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import { finalizeAskUserInterview } from "../../src/tools/ask-user.js";
import type { AskUserToolPolicy } from "../../src/tools/registry.js";

function policy(overrides: Partial<AskUserToolPolicy> = {}): AskUserToolPolicy {
	return {
		id: "interview-1",
		status: "complete",
		startedAt: "2026-08-19T10:00:00.000Z",
		updatedAt: "2026-08-19T10:03:00.000Z",
		endedAt: "2026-08-19T10:03:00.000Z",
		sessionId: "session-1",
		turnId: "user-1",
		transcriptPath: "/tmp/interviews/interview-1.json",
		summary: "Use the operator-selected scope.",
		rounds: [
			{
				round: 1,
				requestedAt: "2026-08-19T10:00:30.000Z",
				answeredAt: "2026-08-19T10:01:00.000Z",
				questions: [{ header: "Scope", question: "Which scope?" }],
				answers: [{ question: "Which scope?", answer: "Focused" }],
			},
		],
		decisions: [{ key: "scope", value: "Focused", label: "Scope", source_question: "Which scope?" }],
		inFlight: false,
		cancelled: false,
		answerCount: 1,
		callCount: 1,
		maxCalls: 6,
		askedQuestionKeys: new Set(["scope"]),
		...overrides,
	};
}

function persisted(fields: DecisionLedgerEntryFields, suffix: string): DecisionLedgerEntry {
	return {
		...fields,
		turnId: `ledger-${suffix}`,
		timestamp: `2026-08-19T10:0${suffix}:00.000Z`,
	};
}

describe("contracts/decision-board", () => {
	it("converts answer and explicit decisions with deterministic timestamps and last-key replacement", () => {
		const entry = finalizedInterviewEntryFields(
			policy({
				decisions: [
					{ key: "scope", value: "Broad", source_question: "Which scope?" },
					{ key: "release_gate", value: "Targeted contracts" },
					{ key: "scope", value: "Focused", label: "Scope", source_question: "Which scope?" },
				],
			}),
		);
		ok(entry);
		strictEqual(entry.parentTurnId, "user-1", "the snapshot is anchored to the originating user turn");
		strictEqual(entry.startedAt, "2026-08-19T10:00:00.000Z");
		strictEqual(entry.endedAt, "2026-08-19T10:03:00.000Z");
		strictEqual(entry.roundCount, 1);
		strictEqual(entry.transcriptPath, "/tmp/interviews/interview-1.json");
		deepStrictEqual(entry.decisions, [
			{
				key: "scope",
				value: "Focused",
				label: "Scope",
				source_question: "Which scope?",
				status: "active",
				decidedAt: "2026-08-19T10:01:00.000Z",
			},
			{
				key: "release_gate",
				value: "Targeted contracts",
				status: "active",
				decidedAt: "2026-08-19T10:03:00.000Z",
			},
		]);
	});

	it("keeps the last full snapshot for each interview and orders interviews newest first", () => {
		const original = finalizedInterviewEntryFields(policy());
		ok(original);
		const originalDecision = original.decisions[0];
		ok(originalDecision);
		const revised = persisted(
			{
				...original,
				parentTurnId: "assistant-1",
				decisions: [
					{
						...originalDecision,
						status: "superseded",
						revisedAt: "2026-08-19T10:04:00.000Z",
						correction: "Use broad scope",
					},
				],
			},
			"4",
		);
		const newer = finalizedInterviewEntryFields(
			policy({
				id: "interview-2",
				turnId: "user-2",
				startedAt: "2026-08-19T11:00:00.000Z",
				updatedAt: "2026-08-19T11:01:00.000Z",
				endedAt: "2026-08-19T11:01:00.000Z",
			}),
		);
		ok(newer);
		const folded = foldDecisionBoard([persisted(original, "1"), revised, persisted(newer, "5")]);
		deepStrictEqual(
			folded.map((entry) => entry.interviewId),
			["interview-2", "interview-1"],
		);
		strictEqual(folded[1]?.decisions[0]?.status, "superseded");
		strictEqual(folded[1]?.decisions[0]?.correction, "Use broad scope");
	});

	it("persists cancelled interviews with answered rounds even when they produced no compact decision", async () => {
		const cancelled = policy({
			status: "cancelled",
			cancelled: true,
			decisions: [],
		});
		delete cancelled.summary;
		const entries: DecisionLedgerEntry[] = [];
		const store = createDecisionBoardStore({
			getSessionId: () => "session-1",
			readEntries: () => entries,
			appendEntry: (entry) => entries.push(persisted(entry, "3")),
		});
		strictEqual(store.recordFinalizedInterview(cancelled), true);
		strictEqual(entries.length, 1);
		strictEqual(entries[0]?.interviewStatus, "cancelled");
		strictEqual(entries[0]?.roundCount, 1);
		deepStrictEqual(entries[0]?.decisions, []);

		const hostSettled = policy({
			status: "active",
			updatedAt: "2026-08-19T10:01:00.000Z",
		});
		delete hostSettled.endedAt;
		delete hostSettled.summary;
		await finalizeAskUserInterview(hostSettled, "turn_finished");
		strictEqual(hostSettled.status, "complete");
		strictEqual(store.recordFinalizedInterview(hostSettled), true);
		strictEqual(entries.length, 2, "host finalization reaches the producer once per invocation");
		strictEqual(entries[1]?.summary, "Interview closed by host: turn_finished.");
	});

	it("acknowledges revision appends, anchors them to the live leaf, and never fabricates failed updates", () => {
		const initialFields = finalizedInterviewEntryFields(policy());
		ok(initialFields);
		const entries = [persisted(initialFields, "1")];
		const appended: DecisionLedgerEntryFields[] = [];
		const store = createDecisionBoardStore({
			getSessionId: () => "session-1",
			getActiveLeafTurnId: () => "assistant-leaf",
			readEntries: () => entries,
			now: () => new Date("2026-08-19T10:05:00.000Z"),
			appendEntry: (entry) => {
				appended.push(entry);
				entries.push(persisted(entry, "5"));
			},
		});
		const revision = store.supersede("interview-1", "scope", "  Expand to all packages.  ");
		strictEqual(revision.parentTurnId, "assistant-leaf");
		strictEqual(revision.decisions[0]?.status, "superseded");
		strictEqual(revision.decisions[0]?.correction, "Expand to all packages.");
		strictEqual(revision.decisions[0]?.revisedAt, "2026-08-19T10:05:00.000Z");
		strictEqual(appended.length, 1);
		strictEqual(store.snapshot()[0]?.decisions[0]?.status, "superseded");

		const failingStore = createDecisionBoardStore({
			getSessionId: () => "session-1",
			getActiveLeafTurnId: () => "assistant-leaf",
			readEntries: () => [persisted(initialFields, "1")],
			appendEntry: () => {
				throw new Error("disk full");
			},
		});
		throws(() => failingStore.supersede("interview-1", "scope"), /disk full/);
		strictEqual(failingStore.snapshot()[0]?.decisions[0]?.status, "active");
	});

	it("skips idle policies that never opened an interview", () => {
		const entries: DecisionLedgerEntryFields[] = [];
		const store = createDecisionBoardStore({ appendEntry: (entry) => entries.push(entry) });
		const idle = policy({ status: "idle", rounds: [], decisions: [] });
		delete idle.endedAt;
		delete idle.turnId;
		strictEqual(store.recordFinalizedInterview(idle), false);
		deepStrictEqual(entries, []);
	});
});
