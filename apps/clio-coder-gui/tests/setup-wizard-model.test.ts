import assert from "node:assert/strict";
import test from "node:test";
import { readMessages, stepFor, viewFor, workingLabel } from "../client/wizard/wizard-model.js";
import type { SetupState } from "../contracts/setup.js";

const select = (heading: string[], labels: string[]) =>
	({
		id: 7,
		kind: "select",
		heading,
		choices: labels.map((label, id) => ({ id, label, hint: "" })),
		initial: 0,
		searchable: false,
	}) as const;

const state = (status: SetupState["status"], messages: string[]): SetupState => ({
	id: "setup-1",
	status,
	prompt: null,
	messages,
	problem: null,
});

test("the routes Clio found and the test-request failure are steps of their own, not generic prompts", () => {
	const offered = stepFor(
		select(
			["Clio found a way to reach a model:"],
			["Anthropic, with the key in ANTHROPIC_API_KEY", "Set up something else"],
		),
	);
	assert.equal(offered.kind, "offered");
	if (offered.kind !== "offered") return;
	assert.equal(offered.stage, "provider");
	assert.deepEqual(
		offered.routes.map((choice) => choice.label),
		["Anthropic, with the key in ANTHROPIC_API_KEY"],
	);
	assert.equal(offered.other?.label, "Set up something else");

	const have = stepFor(select(["What do you have?"], ["An API key", "A subscription"]));
	assert.equal(have.stage, "provider");

	const failed = stepFor(
		select(
			["The test request failed", "Check the key for Anthropic."],
			["Try again", "Change the key or address", "Save anyway", "Connection and machine details", "Cancel setup"],
		),
	);
	assert.equal(failed.kind, "test-failed");
	if (failed.kind !== "test-failed") return;
	assert.equal(failed.stage, "test");
	assert.equal(failed.fix, "Check the key for Anthropic.");
	assert.equal(failed.retry?.label, "Try again");
	assert.equal(failed.save?.label, "Save anyway");
	assert.equal(failed.model, null);
	assert.equal(failed.cancel?.label, "Cancel setup");

	const review = stepFor(
		select(
			["Review what Clio could verify", "Connection: anthropic", "Save sends one short test message first."],
			["Save target", "Connection and machine details", "Back", "Cancel setup"],
		),
	);
	assert.equal(review.kind === "review" && review.tests, true);
	assert.deepEqual(review.kind === "review" ? review.notes : null, []);
});

test("the test request is read from the CLI's lines: waiting on it, its answer, and a save without it", () => {
	const waiting = readMessages(["Testing anthropic / claude ..."]);
	assert.equal(workingLabel(waiting, null), "Sending the model a test message");
	assert.equal(
		workingLabel(readMessages(["Testing anthropic / claude ...", "✓ Testing anthropic / claude ... answered in 0.8 s."])),
		"Setting this up",
	);

	const failed = readMessages([
		"Testing anthropic / claude ...",
		"anthropic / claude did not answer: 401 invalid x-api-key",
	]);
	assert.deepEqual(failed.test, { state: "failed", text: "anthropic / claude did not answer: 401 invalid x-api-key" });

	const saved = viewFor(
		state("saved", [
			"Testing anthropic / claude ...",
			"anthropic / claude did not answer: overloaded",
			"Testing anthropic / claude ...",
			"✓ Testing anthropic / claude ... answered in 0.8 s.",
		]),
		null,
	);
	assert.equal(saved.kind, "saved");
	if (saved.kind !== "saved") return;
	assert.equal(saved.verified, true);
	assert.equal(saved.tested, "answered in 0.8 s");
	assert.deepEqual(saved.summary, []);

	const anyway = viewFor(
		state("saved", [
			"Testing anthropic / claude ...",
			"anthropic / claude did not answer: overloaded",
			"anthropic was saved without a passed test request.",
		]),
		null,
	);
	assert.equal(anyway.kind === "saved" && anyway.verified, false);
	assert.deepEqual(anyway.kind === "saved" ? anyway.warnings : null, [
		"anthropic was saved without a passed test request.",
	]);
});
