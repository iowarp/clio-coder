import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { TURN_CONTINUATION_CAP } from "../../src/core/job-types.js";
import type { ModelTier } from "../../src/core/model-tier.js";
import type { ToolName } from "../../src/core/tool-names.js";
import { type TurnConstraints, turnScopeGuidance } from "../../src/core/turn-constraints.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareContract } from "../../src/domains/middleware/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { expandSubmitText } from "../../src/domains/resources/submit-expansion.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// WTF-P 0.8.3 C5: `turnPolicy: step` ended every turn after one step on every
// route, though only a small or uncached route saves context by it. `when`
// scopes the policy to routes; on any other route the turn runs with no step
// policy at all, judged afresh at each turn's start.

const STEP = "extension_wtfp__next_step";

interface Route {
	model: string;
	tier: ModelTier;
	uncached?: boolean;
}

interface Run {
	/** Per model request: the turn's constraints, its submitted text, and each step call's verdict. */
	turns: { constraints: TurnConstraints | undefined; text: string; verdicts: string[] }[];
	continued: string[];
	/** Loop-guard blocks and step-policy refusals the run raised. */
	guardEvents: string[];
	close(): Promise<void>;
}

/** A step tool with `stages` stages that says pipelineDone on the last, and how many step calls each turn makes. */
interface Pipeline {
	calls: number;
	stages?: number;
}

/**
 * One session on `route` that submits a template turn with `policy`. Each model
 * request calls the step tool twice through a real registry and loop guard on
 * the session bus, under the constraints the chat loop holds for that turn.
 * `switchTo` moves the session to another route during the first request.
 */
