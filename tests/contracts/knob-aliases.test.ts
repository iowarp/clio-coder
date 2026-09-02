import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { deprecatedFlagMessage } from "../../src/cli/argv.js";
import { GUARDRAIL_DEFAULTS, resetGuardrailAliasWarnings, resolveGuardrail } from "../../src/core/guardrails.js";

/**
 * Every knob with two spellings resolves through the canonical one and says
 * so once. The knob registry (docs/knobs.yaml) lists each alias with verdict
 * `deprecate`; this pins the warning the verdict promises.
 */
describe("deprecated knob spellings", () => {
	it("reads CLIO_CODER_MAX_RUNS behind CLIO_CODER_MAX_DISPATCH_RUNS and warns once per process", () => {
		resetGuardrailAliasWarnings();
		const warnings: string[] = [];
		const warn = (message: string) => warnings.push(message);
		assert.equal(resolveGuardrail("maxDispatchRuns", { CLIO_CODER_MAX_RUNS: "42" }, warn), 42);
		assert.equal(resolveGuardrail("maxDispatchRuns", { CLIO_CODER_MAX_RUNS: "42" }, warn), 42);
		assert.deepEqual(warnings, ["CLIO_CODER_MAX_RUNS is deprecated; use CLIO_CODER_MAX_DISPATCH_RUNS instead"]);

		// The canonical spelling wins silently, and an unset pair falls through to the default.
		resetGuardrailAliasWarnings();
		warnings.length = 0;
		assert.equal(
			resolveGuardrail("maxDispatchRuns", { CLIO_CODER_MAX_RUNS: "42", CLIO_CODER_MAX_DISPATCH_RUNS: "7" }, warn),
			7,
		);
		assert.equal(resolveGuardrail("maxDispatchRuns", {}, warn), GUARDRAIL_DEFAULTS.maxDispatchRuns);
		assert.deepEqual(warnings, []);
	});

	it("parses the worker spellings of the run flags as their agent counterparts with a warning diagnostic", () => {
		const parsed = parseRunCliArgs(["--worker-profile", "code", "--worker-runtime", "llamacpp", "task"]);
		assert.equal(parsed.agentProfile, "code");
		assert.equal(parsed.agentRuntime, "llamacpp");
		assert.deepEqual(
			parsed.diagnostics.map((d) => `${d.type}: ${d.message}`),
			[
				`warning: ${deprecatedFlagMessage("--worker-profile", "--agent-profile")}`,
				`warning: ${deprecatedFlagMessage("--worker-runtime", "--agent-runtime")}`,
			],
		);
		const canonical = parseRunCliArgs(["--agent-profile", "code", "--agent-runtime", "llamacpp", "task"]);
		assert.deepEqual(canonical.diagnostics, []);
	});
});
