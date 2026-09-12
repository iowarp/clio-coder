import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	activeDecisionRefs,
	createDecisionBoardStore,
	type DecisionBoardStore,
	type DecisionLedgerEntryFields,
} from "../../src/domains/session/decision-board.js";
import { type DecisionLedgerEntry, isDecisionRecord, isSessionEntry } from "../../src/domains/session/entries.js";
import { builtin } from "../../src/tools/builtin-tool-catalog.js";
import { createDecideTool, DECIDE_CAPS } from "../../src/tools/decide.js";
import { validateBuiltinToolPolicy } from "../../src/tools/policy.js";

const SOURCE = { source: "builtin" } as never;

interface Fixture {
	entries: DecisionLedgerEntry[];
	board: DecisionBoardStore;
	tool: ReturnType<typeof createDecideTool>;
}

/** An in-memory session ledger: appends land as full entries the fold reads back. */
function fixture(seed: DecisionLedgerEntry[] = []): Fixture {
	const entries: DecisionLedgerEntry[] = [...seed];
	let sequence = 0;
	const board = createDecisionBoardStore({
		getSessionId: () => "session-1",
		readEntries: () => entries,
		getActiveLeafTurnId: () => "turn-9",
		appendEntry: (entry: DecisionLedgerEntryFields) => {
			sequence += 1;
			entries.push({ ...entry, turnId: `decision-${sequence}`, timestamp: `2026-09-05T00:00:0${sequence}.000Z` });
		},
		now: () => new Date("2026-09-05T00:00:00.000Z"),
	});
	return { entries, board, tool: createDecideTool({ decisionBoard: board }) };
}

function operatorInterview(key: string, value: string): DecisionLedgerEntry {
	return {
		kind: "decisionLedger",
		turnId: "interview-entry",
		parentTurnId: "turn-1",
		timestamp: "2026-09-04T00:00:00.000Z",
		interviewId: "interview-1",
		interviewStatus: "complete",
		startedAt: "2026-09-04T00:00:00.000Z",
		endedAt: "2026-09-04T00:00:01.000Z",
		roundCount: 1,
		exposure: "local",
		decisions: [{ key, value, status: "active", decidedAt: "2026-09-04T00:00:01.000Z" }],
	};
}

const GOOD_ARGS = {
	key: "cache-key-shape",
	value: "capability tuple",
	alternatives: ["node id", "fleet hash"],
	rationale: "matches the existing bucket keys and survives fleet changes",
	label: "Cache key",
};

