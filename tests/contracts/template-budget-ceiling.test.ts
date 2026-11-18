import { ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../../src/core/guardrails.js";
import type { ToolName } from "../../src/core/tool-names.js";
import { turnScopeGuidance } from "../../src/core/turn-constraints.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { reserveObservation } from "../../src/tools/observation.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// WTF-P 0.8.3 B4: /wtfp:advance needs more tool calls than the per-turn
// default while a reviewer template wants fewer. A template budget lowers the
// operator's limit always and raises it only up to the operator's
// `safety.limits.templateToolCallsPerTurnMax` (and the matching byte ceiling);
// unset, a template can only lower.

const OPERATOR = 60;

function ceilings(toolCalls: number | null, observationBytes: number | null = null): void {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.limits.chatToolCallsPerTurn = OPERATOR;
	settings.safety.limits.templateToolCallsPerTurnMax = toolCalls;
	settings.safety.limits.templateObservationBytesPerTurnMax = observationBytes;
	configureGuardrails(guardrailValuesFromSettings(settings));
}

/** The ordinal of the first refused call in a turn under a template's budget, and its reason. */
/** How many calls ran before the first refusal, and its reason. */
async function firstRefusal(templateCalls: number): Promise<{ ran: number; reason: string }> {
	let loopState = createLoopState();
	const guard = createLoopGuardRegistration({
		safety: {
			observeLoop(key: string, now: number) {
				const [next, verdict] = observe(loopState, key, now);
				loopState = next;
				return verdict;
			},
		} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"],
		turnToolCallBudget: () => ({ soft: OPERATOR, hard: OPERATOR + 15 }),
	});
	const registry = createRegistry({
		safety: createWorkerSafety(),
		middleware: createMiddlewareBundle({ registrations: [guard] }).contract,
	});
	registry.register({
		name: "extension_desk__status" as ToolName,
		description: "status fixture",
		parameters: Type.Object({ n: Type.Number() }),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: "fine" }),
	});
	const turnConstraints = { budget: { toolCalls: templateCalls, template: "wtfp:advance" } };
	for (let n = 1; n <= 300; n++) {
		const verdict = await registry.invoke(
			{ tool: "extension_desk__status", args: { n } },
			{ sessionId: "s1", turnId: "t1", turnConstraints },
		);
		if (verdict.kind === "blocked") return { ran: n - 1, reason: verdict.reason };
	}
	return { ran: -1, reason: "" };
}

describe("template budget ceiling", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-template-ceiling-");
	});
	afterEach(() => {
		configureGuardrails(undefined);
		env.restore();
	});

	it("is an operator setting that defaults to unset and refuses a non-positive value", () => {
		strictEqual(DEFAULT_SETTINGS.safety.limits.templateToolCallsPerTurnMax, null);
		strictEqual(DEFAULT_SETTINGS.safety.limits.templateObservationBytesPerTurnMax, null);
		const withLimits = (limits: Record<string, unknown>) =>
			validateSettings({ safety: { limits: { ...DEFAULT_SETTINGS.safety.limits, ...limits } } });
		const parsed = withLimits({ templateToolCallsPerTurnMax: 120, templateObservationBytesPerTurnMax: null });
		strictEqual(parsed.issues.length, 0, JSON.stringify(parsed.issues));
		strictEqual(parsed.settings.safety.limits.templateToolCallsPerTurnMax, 120);
		strictEqual(parsed.settings.safety.limits.templateObservationBytesPerTurnMax, null);
		const zero = withLimits({ templateToolCallsPerTurnMax: 0 });
		ok(zero.issues.some((issue) => JSON.stringify(issue).includes("templateToolCallsPerTurnMax")));
		strictEqual(zero.settings.safety.limits.templateToolCallsPerTurnMax, null);
	});

	it("unset keeps a template budget lower-only", async () => {
		ceilings(null);
		const raised = await firstRefusal(100);
		strictEqual(raised.ran, OPERATOR);
		ok(raised.reason.includes(`soft budget ${OPERATOR}, safety.limits.chatToolCallsPerTurn;`), raised.reason);
		ok(raised.reason.includes("templateToolCallsPerTurnMax is unset"), raised.reason);

		const lowered = await firstRefusal(20);
		strictEqual(lowered.ran, 20);
		ok(lowered.reason.includes('soft budget 20, set by prompt template "wtfp:advance" budget.toolCalls'), lowered.reason);
	});

	it("a ceiling of 120 lets a budget of 100 through, clamps 200 to 120, and lowering still works", async () => {
		ceilings(120);
		const raised = await firstRefusal(100);
		strictEqual(raised.ran, 100);
		ok(raised.reason.includes("raised within safety.limits.templateToolCallsPerTurnMax 120"), raised.reason);

		const clamped = await firstRefusal(200);
		strictEqual(clamped.ran, 120);
		ok(
			clamped.reason.includes(
				'soft budget 120, safety.limits.templateToolCallsPerTurnMax; prompt template "wtfp:advance" asked for 200',
			),
			clamped.reason,
		);

		const lowered = await firstRefusal(20);
		strictEqual(lowered.ran, 20);

		ok(turnScopeGuidance({ budget: { toolCalls: 200, template: "wtfp:advance" } }).includes("at most 120 tool calls"));
	});

	it("applies the same ceiling to the observation pool", () => {
		const turn = (observationBytes: number) => ({
			sessionId: "s1",
			turnId: `t-${observationBytes}`,
			turnConstraints: { budget: { observationBytes, template: "wtfp:advance" } },
		});
		ceilings(null, null);
		strictEqual(
			reserveObservation(16 * 1024, turn(512 * 1024)).limitBytes,
			DEFAULT_SETTINGS.safety.limits.observationBytesPerTurn,
		);
		ceilings(null, 400 * 1024);
		const clamped = reserveObservation(16 * 1024, turn(512 * 1024));
		strictEqual(clamped.limitBytes, 400 * 1024);
		strictEqual(clamped.template, "wtfp:advance");
		strictEqual(reserveObservation(16 * 1024, turn(300 * 1024)).limitBytes, 300 * 1024);
		strictEqual(reserveObservation(16 * 1024, turn(4096)).limitBytes, 4096);
	});
});
