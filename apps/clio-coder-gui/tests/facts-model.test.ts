import assert from "node:assert/strict";
import { test } from "node:test";
import { FACT_LIMITS, factsOf, humanizeKey, omittedSentence, scalarText } from "../client/design/facts-model.js";

test("keys read as words and keep their acronyms", () => {
	assert.equal(humanizeKey("toolCallsPerRun"), "Tool calls per run");
	assert.equal(humanizeKey("costUsd"), "Cost");
	assert.equal(humanizeKey("sha256"), "SHA256");
	assert.equal(humanizeKey("run_id"), "Run ID");
	assert.equal(humanizeKey("wallTimeMs"), "Wall time");
	assert.equal(humanizeKey("ms"), "MS", "a key that is only a unit keeps its word");
	assert.equal(humanizeKey("id"), "id".toUpperCase());
	assert.equal(humanizeKey(""), "");
});

test("absent and zero are different facts, and the key chooses the unit", () => {
	assert.deepEqual(scalarText("costUsd", null), { text: "Not recorded", tone: "absent" });
	// A local runtime that prices at zero is not a run whose cost was never recorded.
	assert.deepEqual(scalarText("costUsd", 0), { text: "$0.00" });
	assert.deepEqual(scalarText("costUsd", 0.004), { text: "$0.0040" });
	assert.deepEqual(scalarText("wallTimeMs", 61_000), { text: "1m 1s" });
	assert.deepEqual(scalarText("tokens", 1234567), { text: "1,234,567" });
	assert.deepEqual(scalarText("readBytes", 2048), { text: "2,048 bytes" });
	assert.deepEqual(scalarText("tokens", Number.NaN), { text: "Not recorded", tone: "absent" });
	assert.deepEqual(scalarText("verified", true), { text: "Yes", tone: "yes" });
	assert.deepEqual(scalarText("verified", false), { text: "No", tone: "no" });
	assert.deepEqual(scalarText("note", ""), { text: "Empty", tone: "absent" });
	assert.equal(scalarText("runId", "abc").mono, true);
	assert.equal(scalarText("note", "a".repeat(64)).mono, true, "a long hex string reads as a digest");
	assert.equal(scalarText("note", "plain words").mono, undefined);
	assert.match(scalarText("startedAt", "2026-09-20T10:11:12.000Z").text, /^2026-09-20 \d{2}:\d{2}:\d{2}$/);
	assert.equal(scalarText("note", "x".repeat(2000)).text.length, FACT_LIMITS.text);
});

test("named keys lead in the requested order, hidden keys vanish, and the rest keep wire order", () => {
	const { facts } = factsOf(
		{ z: 1, verdict: "grounded", a: 2, secret: "x", claimant: "clio" },
		{ order: ["claimant", "verdict", "missing"], hide: ["secret"] },
	);
	assert.deepEqual(
		facts.map((fact) => fact.label),
		["Claimant", "Verdict", "Z", "A"],
	);
});

test("collections keep their shape, and every bound that drops something says how much", () => {
	const { facts } = factsOf({
		tags: ["a", "b"],
		none: [],
		empty: {},
		nested: { inner: { deep: 1 } },
		runs: [
			{ runId: "r1", ok: true },
			{ runId: "r2", ok: false },
		],
		many: Array.from({ length: FACT_LIMITS.items + 5 }, (_, index) => index),
	});
	const by = new Map(facts.map((fact) => [fact.label, fact]));
	assert.deepEqual(by.get("Tags"), { kind: "list", label: "Tags", items: ["a", "b"], omitted: 0 });
	assert.deepEqual(by.get("None"), { kind: "value", label: "None", text: "None", tone: "absent" });
	assert.deepEqual(by.get("Empty"), { kind: "value", label: "Empty", text: "None", tone: "absent" });
	assert.equal(by.get("Nested")?.kind, "group");
	const runs = by.get("Runs");
	assert.equal(runs?.kind === "rows" && runs.rows.length, 2);
	const many = by.get("Many");
	assert.equal(many?.kind === "list" && many.omitted, 5);

	const wide = factsOf(
		Object.fromEntries(Array.from({ length: FACT_LIMITS.keys + 3 }, (_, index) => [`k${index}`, index])),
	);
	assert.equal(wide.facts.length, FACT_LIMITS.keys);
	assert.equal(wide.omitted, 3);
	assert.equal(omittedSentence(3, "field"), "3 more fields are outside this bounded view.");
	assert.equal(omittedSentence(1, "record"), "1 more record is outside this bounded view.");
	assert.equal(omittedSentence(0, "field"), "");
});

test("depth is bounded, so a hostile or cyclic-looking record cannot hang a page", () => {
	let value: Record<string, unknown> = { leaf: 1 };
	for (let index = 0; index < 12; index++) value = { next: value };
	let cursor = factsOf(value).facts[0];
	let depth = 0;
	while (cursor?.kind === "group") {
		cursor = cursor.facts[0];
		depth++;
	}
	assert.ok(depth <= FACT_LIMITS.depth);
	assert.equal(cursor?.kind === "value" && cursor.text, "1 nested fields");
});
