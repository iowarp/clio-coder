import { ok } from "node:assert/strict";
import { test } from "node:test";
import { selfCheck } from "../../scripts/report-dataset.js";

test("the dataset exporter's self-check passes over synthetic bundles (R-21)", async () => {
	const passed = await selfCheck();
	ok(passed.length >= 6, passed.join("\n"));
});
