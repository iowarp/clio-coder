import { match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { mergeHandoffDecisions, renderHandoffDocument } from "../../src/domains/session/handoff.js";
import { packOracleDigest } from "../../src/interactive/oracle.js";
import { agentDecision } from "../harness/decision.js";

it("handoff and oracle preserve the agent's alternatives and rationale", async () => {
	const entry = await agentDecision();
	const decisions = mergeHandoffDecisions([], [entry]);
	const text = renderHandoffDocument({
		goal: "Continue the cache work",
		fromSessionId: "session-1",
		decisions,
		facts: [],
		files: [],
		droppedFiles: [],
		commands: [],
		openQuestions: [],
		truncations: [],
	});
	const oracle = packOracleDigest({
		decisions: [entry],
		tasks: [],
		compactionSummary: null,
		question: "Review the cache choice",
	});
	for (const output of [text, oracle.text]) {
		match(output, /Alternatives: node id in src\/cache.ts; fleet hash/u);
		match(output, /Rationale: src\/cache.ts needs keys that survive fleet changes/u);
	}
	const record = entry.decisions[0];
	if (!record) throw new Error("missing decision");
	const oldRecord = { ...record };
	delete oldRecord.alternatives;
	delete oldRecord.rationale;
	const legacy = {
		...entry,
		decisions: [{ ...oldRecord, source_question: "Which key?" }],
	};
	strictEqual(mergeHandoffDecisions([], [legacy])[0]?.rationale, "Which key?");
});
