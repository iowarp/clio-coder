import assert from "node:assert/strict";
import { test } from "node:test";
import { provenanceFacts } from "../client/pages/traces/trace-model.js";

const version = (receipt: Record<string, unknown>) =>
	provenanceFacts(receipt).find(([key]) => key === "clioCoderVersion")?.[1];

test("the provenance panel shows the version a current receipt records", () => {
	// Receipts write `clioCoderVersion`; the panel read `clioVersion` and the row silently vanished.
	assert.equal(version({ clioCoderVersion: "0.5.6", platform: "linux" }), "0.5.6");
});

test("a receipt sealed before the rename still shows its version", () => {
	assert.equal(version({ clioVersion: "0.4.7" }), "0.4.7");
	assert.equal(version({ clioCoderVersion: "0.5.6", clioVersion: "0.4.7" }), "0.5.6");
});

test("provenance keeps its display order and names no legacy key", () => {
	const keys = provenanceFacts({}).map(([key]) => key);
	assert.deepEqual(keys, [
		"clioCoderVersion",
		"platform",
		"nodeVersion",
		"runtimeKind",
		"skillActivations",
		"integrity",
		"lineage",
		"node",
		"gate",
		"plan",
		"pipeline",
		"reroutes",
	]);
});
