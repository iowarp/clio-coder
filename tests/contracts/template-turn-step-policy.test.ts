import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import type { TelemetryHub } from "../../src/core/telemetry/hub.js";
import type { ToolBudgetExceededPayload } from "../../src/core/telemetry/live-events.js";
import type { ToolName } from "../../src/core/tool-names.js";
import {
	snapshotTurnConstraints,
	type TurnConstraints,
	turnScopeGuidance,
	workerTurnConstraints,
} from "../../src/core/turn-constraints.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../../src/domains/middleware/index.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { expandSubmitText } from "../../src/domains/resources/submit-expansion.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// WTF-P 0.8.3 C5: a desk turn chained every step the driver handed out, so one
// turn grew without bound. `turnPolicy: {mode: step, stepTool}` makes each turn
// run one step: the step tool's second call is refused with the step text, tools
// lock to a text-only round, and the tool-budget lock lets a yolo continuation
// start the next step in a fresh turn.

const STEP = "extension_desk__next_step";

function fixture(extra: MiddlewareHookRegistration[] = []) {
	let loopState = createLoopState();
	const safety = createWorkerSafety();
	const guardSafety = {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"];
	const events: ToolBudgetExceededPayload[] = [];
	const bus = {
		emit(kind: string, payload: unknown) {
			if (kind === "safety.tool_budget_exceeded") events.push(payload as ToolBudgetExceededPayload);
		},
	} as unknown as TelemetryHub;
	const guard = createLoopGuardRegistration({
		safety: guardSafety,
		bus,
		turnToolCallBudget: () => ({ soft: 60, hard: 75 }),
		turnSynthesisLockout: true,
	});
	const middleware = createMiddlewareBundle({ registrations: [guard, ...extra] }).contract;
	const choice = createMiddlewareToolChoiceControl();
	const effects: MiddlewareEffect[] = [];
	const registry = createRegistry({
		safety,
		middleware,
		onMiddlewareEffects: (emitted) => {
			effects.push(...emitted);
			choice.apply(emitted);
		},
	});
	const ran: string[] = [];
	/** While set, a step call waits on it before answering, so a sibling call starts while it is in flight. */
	const hold: { until: Promise<void> | null } = { until: null };
	for (const name of [STEP, "extension_desk__status"]) {
		registry.register({
			name: name as ToolName,
			description: `${name} fixture`,
			parameters: Type.Object({ after: Type.Optional(Type.String()) }),
			baseActionClass: "read",
			run: async (args) => {
				ran.push(`${name}:${String((args as { after?: string }).after ?? "")}`);
				if (name === STEP && hold.until !== null) await hold.until;
				return { kind: "ok", output: `${name} answered ${ran.length}` };
			},
		});
	}
	return { registry, guard, events, effects, choice, ran, hold };
}

describe("template turnPolicy step", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-step-policy-");
	});
	afterEach(() => {
		env.restore();
	});

	it("loads from frontmatter, rides the turn constraint, and stays out of workers", async () => {
		const prompts = join(env.dir, "prompts");
		mkdirSync(prompts, { recursive: true });
		writeFileSync(
			join(prompts, "advance.md"),
			`---\nallowed-tools: [read, ${STEP}]\nturnPolicy: {mode: step, stepTool: ${STEP}}\n---\nAdvance $ARGUMENTS\n`,
		);
		writeFileSync(join(prompts, "bare.md"), "---\nturnPolicy: step\n---\nBare\n");
		writeFileSync(
			join(prompts, "outside.md"),
			`---\nallowed-tools: [read]\nturnPolicy: {mode: step, stepTool: ${STEP}}\n---\nX\n`,
		);
		const loaded = loadPromptTemplates({ roots: [{ path: prompts, scope: "project", trusted: true }] });
		const byName = new Map(loaded.items.map((template) => [template.name, template]));
		deepStrictEqual(byName.get("advance")?.turnPolicy, { mode: "step", stepTool: STEP });
		ok(byName.get("bare")?.unavailable?.includes("turnPolicy must be a mapping that names its step tool"));
		ok(byName.get("outside")?.unavailable?.includes("is not in this template's allowed-tools"));

		const resources = {
			parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
			expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, loaded),
		} as unknown as ResourcesContract;
		const expansion = await expandSubmitText("/advance now", resources, env.dir);
		const constraints = snapshotTurnConstraints(expansion.constraints);
		deepStrictEqual(constraints?.turnPolicy, { mode: "step", stepTool: STEP, template: "advance" });
		ok(turnScopeGuidance(constraints).includes(`Do not call ${STEP} again this turn`));
		strictEqual(workerTurnConstraints(constraints as TurnConstraints).turnPolicy, undefined);
		strictEqual((await expandSubmitText("/bare", resources, env.dir)).promptRefusal?.includes("cannot run"), true);
	});

	it("refuses the second step-tool call with the step text and locks the turn", async () => {
		const { registry, events, effects, choice, ran } = fixture();
		const constraints = snapshotTurnConstraints({
			turnPolicy: { mode: "step", stepTool: STEP, template: "desk:advance" },
		});
		const turn = (turnId: string) => ({
			sessionId: "s1",
			turnId,
			...(constraints ? { turnConstraints: constraints } : {}),
		});
		const call = (tool: string, after: string, turnId = "t1") => registry.invoke({ tool, args: { after } }, turn(turnId));

		strictEqual((await call(STEP, "start")).kind, "ok");
		strictEqual((await call("extension_desk__status", "")).kind, "ok");
		strictEqual(choice.current().kind, "auto");
		const refused = await call(STEP, "plan-section intro");
		strictEqual(refused.kind, "blocked");
		ok(refused.kind === "blocked" && refused.reason.includes('prompt template "desk:advance" runs one step per turn'));
		ok(refused.kind === "blocked" && refused.reason.includes("compact state summary"));
		ok(effects.some((effect) => effect.kind === "lock_tools"));
		strictEqual(choice.current().kind, "none");
		strictEqual(events.length, 1);
		strictEqual(events[0]?.stepTool, STEP);
		strictEqual(events[0]?.template, "desk:advance");
		strictEqual(events[0]?.interrupted, false);
		const after = await call("extension_desk__status", "");
		strictEqual(after.kind, "blocked");
		deepStrictEqual(ran, [`${STEP}:start`, "extension_desk__status:"]);

		// The continuation is a new turn: its first step runs.
		strictEqual((await call(STEP, "plan-section intro", "t2")).kind, "ok");
	});

	it("refuses a second step-tool call in the same parallel batch while the first is in flight", async () => {
		const { registry, ran, hold } = fixture();
		const constraints = snapshotTurnConstraints({
			turnPolicy: { mode: "step", stepTool: STEP, template: "desk:advance" },
		});
		let release = () => {};
		hold.until = new Promise<void>((resolve) => {
			release = resolve;
		});
		const batch = (toolCallId: string, correlationId = "assistant-1") => ({
			sessionId: "s1",
			turnId: "t1",
			toolCallId,
			correlationId,
			...(constraints ? { turnConstraints: constraints } : {}),
		});
		const first = registry.invoke({ tool: STEP, args: { after: "start" } }, batch("call-1"));
		const sibling = registry.invoke({ tool: STEP, args: { after: "start" } }, batch("call-2"));
		// Both calls are past admission or refused by now; the first is still waiting on its body.
		await new Promise((resolve) => setImmediate(resolve));
		release();
		const [ran1, second] = await Promise.all([first, sibling]);
		strictEqual(ran1.kind, "ok");
		strictEqual(second.kind, "blocked");
		ok(second.kind === "blocked" && second.reason.includes("is already running, so this call did not run"));
		deepStrictEqual(ran, [`${STEP}:start`]);
		hold.until = null;

		// A step call that failed leaves the turn's step open for a retry in the next batch.
		const failing = fixture();
		failing.registry.register({
			name: "extension_desk__broken_step" as ToolName,
			description: "fails",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "error", message: "desk offline" }),
		});
		const brokenConstraints = snapshotTurnConstraints({
			turnPolicy: { mode: "step", stepTool: "extension_desk__broken_step", template: "desk:advance" },
		});
		const call = (toolCallId: string, correlationId: string) =>
			failing.registry.invoke(
				{ tool: "extension_desk__broken_step", args: {} },
				{
					sessionId: "s1",
					turnId: "t1",
					toolCallId,
					correlationId,
					...(brokenConstraints ? { turnConstraints: brokenConstraints } : {}),
				},
			);
		const failed = await call("call-1", "assistant-1");
		ok(failed.kind === "ok" && failed.result.kind === "error", JSON.stringify(failed));
		strictEqual((await call("call-2", "assistant-2")).kind, "ok");
	});

	it("judges a hook-rewritten step call again as the same call, not its own sibling", async () => {
		// Astra r2-3: the registry rejudges the rewritten arguments with the same call id and batch.
		const rewriter: MiddlewareHookRegistration = {
			id: "extension:desk:before_tool:0",
			description: "adds an optional argument",
			hooks: ["before_tool"],
			awaited: true,
			evaluate: () => [],
			evaluateAsync: async () => [
				{ kind: "rewrite_tool_input", args: { after: "rewritten" }, reason: "default", source: "desk" },
			],
		};
		const { registry, guard, ran } = fixture([rewriter]);
		const constraints = snapshotTurnConstraints({
			turnPolicy: { mode: "step", stepTool: STEP, template: "desk:advance" },
		});
		const options = (toolCallId: string) => ({
			sessionId: "s1",
			turnId: "t1",
			toolCallId,
			correlationId: "assistant-1",
			...(constraints ? { turnConstraints: constraints } : {}),
		});
		const verdict = await registry.invoke({ tool: STEP, args: {} }, options("call-1"));
		strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
		deepStrictEqual(ran, [`${STEP}:rewritten`]);
		strictEqual(guard.callCount(), 1);
	});

	it("leaves chaining unchanged without a turn policy", async () => {
		const { registry, events, effects } = fixture();
		const options = { sessionId: "s1", turnId: "t1" };
		strictEqual((await registry.invoke({ tool: STEP, args: { after: "start" } }, options)).kind, "ok");
		strictEqual((await registry.invoke({ tool: STEP, args: { after: "one" } }, options)).kind, "ok");
		strictEqual((await registry.invoke({ tool: STEP, args: { after: "two" } }, options)).kind, "ok");
		strictEqual(events.length, 0);
		ok(!effects.some((effect) => effect.kind === "lock_tools"));
	});
});
