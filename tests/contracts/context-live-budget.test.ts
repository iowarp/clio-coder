import { ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	createLiveBudgetProducer,
	type LiveBudgetInput,
	type LiveBudgetView,
	resolveLiveBudgetPolicy,
} from "../../src/domains/context/budget/live-view.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { estimateAgentMessageTokens } from "../../src/domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage, Usage } from "../../src/engine/types.js";
import { resolveTurnOutputReserve } from "../../src/interactive/output-reserve.js";
import { createTurnContext, type TurnContextDeps } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const WINDOW = 32_768;
const MODEL_MAX_TOKENS = 8192;

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text = "Read the source next."): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage(20_281, 61),
		api: "openai-completions",
		provider: "fixture",
		model: "qwen",
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "read1",
		toolName: "read",
		isError: false,
		timestamp: 2,
	};
}

describe("live budget producer", () => {
	const POLICY = resolveLiveBudgetPolicy(0.8, 0.6);

	function input(overrides: Partial<LiveBudgetInput> = {}): LiveBudgetInput {
		return {
			sessionId: "s1",
			branchAnchorTurnId: "anchor",
			activeLeafTurnId: "leaf-1",
			activeUserTurnId: "u1",
			capturedSnapshotId: "snap-1",
			targetId: "dynamo",
			runtimeId: "openai-compat",
			modelId: "qwen",
			modelApi: "openai-completions",
			effectiveWindow: WINDOW,
			windowSource: "configured",
			estimatedInputTokens: 10_000,
			anchoredInputTokens: null,
			inputTokens: 10_000,
			inputSource: "estimated",
			historical: false,
			breakdown: { systemPromptTokens: 400, messageTokens: 8600, pendingUserTokens: 0, toolSchemaTokens: 1000 },
			breakdownSource: "live",
			outputReserveTokens: MODEL_MAX_TOKENS,
			thresholdReserveTokens: 4915,
			policy: POLICY.policy,
			policyRejection: POLICY.rejection,
			reduction: "unknown",
			reductionBasisKey: "fp-1",
			promptFingerprint: "prompt-1",
			toolSignature: "tools-1",
			navigationEpoch: 0,
			lastReduction: null,
			pendingHandoff: null,
			lastOutcome: null,
			...overrides,
		};
	}

	it("keeps one revision while the material inputs hold and moves it when they change", () => {
		const producer = createLiveBudgetProducer();
		const first = producer.publish(input());
		const repeat = producer.publish(input());
		strictEqual(repeat.revision, first.revision, "an unchanged republish must not invent a revision");
		strictEqual(producer.current()?.revision, first.revision);

		// Same length, different bytes: every token figure is identical and the
		// request is still a different one.
		const mutated = producer.publish(input({ reductionBasisKey: "fp-2" }));
		ok(mutated.revision !== first.revision, "a same-length message mutation must move the revision");
		strictEqual(mutated.estimatedInputTokens, first.estimatedInputTokens);
	});

	it("never aliases an initial capture, a reconciliation, and later tool growth onto one revision", () => {
		const producer = createLiveBudgetProducer();
		const captured = producer.publish(input());
		const reconciled = producer.publish(
			input({ anchoredInputTokens: 20_342, inputTokens: 20_342, inputSource: "anchored-plus-estimated-tail" }),
		);
		const grown = producer.publish(
			input({ anchoredInputTokens: 24_000, inputTokens: 24_000, inputSource: "anchored-plus-estimated-tail" }),
		);
		const seen = new Set([captured.revision, reconciled.revision, grown.revision]);
		strictEqual(seen.size, 3, "three distinct accountings must produce three revisions");

		// A conversation that returns to a byte-identical earlier state is still a
		// later observation, so the revision does not travel backwards.
		const returned = producer.publish(input());
		ok(returned.revision !== captured.revision, "a revision must never be reused after a later one existed");
	});

	it("moves the revision when only the reserve or the reduction verdict changed", () => {
		const producer = createLiveBudgetProducer();
		const base = producer.publish(input());
		const reserved = producer.publish(input({ outputReserveTokens: 3744 }));
		ok(reserved.revision !== base.revision, "a route-clamped reserve is a different request");
		const refused = producer.publish(input({ outputReserveTokens: 3744, reduction: "no-useful-cut" }));
		ok(refused.revision !== reserved.revision, "a reduction verdict change must not reuse a revision");
	});

	it("announces once per advisory epoch while the branch leaf advances, and re-arms on real navigation", () => {
		const producer = createLiveBudgetProducer();
		const crossed = { inputTokens: Math.round(0.7 * WINDOW), estimatedInputTokens: Math.round(0.7 * WINDOW) };
		const first = producer.publish(input({ ...crossed, reductionBasisKey: "fp-a" }));
		strictEqual(first.phase, "notice");
		strictEqual(first.advisory.emit, true);

		// Two ordinary tool batches: new content, new leaf, same branch.
		const second = producer.publish(input({ ...crossed, reductionBasisKey: "fp-b", activeLeafTurnId: "leaf-2" }));
		strictEqual(second.advisory.emit, false);
		strictEqual(second.advisory.suppressedBy, "already-announced");
		const third = producer.publish(input({ ...crossed, reductionBasisKey: "fp-c", activeLeafTurnId: "leaf-3" }));
		strictEqual(third.advisory.emit, false, "an advancing leaf is not a new advisory epoch");

		const navigated = producer.publish(
			input({
				...crossed,
				reductionBasisKey: "fp-d",
				branchAnchorTurnId: "other-branch",
				activeLeafTurnId: "leaf-9",
				navigationEpoch: 1,
			}),
		);
		strictEqual(navigated.advisory.emit, true, "real branch navigation re-arms the advisory");
	});

	it("holds one advisory verdict for one revision instead of consuming it on a refresh", () => {
		const producer = createLiveBudgetProducer();
		const crossed = { inputTokens: Math.round(0.7 * WINDOW), estimatedInputTokens: Math.round(0.7 * WINDOW) };
		const published = producer.publish(input({ ...crossed, reductionBasisKey: "fp-a" }));
		strictEqual(published.advisory.emit, true);

		// An incidental producer refresh before anybody read the view. Delivery
		// deduplicates on the revision; a cache refresh is not acknowledgement.
		const refreshed = producer.publish(input({ ...crossed, reductionBasisKey: "fp-a" }));
		strictEqual(refreshed.revision, published.revision);
		strictEqual(refreshed.advisory.emit, true, "an unchanged republish must not consume the crossing");
		strictEqual(producer.current()?.advisory.emit, true, "a reader after the refresh still sees one crossing");

		// The next material transition at the same phase is quiet.
		const advanced = producer.publish(input({ ...crossed, reductionBasisKey: "fp-b" }));
		ok(advanced.revision !== published.revision);
		strictEqual(advanced.advisory.emit, false);
		strictEqual(advanced.advisory.suppressedBy, "already-announced");
	});

	it("carries a no-cut refusal only for the identical post-accounting basis", () => {
		const producer = createLiveBudgetProducer();
		// At the reduce point but still inside the window, so the verdict under
		// test is reduction eligibility rather than overflow.
		const atReduce = {
			inputTokens: Math.round(0.85 * WINDOW),
			estimatedInputTokens: Math.round(0.85 * WINDOW),
			outputReserveTokens: 1000,
		};
		producer.publish(input({ ...atReduce, reductionBasisKey: "basis-1", reduction: "no-useful-cut" }));

		// Same basis, caller no longer asserting the refusal: the policy still
		// knows this exact request had no useful cut.
		const retained = producer.publish(input({ ...atReduce, reductionBasisKey: "basis-1", reduction: "unknown" }));
		strictEqual(retained.admission.reason, "fits", "an unchanged refused request is admitted, not asked to cut again");

		// A different basis (a recalibrated anchor, a different resolved cap) is a
		// request the reducer never saw.
		const rebased = producer.publish(input({ ...atReduce, reductionBasisKey: "basis-2", reduction: "unknown" }));
		strictEqual(rebased.admission.result, "reduce-first");
		strictEqual(rebased.admission.reason, "pressure-at-reduce-threshold");
	});

	it("publishes frozen copies of the optional projections under a revision of their own", () => {
		const producer = createLiveBudgetProducer();
		const handoff = { id: "handoff-1", preparedAt: null as string | null, sourceRevision: "lb-1-aaa" };
		const view = producer.publish(input({ pendingHandoff: handoff }));
		strictEqual(view.pendingHandoff?.sourceRevision, "lb-1-aaa");

		// The reader still owns its object; the publication does not follow it.
		handoff.sourceRevision = "lb-9-zzz";
		strictEqual(view.pendingHandoff?.sourceRevision, "lb-1-aaa", "a published view does not change behind its revision");
		throws(() => {
			(view.pendingHandoff as { sourceRevision: string }).sourceRevision = "edited";
		}, TypeError);
		throws(() => {
			(view.policy as { reduce: number }).reduce = 0.1;
		}, TypeError);

		// A genuinely different projection is a different publication.
		const republished = producer.publish(input({ pendingHandoff: { ...handoff } }));
		ok(republished.revision !== view.revision, "a changed projection must not hide under the old revision");
	});

	it("reports an unresolvable measurement as unknown rather than admitting an unpriced request", () => {
		const producer = createLiveBudgetProducer();
		const view = producer.publish(
			input({ historical: true, inputSource: "historical", outputReserveTokens: null, effectiveWindow: WINDOW }),
		);
		strictEqual(view.admission.result, "unknown");
		strictEqual(view.pressure, null);
		strictEqual(view.headroomTokens, null);
		strictEqual(view.outputReserveTokens, null);
		strictEqual(view.advisory.emit, false);
	});
});

