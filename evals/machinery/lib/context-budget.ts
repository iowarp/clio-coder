/**
 * Context budget scenarios: the three places a request is admitted against
 * input plus reserved output, and the one policy resolution that decides where
 * the pressure phases sit.
 *
 * Submission and the post-tool continuation guard both refuse before a provider
 * call; the provider boundary re-derives the wire ceiling against the context it
 * is about to send. The three are measured separately because a change that
 * moves one of them and not the others is the change worth seeing.
 */
import { DEFAULT_SETTINGS } from "../../../src/core/defaults.js";
import { resolveLiveBudgetPolicy } from "../../../src/domains/context/budget/live-view.js";
import { DEFAULT_REDUCE_THRESHOLD, DEFAULT_WORKING_SET_TARGET } from "../../../src/domains/context/budget/pressure.js";
import { requestFits } from "../../../src/domains/context/budget/request-fit.js";
import type { ProvidersContract } from "../../../src/domains/providers/contract.js";
import type { SessionContract, SessionMeta } from "../../../src/domains/session/contract.js";
import { createEngineAgent } from "../../../src/engine/agent.js";
import {
	remainingContextMaxTokens,
	resolveReservedOutputTokens,
	setGlobalDefaultMaxOutputTokens,
} from "../../../src/engine/apis/output-budget.js";
import type { AgentMessage, Usage } from "../../../src/engine/types.js";
import { createTurnContext, type TurnContext } from "../../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../../src/interactive/turn-state.js";
import { type MachineryObservation, type MachineryScenario, observe } from "./observation.js";

const WINDOW = 32_768;

async function submissionAdmission(): Promise<MachineryObservation> {
	// The rule the submit guard applies: the prompt side and the reservation
	// held for the answer must both fit the window, and an unknown measurement
	// is a refusal rather than an optimistic zero.
	const cases: Array<readonly [string, number | null, number | null, number | null]> = [
		["comfortable", 8_000, 8_192, 131_072],
		["exactly-at-the-window", 24_000, 8_768, 32_768],
		["one-token-over", 24_001, 8_768, 32_768],
		["input-alone-fits-but-reserve-does-not", 24_000, 12_000, 32_768],
		["zero-reserve", 32_768, 0, 32_768],
		["empty-request", 0, 0, 0],
		["unknown-input", null, 8_192, 131_072],
		["unknown-reserve", 8_000, null, 131_072],
		["unknown-window", 8_000, 8_192, null],
		["not-a-number-input", Number.NaN, 8_192, 131_072],
		["infinite-reserve", 8_000, Number.POSITIVE_INFINITY, 131_072],
		["negative-input", -1, 8_192, 131_072],
	];
	const admitted: Record<string, boolean> = {};
	for (const [name, input, output, window] of cases) admitted[name] = requestFits(input, output, window);
	return observe(
		{ admitted },
		{
			"a request that exactly fills the window is admitted": admitted["exactly-at-the-window"] === true,
			"one token past the window is refused": admitted["one-token-over"] === false,
			"the reserved output counts against the window": admitted["input-alone-fits-but-reserve-does-not"] === false,
			"an unmeasured figure is refused rather than read as zero": [
				"unknown-input",
				"unknown-reserve",
				"unknown-window",
			].every((name) => admitted[name] === false),
			"a non-finite or negative figure is refused": ["not-a-number-input", "infinite-reserve", "negative-input"].every(
				(name) => admitted[name] === false,
			),
			"a window of zero admits nothing": admitted["empty-request"] === false,
		},
	);
}