async function drive(
	route: Route,
	policy: NonNullable<TurnConstraints["turnPolicy"]>,
	switchTo?: Route,
	pipeline?: Pipeline,
): Promise<Run> {
	const scratch = await isolateClioEnv("clio-coder-step-when-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const routes = [route, ...(switchTo ? [switchTo] : [])];
	settings.targets = routes.map((entry) => ({
		id: `route-${entry.model}`,
		runtime: "openai" as const,
		defaultModel: entry.model,
		...(entry.uncached === true ? { cache: { retention: "none" as const } } : {}),
	}));
	const context = dispatchStubContext({ settings });
	settings.chat.target = `route-${route.model}`;
	settings.chat.model = route.model;
	const providers = {
		...(context.getContract("providers") as ProvidersContract),
		modelTierOverride: (id: string) => routes.find((entry) => entry.model === id)?.tier ?? null,
	} as ProvidersContract;
	const entries: SessionEntry[] = [];
	let leaf: string | null = null;
	const session = {
		current: () => ({ id: "when-session", cwd: scratch.dir, cwdHash: "when-repo" }),
		tree: () => ({ leafId: leaf }),
		leafId: () => leaf,
		append(turn: TurnInput) {
			const id = turn.id ?? `turn-${entries.length + 1}`;
			leaf = id;
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: new Date().toISOString(),
				role: turn.kind,
				payload: turn.payload,
			} as SessionEntry);
			return { id };
		},
		appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
			const row = { ...entry, turnId: entry.turnId ?? `entry-${entries.length + 1}` } as SessionEntry;
			entries.push(row);
			return row;
		},
	} as unknown as SessionContract;
	const continued: string[] = [];
	context.bus.subscribe("turn.continued", (payload) => {
		continued.push((payload as { cause: string }).cause);
	});
	const guardEvents: string[] = [];
	for (const channel of ["safety.loop_blocked", "safety.tool_budget_exceeded"] as const)
		context.bus.subscribe(channel, () => {
			guardEvents.push(channel);
		});

	let loopState = createLoopState();
	const guard = createLoopGuardRegistration({
		safety: {
			observeLoop(key: string, now: number) {
				const [next, verdict] = observe(loopState, key, now);
				loopState = next;
				return verdict;
			},
		} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"],
		bus: context.bus,
		turnToolCallBudget: () => ({ soft: 60, hard: 75 }),
		turnSynthesisLockout: true,
	});
	let stage = 0;
	const registry = createRegistry({
		safety: createWorkerSafety(),
		middleware: createMiddlewareBundle({ registrations: [guard] }).contract,
	});
	registry.register({
		name: STEP as ToolName,
		description: "step fixture",
		parameters: Type.Object({ after: Type.Optional(Type.String()) }),
		baseActionClass: "read",
		run: async () => {
			stage += 1;
			return pipeline?.stages !== undefined && stage >= pipeline.stages
				? { kind: "ok", output: `stage ${stage}: pipeline complete`, details: { pipelineDone: true } }
				: { kind: "ok", output: "step: draft the intro" };
		},
	});

	const middleware: MiddlewareContract = {
		runHook: (input) => ({ hook: input.hook, input, effects: [], ruleIds: [] }),
		snapshot: () => ({ version: 1, rules: [] }),
	};
	const turns: Run["turns"] = [];
	let loop: ReturnType<typeof createChatLoop> | null = null;
	loop = createChatLoop({
		getSettings: () => settings,
		getAutonomy: () => "yolo",
		providers,
		knownTargets: () => new Set(routes.map((entry) => `route-${entry.model}`)),
		session,
		bus: context.bus,
		readSessionEntries: () => entries,
		middleware,
		createAgent: ((agentOptions: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...agentOptions?.initialState, messages: [] as AgentMessage[] };
			return {
				requestCorrelationId: () => undefined,
				agent: {
					state,
					subscribe: (next: typeof listener) => {
						listener = next;
						return () => {};
					},
					abort() {},
					clearAllQueues() {},
					async continue() {
						throw new Error("the fixture never retries");
					},
					async prompt(text: string) {
						const constraints = loop?.currentTurnConstraints?.();
						const turnId = `t${turns.length + 1}`;
						const verdicts: string[] = [];
						turns.push({ constraints, text, verdicts });
						state.messages.push({
							role: "user",
							content: [{ type: "text", text }],
							timestamp: Date.now(),
						} as unknown as AgentMessage);
						await listener({ type: "agent_start" });
						await listener({ type: "turn_start" });
						// Later turns run no step, so the chain ends there, except the switched route's turn,
						// which shows whether a second call is refused.
						const steps =
							pipeline !== undefined
								? Array.from({ length: pipeline.calls }, () => `stage-${turns.length}`)
								: turns.length === 1 || (switchTo !== undefined && turns.length === 2)
									? ["start", "intro-done"]
									: [];
						for (const [index, after] of steps.entries()) {
							const id = `${turnId}-call-${index}`;
							const result = await registry.invoke(
								{ tool: STEP, args: { after } },
								{ sessionId: "when-session", turnId, ...(constraints ? { turnConstraints: constraints } : {}) },
							);
							verdicts.push(result.kind);
							// The engine's tool round: the call, then its result with the tool's details.
							state.messages.push(
								{
									role: "assistant",
									content: [{ type: "toolCall", id, name: STEP, arguments: { after } }],
									stopReason: "toolUse",
									timestamp: Date.now(),
								} as unknown as AgentMessage,
								{
									role: "toolResult",
									toolCallId: id,
									toolName: STEP,
									content: [
										{
											type: "text",
											text: result.kind === "ok" && result.result.kind === "ok" ? result.result.output : "refused",
										},
									],
									...(result.kind === "ok" && result.result.details !== undefined ? { details: result.result.details } : {}),
									isError: result.kind !== "ok",
									timestamp: Date.now(),
								} as unknown as AgentMessage,
							);
						}
						if (switchTo !== undefined && turns.length === 1) {
							settings.chat.target = `route-${switchTo.model}`;
							settings.chat.model = switchTo.model;
						}
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "Step ran; after=intro-done." }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						state.messages.push(message);
						await listener({ type: "message_end", message });
						await listener({ type: "agent_end", messages: [message] });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	await loop.submit("Advance the paper one step.", {
		constraints: { turnPolicy: { ...policy, template: "wtfp:advance" } },
		display: { text: "/wtfp:advance" },
	});
	await loop.whenSettled();
	return {
		turns,
		continued,
		guardEvents,
		close: async () => {
			loop?.dispose();
			await loop?.whenSettled();
			scratch.restore();
		},
	};
}

const SMALL_ONLY = { mode: "step" as const, stepTool: STEP, when: ["small" as const] };

describe("template turnPolicy when", () => {
	it("parses when from frontmatter and makes a malformed when unavailable", async () => {
		const scratch = await isolateClioEnv("clio-coder-step-when-load-");
		try {
			const prompts = join(scratch.dir, "prompts");
			mkdirSync(prompts, { recursive: true });
			const write = (name: string, when: string) =>
				writeFileSync(
					join(prompts, `${name}.md`),
					`---\nallowed-tools: [read, ${STEP}]\nturnPolicy: {mode: step, stepTool: ${STEP}, when: ${when}}\n---\nAdvance\n`,
				);
			write("advance", "[small, uncached]");
			write("unknown", "[small, tiny]");
			write("empty", "[]");
			write("twice", "[small, small]");
			write("scalar", "small");
			const loaded = loadPromptTemplates({ roots: [{ path: prompts, scope: "project", trusted: true }] });
			const byName = new Map(loaded.items.map((template) => [template.name, template]));
			deepStrictEqual(byName.get("advance")?.turnPolicy, { mode: "step", stepTool: STEP, when: ["small", "uncached"] });
			ok(byName.get("unknown")?.unavailable?.includes("turnPolicy.when has unknown token tiny"));
			ok(byName.get("empty")?.unavailable?.includes("turnPolicy.when must be a non-empty list"));
			ok(byName.get("twice")?.unavailable?.includes("turnPolicy.when names small twice"));
			ok(byName.get("scalar")?.unavailable?.includes("turnPolicy.when must be a non-empty list"));
			const resources = {
				parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
				expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, loaded),
			} as unknown as ResourcesContract;
			const expansion = await expandSubmitText("/advance", resources, scratch.dir);
			deepStrictEqual(expansion.constraints?.turnPolicy?.when, ["small", "uncached"]);
		} finally {
			scratch.restore();
		}
	});

	it("when: [small] on a frontier route runs with no step policy: no refusal, no lock, no continuation", async () => {
		const run = await drive({ model: "when-frontier-model", tier: "frontier" }, SMALL_ONLY);
		try {
			strictEqual(run.turns.length, 1);
			deepStrictEqual(run.turns[0]?.verdicts, ["ok", "ok"]);
			strictEqual(run.turns[0]?.constraints?.turnPolicy, undefined);
			strictEqual(run.turns[0]?.constraints?.dormantTurnPolicy?.stepTool, STEP);
			ok(run.turns[0]?.text.includes("does not apply on this route"), run.turns[0]?.text);
			ok(!run.turns[0]?.text.includes("One step per turn"), run.turns[0]?.text);
			deepStrictEqual(run.continued, []);
		} finally {
			await run.close();
		}
	});

	it("when: [small] on a small route locks after the step and continues into the next step turn", async () => {
		const run = await drive({ model: "when-small-model", tier: "small" }, SMALL_ONLY);
		try {
			strictEqual(run.turns.length, 2);
			deepStrictEqual(run.turns[0]?.verdicts, ["ok", "blocked"]);
			strictEqual(run.turns[0]?.constraints?.turnPolicy?.stepTool, STEP);
			ok(run.turns[0]?.text.includes("This step policy applies on this route (when: small)."), run.turns[0]?.text);
			strictEqual(run.continued[0], "tool_budget");
		} finally {
			await run.close();
		}
	});

	it("when: [uncached] keys on prompt caching, not on the tier", async () => {
		const policy = { mode: "step" as const, stepTool: STEP, when: ["uncached" as const] };
		const uncached = await drive({ model: "when-uncached-model", tier: "frontier", uncached: true }, policy);
		try {
			deepStrictEqual(uncached.turns[0]?.verdicts, ["ok", "blocked"]);
		} finally {
			await uncached.close();
		}
		const cached = await drive({ model: "when-cached-small-model", tier: "small" }, policy);
		try {
			deepStrictEqual(cached.turns[0]?.verdicts, ["ok", "ok"]);
			strictEqual(cached.turns.length, 1);
		} finally {
			await cached.close();
		}
	});

	it("a yolo step continuation judges the route it starts on, so a model switch takes effect on the next turn", async () => {
		const run = await drive({ model: "when-switch-small", tier: "small" }, SMALL_ONLY, {
			model: "when-switch-frontier",
			tier: "frontier",
		});
		try {
			strictEqual(run.turns.length, 2);
			deepStrictEqual(run.turns[0]?.verdicts, ["ok", "blocked"]);
			strictEqual(run.turns[1]?.constraints?.turnPolicy, undefined);
			deepStrictEqual(run.turns[1]?.verdicts, ["ok", "ok"]);
		} finally {
			await run.close();
		}
	});

	it("a yolo step turn that ran its step continues until pipelineDone, a turn without a step, or the cap (bt-6)", async () => {
		const policy = { mode: "step" as const, stepTool: STEP };
		const route = { model: "step-compliant-model", tier: "frontier" as const };
		const compliant = await drive(route, policy, undefined, { calls: 1, stages: 3 });
		try {
			deepStrictEqual(
				compliant.turns.map((turn) => turn.verdicts),
				[["ok"], ["ok"], ["ok"]],
			);
			deepStrictEqual(compliant.continued, ["tool_budget", "tool_budget"]);
			deepStrictEqual(compliant.guardEvents, []);
		} finally {
			await compliant.close();
		}
		const idle = await drive(route, policy, undefined, { calls: 0 });
		try {
			strictEqual(idle.turns.length, 1);
			deepStrictEqual(idle.continued, []);
		} finally {
			await idle.close();
		}
		const endless = await drive(route, policy, undefined, { calls: 1 });
		try {
			strictEqual(endless.turns.length, 1 + TURN_CONTINUATION_CAP);
			strictEqual(endless.continued.length, TURN_CONTINUATION_CAP);
		} finally {
			await endless.close();
		}
	});

	it("absent when keeps the policy on every route and the reminder unchanged", () => {
		const guidance = turnScopeGuidance({ turnPolicy: { mode: "step", stepTool: STEP } });
		ok(guidance.includes(`Do not call ${STEP} again this turn`));
		ok(!guidance.includes("on this route"));
	});
});
