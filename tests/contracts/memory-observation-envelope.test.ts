import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import type { ObservationSource, ObservationSourceUnit } from "../../src/domains/memory/contract.js";
import { prepareObservation } from "../../src/domains/memory/observations.js";

const unit: ObservationSourceUnit = {
	refs: ["r1"],
	digest: "d1",
	text: "user asked to pin the pnpm version; the assistant edited package.json",
	exact: [],
	toolCallIds: [],
	successfulResultRefs: [],
	complete: true,
};
const source: ObservationSource = {
	sessionId: "s1",
	branchAnchorTurnId: null,
	checkpoint: null,
	units: [unit],
};
const envelope = JSON.stringify({
	notes: [
		{ id: "n1", category: "decision", status: "assertion", text: "Pin pnpm to 10 in package.json {kept}", refs: ["r1"] },
	],
});

function prepare(response: string) {
	return prepareObservation({
		response,
		source,
		units: [unit],
		authority: { generation: 1, commitEpoch: 1 },
		revision: "0123456789abcdef",
		route: null,
		usage: null,
	});
}

test("an observation wrapped in a reasoning block or prose keeps its notes", () => {
	for (const response of [
		envelope,
		`\`\`\`json\n${envelope}\n\`\`\``,
		`<think>\nThe user wants {a pin}. I will emit {"notes": []}?\n</think>\n\n${envelope}`,
		`Here is the observation:\n\n\`\`\`json\n${envelope}\n\`\`\`\n\nLet me know if more is needed.`,
		`<think>plan</think>\n${envelope.slice(0, -1)}`,
	]) {
		const batch = prepare(response);
		deepStrictEqual(
			batch.notes.map((note) => note.text),
			["Pin pnpm to 10 in package.json {kept}"],
			response,
		);
	}
});

test("an observation cut off inside its reasoning block or carrying no envelope is still refused", () => {
	throws(() => prepare(`<think>The notes would be ${envelope}`));
	throws(() => prepare("I could not find anything worth noting."));
	throws(() => prepare(`<think>x</think> {"summary": "no notes key"}`));
	strictEqual(prepare(`${envelope}\n{"notes": []}`).notes.length, 1);
});