async function outputReserveResolution(): Promise<MachineryObservation> {
	// The preflight reservation is the smaller of the model's advertised cap and
	// the configured budget, then clamped to remaining room on the two transports
	// that already clamp on the wire. The global default is process state, so the
	// scenario sets it explicitly and puts it back.
	const reserved: Record<string, number> = {};
	try {
		for (const [label, configured] of [
			["unset", 0],
			["configured-8k", 8_192],
			["configured-above-cap", 200_000],
		] as const) {
			setGlobalDefaultMaxOutputTokens(configured);
			reserved[`${label}/no-request`] = resolveReservedOutputTokens(131_072);
			reserved[`${label}/unknown-cap`] = resolveReservedOutputTokens(null);
			reserved[`${label}/openai-roomy`] = resolveReservedOutputTokens(131_072, {
				api: "openai-completions",
				contextWindow: 262_144,
				inputTokens: 1_000,
			});
			reserved[`${label}/openai-crowded`] = resolveReservedOutputTokens(131_072, {
				api: "openai-completions",
				contextWindow: 32_768,
				inputTokens: 30_000,
			});
			reserved[`${label}/ollama-crowded`] = resolveReservedOutputTokens(131_072, {
				api: "ollama-native",
				contextWindow: 32_768,
				inputTokens: 30_000,
			});
			reserved[`${label}/anthropic-crowded`] = resolveReservedOutputTokens(131_072, {
				api: "anthropic-messages",
				contextWindow: 32_768,
				inputTokens: 30_000,
			});
		}
	} finally {
		setGlobalDefaultMaxOutputTokens(0);
	}
	return observe(
		{ reserved },
		{
			"an unset budget falls back to the product floor": reserved["unset/no-request"] === 32_768,
			"a configured budget below the cap wins": reserved["configured-8k/no-request"] === 8_192,
			"a configured budget above the cap is clamped to it": reserved["configured-above-cap/no-request"] === 131_072,
			"a clamping transport reserves only the remaining room":
				(reserved["unset/openai-crowded"] ?? 0) < 32_768 &&
				reserved["unset/openai-crowded"] === reserved["unset/ollama-crowded"],
			"a transport that does not clamp keeps its whole reservation": reserved["unset/anthropic-crowded"] === 32_768,
			"a roomy window leaves the reservation untouched": reserved["configured-8k/openai-roomy"] === 8_192,
		},
	);
}

type BoundaryModel = Parameters<typeof remainingContextMaxTokens>[0];
type BoundaryContext = Parameters<typeof remainingContextMaxTokens>[1];

function boundaryContext(systemPromptChars: number): BoundaryContext {
	return { systemPrompt: "x".repeat(systemPromptChars), messages: [], tools: [] } as unknown as BoundaryContext;
}

async function providerBoundaryCeiling(): Promise<MachineryObservation> {
	// The preflight reservation is not the wire ceiling. At request time the
	// transport re-derives it against the context it is about to send, so a
	// prompt that grew after admission still leaves room for an answer.
	const model = { contextWindow: 262_144, maxTokens: 131_072 } as BoundaryModel;
	const uncapped = { contextWindow: 262_144, maxTokens: 0 } as BoundaryModel;
	const served = { contextWindow: 131_072, maxTokens: 131_072 } as BoundaryModel;
	const ceilings: Record<string, number> = {};
	try {
		setGlobalDefaultMaxOutputTokens(0);
		ceilings["advertised-cap"] = remainingContextMaxTokens(model, boundaryContext(0), undefined);
		ceilings["no-advertised-cap"] = remainingContextMaxTokens(uncapped, boundaryContext(0), undefined);
		ceilings["explicit-request"] = remainingContextMaxTokens(model, boundaryContext(0), { maxTokens: 4_096 });
		ceilings["tool-turn-limit"] = remainingContextMaxTokens(model, boundaryContext(0), undefined, {
			maxOutputTokens: 2_048,
		});
		ceilings["loaded-window-below-configured"] = remainingContextMaxTokens(model, boundaryContext(0), undefined, {
			contextWindow: 8_192,
		});
		ceilings["crowded-context"] = remainingContextMaxTokens(served, boundaryContext(480_000), undefined);
		setGlobalDefaultMaxOutputTokens(8_192);
		ceilings["global-default"] = remainingContextMaxTokens(model, boundaryContext(0), undefined);
		ceilings["explicit-beats-global-default"] = remainingContextMaxTokens(model, boundaryContext(0), {
			maxTokens: 16_384,
		});
	} finally {
		setGlobalDefaultMaxOutputTokens(0);
	}
	return observe(
		{ ceilings },
		{
			"an empty context is offered the model's advertised cap": ceilings["advertised-cap"] === 131_072,
			"a model with no advertised cap gets the product floor": ceilings["no-advertised-cap"] === 32_768,
			"an explicit request outranks every default": ceilings["explicit-request"] === 4_096,
			"a tool-turn limit outranks the global default": ceilings["tool-turn-limit"] === 2_048,
			"a smaller loaded window bounds the ceiling": (ceilings["loaded-window-below-configured"] ?? 0) < 8_192,
			"a crowded context leaves room for an answer":
				(ceilings["crowded-context"] ?? 0) > 0 && (ceilings["crowded-context"] ?? 0) < 131_072,
			"the global default applies only where nothing more specific does":
				ceilings["global-default"] === 8_192 && ceilings["explicit-beats-global-default"] === 16_384,
		},
	);
}

