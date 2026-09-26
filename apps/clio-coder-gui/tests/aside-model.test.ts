import assert from "node:assert/strict";
import { test } from "node:test";
import { answerView, asideBlock, draftCounts, draftsView } from "../client/chat/aside-model.js";

const capability = {
	version: 1 as const,
	ask: "_clio-coder/aside/ask",
	draft: "_clio-coder/aside/draft",
	cancel: "_clio-coder/aside/cancel",
	draftCounts: { min: 1, max: 4, default: 3 },
};

test("an aside is offered only by an open, idle conversation whose agent announced it", () => {
	assert.match(asideBlock(undefined, true, false) ?? "", /cannot answer beside/);
	assert.match(asideBlock(capability, false, false) ?? "", /not open/);
	assert.match(asideBlock(capability, true, true) ?? "", /turn settles/);
	assert.equal(asideBlock(capability, true, false), null);
});

test("draft counts start at two, because one draft has nothing to be judged against", () => {
	assert.deepEqual(draftCounts(capability), { counts: [2, 3, 4], initial: 3 });
	assert.deepEqual(draftCounts({ ...capability, draftCounts: { min: 1, max: 2, default: 1 } }), {
		counts: [2],
		initial: 2,
	});
});

test("an answer reads as answered, stopped, refused or failed, and says when it was cut", () => {
	assert.deepEqual(answerView({ status: "answered", text: "README.md", truncated: false }), {
		tone: "success",
		word: "Answered",
		text: "README.md",
		note: "Not added to the conversation.",
	});
	assert.equal(answerView({ status: "aborted", text: "Part", truncated: false }).word, "Stopped");
	assert.match(answerView({ status: "answered", text: "x", truncated: true }).note, /shortened/);
	assert.deepEqual(answerView({ status: "refused", reason: "a turn is in flight" }), {
		tone: "warn",
		word: "Not asked",
		text: null,
		note: "a turn is in flight",
	});
	assert.equal(answerView({ status: "failed", reason: "endpoint reset" }).tone, "fail");
});

test("drafts show the judge's pick and shares, or why there is no judgment", () => {
	const judged = draftsView({
		status: "drafted",
		aborted: false,
		candidates: [
			{ label: "A", status: "drafted", text: "Table.", truncated: false },
			{ label: "B", status: "drafted", text: "List.", truncated: false },
		],
		judgment: {
			status: "judged",
			picked: "A",
			probabilities: { A: 0.7, B: 0.3 },
			sound: { A: true, B: null },
			source: "jev/sys1",
			elapsedMs: 264,
		},
	});
	assert.equal(judged.summary, "jev/sys1 picked A in 264 ms.");
	assert.deepEqual(
		judged.cards.map((card) => [card.label, card.picked, card.share, card.sound]),
		[
			["A", true, "70%", "Sound"],
			["B", false, "30%", "Undecided"],
		],
	);
	const unjudged = draftsView({
		status: "drafted",
		aborted: false,
		candidates: [
			{ label: "A", status: "drafted", text: "Table.", truncated: false },
			{ label: "B", status: "failed", reason: "endpoint reset" },
		],
		judgment: { status: "unjudged", reason: "not judged: a draft failed or came back empty" },
	});
	assert.equal(unjudged.summary, "Not judged: a draft failed or came back empty.");
	assert.deepEqual(unjudged.cards[1], {
		label: "B",
		picked: false,
		share: null,
		sound: null,
		text: null,
		failed: "endpoint reset",
		truncated: false,
	});
	assert.equal(draftsView({ status: "drafted", aborted: true, candidates: [] }).summary, "Stopped before a judgment.");
	assert.equal(
		draftsView({ status: "refused", reason: "a turn is in flight" }).summary,
		"Not drafted: a turn is in flight.",
	);
});
