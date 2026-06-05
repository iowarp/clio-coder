import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { admit } from "../../src/domains/dispatch/admission.js";
import { createBackoff, nextDelay, reset } from "../../src/domains/dispatch/backoff.js";
import { createBatch, isBatchDone, onRunComplete, snapshotBatch } from "../../src/domains/dispatch/batch-tracker.js";
import { deriveRequestedActions, pickOrchestratorScope } from "../../src/domains/dispatch/extension.js";
import { classifyHeartbeat } from "../../src/domains/dispatch/heartbeat.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { ADVISE_SCOPE, DEFAULT_SCOPE, isSubset, READONLY_SCOPE } from "../../src/domains/safety/scope.js";

describe("dispatch/validation", () => {
	it("accepts minimal spec", () => {
		const v = validateJobSpec({ agentId: "coder", task: "fix bug" });
		ok(v.ok);
		strictEqual(v.spec.agentId, "coder");
		strictEqual(v.spec.task, "fix bug");
	});

	it("rejects non-object", () => {
		const v = validateJobSpec("not an object");
		strictEqual(v.ok, false);
	});

	it("rejects missing agentId", () => {
		const v = validateJobSpec({ task: "t" });
		strictEqual(v.ok, false);
	});

	it("rejects unknown keys", () => {
		const v = validateJobSpec({ agentId: "a", task: "t", mystery: 1 });
		strictEqual(v.ok, false);
		if (!v.ok) ok(v.errors.some((e) => e.includes("unknown key")));
	});

	it("rejects the legacy 'runtime' field as an unknown key (W7 dropped it)", () => {
		const v = validateJobSpec({ agentId: "a", task: "t", runtime: "native" });
		strictEqual(v.ok, false);
		if (!v.ok) ok(v.errors.some((e) => e.includes("unknown key")));
	});

	it("accepts endpoint + model as the post-W7 way to target a runtime", () => {
		const v = validateJobSpec({ agentId: "a", task: "t", endpoint: "anthropic", model: "claude-sonnet-4-6" });
		ok(v.ok);
	});

	it("accepts a named worker profile selector", () => {
		const v = validateJobSpec({ agentId: "a", task: "t", workerProfile: "claude-opus" });
		ok(v.ok);
		strictEqual(v.spec.workerProfile, "claude-opus");
	});

	it("accepts a worker runtime selector without reintroducing the legacy runtime key", () => {
		const v = validateJobSpec({ agentId: "a", task: "t", workerRuntime: "copilot-cli" });
		ok(v.ok);
		strictEqual(v.spec.workerRuntime, "copilot-cli");
	});

	it("accepts shipped tool profiles and rejects unknown profiles", () => {
		const v = validateJobSpec({ agentId: "a", task: "t", toolProfile: "science-local" });
		ok(v.ok);
		strictEqual(v.spec.toolProfile, "science-local");

		const invalid = validateJobSpec({ agentId: "a", task: "t", toolProfile: "unknown-profile" });
		strictEqual(invalid.ok, false);
		if (!invalid.ok) ok(invalid.errors.some((e) => e.includes("toolProfile")));
	});

	it("accepts supervised booleans and rejects other values", () => {
		for (const supervised of [true, false]) {
			const v = validateJobSpec({ agentId: "a", task: "t", supervised });
			ok(v.ok);
			strictEqual(v.spec.supervised, supervised);
		}

		const invalid = validateJobSpec({ agentId: "a", task: "t", supervised: "x" });
		strictEqual(invalid.ok, false);
		if (!invalid.ok) ok(invalid.errors.some((e) => e.includes("supervised")));
	});

	it("accepts allow or deny autoApprove values and rejects others", () => {
		for (const autoApprove of ["allow", "deny"] as const) {
			const v = validateJobSpec({ agentId: "a", task: "t", autoApprove });
			ok(v.ok);
			strictEqual(v.spec.autoApprove, autoApprove);
		}

		const invalid = validateJobSpec({ agentId: "a", task: "t", autoApprove: "maybe" });
		strictEqual(invalid.ok, false);
		if (!invalid.ok) ok(invalid.errors.some((e) => e.includes("autoApprove")));
	});
});

