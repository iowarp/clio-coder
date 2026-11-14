import assert from "node:assert/strict";
import test from "node:test";
import type { SearchDraft } from "../client/shell/search-draft-model.js";
import { observed, startDraft, typed } from "../client/shell/search-draft-model.js";

const typeAll = (draft: SearchDraft, values: readonly string[]) => values.reduce(typed, draft);
const observeAll = (draft: SearchDraft, urls: readonly string[]) => urls.reduce(observed, draft);

test("late echoes of the operator's own keystrokes keep the draft", () => {
	const draft = typeAll(startDraft(""), ["a", "ab", "abc"]);
	const settled = observeAll(draft, ["a", "ab", "abc"]);
	assert.equal(settled.value, "abc");
	assert.deepEqual(settled.sent, []);
});

test("echoes interleaved with typing never rewind the box", () => {
	let draft = typed(startDraft(""), "a");
	draft = typed(draft, "ab");
	draft = observed(draft, "a");
	assert.equal(draft.value, "ab");
	draft = typed(draft, "abc");
	draft = observed(draft, "ab");
	assert.equal(draft.value, "abc");
	draft = observed(draft, "abc");
	assert.deepEqual(draft, { value: "abc", sent: [] });
});

test("an echo that skips the intermediates clears what was sent", () => {
	const draft = observed(typeAll(startDraft(""), ["a", "ab", "abc"]), "abc");
	assert.deepEqual(draft, { value: "abc", sent: [] });
});

test("an outside URL value is adopted", () => {
	const draft = observed(typeAll(startDraft("old"), ["a", "ab"]), "");
	assert.deepEqual(draft, { value: "", sent: [] });
	assert.deepEqual(observed(startDraft("abc"), "xyz"), { value: "xyz", sent: [] });
});

test("a Backspace is not undone by the echo of the longer value", () => {
	const draft = typeAll(startDraft(""), ["ab", "a"]);
	const afterFirst = observed(draft, "ab");
	assert.equal(afterFirst.value, "a");
	assert.deepEqual(observed(afterFirst, "a"), { value: "a", sent: [] });
});

test("the sent list stays bounded", () => {
	const values = Array.from({ length: 100 }, (_, index) => "x".repeat(index + 1));
	const draft = typeAll(startDraft(""), values);
	assert.equal(draft.sent.length, 32);
	assert.equal(draft.sent.at(-1), values.at(-1));
	assert.equal(draft.value, values.at(-1));
});
