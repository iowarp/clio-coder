import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	foldTaskMemorySpend,
	formatTaskMemorySpend,
	proposeInjectedTaskMemory,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	type TaskMemoryModelClient,
	type TaskMemoryStepUsage,
} from "../../src/domains/memory/index.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { runTaskMemoryPolicy } from "../../src/domains/memory/task-memory-policy.js";
import type { TaskMemoryTelemetryStep } from "../../src/domains/memory/task-memory-telemetry.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { createCostTracker } from "../../src/domains/observability/cost.js";
import { readOutOfTurnUsageRows, recordBackgroundMemoryStep } from "../../src/domains/observability/index.js";
import { foregroundStreamUsage, registerForegroundStream } from "../../src/domains/providers/index.js";
import { aggregateCostEntries } from "../../src/interactive/cost-overlay.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const BASE_INPUT = {
	task: "Close the memory spend accounting gap.",
	trajectory: [],
	deterministicTrigger: false,
	maxTokens: 100,
} as const;

function usage(overrides: Partial<TaskMemoryStepUsage> = {}): TaskMemoryStepUsage {
	return {
		targetId: "mini",
		attributedModelId: "qwen3.8-27b-dense",
		input: 4_120,
		output: 96,
		cacheRead: 3_900,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 4_216,
		costUsd: 0,
		costProvenance: "known_free",
		durationMs: 18_400,
		backend: {
			promptTokens: 4_120,
			cachedTokens: 3_900,
			predictedTokens: 96,
			promptMs: 1_240,
			predictedMs: 17_100,
			source: "llamacpp-timings",
		},
		...overrides,
	};
}

function clientReporting(text: string, stepUsage: TaskMemoryStepUsage): TaskMemoryModelClient {
	return {
		async complete() {
			return { text, usage: stepUsage };
		},
	};
}

