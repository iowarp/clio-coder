import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { findingAction, healthGroups } from "../client/pages/system-model.js";
import { SystemReport } from "../contracts/system.js";

const report = {
	checkedAt: "2026-09-26T12:00:00Z",
	paths: { config: "/config", data: "/data", state: "/state", cache: "/cache" },
	findings: [
		{ name: "platform", ok: true, level: "ok" as const, detail: "linux", detailRedacted: false },
		{ name: "installation", ok: true, level: "warn" as const, detail: "Not set up yet", detailRedacted: false },
		{ name: "credentials", ok: false, level: "error" as const, detail: "Withheld", detailRedacted: true },
		{ name: "optional", ok: true, level: "info" as const, detail: "Not required", detailRedacted: false },
	],
};

test("doctor severity orders actionable groups and preserves informational observations", () => {
	assert.equal(Value.Check(SystemReport, report), true);
	assert.deepEqual(
		healthGroups(report.findings).map((group) => group.level),
		["error", "warn", "info", "ok"],
	);
	assert.deepEqual(
		healthGroups(report.findings, "", true).map((group) => group.level),
		["error", "warn"],
	);
	assert.deepEqual(
		healthGroups(report.findings, "WITHHELD").map((group) => group.findings[0]?.name),
		["credentials"],
	);
	assert.equal(healthGroups(report.findings, "missing").length, 0);
});

test("a diagnostic offers supported inspection links without claiming a repair action", () => {
	assert.deepEqual(findingAction({ name: "settings.yaml", level: "error" }), {
		label: "Inspect settings sources",
		path: "/settings/effective",
	});
	assert.equal(findingAction({ name: "credentials", level: "error" }), null);
	assert.equal(findingAction({ name: "engine runtime", level: "error" }), null);
	assert.equal(findingAction({ name: "settings.yaml", level: "ok" }), null);
});
