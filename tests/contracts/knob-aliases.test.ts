import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { configureGuardrails, GUARDRAIL_DEFAULTS, resolveGuardrail } from "../../src/core/guardrails.js";
import { createLoopGuardRegistration, type OrchTurnToolCallBudget } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

/**
 * Removed compatibility spellings must not silently regain behavior. The
 * canonical setting or flag remains the only accepted policy surface.
 */
describe("removed knob spellings", () => {
	it("resolves guardrails from the configured settings projection", () => {
		try {
			configureGuardrails({ maxDispatchRuns: 42 });
			assert.equal(resolveGuardrail("maxDispatchRuns"), 42);
		} finally {
			configureGuardrails(undefined);
		}
		assert.equal(resolveGuardrail("maxDispatchRuns"), GUARDRAIL_DEFAULTS.maxDispatchRuns);
	});

	it("reads a changed orchestrator turn budget on the next attempt", () => {
		let budget: OrchTurnToolCallBudget = { soft: 2, hard: 3 };
		const guard = createLoopGuardRegistration({
			safety: createWorkerSafety({ cwd: process.cwd() }),
			turnToolCallBudget: () => budget,
		});
		const attempt = () => guard.evaluate({ hook: "before_tool", toolName: "read", turnId: "turn-1" });
		assert.deepEqual(attempt(), []);
		const firstBlocked = attempt();
		assert.match(firstBlocked[0]?.kind === "block_tool" ? firstBlocked[0].reason : "", /soft budget 2/);
		budget = { soft: 4, hard: 5 };
		assert.deepEqual(attempt(), []);
		const blocked = attempt();
		assert.equal(blocked[0]?.kind, "block_tool");
		assert.match(blocked[0]?.kind === "block_tool" ? blocked[0].reason : "", /soft budget 4/);
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
