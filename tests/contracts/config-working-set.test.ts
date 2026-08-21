import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { diffSettings } from "../../src/domains/config/classify.js";

describe("contracts/context working-set settings", () => {
	it("accepts the complete strict block and applies changes next turn", () => {
		const result = validateSettings({
			context: {
				workingSet: {
					enabled: false,
					policy: "structural-v1",
					target: 0.55,
					protectLastTurns: 3,
					minEvictableTokens: 0,
				},
			},
		});

		deepStrictEqual(result.issues, []);
		deepStrictEqual(result.settings.context.workingSet, {
			enabled: false,
			policy: "structural-v1",
			target: 0.55,
			protectLastTurns: 3,
			minEvictableTokens: 0,
		});
		deepStrictEqual(diffSettings(DEFAULT_SETTINGS, result.settings).nextTurn.sort(), [
			"context.workingSet.enabled",
			"context.workingSet.minEvictableTokens",
			"context.workingSet.policy",
			"context.workingSet.protectLastTurns",
			"context.workingSet.target",
		]);
	});

	it("rejects unknown keys, invalid enums, open-interval endpoints, and integer range violations", () => {
		const result = validateSettings({
			context: {
				extra: true,
				workingSet: {
					enabled: "yes",
					policy: "newest",
					target: 1,
					protectLastTurns: 0,
					minEvictableTokens: -1,
					unknown: true,
				},
			},
		});

		deepStrictEqual(result.issues.map((issue) => issue.path).sort(), [
			"context.extra",
			"context.workingSet.enabled",
			"context.workingSet.minEvictableTokens",
			"context.workingSet.policy",
			"context.workingSet.protectLastTurns",
			"context.workingSet.target",
			"context.workingSet.unknown",
		]);
		deepStrictEqual(result.settings.context.workingSet, DEFAULT_SETTINGS.context.workingSet);
	});

	it("requires context and workingSet to be maps and target to stay strictly between zero and one", () => {
		const badContext = validateSettings({ context: false });
		deepStrictEqual(
			badContext.issues.map((issue) => issue.path),
			["context"],
		);

		const badWorkingSet = validateSettings({ context: { workingSet: [] } });
		deepStrictEqual(
			badWorkingSet.issues.map((issue) => issue.path),
			["context.workingSet"],
		);

		for (const target of [0, 1]) {
			const result = validateSettings({ context: { workingSet: { target } } });
			strictEqual(result.issues[0]?.path, "context.workingSet.target");
			strictEqual(result.settings.context.workingSet.target, DEFAULT_SETTINGS.context.workingSet.target);
		}
	});
});