describe("decide tool", () => {
	it("appends one agent decision set with the shape the shared types describe", async () => {
		const f = fixture();
		const result = await f.tool.run(GOOD_ARGS);
		strictEqual(result.kind, "ok", JSON.stringify(result));
		strictEqual(f.entries.length, 1);
		const [entry] = f.entries;
		if (entry === undefined) throw new Error("expected one entry");
		strictEqual(entry.kind, "decisionLedger");
		strictEqual(entry.origin, "agent");
		match(entry.interviewId, /^agent:[0-9a-f-]{36}$/u);
		strictEqual(entry.roundCount, 0);
		strictEqual(entry.interviewStatus, "complete");
		strictEqual(entry.parentTurnId, "turn-9");
		deepStrictEqual(entry.decisions, [
			{
				key: "cache-key-shape",
				value: "capability tuple",
				label: "Cache key",
				status: "active",
				decidedAt: "2026-09-05T00:00:00.000Z",
				source: "agent",
				alternatives: ["node id", "fleet hash"],
				rationale: "matches the existing bucket keys and survives fleet changes",
			},
		]);
		if (result.kind !== "ok") return;
		const details = result.details?.decision as { ref: string; superseded?: string };
		strictEqual(details.ref, `${entry.interviewId}/cache-key-shape`);
		strictEqual(details.superseded, undefined);
		deepStrictEqual(activeDecisionRefs(f.board.snapshot()), [details.ref]);
		ok(result.output.startsWith("decision recorded: cache-key-shape = capability tuple ["), result.output);
	});

	it("supersedes an earlier agent decision with the same key and records the new rationale as its correction", async () => {
		const f = fixture();
		const first = await f.tool.run(GOOD_ARGS);
		strictEqual(first.kind, "ok");
		const firstRef = (first.kind === "ok" ? (first.details?.decision as { ref: string }) : { ref: "" }).ref;
		const second = await f.tool.run({ ...GOOD_ARGS, value: "node id", rationale: "the tuple leaked across fleets" });
		strictEqual(second.kind, "ok", JSON.stringify(second));
		if (second.kind !== "ok") return;
		const details = second.details?.decision as { ref: string; superseded?: string };
		strictEqual(details.superseded, firstRef);
		ok(second.output.includes(`(supersedes ${firstRef})`), second.output);
		// Three appends: the first set, its superseded revision, the new set.
		strictEqual(f.entries.length, 3);
		const revision = f.entries[1];
		strictEqual(revision?.origin, "agent");
		strictEqual(revision?.decisions[0]?.revisionSource, "agent");
		strictEqual(revision?.interviewId, firstRef.split("/")[0]);
		deepStrictEqual(
			revision?.decisions.map((decision) => [decision.status, decision.correction]),
			[["superseded", "the tuple leaked across fleets"]],
		);
		deepStrictEqual(activeDecisionRefs(f.board.snapshot()), [details.ref]);
		ok(details.ref !== firstRef);
	});

	it("records an operator supersession without a correction and validates revision authors", async () => {
		const f = fixture();
		await f.tool.run(GOOD_ARGS);
		const initial = f.entries[0];
		if (!initial) throw new Error("expected decision");
		f.board.supersede(initial.interviewId, GOOD_ARGS.key);
		const revision = f.entries[1];
		ok(isSessionEntry(revision));
		const record = revision.decisions[0];
		strictEqual(record?.revisionSource, "operator");
		strictEqual(record?.correction, undefined);
		strictEqual(isDecisionRecord({ ...record, revisionSource: "model" }), false);
		strictEqual(isDecisionRecord({ ...initial.decisions[0], revisionSource: "agent" }), false);
	});

	it("refuses to overwrite an operator decision with the same key", async () => {
		const f = fixture([operatorInterview("cache-key-shape", "node id")]);
		const result = await f.tool.run(GOOD_ARGS);
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /operator decision \(interview-1\).*ask_user/u);
		strictEqual(f.entries.length, 1);
	});

	it("enforces the argument caps and names the field", async () => {
		const f = fixture();
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ ...GOOD_ARGS, key: "CacheKey" }, /key must be kebab-case/u],
			[
				{ ...GOOD_ARGS, key: "a".repeat(DECIDE_CAPS.keyBytes + 1) },
				new RegExp(`key exceeds the ${DECIDE_CAPS.keyBytes}-byte cap`, "u"),
			],
			[
				{ ...GOOD_ARGS, value: "v".repeat(DECIDE_CAPS.valueBytes + 1) },
				new RegExp(`value exceeds the ${DECIDE_CAPS.valueBytes}-byte cap`, "u"),
			],
			[{ ...GOOD_ARGS, alternatives: [] }, /alternatives must list at least one/u],
			[
				{ ...GOOD_ARGS, alternatives: ["a", "b", "c", "d", "e", "f", "g"] },
				new RegExp(`alternatives exceeds the ${DECIDE_CAPS.alternatives}-entry cap`, "u"),
			],
			[
				{ ...GOOD_ARGS, alternatives: ["x".repeat(DECIDE_CAPS.alternativeBytes + 1)] },
				new RegExp(`alternatives\\[0\\] exceeds the ${DECIDE_CAPS.alternativeBytes}-byte cap`, "u"),
			],
			[
				{ ...GOOD_ARGS, rationale: "r".repeat(DECIDE_CAPS.rationaleBytes + 1) },
				new RegExp(`rationale exceeds the ${DECIDE_CAPS.rationaleBytes}-byte cap`, "u"),
			],
			[{ ...GOOD_ARGS, rationale: "   " }, /rationale is required/u],
		];
		for (const [args, expected] of cases) {
			const result = await f.tool.run(args);
			strictEqual(result.kind, "error", JSON.stringify(args));
			if (result.kind === "error") match(result.message, expected);
		}
		strictEqual(f.entries.length, 0);
	});

	it("refuses without a decision board, as in a worker registry", async () => {
		const result = await createDecideTool().run(GOOD_ARGS);
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /no session decision board/u);
	});

	it("is read class and agrees with the classifier and plane table", () => {
		const tool = createDecideTool();
		strictEqual(tool.name, ToolNames.Decide);
		strictEqual(tool.baseActionClass, "read");
		const errors = validateBuiltinToolPolicy([builtin(tool, SOURCE)]).filter((error: string) =>
			error.includes(ToolNames.Decide),
		);
		deepStrictEqual(errors, []);
	});
});
