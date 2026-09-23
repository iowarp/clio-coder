import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACP_TARGET_MODEL_LIMIT,
	catalogMayBeCut,
	MODEL_TARGET_PATHS,
	modelAfterTargetChange,
	modelOptions,
	OTHER_MODEL,
} from "../client/pages/model-options.js";

test("modelOptions offers the target's catalog, keeps a saved id it lacks, and ends with a typed escape", () => {
	const options = modelOptions(["mercury-2.5", "mercury-2", "mercury-2.5"], "mercury-2", "mercury-2.5");
	assert.deepEqual(
		options.map((option) => option.value),
		["", "mercury-2", "mercury-2.5", OTHER_MODEL],
	);
	assert.equal(options[0]?.label, "Target default · mercury-2.5");
	assert.equal(options.at(-1)?.label, "Another model id…");

	const stale = modelOptions(["a", "b"], "retired-model", null);
	assert.deepEqual(stale[1], { value: "retired-model", label: "retired-model · not in this target's list" });
	assert.equal(stale[0]?.label, "Target default", "an unknown default is not guessed");
});

test("a catalog as long as the wire allows may be cut, and says so", () => {
	assert.equal(catalogMayBeCut(Array.from({ length: ACP_TARGET_MODEL_LIMIT }, (_, index) => `m${index}`)), true);
	assert.equal(catalogMayBeCut(["one", "two"]), false);
});

test("a target change keeps the model only when the new target lists it", () => {
	assert.equal(modelAfterTargetChange("mercury-2", ["mercury-2.5", "mercury-2"]), "mercury-2");
	assert.equal(modelAfterTargetChange("gpt-6-astra", ["mercury-2.5"]), "");
	assert.equal(modelAfterTargetChange("gpt-6-astra", null), "", "an unread catalog cannot vouch for the model");
	assert.equal(modelAfterTargetChange("", ["mercury-2.5"]), "");
});

test("every model setting names the target whose catalog it picks from", () => {
	assert.equal(MODEL_TARGET_PATHS["chat.model"], "chat.target");
	assert.equal(MODEL_TARGET_PATHS["fleet.default.model"], "fleet.default.target");
	assert.equal(MODEL_TARGET_PATHS["context.memory.model"], "context.memory.target");
	assert.equal(MODEL_TARGET_PATHS["context.compaction.model"], "chat.target");
});
