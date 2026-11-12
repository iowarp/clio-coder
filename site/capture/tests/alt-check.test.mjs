import assert from "node:assert/strict";
import { test } from "node:test";
import { figures, missingFigures } from "../alt-check.mjs";
import { normalize } from "../quote-check.mjs";

test("figures skip version literals", () => {
	assert.deepEqual(figures("CLIO Coder v0.8.0-rc.1 shows 13,737 of 200,000 tokens and 7 tests"), [
		"13,737",
		"200,000",
		"7",
	]);
});

test("a figure the re-take no longer shows is missing", () => {
	const transcript = normalize("ctx 12,973 / 200000 tokens");
	assert.deepEqual(missingFigures({ alt: "a bar with 13,737 of 200,000 tokens", caption: "" }, transcript), ["13,737"]);
	assert.deepEqual(missingFigures({ alt: "the tokens in use out of the 200,000-token window" }, transcript), []);
});
