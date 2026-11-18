import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { configureGuardrails, GUARDRAIL_DEFAULTS } from "../../src/core/guardrails.js";
import type { ToolName } from "../../src/core/tool-names.js";
import {
	narrowTurnConstraints,
	snapshotTurnConstraints,
	type TurnConstraints,
	workerTurnConstraints,
} from "../../src/core/turn-constraints.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { expandSubmitText } from "../../src/domains/resources/submit-expansion.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { reserveObservation } from "../../src/tools/observation.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// WTF-P 0.8.3 B4: a template had no way to bound the turn it starts below the
// operator's per-turn limits. Frontmatter `budget: {toolCalls, observationBytes}`
// now lowers both for that turn; the operator's settings stay the cap.

function guardedRegistry(operatorSoft: number) {
	let loopState = createLoopState();
	const guardSafety = {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"];
	const guard = createLoopGuardRegistration({
		safety: guardSafety,
		turnToolCallBudget: () => ({ soft: operatorSoft, hard: operatorSoft + 15 }),
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
	return registry;
}

/** How many calls ran before the first refusal in a turn, and its reason. */
async function firstRefusal(
	operatorSoft: number,
	constraints: TurnConstraints | undefined,
): Promise<{ ran: number; reason: string }> {
	const registry = guardedRegistry(operatorSoft);
	for (let n = 1; n <= operatorSoft + 1; n++) {
		const verdict = await registry.invoke(
			{ tool: "extension_desk__status", args: { n } },
			{ sessionId: "s1", turnId: "t1", ...(constraints ? { turnConstraints: constraints } : {}) },
		);
		if (verdict.kind === "blocked") return { ran: n - 1, reason: verdict.reason };
	}
	return { ran: -1, reason: "" };
}

describe("template budget", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-template-budget-");
		configureGuardrails({});
	});
	afterEach(() => {
		configureGuardrails({});
		env.restore();
	});

	it("loads from frontmatter, refuses invalid values, and rides the turn constraint", async () => {
		const prompts = join(env.dir, "prompts");
		mkdirSync(prompts, { recursive: true });
		writeFileSync(join(prompts, "write.md"), "---\nbudget: {toolCalls: 3, observationBytes: 4096}\n---\nWrite\n");
		writeFileSync(join(prompts, "zero.md"), "---\nbudget: {toolCalls: 0}\n---\nZero\n");
		writeFileSync(join(prompts, "typo.md"), "---\nbudget: {toolcalls: 5}\n---\nTypo\n");
		const loaded = loadPromptTemplates({ roots: [{ path: prompts, scope: "project", trusted: true }] });
		const byName = new Map(loaded.items.map((template) => [template.name, template]));
		deepStrictEqual(byName.get("write")?.budget, { toolCalls: 3, observationBytes: 4096 });
		ok(byName.get("zero")?.unavailable?.includes("budget.toolCalls must be a whole number of at least 1"));
		ok(byName.get("typo")?.unavailable?.includes("budget has unknown keys toolcalls"));

		const resources = {
			parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
			expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, loaded),
		} as unknown as ResourcesContract;
		const constraints = snapshotTurnConstraints((await expandSubmitText("/write", resources, env.dir)).constraints);
		deepStrictEqual(constraints?.budget, { toolCalls: 3, observationBytes: 4096, template: "write" });
		strictEqual(workerTurnConstraints(constraints as TurnConstraints).budget, undefined);
		deepStrictEqual(narrowTurnConstraints({ budget: { toolCalls: 2 } }, constraints)?.budget, {
			toolCalls: 2,
			observationBytes: 4096,
			template: "write",
		});
	});

	it("lowers the turn's tool-call limit and names the template; above the cap it gets the cap", async () => {
		const lowered = await firstRefusal(6, { budget: { toolCalls: 3, template: "desk:write" } });
		strictEqual(lowered.ran, 3);
		ok(lowered.reason.includes('soft budget 3, set by prompt template "desk:write" budget.toolCalls'), lowered.reason);

		const capped = await firstRefusal(6, { budget: { toolCalls: 50, template: "desk:write" } });
		strictEqual(capped.ran, 6);
		// No template ceiling is set, so the operator's limit applies and the refusal says so.
		ok(capped.reason.includes("soft budget 6, safety.limits.chatToolCallsPerTurn;"), capped.reason);

		strictEqual((await firstRefusal(6, undefined)).ran, 6);
	});

	it("lowers the turn's observation pool and names the template; above the cap it gets the cap", () => {
		const turn = (observationBytes: number) => ({
			sessionId: "s1",
			turnId: `t-${observationBytes}`,
			turnConstraints: { budget: { observationBytes, template: "desk:write" } },
		});
		const lowered = reserveObservation(16 * 1024, turn(4096));
		strictEqual(lowered.limitBytes, 4096);
		strictEqual(lowered.callCapBytes, 4096);
		strictEqual(lowered.template, "desk:write");

		const capped = reserveObservation(16 * 1024, turn(10_000_000));
		strictEqual(capped.limitBytes, GUARDRAIL_DEFAULTS.observationTurnBudgetBytes);
		strictEqual(capped.template, undefined);

		configureGuardrails({ observationTurnBudgetBytes: 2048 });
		strictEqual(reserveObservation(16 * 1024, turn(4096)).limitBytes, 2048);
	});
});