describe("contracts/proactive memory spend", { concurrency: false }, () => {
	/**
	 * The tier spent 137,205 tokens over 14 days on the operator's machine and no
	 * surface carried a single one of them (#229). A step now reports its
	 * provider usage, that usage becomes one labelled cost entry plus one durable
	 * out-of-turn row, and `/cost` folds the entry into its own memory line.
	 */
	it("bills a completed step to the cost ledger and to the durable out-of-turn store", async () => {
		const scratch = makeScratchHome("clio-memory-spend-");
		try {
			const bank = new TaskMemoryBank();
			const reported: TaskMemoryStepUsage[] = [];
			const registration = createMemoryInterventionRegistration({
				bank,
				getModelClient: () => clientReporting("<operations>[]</operations>\n<no_intervention/>", usage()),
				onStepUsage: (stepUsage) => reported.push(stepUsage),
			});

			const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "spend" });

			strictEqual(result.decision, "silent");
			strictEqual(reported.length, 1, "a model step that answered must report what it cost");
			// A step that decided to say nothing spent the same prefill as one that
			// produced a reminder, so silence is billed exactly the same way.
			strictEqual(reported[0]?.totalTokens, 4_216);

			const tracker = createCostTracker();
			const stateDir = join(scratch.dir, "state");
			mkdirSync(stateDir, { recursive: true });
			const row = recordBackgroundMemoryStep({
				usage: reported[0],
				stateDir,
				sessionId: "session-spend",
				repoIdentity: "repo-hash",
				observability: {
					recordTokens: (providerId, modelId, tokens, costUsd, breakdown, provenance, _facts, label) => {
						tracker.accumulate(providerId, modelId, tokens, costUsd, breakdown, provenance, undefined, label);
					},
				},
			});

			strictEqual(row.label, "background-memory");
			strictEqual(row.timing?.durationMs, 18_400);
			strictEqual(row.promptCache?.uncachedPrefillTokens, 220);

			const rows = aggregateCostEntries(tracker.entries());
			strictEqual(rows.length, 1);
			strictEqual(rows[0]?.backgroundMemory, 1, "/cost must count the step under its own origin");
			strictEqual(rows[0]?.tokens, 4_216);
			strictEqual(rows[0]?.providerId, "mini");

			const durable = readOutOfTurnUsageRows(stateDir);
			deepStrictEqual(durable.errors, []);
			strictEqual(durable.rows.length, 1);
			strictEqual(durable.rows[0]?.label, "background-memory");
			strictEqual(durable.rows[0]?.usage.totalTokens, 4_216);
			strictEqual(durable.rows[0]?.timing?.durationMs, 18_400);
			strictEqual(durable.rows[0]?.promptCache?.cachedTokens, 3_900);
		} finally {
			scratch.cleanup();
		}
	});

	/**
	 * A step that holds a local server for its whole budget and answers nothing
	 * used to be filed as `silent`, which is the same row a model that read the
	 * trajectory and chose not to speak produces. The two call for opposite
	 * responses, so the deadline is now its own outcome on both paths: the
	 * policy's own race and the transport aborting at its deadline first.
	 */
	it("records a timed-out step as a timeout rather than as silence", async () => {
		strictEqual(
			TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
			30_000,
			"the bounded default is the contract; a turn boundary cannot wait three minutes",
		);
		strictEqual(DEFAULT_SETTINGS.memory.intervention.timeoutMs, 30_000);

		const raced = await runTaskMemoryPolicy(
			new TaskMemoryBank(),
			{ complete: () => new Promise(() => {}) },
			{ ...BASE_INPUT, timeoutMs: 20 },
		);
		strictEqual(raced.decision, "timeout");
		strictEqual(raced.reason, "deadline");

		const aborted = await runTaskMemoryPolicy(
			new TaskMemoryBank(),
			{
				async complete() {
					throw Object.assign(new Error("model completion aborted"), { name: "AbortError" });
				},
			},
			{ ...BASE_INPUT, timeoutMs: 30_000 },
		);
		strictEqual(aborted.decision, "timeout");
		strictEqual(aborted.reason, "timed_out");

		// A route that refused the connection is still a client error; the two
		// diagnoses stay distinguishable.
		const refused = await runTaskMemoryPolicy(
			new TaskMemoryBank(),
			{
				async complete() {
					throw new Error("connect ECONNREFUSED 192.168.86.141:8080");
				},
			},
			{ ...BASE_INPUT, timeoutMs: 30_000 },
		);
		strictEqual(refused.decision, "silent");
		strictEqual(refused.reason, "client_error");
	});

	/**
	 * On a single-slot local server a memory step started during a turn either
	 * queues behind the operator's own decoding or makes the server evict the
	 * resident model to serve it. The boundary is skipped instead, and the skip
	 * is recorded so a starved cadence is not read as a quiet one.
	 */
	it("skips a step whose endpoint is serving the chat stream and records the skip", async () => {
		const endpointKey = "http://192.168.86.141:8080";
		const release = registerForegroundStream(endpointKey);
		try {
			const steps: TaskMemoryTelemetryStep[] = [];
			let modelCalls = 0;
			const registration = createMemoryInterventionRegistration({
				bank: new TaskMemoryBank(),
				telemetry: { record: (step) => steps.push(step) },
				getModelClient: () => ({
					async complete() {
						modelCalls += 1;
						return { text: "<operations>[]</operations>\n<no_intervention/>" };
					},
				}),
				// The predicate the composition root wires: the background route's
				// endpoint key against the streams registered on this process.
				backgroundEndpointBusy: () => (foregroundStreamUsage()[endpointKey] ?? 0) > 0,
			});

			const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "busy endpoint" });

			strictEqual(modelCalls, 0, "the resident model must never be evicted by a background step");
			strictEqual(result.reason, "endpoint_busy");
			strictEqual(result.usage, null);
			strictEqual(steps.length, 1);
			strictEqual(steps[0]?.tier, "llm");
			strictEqual(steps[0]?.decision, "dropped");
			strictEqual(steps[0]?.reason, "endpoint_busy");
			strictEqual(steps[0]?.inputTokens, 0);

			release();
			const ran = await registration.runPromptedStep({ deterministicTrigger: true, task: "free endpoint" });
			strictEqual(modelCalls, 1, "the next free boundary runs the step the busy one declined");
			strictEqual(ran.reason, "model_silent");
		} finally {
			release();
		}
	});

	/**
	 * The task bank and `records.json` were two stores where only one was ever
	 * written. An injected reminder's cited entries are now proposed for review,
	 * so `clio-coder memory list` shows what the tier produced.
	 */
	it("writes an injected step's cited entries into the store memory list reads", async () => {
		const scratch = makeScratchHome("clio-memory-store-");
		try {
			const repository = join(scratch.dir, "repository");
			mkdirSync(repository, { recursive: true });
			const bank = new TaskMemoryBank();
			const knowledge = bank.saveKnowledge("The boundary checker refuses a value import of a domain extension.");
			const proposed: string[] = [];
			const registration = createMemoryInterventionRegistration({
				bank,
				getModelClient: () =>
					clientReporting(
						`<operations>[]</operations>\n<context_for_action>[${knowledge.id}] the boundary checker refuses this import.</context_for_action>`,
						usage(),
					),
				onInjectedEntries: (entries) => {
					void proposeInjectedTaskMemory(join(scratch.dir, "data"), {
						sessionId: "session-injected",
						cwd: repository,
						entries,
					}).then((result) => {
						for (const record of result.records) proposed.push(record.id);
						deepStrictEqual(result.errors, []);
					});
				},
			});

			const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "store" });
			strictEqual(result.decision, "injected");
			// The store write is a promise the step deliberately does not await.
			await new Promise((resolve) => setTimeout(resolve, 50));
			strictEqual(proposed.length, 1, "an injected reminder proposes the entry it cited");

			const listed = await runCli(["memory", "list"], { env: scratch.env });
			strictEqual(listed.code, 0, listed.stderr);
			match(listed.stdout, /1 memory record/u);
			match(listed.stdout, /proposed/u);
			match(listed.stdout, /boundary checker refuses a value import/u);
			ok(listed.stdout.includes(proposed[0] ?? "missing"), "the listed record is the one the step proposed");
			match(listed.stdout, /key: promotion:task-bank-entry:session-injected:/u);
		} finally {
			scratch.cleanup();
		}
	});
});