const USAGE: Usage = {
	input: 9_000,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9_050,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "r1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	} as AgentMessage;
}

interface BudgetFixture {
	context: TurnContext;
	runtime: AgentRuntime;
	settings: ReturnType<typeof structuredClone<typeof DEFAULT_SETTINGS>>;
	reductions: () => number;
}

/**
 * A turn context over a scripted runtime. It carries no tool registry and no
 * session persistence: what these scenarios measure is the accounting and the
 * admission the turn performs, not the surfaces that quote them.
 */
function budgetFixture(options: { autoCompact?: boolean } = {}): BudgetFixture {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "fixture";
	settings.chat.model = "model";
	settings.context.compaction.threshold = 0.85;
	const state = createTurnState("medium");
	const descriptor = {
		id: "fixture",
		kind: "http",
		apiFamily: "openai-completions",
		defaultCapabilities: { chat: true, tools: true, reasoning: false, contextWindow: WINDOW, maxTokens: 8_192 },
	} as AgentRuntime["runtimeResolution"]["runtime"];
	const runtime = {
		targetId: "fixture",
		runtimeId: "fixture",
		wireModelId: "model",
		runtimeResolution: {
			runtime: descriptor,
			capabilityDecisions: { maxTokens: 8_192 },
			contextWindowDetails: {
				desiredContextWindow: WINDOW,
				effectiveContextWindow: WINDOW,
				contextWindowSource: "configured",
			},
		},
		agent: createEngineAgent({
			initialState: {
				model: { id: "model", api: "openai-completions", contextWindow: WINDOW, maxTokens: 8_192 } as never,
				systemPrompt: "System prompt.",
				tools: [],
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Inspect the source." }],
						usage: USAGE,
						api: "openai-completions",
						provider: "fixture",
						model: "model",
						stopReason: "toolUse",
						timestamp: 1,
					},
				],
			},
		}).agent,
	} as unknown as AgentRuntime;
	state.runtime = runtime;
	state.lastTurnId = "leaf";
	const providers = {
		list: () => [],
		getTarget: () => ({ id: "fixture", runtime: "fixture" }),
		getDetectedReasoning: () => false,
		knowledgeBase: null,
		getRuntime: () => descriptor,
	} as unknown as ProvidersContract;
	let reductions = 0;
	const context = createTurnContext({
		middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
		state,
		providers,
		getSettings: () => settings,
		session: {
			current: () => ({ id: "machinery-budget", cwdHash: "machinery", cwd: process.cwd() }) as SessionMeta,
			appendEntry: () => {},
		} as unknown as SessionContract,
		readSessionEntries: () => [],
		autoCompact: async () => {
			reductions += 1;
			return options.autoCompact === true ? ({ summary: "Prior work." } as never) : null;
		},
		emitNotice: () => {},
	});
	// A conversation the provider has already answered once, so the accounting
	// runs on an attested anchor plus an estimated tail rather than on the
	// structural estimate alone.
	context.setCurrentSnapshot(
		context.captureRuntimeContextSnapshot(runtime, "leaf", settings.context.compaction.threshold),
	);
	context.reconcileUsage(USAGE);
	return { context, runtime, settings, reductions: () => reductions };
}

