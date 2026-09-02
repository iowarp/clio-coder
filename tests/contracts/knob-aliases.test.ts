import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { configureGuardrails, GUARDRAIL_DEFAULTS, resolveGuardrail } from "../../src/core/guardrails.js";

/**
 * Removed compatibility spellings must not silently regain behavior. The
 * canonical setting or flag remains the only accepted policy surface.
 */
describe("removed knob spellings", () => {
	it("ignores CLIO_CODER_MAX_RUNS while the canonical guardrail variable still resolves", () => {
		configureGuardrails(undefined);
		assert.equal(resolveGuardrail("maxDispatchRuns", { CLIO_CODER_MAX_RUNS: "42" }), GUARDRAIL_DEFAULTS.maxDispatchRuns);
		assert.equal(resolveGuardrail("maxDispatchRuns", { CLIO_CODER_MAX_DISPATCH_RUNS: "7" }), 7);
	});

	it("rejects removed run aliases and accepts the canonical agent flags", () => {
		for (const alias of ["--worker", "--worker-profile", "--worker-runtime", "--runtime"]) {
			const parsed = parseRunCliArgs([alias, "value", "task"]);
			assert.deepEqual(parsed.diagnostics, [{ type: "error", message: `unknown clio-coder run option: ${alias}` }]);
		}
		const canonical = parseRunCliArgs(["--agent-profile", "code", "--agent-runtime", "llamacpp", "task"]);
		assert.deepEqual(canonical.diagnostics, []);
	});
});