describe("contracts/proactive memory spend ledger", () => {
	/**
	 * The hit rate is the figure the default decision rests on, and it is folded
	 * from rows the sink was already writing. Rules-tier steps are free and are
	 * excluded, so the rate answers what the model plane bought.
	 */
	it("folds the llm tier's lifetime spend and hit rate out of the telemetry rows", () => {
		const row = (over: Record<string, unknown>): string =>
			JSON.stringify({
				version: 2,
				at: "2026-08-20T10:00:00.000Z",
				triggerReasons: ["interval"],
				tier: "llm",
				bankDelta: {
					status: { added: 0, updated: 0, deleted: 0 },
					knowledge: { added: 0, updated: 0, deleted: 0 },
					procedural: { added: 0, updated: 0, deleted: 0 },
				},
				decision: "silent",
				reason: "model_silent",
				bankOperations: 0,
				droppedOperations: 0,
				citedEntries: 0,
				tokenCost: { input: 4_000, output: 100, total: 4_100 },
				latencyMs: 20_000,
				...over,
			});

		const summary = foldTaskMemorySpend([
			row({}),
			row({ at: "2026-08-21T10:00:00.000Z", decision: "injected", reason: "intervened", citedEntries: 1 }),
			row({ at: "2026-08-22T10:00:00.000Z", decision: "timeout", reason: "timed_out", latencyMs: 102_500 }),
			row({ at: "2026-08-23T10:00:00.000Z", tier: "rules", tokenCost: { input: 0, output: 0, total: 0 } }),
			row({ at: "2026-08-24T10:00:00.000Z", tier: "rules", decision: "dropped", reason: "endpoint_busy" }),
			"not json at all",
		]);

		strictEqual(summary.llmSteps, 3, "a rules-tier step costs nothing and is not part of the rate");
		strictEqual(summary.injections, 1);
		strictEqual(summary.hitRate, 1 / 3);
		strictEqual(summary.totalTokens, 12_300);
		strictEqual(summary.timeouts, 1);
		strictEqual(summary.slowestStepMs, 102_500);
		strictEqual(summary.endpointBusySkips, 1);
		strictEqual(summary.firstAt, "2026-08-20T10:00:00.000Z");
		strictEqual(summary.lastAt, "2026-08-24T10:00:00.000Z");
		match(formatTaskMemorySpend(summary), /spend 3 steps · 12\.3k tok · 2\.4m · hit 1\/3 \(33%\)/u);
	});

	it("reports no spend at all when the model tier has never run", () => {
		strictEqual(formatTaskMemorySpend(foldTaskMemorySpend([])), "");
	});
});