function viewFacts(view: ReturnType<TurnContext["liveBudget"]>) {
	return {
		revision: view.revision,
		inputTokens: view.inputTokens,
		inputSource: view.inputSource,
		outputReserveTokens: view.outputReserveTokens,
		thresholdReserveTokens: view.thresholdReserveTokens,
		headroomTokens: view.headroomTokens,
		pressure: view.pressure,
		phase: view.phase,
		admission: view.admission,
		advisory: view.advisory,
		reduction: view.reduction,
		policy: view.policy,
		policyRejection: view.policyRejection,
	};
}

async function liveViewAdmission(): Promise<MachineryObservation> {
	const fixture = budgetFixture();
	const stages: Record<string, ReturnType<typeof viewFacts>> = {};
	stages.empty = viewFacts(fixture.context.refreshLiveBudget());
	// Each push crosses one more of the published phases. The figures are a
	// property of the accounting, so they are pinned rather than bounded.
	for (const [name, chars] of [
		["notice", 20_000],
		["prepare", 12_000],
		["reduce", 20_000],
		["overflowing", 60_000],
	] as const) {
		fixture.runtime.agent.state.messages.push(toolResult("x".repeat(chars)));
		stages[name] = viewFacts(fixture.context.refreshLiveBudget());
	}
	const phases = Object.values(stages).map((stage) => stage.phase);
	const results = Object.values(stages).map((stage) => stage.admission.result);
	const cached = viewFacts(fixture.context.liveBudget());
	return observe(
		{ stages, cached },
		{
			"a read of the published view never recomputes it": cached.revision === stages.overflowing?.revision,
			"an empty conversation admits its request": stages.empty?.admission.result === "admit",
			"a saturated conversation refuses before the provider call": stages.overflowing?.admission.result === "unsafe",
			"the phase never walks backwards while the context only grows": phases.every(
				(phase, index) => index === 0 || phaseRank(phase) >= phaseRank(phases[index - 1] ?? "normal"),
			),
			"every stage prices the reservation it admits against": Object.values(stages).every(
				(stage) => stage.outputReserveTokens !== null,
			),
			"the reserve held for the answer is not the reduce threshold's headroom": Object.values(stages).every(
				(stage) => stage.outputReserveTokens !== stage.thresholdReserveTokens,
			),
			"a refusal is reported once the request stops fitting": results.includes("unsafe"),
		},
	);
}

const PHASE_ORDER = ["normal", "notice", "prepare", "reduce", "recover"];

function phaseRank(phase: string): number {
	return PHASE_ORDER.indexOf(phase);
}

