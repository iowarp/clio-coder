import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { admit } from "../../src/domains/dispatch/admission.js";
import { createBackoff, nextDelay, reset } from "../../src/domains/dispatch/backoff.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, isSubset } from "../../src/domains/safety/scope.js";

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
