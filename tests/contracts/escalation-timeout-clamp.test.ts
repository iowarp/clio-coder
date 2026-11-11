import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { validateSettings } from "../../src/core/config.js";

const withTimeout = (timeoutMs: unknown) => ({ fleet: { permissions: { escalation: { timeoutMs } } } });

it("an out-of-range fleet.permissions.escalation.timeoutMs clamps to the valid range instead of failing", () => {
	const low = validateSettings(withTimeout(0));
	deepStrictEqual(low.issues, []);
	strictEqual(low.settings.fleet.permissions.escalation.timeoutMs, 1);

	const high = validateSettings(withTimeout(2 ** 40));
	deepStrictEqual(high.issues, []);
	strictEqual(high.settings.fleet.permissions.escalation.timeoutMs, 2 ** 31 - 1);
});

it("a non-integer fleet.permissions.escalation.timeoutMs is still rejected", () => {
	const result = validateSettings(withTimeout("soon"));
	ok(result.issues.some((issue) => issue.path === "fleet.permissions.escalation.timeoutMs"));
});
