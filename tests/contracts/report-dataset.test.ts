import { match, ok } from "node:assert/strict";
import { test } from "node:test";
import { selfCheck, shiftedMintedId } from "../../scripts/report-dataset.js";

test("the dataset exporter's self-check passes over synthetic bundles (R-21)", async () => {
	const passed = await selfCheck();
	ok(passed.length >= 6, passed.join("\n"));
});

test("a run id shaped like a compact UTC time that is no real time is re-minted opaque, never thrown on", () => {
	match(shiftedMintedId("run-20261301T120000Z-abcdef", 1000) ?? "", /^run-[0-9a-f]{16}$/u);
	match(shiftedMintedId("20260101T120061Z-abcdef", 1000) ?? "", /^[0-9a-f]{16}$/u);
});
