import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { SETTINGS_FIELD_NAMES } from "../../src/core/settings-fields.js";
import { copilotContextTierLabel, copilotContextTierOf } from "../../src/domains/providers/index.js";

function settingsWith(target: Record<string, unknown>): unknown {
	return { version: 2, targets: [target] };
}

test("targets[].contextTier round-trips through validateSettings for a copilot-sdk target", () => {
	ok((SETTINGS_FIELD_NAMES as readonly string[]).includes("contextTier"));
	const first = validateSettings(settingsWith({ id: "gh", runtime: "copilot-sdk", contextTier: "long_context" }));
	deepStrictEqual(first.issues, []);
	strictEqual(first.settings.targets[0]?.contextTier, "long_context");
	const second = validateSettings(JSON.parse(JSON.stringify(first.settings)));
	deepStrictEqual(second.issues, []);
	deepStrictEqual(second.settings.targets, first.settings.targets);
	strictEqual(copilotContextTierOf(second.settings.targets[0]), "long_context");
	strictEqual(copilotContextTierLabel(second.settings.targets[0]), "long context");
});

test("an absent contextTier stays absent and means the default tier", () => {
	const result = validateSettings(settingsWith({ id: "gh", runtime: "copilot-sdk" }));
	deepStrictEqual(result.issues, []);
	strictEqual("contextTier" in (result.settings.targets[0] ?? {}), false);
	strictEqual(copilotContextTierOf(result.settings.targets[0]), "default");
	strictEqual(copilotContextTierLabel(result.settings.targets[0]), null);
});

test("contextTier rejects unknown values and non-copilot targets", () => {
	const bad = validateSettings(settingsWith({ id: "gh", runtime: "copilot-sdk", contextTier: "huge" }));
	strictEqual(bad.issues.length, 1);
	strictEqual(bad.issues[0]?.path, "targets[0].contextTier");
	match(bad.issues[0]?.message ?? "", /default \| long_context/);
	const other = validateSettings(settingsWith({ id: "oa", runtime: "openai", contextTier: "long_context" }));
	strictEqual(other.issues.length, 1);
	strictEqual(other.issues[0]?.path, "targets[0].contextTier");
	strictEqual(other.settings.targets[0]?.contextTier, undefined);
});