describe("live budget policy resolution", () => {
	it("publishes the independently configured threshold and target unchanged", () => {
		const resolved = resolveLiveBudgetPolicy(0.9, 0.6);
		strictEqual(resolved.rejection, null);
		strictEqual(resolved.policy.reduce, 0.9);
		strictEqual(
			resolved.policy.target,
			0.6,
			"the working-set target is its own setting, not a fraction of the threshold",
		);
		ok(resolved.policy.target < resolved.policy.notice);
	});

	it("keeps a custom valid pair that is not the product default", () => {
		const resolved = resolveLiveBudgetPolicy(0.7, 0.45);
		strictEqual(resolved.rejection, null);
		strictEqual(resolved.policy.reduce, 0.7);
		strictEqual(resolved.policy.target, 0.45);
		ok(resolved.policy.notice < resolved.policy.prepare && resolved.policy.prepare < 0.7);
	});

	it("falls through to the product default for each value left unset", () => {
		strictEqual(resolveLiveBudgetPolicy(null, 0.4).policy.reduce, 0.8);
		strictEqual(resolveLiveBudgetPolicy(0.9, null).policy.target, 0.6);
	});

	it("reports a refused pair instead of presenting a fabricated configured policy", () => {
		const refused = resolveLiveBudgetPolicy(0.5, 0.6);
		strictEqual(refused.rejection, "target-out-of-range");
		strictEqual(refused.policy.reduce, 0.8, "the defaults are in force, and the view says the configuration is not");
		strictEqual(refused.policy.target, 0.6);
		strictEqual(resolveLiveBudgetPolicy(1.5, 0.6).rejection, "reduce-threshold-out-of-range");
		strictEqual(resolveLiveBudgetPolicy(Number.NaN, 0.6).rejection, "reduce-threshold-out-of-range");
	});
});

