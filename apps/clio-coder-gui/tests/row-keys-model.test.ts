import assert from "node:assert/strict";
import { test } from "node:test";
import { rowAfterKey } from "../client/interaction/row-keys-model.js";

test("Up, Down, j and k step between rows without wrapping, and Home and End jump", () => {
	const on = (at: number) => ({ at, on: true });
	assert.equal(rowAfterKey("ArrowDown", on(0), 3), 1);
	assert.equal(rowAfterKey("j", on(1), 3), 2);
	assert.equal(rowAfterKey("ArrowDown", on(2), 3), 2, "the last row stays");
	assert.equal(rowAfterKey("k", on(2), 3), 1);
	assert.equal(rowAfterKey("ArrowUp", on(0), 3), 0, "the first row stays");
	assert.equal(rowAfterKey("Home", on(2), 3), 0);
	assert.equal(rowAfterKey("End", on(0), 3), 2);
	for (const key of ["ArrowRight", "J", "Enter", " "]) assert.equal(rowAfterKey(key, on(1), 3), -1, key);
	assert.equal(rowAfterKey("ArrowDown", on(0), 0), -1, "an empty list leaves the key alone");
});

test("from between rows (a group heading or button), Down takes the next row and Up the one before", () => {
	// Focus on the list itself, before any row.
	assert.equal(rowAfterKey("ArrowDown", { at: 0, on: false }, 4), 0);
	assert.equal(rowAfterKey("ArrowUp", { at: 0, on: false }, 4), 0);
	// Focus on a group's "New task" button after the first two rows.
	assert.equal(rowAfterKey("j", { at: 2, on: false }, 4), 2);
	assert.equal(rowAfterKey("k", { at: 2, on: false }, 4), 1);
	// Past the last row.
	assert.equal(rowAfterKey("ArrowDown", { at: 4, on: false }, 4), 3);
});
