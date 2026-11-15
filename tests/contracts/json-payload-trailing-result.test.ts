import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseJsonObjectPayload } from "../../src/core/json-payload.js";

test("a Markdown review that closes with its JSON result yields that result", () => {
	const fencedAfterCode = [
		"## Review",
		"```ts",
		"function f() { return 1; }",
		"```",
		"Result:",
		"```json",
		'{"verdict":"pass","checks":[{"name":"scope","passed":true,"evidence":"plan-01 P2"}]}',
		"```",
	].join("\n");
	deepStrictEqual(parseJsonObjectPayload(fencedAfterCode), {
		ok: true,
		value: { verdict: "pass", checks: [{ name: "scope", passed: true, evidence: "plan-01 P2" }] },
	});
	const bareAfterBraces =
		'The plan keeps `f() {` intact and says "{". Final: {"findings":[{"claim":"a } in a string"}]}';
	deepStrictEqual(parseJsonObjectPayload(bareAfterBraces), {
		ok: true,
		value: { findings: [{ claim: "a } in a string" }] },
	});
	deepStrictEqual(parseJsonObjectPayload("## Review\nAll checks pass."), { ok: false, reason: "not-json" });
});