describe("dispatch/admission", () => {
	it("admits when scope is subset and actions allowed", () => {
		const verdict = admit(
			{
				requestedScope: READONLY_SCOPE,
				orchestratorScope: DEFAULT_SCOPE,
				requestedActions: ["read"],
				agentId: "spotter",
			},
			isSubset,
		);
		strictEqual(verdict.admitted, true);
	});

	it("rejects when requested action missing from requested scope", () => {
		const verdict = admit(
			{
				requestedScope: READONLY_SCOPE,
				orchestratorScope: DEFAULT_SCOPE,
				requestedActions: ["write"],
				agentId: "spotter",
			},
			isSubset,
		);
		strictEqual(verdict.admitted, false);
	});

	it("rejects when scope escalates above orchestrator", () => {
		const verdict = admit(
			{
				requestedScope: DEFAULT_SCOPE,
				orchestratorScope: READONLY_SCOPE,
				requestedActions: ["read"],
				agentId: "escalator",
			},
			isSubset,
		);
		strictEqual(verdict.admitted, false);
	});

	it("derives requested actions from the worker tool surface", () => {
		const safety = {
			classify: (call: { tool: string }) => classify(call),
		} as never;
		deepStrictEqual(deriveRequestedActions([ToolNames.Read, ToolNames.Write, ToolNames.Bash], safety), [
			"execute",
			"read",
			"write",
		]);
		deepStrictEqual(deriveRequestedActions([ToolNames.Read, "mystery" as never], safety), ["read", "unknown"]);
	});

	it("honors mode dispatchScope when picking the orchestrator scope", () => {
		const safety = {
			scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, advise: ADVISE_SCOPE, super: DEFAULT_SCOPE },
		} as never;
		strictEqual(pickOrchestratorScope(safety, "advise"), READONLY_SCOPE);
		strictEqual(pickOrchestratorScope(safety, "default"), DEFAULT_SCOPE);
	});

	it("admits advise worker writers under a default orchestrator without granting execute or dispatch", () => {
		const verdict = admit(
			{
				requestedScope: ADVISE_SCOPE,
				orchestratorScope: DEFAULT_SCOPE,
				requestedActions: ["read", "write"],
				agentId: "planner",
			},
			isSubset,
		);
		strictEqual(verdict.admitted, true);
		strictEqual(ADVISE_SCOPE.allowedActions.has("execute"), false);
		strictEqual(ADVISE_SCOPE.allowedActions.has("dispatch"), false);
		strictEqual(ADVISE_SCOPE.allowDispatch, false);
	});

	it("advise dispatch scope denies default worker recipes that expose write or bash", () => {
		const writeVerdict = admit(
			{
				requestedScope: DEFAULT_SCOPE,
				orchestratorScope: READONLY_SCOPE,
				requestedActions: ["read", "write"],
				agentId: "worker",
			},
			isSubset,
		);
		strictEqual(writeVerdict.admitted, false);

		const bashVerdict = admit(
			{
				requestedScope: DEFAULT_SCOPE,
				orchestratorScope: READONLY_SCOPE,
				requestedActions: ["execute", "read"],
				agentId: "worker",
			},
			isSubset,
		);
		strictEqual(bashVerdict.admitted, false);
	});
});

describe("dispatch/backoff", () => {
	it("starts at base delay", () => {
		const state = createBackoff({ baseMs: 100, maxMs: 1000, factor: 2 });
		const { delayMs } = nextDelay(state, { baseMs: 100, maxMs: 1000, factor: 2 });
		strictEqual(delayMs, 100);
	});

	it("grows geometrically and clamps to maxMs", () => {
		const opts = { baseMs: 100, maxMs: 500, factor: 2 };
		let state = createBackoff(opts);
		const delays: number[] = [];
		for (let i = 0; i < 6; i++) {
			const { state: next, delayMs } = nextDelay(state, opts);
			delays.push(delayMs);
			state = next;
		}
		ok(delays[0] === 100);
		ok(delays[delays.length - 1] === 500);
		strictEqual(state.attempts, 6);
	});

	it("reset returns state at base", () => {
		const state = reset({ baseMs: 50 });
		strictEqual(state.attempts, 0);
		strictEqual(state.nextDelayMs, 50);
	});
});

describe("dispatch/batch-tracker", () => {
	it("tracks completed and failed runs without mutating prior state", () => {
		const initial = createBatch(["run-a", "run-b"]);
		const afterA = onRunComplete(initial, "run-a", false);
		const afterB = onRunComplete(afterA, "run-b", true);

		strictEqual(isBatchDone(initial), false);
		strictEqual(isBatchDone(afterA), false);
		strictEqual(isBatchDone(afterB), true);
		deepStrictEqual(snapshotBatch(afterB).completed, ["run-a"]);
		deepStrictEqual(snapshotBatch(afterB).failed, ["run-b"]);
		deepStrictEqual(snapshotBatch(initial).completed, []);
	});
});

describe("dispatch/heartbeat", () => {
	it("classifies heartbeats across alive, stale, and dead windows", () => {
		const spec = { windowMs: 1000, graceMs: 2000 };
		strictEqual(classifyHeartbeat(10_000, 11_000, spec), "alive");
		strictEqual(classifyHeartbeat(10_000, 11_001, spec), "stale");
		strictEqual(classifyHeartbeat(10_000, 13_000, spec), "stale");
		strictEqual(classifyHeartbeat(10_000, 13_001, spec), "dead");
	});
});