describe("live budget adapter", () => {
	let isolated: IsolatedClioEnv;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-live-budget-");
	});
	afterEach(() => isolated.restore());

	function fixture(overrides: Partial<TurnContextDeps> = {}) {
		const state = createTurnState("medium");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.context.compaction.threshold = 0.85;
		settings.context.workingSet.target = 0.6;
		settings.chat.maxOutputTokens = MODEL_MAX_TOKENS;
		const runtime = {
			targetId: "dynamo",
			runtimeId: "openai-compat",
			wireModelId: "qwen",
			runtimeResolution: {
				contextWindowDetails: {
					desiredContextWindow: WINDOW,
					effectiveContextWindow: WINDOW,
					contextWindowSource: "configured",
				},
				capabilityDecisions: { maxTokens: MODEL_MAX_TOKENS },
			},
			agent: createEngineAgent({
				initialState: {
					model: {
						id: "qwen",
						api: "openai-completions",
						baseUrl: "http://source.invalid",
						maxTokens: MODEL_MAX_TOKENS,
						contextWindow: WINDOW,
					} as AgentRuntime["agent"]["state"]["model"],
					systemPrompt: "system".repeat(100),
					messages: [assistant()],
					tools: [
						{
							name: "read",
							label: "Read",
							description: "s".repeat(27_000),
							parameters: { type: "object" },
							execute: async () => ({ content: [], details: {} }),
						},
					],
				},
			}).agent,
		} as unknown as AgentRuntime;
		state.runtime = runtime;
		state.lastTurnId = "t1";
		const meta = { id: "budget-session", cwdHash: "budget-fixture", cwd: isolated.dir } as SessionMeta;
		let summaries = 0;
		const context = createTurnContext({
			state,
			getSettings: () => settings,
			providers: {} as ProvidersContract,
			session: { current: () => meta, appendEntry: () => {} } as unknown as SessionContract,
			readSessionEntries: () => [],
			autoCompact: async () => {
				summaries += 1;
				return null;
			},
			middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
			emitNotice: () => {},
			...overrides,
		});
		// The path production actually writes to: `getSnapshotsFilePath` resolves it
		// through `sessionPaths(meta)`, which follows CLIO_CODER_STATE_DIR. Guessing
		// a directory here would let a persisting read pass unnoticed, so the file
		// is resolved through the same owner and the test establishes a positive
		// control before asserting the count holds.
		const snapshotsFile = join(dirname(sessionPaths(meta).current), "context-snapshots.jsonl");
		const snapshotLines = (): number => {
			try {
				return readFileSync(snapshotsFile, "utf8").split("\n").filter(Boolean).length;
			} catch {
				return 0;
			}
		};
		return { state, runtime, settings, context, meta, snapshotLines, summaries: () => summaries };
	}

	/** Capture and reconcile a prompt, the way a submitted turn does. */
	function reconciledFixture(overrides: Partial<TurnContextDeps> = {}) {
		const f = fixture(overrides);
		f.context.setCurrentSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "t1", 0.85));
		f.context.reconcileUsage(usage(20_281, 61));
		return f;
	}

	it("budgets against the same live estimate admission uses, with truthful anchored provenance", () => {
		const f = reconciledFixture();
		const view = f.context.refreshLiveBudget();
		strictEqual(view.inputTokens, f.context.liveContextEstimate(f.runtime).tokens);
		strictEqual(view.anchoredInputTokens, 20_342, "the attested prompt plus its own output, charged once");
		strictEqual(view.estimatedInputTokens, f.context.liveContextEstimate(f.runtime).estimatedTokens);
		strictEqual(view.inputSource, "anchored-plus-estimated-tail");
		strictEqual(view.historical, false);
		strictEqual(view.breakdownSource, "live");
		strictEqual(view.effectiveWindow, WINDOW);
		strictEqual(view.capturedSnapshotId !== null, true, "the capture stays reachable as a diagnostic reference");
	});

	it("shares one total and one revision between the admission refresh and every later read", () => {
		const f = reconciledFixture();
		const admission = f.context.refreshLiveBudget("send this");
		const rendered = f.context.liveBudget();
		strictEqual(rendered.revision, admission.revision);
		strictEqual(rendered.inputTokens, admission.inputTokens);
		strictEqual(rendered.outputReserveTokens, admission.outputReserveTokens);

		// The tool batch appends a large result with no further model response.
		f.runtime.agent.state.messages.push(toolResult("read result ".repeat(4000)));
		const afterTool = f.context.refreshLiveBudget("send this");
		ok(afterTool.revision !== admission.revision, "appended results are a new request");
		ok((afterTool.inputTokens ?? 0) > (admission.inputTokens ?? 0));
		strictEqual(afterTool.inputTokens, f.context.liveContextEstimate(f.runtime, "send this").tokens);
		strictEqual(f.context.liveBudget().revision, afterTool.revision, "a read never lags the publication");
	});

	it("charges a tool result once on top of the anchor and never re-charges the assistant output", () => {
		const f = reconciledFixture();
		const tail = toolResult("source".repeat(660));
		f.runtime.agent.state.messages.push(tail);
		const view = f.context.refreshLiveBudget();
		strictEqual(view.anchoredInputTokens, 20_342 + estimateAgentMessageTokens(tail));
		strictEqual(view.inputTokens, view.anchoredInputTokens);
	});

	it("charges pending text exactly once and only while it is pending", () => {
		const f = reconciledFixture();
		const quiet = f.context.refreshLiveBudget();
		strictEqual(quiet.breakdown?.pendingUserTokens, 0);
		const pending = f.context.refreshLiveBudget("pending text");
		strictEqual(pending.breakdown?.pendingUserTokens, 3);
		strictEqual(pending.inputTokens, (quiet.inputTokens ?? 0) + 3);
		strictEqual(f.context.refreshLiveBudget().inputTokens, quiet.inputTokens);
	});

	it("changes the revision when the accounting is reconciled again", () => {
		const f = reconciledFixture();
		const first = f.context.refreshLiveBudget();
		f.runtime.agent.state.messages.push(toolResult("more".repeat(500)), assistant("done"));
		f.context.reconcileUsage(usage(26_000, 120));
		const second = f.context.liveBudget();
		ok(second.revision !== first.revision, "a reconcile that moves the anchor must move the revision");
		strictEqual(second.anchoredInputTokens, 26_120);
	});

	it("drops the anchor and moves the revision when an attested message is edited in place", () => {
		const f = reconciledFixture();
		const before = f.context.refreshLiveBudget();
		strictEqual(before.inputSource, "anchored-plus-estimated-tail");
		// The same message object, the same character count, different bytes. Every
		// chars/4 figure is identical and the provider counted different tokens, so
		// object identity and token counts both miss this on their own.
		const attested = f.runtime.agent.state.messages.at(-1) as { content: { type: string; text: string }[] };
		const original = attested.content[0]?.text ?? "";
		attested.content[0] = { type: "text", text: "X".repeat(original.length) };
		const after = f.context.refreshLiveBudget();
		strictEqual(
			after.breakdown?.messageTokens,
			before.breakdown?.messageTokens,
			"the structural split is unchanged, which is why it cannot be the detector",
		);
		strictEqual(after.anchoredInputTokens, null, "an edited attested prefix is no longer attested");
		strictEqual(after.inputSource, "estimated");
		ok(after.revision !== before.revision, "a replaced message of the same length is a different request");
	});

	it("stops claiming attested provenance after a large in-place replacement", () => {
		const f = reconciledFixture();
		const before = f.context.refreshLiveBudget();
		strictEqual(before.inputSource, "anchored-plus-estimated-tail");
		ok((before.headroomTokens ?? 0) > 0, "the request fits before the edit");

		// Far more content than the provider ever counted, written into the same
		// attested object. The total was never at risk here: `liveContextEstimate`
		// takes the higher of the structural estimate and the anchor, and the
		// structural estimate grows with the edit. What a stale anchor corrupted
		// is provenance, reporting a provider-attested prefix for bytes the
		// provider never saw, which is what packet 02 would carry forward.
		const attested = f.runtime.agent.state.messages.at(-1) as { content: { type: string; text: string }[] };
		attested.content[0] = { type: "text", text: "y".repeat(120_000) };
		const after = f.context.refreshLiveBudget();
		strictEqual(after.anchoredInputTokens, null, "an edited prefix is not an attested prefix");
		strictEqual(after.inputSource, "estimated");
		ok(
			(after.inputTokens ?? 0) > (before.inputTokens ?? 0) + 15_000,
			`the grown prefix must be repriced, got ${after.inputTokens} from ${before.inputTokens}`,
		);
		ok((after.inputTokens ?? 0) > WINDOW, "the repriced prefix alone already exceeds the window");
		ok((after.headroomTokens ?? 0) < 0, "the view reports the overflow it now measures");
		strictEqual(after.phase, "recover");
		strictEqual(after.admission.result, "unsafe");
	});

	it("drops the anchor when the target or the message projection changes", () => {
		for (const change of ["target", "projection"] as const) {
			const f = reconciledFixture();
			strictEqual(f.context.refreshLiveBudget().inputSource, "anchored-plus-estimated-tail");
			if (change === "target") f.runtime.targetId = "mini";
			if (change === "projection") f.runtime.agent.state.messages = [assistant("replayed")];
			const view = f.context.refreshLiveBudget();
			strictEqual(view.anchoredInputTokens, null, `${change} must invalidate the anchor`);
			strictEqual(view.inputSource, "estimated");
		}
	});

	it("separates the compaction-threshold reserve from the route-clamped output reserve", () => {
		const f = reconciledFixture();
		const view = f.context.refreshLiveBudget();
		strictEqual(view.thresholdReserveTokens, Math.round(WINDOW * 0.15), "threshold headroom follows the configured 0.85");
		strictEqual(view.outputReserveTokens, MODEL_MAX_TOKENS);
		ok(view.thresholdReserveTokens !== view.outputReserveTokens);

		// Grow the prompt until the transport's own remaining-context clamp bites.
		f.runtime.agent.state.messages.push(toolResult("x".repeat(30_000)));
		const clamped = f.context.refreshLiveBudget();
		strictEqual(clamped.outputReserveTokens, resolveTurnOutputReserve(f.runtime, clamped.inputTokens ?? 0));
		ok(
			(clamped.outputReserveTokens ?? 0) < MODEL_MAX_TOKENS,
			"openai-completions clamps the reservation to remaining context, and the view must show that",
		);
	});

	it("moves the revision when reserve or reduction-eligibility configuration changes", () => {
		const f = reconciledFixture();
		const before = f.context.refreshLiveBudget();
		f.settings.context.workingSet.target = 0.5;
		const retargeted = f.context.refreshLiveBudget();
		ok(retargeted.revision !== before.revision, "a working-set target change is a different reduction basis");
		strictEqual(retargeted.policy.target, 0.5);

		f.settings.chat.maxOutputTokens = 4096;
		const rebudgeted = f.context.refreshLiveBudget();
		ok(rebudgeted.revision !== retargeted.revision, "an output-budget change is a different request");
	});

	it("reads without repricing, persisting, or reducing", () => {
		const f = reconciledFixture();
		// Positive control: prove the watched file is the one a real capture lands
		// in, so an unchanged count afterwards means nothing was written rather
		// than that the test is watching the wrong path.
		strictEqual(f.snapshotLines(), 0, "nothing has been persisted yet");
		f.context.persistContextSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "t1", 0.85));
		const persisted = f.snapshotLines();
		strictEqual(persisted, 1, "a real capture appends to the file this test watches");

		const published = f.context.refreshLiveBudget();
		for (let i = 0; i < 25; i += 1) {
			const view = f.context.liveBudget();
			strictEqual(view.revision, published.revision);
			strictEqual(view.inputTokens, published.inputTokens);
		}
		strictEqual(f.snapshotLines(), persisted, "inspection must not append to the snapshot ledger");
		strictEqual(f.summaries(), 0, "inspection must not run a summary");
		strictEqual(f.state.streaming, false);
	});

	it("keeps one advisory epoch across ordinary tool batches under the same branch", () => {
		const f = fixture();
		// Start below every advisory level, so the crossing under test is the one
		// the reconcile causes and not the fixture's own tool surface.
		const tool = f.runtime.agent.state.tools[0] as { description: string };
		tool.description = "small";
		f.context.setCurrentSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "t1", 0.85));
		strictEqual(f.context.liveBudget().phase, "normal");
		// 0.7 of the window is past the derived notice level for a 0.85 reduce point.
		f.context.reconcileUsage(usage(Math.round(0.7 * WINDOW), 0));
		const announced = f.context.refreshLiveBudget();
		strictEqual(announced.phase, "notice");
		strictEqual(announced.advisory.emit, true);

		for (const leaf of ["t2", "t3"]) {
			f.runtime.agent.state.messages.push(toolResult(`batch ${leaf}`));
			f.state.lastTurnId = leaf;
			const view = f.context.refreshLiveBudget();
			strictEqual(view.advisory.emit, false, `leaf ${leaf} must not re-announce the same phase`);
			strictEqual(view.advisory.suppressedBy, "already-announced");
			strictEqual(view.branchAnchorTurnId, announced.branchAnchorTurnId, "the branch identity is not the leaf");
			strictEqual(view.activeLeafTurnId, leaf);
		}
	});

	it("clears a recorded no-cut when the resolved cap or the anchor moves, and keeps it otherwise", async () => {
		const f = fixture();
		// Working-set eviction off, so an empty automatic attempt reaches the
		// summary stage and is recorded as a no-useful-cut for this request.
		f.settings.context.workingSet.enabled = false;
		f.state.activeUserTurnId = "t1";
		f.context.setCurrentSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "t1", 0.85));
		f.context.reconcileUsage(usage(29_000, 100));
		strictEqual(await f.context.runAutoCompact(f.runtime, false), false);
		strictEqual(f.summaries(), 1, "the reducer was actually asked");
		strictEqual(f.context.refreshLiveBudget().reduction, "no-useful-cut");

		// The resolved output cap changes without a byte of the conversation
		// moving. The reducer never saw this request.
		const resolution = f.runtime.runtimeResolution as unknown as { capabilityDecisions: { maxTokens: number } };
		const cap = resolution.capabilityDecisions.maxTokens;
		resolution.capabilityDecisions.maxTokens = 2048;
		strictEqual(f.context.refreshLiveBudget().reduction, "unknown", "a different resolved cap invalidates the refusal");
		resolution.capabilityDecisions.maxTokens = cap;
		strictEqual(f.context.refreshLiveBudget().reduction, "no-useful-cut", "restoring the cap restores the basis");

		// A recalibrated provider anchor is likewise a different request.
		f.context.reconcileUsage(usage(29_400, 100));
		strictEqual(f.context.refreshLiveBudget().reduction, "unknown", "a recalibrated anchor invalidates the refusal");
	});

	it("labels a pre-runtime view historical and leaves the unresolvable reserve null", () => {
		const f = fixture();
		f.context.setCurrentSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "t1", 0.85));
		f.state.runtime = null;
		const view = f.context.refreshLiveBudget();
		strictEqual(view.historical, true);
		strictEqual(view.inputSource, "historical");
		strictEqual(view.breakdownSource, "captured");
		strictEqual(view.outputReserveTokens, null);
		strictEqual(view.admission.result, "unknown");
		strictEqual(view.pressure, null);
	});

	it("carries an injected continuity projection without implementing one", () => {
		const f = reconciledFixture({
			getPendingHandoff: () => ({ id: "handoff-1", preparedAt: null, sourceRevision: "lb-1-abc" }),
			getLastOutcome: () => {
				throw new Error("projection unavailable");
			},
		});
		const view = f.context.refreshLiveBudget();
		strictEqual(view.pendingHandoff?.id, "handoff-1");
		strictEqual(view.lastOutcome, null, "a throwing projection degrades to null, it does not fail the publication");
	});

	it("re-arms and re-anchors on session navigation", () => {
		const f = reconciledFixture();
		const before = f.context.refreshLiveBudget();
		strictEqual(before.branchAnchorTurnId, null, "no navigation has happened in this process yet");
		f.context.resetForSession("leaf-from-resume");
		const after: LiveBudgetView = f.context.liveBudget();
		strictEqual(after.branchAnchorTurnId, "leaf-from-resume");
		ok(after.revision !== before.revision);
	});
});