async function toolContinuationGuard(): Promise<MachineryObservation> {
	// The mid-run boundary. A tool batch can land observations the submitted
	// turn was never priced for, so the continuation is admitted again against
	// the context it is actually about to send.
	const fitting = budgetFixture();
	const fittingOutcome = await settle(() =>
		fitting.context.postToolContinuationGuard(fitting.runtime, undefined, false),
	);
	fitting.runtime.agent.state.messages.push(toolResult("x".repeat(2_000)));
	const smallBatch = await settle(() => fitting.context.postToolContinuationGuard(fitting.runtime, undefined, false));

	const overflowing = budgetFixture();
	overflowing.runtime.agent.state.messages.push(toolResult("x".repeat(200_000)));
	const refused = await settle(() =>
		overflowing.context.postToolContinuationGuard(overflowing.runtime, undefined, false),
	);

	const aborted = budgetFixture();
	aborted.runtime.agent.state.messages.push(toolResult("x".repeat(200_000)));
	const controller = new AbortController();
	controller.abort();
	const abandoned = await settle(() =>
		aborted.context.postToolContinuationGuard(aborted.runtime, controller.signal, false),
	);

	return observe(
		{
			noToolTail: fittingOutcome,
			smallBatch,
			refused,
			abandoned,
			reductionAttempts: {
				fitting: fitting.reductions(),
				overflowing: overflowing.reductions(),
				aborted: aborted.reductions(),
			},
		},
		{
			"a turn with no tool tail is left alone": fittingOutcome.kind === "returned" && fitting.reductions() === 0,
			"a batch that still fits continues without reducing": smallBatch.kind === "returned" && fitting.reductions() === 0,
			"a batch that no longer fits stops before the provider call": refused.kind === "threw",
			"the refusal names input, reserved output and the window":
				refused.kind === "threw" && refused.message.includes("does not fit context window"),
			"an overflowing batch attempts a reduction first": overflowing.reductions() === 1,
			"an aborted turn neither reduces nor refuses": abandoned.kind === "returned" && aborted.reductions() === 0,
		},
	);
}

type Settled = { kind: "returned"; value: unknown } | { kind: "threw"; message: string };

async function settle(run: () => Promise<unknown>): Promise<Settled> {
	try {
		return { kind: "returned", value: (await run()) ?? null };
	} catch (error) {
		return { kind: "threw", message: error instanceof Error ? error.message : String(error) };
	}
}

async function pressurePolicyResolution(): Promise<MachineryObservation> {
	// Where the phases sit is two independent settings, not one derived from the
	// other. A pair the resolver refuses runs the defaults and says so, rather
	// than repairing itself into a policy the operator never wrote.
	const resolutions: Record<string, unknown> = {};
	for (const [name, reduce, target] of [
		["unset", null, null],
		["configured", 0.9, 0.6],
		["target-at-its-own-reduce-point", 0.8, 0.8],
		["target-above-reduce-point", 0.6, 0.9],
		["reduce-out-of-range", 1.5, 0.6],
		["reduce-only", 0.7, null],
		["target-only", null, 0.4],
	] as const) {
		const resolved = resolveLiveBudgetPolicy(reduce, target);
		resolutions[name] = { policy: resolved.policy, rejection: resolved.rejection };
	}
	const configured = resolutions.configured as { policy: { reduce: number; target: number } };
	const refused = ["target-at-its-own-reduce-point", "target-above-reduce-point", "reduce-out-of-range"];
	return observe(
		{ resolutions, defaults: { reduce: DEFAULT_REDUCE_THRESHOLD, target: DEFAULT_WORKING_SET_TARGET } },
		{
			"a configured pair is published exactly as written":
				configured.policy.reduce === 0.9 && configured.policy.target === 0.6,
			"a refused pair runs the defaults": refused.every((name) => {
				const row = resolutions[name] as { policy: { reduce: number; target: number }; rejection: unknown };
				return row.policy.reduce === DEFAULT_REDUCE_THRESHOLD && row.policy.target === DEFAULT_WORKING_SET_TARGET;
			}),
			"a refused pair names its reason": refused.every(
				(name) => (resolutions[name] as { rejection: unknown }).rejection !== null,
			),
			"an accepted pair carries no rejection": ["unset", "configured", "reduce-only", "target-only"].every(
				(name) => (resolutions[name] as { rejection: unknown }).rejection === null,
			),
		},
	);
}

export const SCENARIOS: Record<string, MachineryScenario> = {
	"submission-admission": submissionAdmission,
	"output-reserve-resolution": outputReserveResolution,
	"provider-boundary-ceiling": providerBoundaryCeiling,
	"live-view-admission": liveViewAdmission,
	"tool-continuation-guard": toolContinuationGuard,
	"pressure-policy-resolution": pressurePolicyResolution,
};
