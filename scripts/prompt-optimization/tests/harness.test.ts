/**
 * Offline contract tests for the prompt A/B harness.
 *
 * These live under `scripts/` rather than `tests/contracts/` for two reasons:
 * `scripts/` is excluded from the npm tarball, and keeping them out of the
 * `tests/contracts/*.test.ts` glob keeps a development instrument out of the
 * ordinary CI and release gate. Run them directly:
 *
 *   npm run test:file -- scripts/prompt-optimization/tests/harness.test.ts
 *
 * Nothing here calls a model, touches the network, or spawns an arm.
 */
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertPromptAbComparable,
	blindIdFor,
	buildPromptAbBlindReview,
	comparePromptAbRecords,
	evaluatePromptAbPromotion,
	exactMcNemarP,
	PromptAbDriftError,
} from "../analyze.js";
import { PromptAbConfigError, parsePromptAbConfig, promptAbExperimentHash } from "../config.js";
import type {
	PromptAbArmIdentity,
	PromptAbScenario,
	PromptAbTrialObservation,
	PromptAbTrialRecordV1,
} from "../contract.js";
import { PROMPT_AB_TRIAL_SCHEMA_V1 } from "../contract.js";
import {
	buildPromptAbFreezeRecord,
	developmentCorpus,
	holdoutCorpus,
	loadPromptAbCorpus,
	PromptAbHoldoutLockedError,
	promptAbCorpusHash,
	promptAbScenarioHash,
} from "../corpus.js";
import type { PromptAbTrialRequest } from "../executor.js";
import {
	answerFrom,
	createOfflineExecutor,
	inventedCapabilities,
	knownCapabilities,
	recipeBoundSkills,
	skillsFrom,
	toolCallsFrom,
} from "../executor.js";
import {
	assertDisjointSandboxes,
	createPromptAbSandbox,
	forbiddenStatePaths,
	workspaceMutations,
} from "../isolation.js";
import { openPromptAbStore, PromptAbStoreError, readPromptAbTrialRecords } from "../records.js";
import { buildPromptAbManifest, runPromptAbExperiment } from "../runner.js";
import { buildPromptAbPlan, promptAbOrderBalance } from "../schedule.js";
import { scorePromptAbTrial } from "../scoring.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function armIdentity(id: "A" | "B", suffix: string): PromptAbArmIdentity {
	return {
		id,
		label: `arm ${id}`,
		checkout: `/tmp/arm-${id}`,
		entry: `/tmp/arm-${id}/dist/cli/index.js`,
		commit: `${suffix}0000000`,
		dirty: false,
		buildHash: suffix.repeat(64).slice(0, 64),
		promptFragmentsHash: suffix.repeat(64).slice(0, 64),
		toolCatalogHash: suffix.repeat(64).slice(0, 64),
	};
}

const ARM_A = armIdentity("A", "a");
const ARM_B = armIdentity("B", "b");

function baseObservation(overrides: Partial<PromptAbTrialObservation> = {}): PromptAbTrialObservation {
	return {
		exitCode: 0,
		timedOut: false,
		wallTimeMs: 1_000,
		metrics: { "tools.blocked": 0, "claims.unsupported": 0, "tools.totalCalls": 2, "tokens.input": 3_000 },
		toolCalls: [],
		answerText: "done",
		workspaceMutations: [],
		foreignStatePaths: [],
		inventedCapabilities: [],
		skills: { loaded: [], suggested: [], marketplaceOffers: 0, installAttempts: 0, recipeBound: null },
		receipt: null,
		serving: {
			targetId: "dynamo",
			runtimeId: "lmstudio",
			modelId: "qwen3.8-27b",
			serverBuild: null,
			total_slots: 1,
			thinkingLevel: "medium",
			compiledPromptHash: null,
		},
		transcript: "transcript",
		...overrides,
	};
}

function scenario(id: string, invariants: PromptAbScenario["invariants"]): PromptAbScenario {
	return {
		schema: "clio.eval.prompt-ab.scenario.v1",
		id,
		corpus: "development",
		family: id,
		title: id,
		source: "test",
		runner: {
			prompt: "do the thing",
			autonomy: "auto-edit",
			agent: null,
			skills: [],
			noSkills: false,
			requiredSkills: [],
		},
		workspace: { kind: "fixture", files: [{ path: "a.txt", content: "one\n" }], writable: ["a.txt"], forbidState: [] },
		invariants,
		reviewQuestions: ["was it good?"],
		timeoutMs: 1_000,
	};
}

function trialRecord(overrides: Partial<PromptAbTrialRecordV1>): PromptAbTrialRecordV1 {
	return {
		schema: PROMPT_AB_TRIAL_SCHEMA_V1,
		harnessVersion: 1,
		trialId: "s|cold|r0|A",
		experimentId: "exp",
		experimentHash: "e".repeat(64),
		blockId: "s|cold|r0",
		pairIndex: 0,
		repetition: 0,
		corpus: "development",
		scenarioId: "s",
		scenarioHash: "s".repeat(64),
		stratum: "cold",
		armId: "A",
		startedAt: "2026-09-01T00:00:00.000Z",
		endedAt: "2026-09-01T00:01:00.000Z",
		wallTimeMs: 60_000,
		status: "passed",
		failureClass: null,
		arm: ARM_A,
		pinned: {
			target: "dynamo",
			model: "qwen3.8-27b",
			runtime: "lmstudio",
			thinking: "medium",
			autonomy: "auto-edit",
			toolProfile: null,
			maxContextTokens: 262_144,
			kvCacheMode: "f16",
			sampling: {
				temperature: 0,
				topP: 1,
				topK: 0,
				minP: 0,
				repeatPenalty: 1,
				presencePenalty: 0,
				frequencyPenalty: 0,
			},
			serverConcurrency: 1,
			targetUrl: "http://example.invalid:1234",
		},
		serving: {
			targetId: "dynamo",
			runtimeId: "lmstudio",
			modelId: "qwen3.8-27b",
			serverBuild: "build-1",
			total_slots: 1,
			thinkingLevel: "medium",
			compiledPromptHash: "1".repeat(64),
		},
		metrics: { "tokens.input": 3_000 },
		invariants: [],
		hardGate: { pass: true, failed: [], unresolved: [] },
		transcriptRef: null,
		error: null,
		...overrides,
	};
}

function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------

test("scheduling is balanced, seeded, and reproducible", () => {
	const scenarios = developmentCorpus();
	const input = {
		experimentId: "exp",
		seed: 42,
		repetitions: 6,
		strata: ["cold", "warm"] as const,
		scenarios,
		arms: ["A", "B"] as const,
	};
	const first = buildPromptAbPlan({ ...input, strata: [...input.strata], arms: [...input.arms] });
	const second = buildPromptAbPlan({ ...input, strata: [...input.strata], arms: [...input.arms] });

	// Reproducibility: identical inputs produce an identical plan, trial for trial.
	deepStrictEqual(first, second);
	strictEqual(first.trials.length, scenarios.length * 2 * 6 * 2);

	// Every cell is exactly balanced at an even repetition count.
	for (const [cell, counts] of promptAbOrderBalance(first)) {
		strictEqual(counts.ab, 3, `cell ${cell} AB count`);
		strictEqual(counts.ba, 3, `cell ${cell} BA count`);
	}

	// Both arms appear exactly once per block, adjacent, with distinct pair indices.
	for (const block of first.blocks) {
		strictEqual(block.trials.length, 2);
		deepStrictEqual(
			block.trials.map((trial) => trial.pairIndex),
			[0, 1],
		);
		strictEqual(new Set(block.trials.map((trial) => trial.armId)).size, 2);
		strictEqual(block.trials[0]?.armId, block.order === "AB" ? "A" : "B");
	}

	// A different seed reorders the run without changing its content.
	const reseeded = buildPromptAbPlan({ ...input, seed: 43, strata: [...input.strata], arms: [...input.arms] });
	strictEqual(reseeded.trials.length, first.trials.length);
	deepStrictEqual(
		new Set(reseeded.trials.map((trial) => trial.trialId)),
		new Set(first.trials.map((trial) => trial.trialId)),
	);
	ok(
		reseeded.trials.some((trial, index) => trial.trialId !== first.trials[index]?.trialId),
		"a different seed must produce a different execution order",
	);
});

test("an odd repetition count stays within one block of even in every cell", () => {
	const plan = buildPromptAbPlan({
		experimentId: "exp",
		seed: 7,
		repetitions: 5,
		strata: ["cold"],
		scenarios: developmentCorpus(),
		arms: ["A", "B"],
	});
	for (const [cell, counts] of promptAbOrderBalance(plan)) {
		ok(Math.abs(counts.ab - counts.ba) <= 1, `cell ${cell} is imbalanced: ${counts.ab}/${counts.ba}`);
	}
});

// ---------------------------------------------------------------------------
// corpus and holdout isolation
// ---------------------------------------------------------------------------

test("the corpus encodes both audit families with disjoint ids and stable hashes", () => {
	const development = developmentCorpus();
	strictEqual(development.length, 8, "the audit defines eight development families");

	const freeze = buildPromptAbFreezeRecord({
		experimentId: "exp",
		arms: [ARM_A, ARM_B],
		note: "test",
		frozenAt: "2026-09-01T00:00:00.000Z",
	});
	const holdout = holdoutCorpus(freeze, [ARM_A, ARM_B]);
	strictEqual(holdout.length, 10, "the audit defines ten holdout families");

	const developmentIds = new Set(development.map((entry) => entry.id));
	for (const entry of holdout) ok(!developmentIds.has(entry.id), `${entry.id} appears in both corpora`);

	// Every scenario carries at least one hard gate, and every hard gate is a
	// bounded observation rather than a prose judgement.
	for (const entry of [...development, ...holdout]) {
		ok(
			entry.invariants.some((invariant) => invariant.severity === "hard"),
			`${entry.id} has no hard gate`,
		);
		ok(entry.reviewQuestions.length > 0, `${entry.id} has no blind-review question`);
	}

	// Hashing is stable and content-sensitive.
	strictEqual(promptAbCorpusHash(development), promptAbCorpusHash(developmentCorpus()));
	const mutated = [...development];
	mutated[0] = { ...(mutated[0] as PromptAbScenario), title: "changed" };
	ok(promptAbCorpusHash(mutated) !== promptAbCorpusHash(development), "a changed scenario must change the corpus hash");
	ok(promptAbScenarioHash(development[0] as PromptAbScenario) !== promptAbScenarioHash(mutated[0] as PromptAbScenario));
});

test("holdouts are unreachable during tuning and locked to the frozen arms", () => {
	throws(
		() => loadPromptAbCorpus({ corpus: "holdout", phase: "tuning", arms: [ARM_A, ARM_B], freeze: null }),
		(error: Error) => error instanceof PromptAbHoldoutLockedError && /unavailable during tuning/u.test(error.message),
		"tuning must not reach the holdout corpus",
	);

	throws(
		() => loadPromptAbCorpus({ corpus: "holdout", phase: "frozen", arms: [ARM_A, ARM_B], freeze: null }),
		PromptAbHoldoutLockedError,
		"a frozen run still needs the freeze record",
	);

	const freeze = buildPromptAbFreezeRecord({
		experimentId: "exp",
		arms: [ARM_A, ARM_B],
		note: "test",
		frozenAt: "2026-09-01T00:00:00.000Z",
	});
	strictEqual(loadPromptAbCorpus({ corpus: "holdout", phase: "frozen", arms: [ARM_A, ARM_B], freeze }).length, 10);

	// A post-hoc prompt edit moves the fragments hash and locks the holdouts again.
	const edited: PromptAbArmIdentity = { ...ARM_B, promptFragmentsHash: "c".repeat(64) };
	throws(
		() => loadPromptAbCorpus({ corpus: "holdout", phase: "frozen", arms: [ARM_A, edited], freeze }),
		(error: Error) => error instanceof PromptAbHoldoutLockedError && /post-hoc prompt edit/u.test(error.message),
		"an arm whose prompt moved after the freeze must not reach the holdouts",
	);

	// So does a rebuilt binary.
	throws(
		() =>
			loadPromptAbCorpus({
				corpus: "holdout",
				phase: "frozen",
				arms: [ARM_A, { ...ARM_B, buildHash: "d".repeat(64) }],
				freeze,
			}),
		PromptAbHoldoutLockedError,
	);
});

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

test("hard gates read bounded observations and fail closed when unresolved", () => {
	const spec = scenario("s", [
		{
			id: "no-dispatch",
			severity: "hard",
			expectation: "",
			spec: { kind: "tool-calls", tool: "dispatch", origin: "any", op: "eq", value: 0 },
		},
		{
			id: "budget",
			severity: "hard",
			expectation: "",
			spec: { kind: "tool-call-budget", tools: ["read", "grep"], origin: "parent", op: "lte", value: 2 },
		},
		{ id: "order", severity: "hard", expectation: "", spec: { kind: "tool-order", before: ["read"], after: "edit" } },
		{ id: "scope", severity: "hard", expectation: "", spec: { kind: "mutation-paths-within", allowed: ["a.txt"] } },
		{
			id: "missing-metric",
			severity: "hard",
			expectation: "",
			spec: { kind: "metric", metric: "never.collected", op: "eq", value: 0 },
		},
		{
			id: "observational",
			severity: "observational",
			expectation: "",
			spec: { kind: "metric", metric: "also.missing", op: "eq", value: 0 },
		},
	]);

	const clean = scorePromptAbTrial(
		spec,
		baseObservation({
			toolCalls: [
				{ tool: "read", outcome: "ok", origin: "parent", path: "a.txt", shapeKey: "read:1" },
				{ tool: "edit", outcome: "ok", origin: "parent", path: "a.txt", shapeKey: "edit:1" },
			],
			workspaceMutations: ["a.txt"],
		}),
	);
	// The missing metric fails closed; everything else passes.
	strictEqual(clean.hardGate.pass, false);
	deepStrictEqual(clean.hardGate.unresolved, ["missing-metric"]);
	deepStrictEqual(clean.hardGate.failed, []);
	// An observational invariant never enters the hard gate, resolved or not.
	strictEqual(clean.outcomes.find((outcome) => outcome.id === "observational")?.unresolved, true);

	const dirty = scorePromptAbTrial(
		spec,
		baseObservation({
			metrics: { ...baseObservation().metrics, "never.collected": 0 },
			toolCalls: [
				{ tool: "edit", outcome: "ok", origin: "parent", path: "b.txt", shapeKey: "edit:1" },
				{ tool: "dispatch", outcome: "ok", origin: "parent", path: null, shapeKey: "dispatch:1" },
				{ tool: "read", outcome: "ok", origin: "parent", path: "a.txt", shapeKey: "read:1" },
				{ tool: "read", outcome: "ok", origin: "parent", path: "b.txt", shapeKey: "read:2" },
				{ tool: "grep", outcome: "ok", origin: "parent", path: null, shapeKey: "grep:1" },
			],
			workspaceMutations: ["b.txt"],
		}),
	);
	strictEqual(dirty.hardGate.pass, false);
	deepStrictEqual([...dirty.hardGate.failed].sort(), ["budget", "no-dispatch", "order", "scope"]);
});

test("repeated-rejected-call counts only repeats of a shape that was already refused", () => {
	const spec = scenario("s", [
		{
			id: "no-blind-retry",
			severity: "hard",
			expectation: "",
			spec: { kind: "repeated-rejected-call", op: "eq", value: 0 },
		},
	]);
	const corrected = scorePromptAbTrial(
		spec,
		baseObservation({
			toolCalls: [
				{ tool: "grep", outcome: "error", origin: "parent", path: null, shapeKey: "grep:bad" },
				{ tool: "grep", outcome: "ok", origin: "parent", path: null, shapeKey: "grep:good" },
			],
		}),
	);
	strictEqual(corrected.hardGate.pass, true, "a corrected call is not a blind retry");

	const looped = scorePromptAbTrial(
		spec,
		baseObservation({
			toolCalls: [
				{ tool: "grep", outcome: "error", origin: "parent", path: null, shapeKey: "grep:bad" },
				{ tool: "grep", outcome: "error", origin: "parent", path: null, shapeKey: "grep:bad" },
			],
		}),
	);
	strictEqual(looped.hardGate.pass, false, "repeating a refused shape is a blind retry");
});

test("a receipt invariant is unresolved rather than passing when no receipt was sealed", () => {
	const spec = scenario("s", [
		{
			id: "sealed",
			severity: "hard",
			expectation: "",
			spec: { kind: "receipt", field: "sealed", op: "eq", value: true },
		},
	]);
	const withoutReceipt = scorePromptAbTrial(spec, baseObservation());
	deepStrictEqual(withoutReceipt.hardGate.unresolved, ["sealed"]);

	const withReceipt = scorePromptAbTrial(
		spec,
		baseObservation({
			receipt: {
				count: 1,
				sealed: true,
				integrityValid: true,
				evidenceStatus: "verified",
				claimedVerifiedWithoutEvidence: false,
				parentSpotChecks: 2,
				resultContractValid: true,
			},
		}),
	);
	strictEqual(withReceipt.hardGate.pass, true);
});

test("path, answer, and skill gates read exactly what they claim to", () => {
	const spec = scenario("s", [
		{
			id: "ownership",
			severity: "hard",
			expectation: "",
			spec: { kind: "tool-path-scope", tools: ["edit"], origin: "parent", forbidden: ["src/owned.ts"] },
		},
		{ id: "cites", severity: "hard", expectation: "", spec: { kind: "answer-matches", pattern: "code-nav\\.ts" } },
		{ id: "omits", severity: "hard", expectation: "", spec: { kind: "answer-omits", pattern: "web_find" } },
		{ id: "skills", severity: "hard", expectation: "", spec: { kind: "skills-loaded", expected: ["clio-coder-dev"] } },
	]);

	const good = scorePromptAbTrial(
		spec,
		baseObservation({
			toolCalls: [{ tool: "edit", outcome: "ok", origin: "worker", path: "src/owned.ts", shapeKey: "e:1" }],
			answerText: "defined in src/tools/codewiki/code-nav.ts",
			skills: { loaded: ["clio-coder-dev"], suggested: [], marketplaceOffers: 0, installAttempts: 0, recipeBound: null },
		}),
	);
	strictEqual(good.hardGate.pass, true, "a worker editing its own assigned file is fine");

	const bad = scorePromptAbTrial(
		spec,
		baseObservation({
			toolCalls: [{ tool: "edit", outcome: "ok", origin: "parent", path: "src/owned.ts", shapeKey: "e:1" }],
			answerText: "you can use web_find for that",
			skills: {
				loaded: ["clio-coder-dev", "other"],
				suggested: [],
				marketplaceOffers: 0,
				installAttempts: 0,
				recipeBound: null,
			},
		}),
	);
	deepStrictEqual([...bad.hardGate.failed].sort(), ["cites", "omits", "ownership", "skills"]);
});

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------

test("each trial gets a fresh, disjoint sandbox with all five Clio roots pinned inside it", () => {
	const spec = developmentCorpus()[0] as PromptAbScenario;
	const pinned = trialRecord({}).pinned;
	const first = createPromptAbSandbox(spec, pinned);
	const second = createPromptAbSandbox(spec, pinned);
	try {
		assertDisjointSandboxes(first, second);
		for (const key of [
			"CLIO_CODER_HOME",
			"CLIO_CODER_CONFIG_DIR",
			"CLIO_CODER_DATA_DIR",
			"CLIO_CODER_STATE_DIR",
			"CLIO_CODER_CACHE_DIR",
		]) {
			const value = first.env[key];
			ok(value?.startsWith(first.home), `${key} must live inside the sandbox home`);
			ok(second.env[key] !== value, `${key} must differ between two sandboxes`);
		}
		strictEqual(first.env.CLIO_CODER_REQUIRE_HOME_PREFIX, "1", "a leak must crash, not contaminate");

		// The pinned target is written into the trial's own settings, so the
		// operator's real configuration never enters the experiment.
		const settings = readFileSync(join(first.home, "config", "settings.yaml"), "utf8");
		ok(settings.includes(`id: ${pinned.target}`) && settings.includes(pinned.model));

		// A clean sandbox reports no mutation; a written file reports exactly one.
		deepStrictEqual(workspaceMutations(first), []);
		writeFileSync(join(first.workspace, "src/rate-limit.ts"), "changed\n", "utf8");
		deepStrictEqual(workspaceMutations(first), ["src/rate-limit.ts"]);

		// Forbidden state is detected only when it actually appears.
		const foreign = developmentCorpus().find((entry) => entry.workspace.forbidState.length > 0) as PromptAbScenario;
		const foreignSandbox = createPromptAbSandbox(foreign, pinned);
		try {
			deepStrictEqual(forbiddenStatePaths(foreignSandbox, foreign), []);
			writeFileSync(join(foreignSandbox.workspace, ".clio-coder"), "leaked", "utf8");
			deepStrictEqual(forbiddenStatePaths(foreignSandbox, foreign), [".clio-coder"]);
		} finally {
			foreignSandbox.dispose();
		}
	} finally {
		first.dispose();
		second.dispose();
	}
});

// ---------------------------------------------------------------------------
// records, resume, failure recording
// ---------------------------------------------------------------------------

test("the trial log is append-only, resumable, and refuses a foreign experiment", async () => {
	const dir = scratch("clio-prompt-ab-store-");
	try {
		const config = testConfig(dir);
		const scenarios = [scenario("s1", []), scenario("s2", [])];
		const manifest = buildPromptAbManifest(config, [ARM_A, ARM_B], "c".repeat(64), 8, "2026-09-01T00:00:00.000Z");

		const plan = buildPromptAbPlan({
			experimentId: config.experimentId,
			seed: config.seed,
			repetitions: config.repetitions,
			strata: config.strata,
			scenarios,
			arms: ["A", "B"],
		});
		const observations = new Map(plan.trials.map((trial) => [trial.trialId, baseObservation()]));

		// First pass runs everything.
		const firstStore = openPromptAbStore(manifest, dir);
		const first = await runPromptAbExperiment({
			config,
			scenarios,
			arms: [ARM_A, ARM_B],
			executor: createOfflineExecutor(observations),
			store: firstStore,
			retainTranscripts: false,
		});
		strictEqual(first.executed, plan.trials.length);
		strictEqual(first.skipped, 0);

		// Second pass re-plans and skips everything already recorded.
		const secondStore = openPromptAbStore(manifest, dir);
		const second = await runPromptAbExperiment({
			config,
			scenarios,
			arms: [ARM_A, ARM_B],
			executor: createOfflineExecutor(new Map()),
			store: secondStore,
			retainTranscripts: false,
		});
		strictEqual(second.executed, 0, "a completed run re-runs nothing");
		strictEqual(second.skipped, plan.trials.length);
		strictEqual(readPromptAbTrialRecords(dir).length, plan.trials.length);

		// A torn final line is the shape of an interrupted write: it is dropped,
		// and that trial simply re-runs.
		appendFileSync(join(dir, "trials.jsonl"), '{"schema":"clio.eval.prompt-ab.tri', "utf8");
		strictEqual(readPromptAbTrialRecords(dir).length, plan.trials.length);

		// A different experiment may not share the log.
		throws(
			() => openPromptAbStore({ ...manifest, experimentHash: "f".repeat(64) }, dir),
			(error: Error) => error instanceof PromptAbStoreError && /mixing two experiments/u.test(error.message),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an executor failure is recorded as an error trial, not dropped", async () => {
	const dir = scratch("clio-prompt-ab-fail-");
	try {
		const config = { ...testConfig(dir), repetitions: 1, strata: ["cold" as const] };
		const scenarios = [scenario("s1", [])];
		const manifest = buildPromptAbManifest(config, [ARM_A, ARM_B], "c".repeat(64), 2, "2026-09-01T00:00:00.000Z");
		const store = openPromptAbStore(manifest, dir);
		const result = await runPromptAbExperiment({
			config,
			scenarios,
			arms: [ARM_A, ARM_B],
			executor: {
				execute(request: PromptAbTrialRequest): Promise<PromptAbTrialObservation> {
					return Promise.reject(new Error(`spawn refused for ${request.trialId}`));
				},
			},
			store,
			retainTranscripts: false,
		});
		strictEqual(result.executed, 2);
		const records = readPromptAbTrialRecords(dir);
		strictEqual(records.length, 2);
		for (const record of records) {
			strictEqual(record.status, "error");
			strictEqual(record.failureClass, "executor_error");
			strictEqual(record.hardGate.pass, false);
			ok(record.error?.message.includes("spawn refused"), "the failure reason is kept");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// comparison and drift refusal
// ---------------------------------------------------------------------------

test("comparison refuses uncontrolled serving drift and a null treatment", () => {
	const a = trialRecord({});
	const b = trialRecord({
		trialId: "s|cold|r0|B",
		armId: "B",
		arm: ARM_B,
		serving: { ...a.serving, compiledPromptHash: "2".repeat(64) },
	});

	// The controlled case is comparable.
	assertPromptAbComparable([a, b]);

	// A server rebuild between arms is drift.
	throws(
		() => assertPromptAbComparable([a, { ...b, serving: { ...b.serving, serverBuild: "build-2" } }]),
		(error: Error) => error instanceof PromptAbDriftError && /serving configurations/u.test(error.message),
	);

	// So is a changed slot count, a changed model, and a changed pin.
	throws(() => assertPromptAbComparable([a, { ...b, serving: { ...b.serving, total_slots: 4 } }]), PromptAbDriftError);
	throws(() => assertPromptAbComparable([a, { ...b, serving: { ...b.serving, modelId: "other" } }]), PromptAbDriftError);
	throws(
		() =>
			assertPromptAbComparable([
				a,
				{ ...b, pinned: { ...b.pinned, sampling: { ...b.pinned.sampling, temperature: 0.7 } } },
			]),
		PromptAbDriftError,
	);

	// Two prompts for the same scenario, stratum, and arm is drift: that cell is
	// not a controlled repetition.
	throws(
		() =>
			assertPromptAbComparable([
				a,
				{ ...a, trialId: "s|cold|r1|A", repetition: 1, serving: { ...a.serving, compiledPromptHash: "9".repeat(64) } },
				b,
			]),
		(error: Error) => error instanceof PromptAbDriftError && /not a controlled repetition/u.test(error.message),
	);

	// But an arm compiling different prompts for *different* scenarios is the
	// product's dynamic compilation working, not drift. Requiring one hash per
	// arm across the corpus refused every real run: an observed 26-trial arm
	// compiled 10 distinct prompts, all correct.
	assertPromptAbComparable([
		a,
		b,
		{ ...a, trialId: "t|cold|r0|A", scenarioId: "t", serving: { ...a.serving, compiledPromptHash: "7".repeat(64) } },
		{
			...b,
			trialId: "t|cold|r0|B",
			scenarioId: "t",
			serving: { ...b.serving, compiledPromptHash: "8".repeat(64) },
		},
	]);

	// Different autonomy or persona across strata is likewise fine.
	assertPromptAbComparable([
		a,
		b,
		{ ...a, trialId: "s|warm|r0|A", stratum: "warm", serving: { ...a.serving, compiledPromptHash: "5".repeat(64) } },
		{
			...b,
			trialId: "s|warm|r0|B",
			stratum: "warm",
			serving: { ...b.serving, compiledPromptHash: "6".repeat(64) },
		},
	]);

	// Two arms with the same compiled prompt are not an A/B at all.
	throws(
		() => assertPromptAbComparable([a, { ...b, serving: { ...a.serving } }]),
		(error: Error) => error instanceof PromptAbDriftError && /no treatment to measure/u.test(error.message),
	);
});

test("paired comparison pairs by trial id, excludes errored pairs, and is deterministic", () => {
	const records: PromptAbTrialRecordV1[] = [];
	for (let rep = 0; rep < 4; rep++) {
		const baseServing = trialRecord({}).serving;
		records.push(
			trialRecord({
				trialId: `s|cold|r${rep}|A`,
				repetition: rep,
				metrics: { "tokens.input": 4_000 },
				hardGate: { pass: rep !== 3, failed: rep === 3 ? ["x"] : [], unresolved: [] },
			}),
			trialRecord({
				trialId: `s|cold|r${rep}|B`,
				armId: "B",
				arm: ARM_B,
				repetition: rep,
				metrics: { "tokens.input": 3_400 },
				serving: { ...baseServing, compiledPromptHash: "2".repeat(64) },
				hardGate: { pass: true, failed: [], unresolved: [] },
			}),
		);
	}
	// One errored pair must not be counted on either side.
	records.push(
		trialRecord({ trialId: "s|cold|r9|A", repetition: 9, status: "error", metrics: {} }),
		trialRecord({ trialId: "s|cold|r9|B", armId: "B", arm: ARM_B, repetition: 9, status: "error", metrics: {} }),
	);

	const comparison = comparePromptAbRecords({
		records,
		baselineArm: "A",
		candidateArm: "B",
		metrics: ["tokens.input"],
		seed: 1,
	});
	strictEqual(comparison.unpaired, 1, "the errored pair is excluded");
	strictEqual(comparison.cells.length, 1);
	strictEqual(comparison.cells[0]?.pairs, 4);
	strictEqual(comparison.cells[0]?.candidateOnlyPass, 1);
	strictEqual(comparison.cells[0]?.baselineOnlyPass, 0);
	strictEqual(comparison.candidateHardPassRate, 1);
	strictEqual(comparison.baselineHardPassRate, 0.75);

	const delta = comparison.metricDeltas[0];
	strictEqual(delta?.metric, "tokens.input");
	strictEqual(delta?.baselineMedian, 4_000);
	strictEqual(delta?.candidateMedian, 3_400);
	strictEqual(Math.round((delta?.relativeDelta ?? 0) * 1000) / 1000, -0.15);

	// The seeded bootstrap gives the same interval every time.
	const repeat = comparePromptAbRecords({
		records,
		baselineArm: "A",
		candidateArm: "B",
		metrics: ["tokens.input"],
		seed: 1,
	});
	deepStrictEqual(repeat.metricDeltas, comparison.metricDeltas);
});

test("exact McNemar matches the hand-computed binomial tail", () => {
	strictEqual(exactMcNemarP(0, 0), 1);
	strictEqual(exactMcNemarP(0, 5), 2 / 32);
	strictEqual(exactMcNemarP(3, 3), 1);
	ok(exactMcNemarP(1, 7) < 0.1);
});

// ---------------------------------------------------------------------------
// blind review and promotion
// ---------------------------------------------------------------------------

test("blind review hides the arm and is a deterministic, reversible mapping", () => {
	const records = [
		trialRecord({ trialId: "s|cold|r0|A" }),
		trialRecord({ trialId: "s|cold|r0|B", armId: "B", arm: ARM_B }),
	];
	const items = buildPromptAbBlindReview(records, new Map([["s", ["was it good?"]]]), 5);
	strictEqual(items.length, 2);
	for (const item of items) {
		ok(!/\|A$|\|B$/u.test(item.blindId), "the blind id must not carry the arm");
		ok(!JSON.stringify(item).includes('"armId"'), "an exported item must not name its arm");
		deepStrictEqual(item.questions, ["was it good?"]);
	}
	// Sorted by blind id, so ordering leaks nothing either.
	deepStrictEqual(
		[...items].sort((l, r) => l.blindId.localeCompare(r.blindId)),
		items,
	);
	// Reversible from the seed, which is what makes unblinding a join.
	strictEqual(blindIdFor("s|cold|r0|A", 5), items.find((i) => i.blindId === blindIdFor("s|cold|r0|A", 5))?.blindId);
	ok(blindIdFor("s|cold|r0|A", 5) !== blindIdFor("s|cold|r0|A", 6), "a different seed reblinds");
});

test("promotion requires every gate, and reports missing data as unmet rather than passing", () => {
	const records: PromptAbTrialRecordV1[] = [];
	for (let rep = 0; rep < 5; rep++) {
		const baseServing = trialRecord({}).serving;
		records.push(
			trialRecord({
				trialId: `dev.self-query-foreign-cwd|cold|r${rep}|A`,
				scenarioId: "dev.self-query-foreign-cwd",
				repetition: rep,
				metrics: { "tokens.input": 4_000, "tokens.cacheReadRatio": 0.5 },
			}),
			trialRecord({
				trialId: `dev.self-query-foreign-cwd|cold|r${rep}|B`,
				scenarioId: "dev.self-query-foreign-cwd",
				armId: "B",
				arm: ARM_B,
				repetition: rep,
				metrics: { "tokens.input": 3_400, "tokens.cacheReadRatio": 0.6 },
				serving: { ...baseServing, compiledPromptHash: "2".repeat(64) },
				invariants: [
					{
						id: "no-safety-blocks",
						severity: "hard",
						expectation: "",
						pass: true,
						unresolved: false,
						actual: 0,
						detail: "",
					},
				],
			}),
		);
	}
	const development = comparePromptAbRecords({
		records,
		baselineArm: "A",
		candidateArm: "B",
		metrics: ["tokens.input", "tokens.cacheReadRatio"],
		seed: 1,
	});

	// No holdout run yet: the holdout gate is unmet and promotion is blocked.
	const withoutHoldout = evaluatePromptAbPromotion({
		development,
		holdout: null,
		developmentRecords: records,
		holdoutRecords: [],
		nonInferiorityPoints: 2,
		requiredTokenReduction: 0.1,
	});
	strictEqual(withoutHoldout.promote, false);
	strictEqual(withoutHoldout.gates.find((gate) => gate.id === "holdouts-pass")?.status, "unmet");
	strictEqual(withoutHoldout.gates.find((gate) => gate.id === "input-token-reduction")?.status, "pass");
	strictEqual(withoutHoldout.gates.find((gate) => gate.id === "zero-tolerance")?.status, "pass");
	// The warm stratum was never run, so its gate is unmet, not passed.
	strictEqual(withoutHoldout.gates.find((gate) => gate.id === "warm-cache-not-worse")?.status, "unmet");

	// A zero-tolerance violation in the candidate fails outright.
	const violating = records.map((record) =>
		record.armId === "B"
			? {
					...record,
					invariants: [
						{
							id: "no-invented-capabilities",
							severity: "hard" as const,
							expectation: "",
							pass: false,
							unresolved: false,
							actual: 1,
							detail: "",
						},
					],
				}
			: record,
	);
	const failed = evaluatePromptAbPromotion({
		development,
		holdout: null,
		developmentRecords: violating,
		holdoutRecords: [],
		nonInferiorityPoints: 2,
		requiredTokenReduction: 0.1,
	});
	strictEqual(failed.gates.find((gate) => gate.id === "zero-tolerance")?.status, "fail");
	strictEqual(failed.promote, false);
});

// ---------------------------------------------------------------------------
// configuration and stream reduction
// ---------------------------------------------------------------------------

test("the configuration parser pins sampling and refuses to default it", () => {
	const dir = scratch("clio-prompt-ab-config-");
	try {
		const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "experiment.dynamo-qwen38-27b.json"), "utf8"));
		const parsed = parsePromptAbConfig(raw, dir);
		strictEqual(parsed.pinned.model, "qwen3.8-27b");
		strictEqual(parsed.repetitions, 5);
		deepStrictEqual([...parsed.strata], ["cold", "warm"]);

		// The experiment hash moves with anything that changes the trials' meaning.
		const reseeded = parsePromptAbConfig({ ...raw, seed: raw.seed + 1 }, dir);
		ok(promptAbExperimentHash(parsed) !== promptAbExperimentHash(reseeded));
		strictEqual(promptAbExperimentHash(parsed), promptAbExperimentHash(parsePromptAbConfig(raw, dir)));

		// A missing sampling parameter is an error, never a default.
		const { temperature: _dropped, ...restSampling } = raw.pinned.sampling;
		throws(
			() => parsePromptAbConfig({ ...raw, pinned: { ...raw.pinned, sampling: restSampling } }, dir),
			(error: Error) => error instanceof PromptAbConfigError && /never defaulted/u.test(error.message),
		);

		// Two arms pointed at one checkout is not an A/B.
		throws(
			() => parsePromptAbConfig({ ...raw, arms: [raw.arms[0], { ...raw.arms[1], checkout: raw.arms[0].checkout }] }, dir),
			(error: Error) => error instanceof PromptAbConfigError && /independently built/u.test(error.message),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stream reduction attributes parent and worker calls and spots an invented capability", () => {
	const stream = [
		JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/a.ts" } }),
		JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "read", outcome: "ok" }),
		JSON.stringify({
			type: "clio_coder_tool_start",
			payload: { toolCallId: "2", tool: "edit", args: { path: "src/b.ts" } },
		}),
		JSON.stringify({ type: "clio_coder_tool_finish", payload: { toolCallId: "2", tool: "edit", outcome: "blocked" } }),
		"not json at all",
	].join("\n");
	const calls = toolCallsFrom(stream, "/work");
	strictEqual(calls.length, 2);
	strictEqual(calls[0]?.origin, "parent");
	strictEqual(calls[0]?.path, "src/a.ts");
	strictEqual(calls[1]?.origin, "worker");
	strictEqual(calls[1]?.outcome, "blocked");

	// A dispatched-agent run is the worker, so every call is the worker's even
	// though pi's `tool_execution_*` family is emitted for all of them. Without
	// this, a real `--agent` run showed 15 pi events and 15 Clio events for 15
	// calls and every one was attributed to the parent, so no worker-origin gate
	// could ever fire.
	const asWorker = toolCallsFrom(stream, "/work", true);
	deepStrictEqual(
		asWorker.map((call) => call.origin),
		["worker", "worker"],
	);

	deepStrictEqual(inventedCapabilities("try `web_find` for that", ["code_nav", "ask_user"]), ["web_find"]);
	deepStrictEqual(inventedCapabilities("use `code_nav` instead", ["code_nav"]), []);
	deepStrictEqual(inventedCapabilities("the word `hello` is not a tool", ["code_nav"]), []);
});

/**
 * Pinned against the real shapes a `clio-coder run --json` stream emits, taken
 * from a live Dynamo run. Both of these were wrong on the first pass and cost
 * nothing to get wrong silently: an empty answer makes every answer-matching
 * gate read as vacuous, and a settings file the binary rejects makes every
 * trial an executor error.
 */
test("answer text is folded from text deltas, not from the stripped message_end summary", () => {
	const stream = [
		JSON.stringify({ type: "session", version: 4, id: "abc123", target: "dynamo", model: "qwen3.8-27b" }),
		JSON.stringify({ type: "thinking_delta", contentIndex: 0, delta: "the user wants " }),
		JSON.stringify({ type: "thinking_delta", contentIndex: 0, delta: "me to reason" }),
		JSON.stringify({ type: "text_delta", contentIndex: 1, delta: "defined in " }),
		JSON.stringify({ type: "text_delta", contentIndex: 1, delta: "src/tools/codewiki/code-nav.ts" }),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinkingSignature: "reasoning_content", streamed: true, thinkingLength: 26 },
					{ type: "text", streamed: true, textLength: 40 },
				],
				usage: { input: 11_379, output: 104, cacheRead: 0, cacheWrite: 0, totalTokens: 11_483 },
			},
		}),
	].join("\n");

	// message_end carries only textLength, so folding it would give "".
	strictEqual(answerFrom(stream), "defined in src/tools/codewiki/code-nav.ts");
	// Reasoning is not the answer; a gate must never match against the scratchpad.
	ok(!answerFrom(stream).includes("the user wants"));
});

test("the capability inventory is read from the arm's real ToolNames table", () => {
	// Regression: this used to scrape builtin-tool-catalog.ts, which keys its
	// entries by the ToolNames.X constant and only mentions ids inside prose.
	// The resulting inventory omitted real tools, so the gate reported `code_nav`
	// as an invented capability on every single answer.
	const names = knownCapabilities({ ...ARM_A, checkout: process.cwd() });
	for (const real of ["read", "grep", "code_nav", "context", "dispatch", "bash", "edit", "write"]) {
		ok(names.includes(real), `${real} must be in the inventory read from src/core/tool-names.ts`);
	}
	deepStrictEqual(inventedCapabilities("use `code_nav` and `web_find`", names), ["web_find"]);
	// An unreadable checkout disables the check rather than failing every answer.
	deepStrictEqual(knownCapabilities({ ...ARM_A, checkout: "/nonexistent-checkout" }), []);
});

test("the claims gate applies only where a receipt is actually sealed", () => {
	// claims.unsupported is receipt-derived. Gating it on a main-agent scenario
	// makes it permanently unresolved: it would fail identically in both arms
	// and contribute only noise to the paired comparison.
	for (const entry of [
		...developmentCorpus(),
		...holdoutCorpus(
			buildPromptAbFreezeRecord({
				experimentId: "e",
				arms: [ARM_A, ARM_B],
				note: "",
				frozenAt: "2026-09-01T00:00:00.000Z",
			}),
			[ARM_A, ARM_B],
		),
	]) {
		const gatesClaims = entry.invariants.some((invariant) => invariant.id === "no-unsupported-claims");
		const dispatches =
			entry.runner.agent !== null || entry.invariants.some((invariant) => invariant.spec.kind === "receipt");
		strictEqual(gatesClaims, dispatches, `${entry.id} gates claims without sealing a receipt (or the reverse)`);
	}
});

test("the isolated settings file is the schema the binary actually accepts", () => {
	const spec = developmentCorpus()[0] as PromptAbScenario;
	const sandbox = createPromptAbSandbox(spec, trialRecord({}).pinned);
	try {
		const settings = readFileSync(join(sandbox.home, "config", "settings.yaml"), "utf8");
		// `version: 2` and a `chat:` block are required; a top-level
		// `defaultTarget` key is rejected outright by config validation.
		ok(settings.startsWith("version: 2\n"), "settings must declare the schema version");
		ok(/^chat:$/mu.test(settings), "settings must carry the chat block");
		ok(!settings.includes("defaultTarget"), "defaultTarget is not a valid settings key");
		// Without a fleet block there is no worker target and dispatch cannot
		// fire, so every delegation gate read 0-pass in both arms: the sandbox
		// had nowhere to delegate to, which is not a fact about either prompt.
		ok(/^fleet:$/mu.test(settings), "settings must carry a fleet block or dispatch cannot fire");
		ok(settings.includes("  profiles:"), "the fleet block must define a worker profile");
	} finally {
		sandbox.dispose();
	}
});

test("skill activity is read from context call arguments, not from skill events", () => {
	// Regression: this looked for stream events whose type contained "skill".
	// There are none, so `loads-exactly-the-named-skill` read 0-pass in both arms
	// on trials where the model had loaded the skill correctly. The real signal
	// is the context call itself.
	const stream = [
		JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "context",
			args: { scope: "skills", name: "clio-coder-dev" },
		}),
		JSON.stringify({ type: "tool_execution_start", toolCallId: "2", toolName: "context", args: { scope: "docs" } }),
		JSON.stringify({ type: "tool_execution_start", toolCallId: "3", toolName: "read", args: { path: "a.ts" } }),
	].join("\n");

	const loadedOnly = skillsFrom(stream, "I loaded it and made the change.");
	deepStrictEqual(loadedOnly.loaded, ["clio-coder-dev"]);
	deepStrictEqual(loadedOnly.suggested, []);
	strictEqual(loadedOnly.marketplaceOffers, 0);

	// An unsolicited proposal counts; echoing back the skill it actually loaded
	// is the operator's own request, not a suggestion.
	const suggesting = skillsFrom(stream, "Run /skill tdd next. I used /skill clio-coder-dev as you asked.");
	deepStrictEqual(suggesting.suggested, ["tdd"]);
	strictEqual(skillsFrom(stream, "[Marketplace] offer for /skill herdr").marketplaceOffers, 1);
});

test("a scenario's required skills are installed from its own arm's checkout", () => {
	// A fresh Clio home ships no skills, so `/skill clio-coder-dev` could never
	// succeed and `loads-exactly-the-named-skill` was 0-pass in both arms across
	// every trial - a gate measuring the empty sandbox rather than either prompt.
	const named = developmentCorpus().find((entry) => entry.runner.requiredSkills.length > 0);
	ok(named !== undefined, "at least one scenario must declare a required skill");
	const sandbox = createPromptAbSandbox(named, trialRecord({}).pinned, {
		armCheckout: process.cwd(),
		installSkills: named.runner.requiredSkills,
	});
	try {
		for (const skill of named.runner.requiredSkills) {
			const installed = join(sandbox.home, "config", "skills", skill, "SKILL.md");
			ok(readFileSync(installed, "utf8").includes(`name: ${skill}`), `${skill} must be installed into the trial home`);
		}
	} finally {
		sandbox.dispose();
	}
});

function testConfig(dir: string) {
	return {
		schema: "clio.eval.prompt-ab.config.v1" as const,
		harnessVersion: 1,
		experimentId: "exp",
		seed: 11,
		repetitions: 2,
		corpus: "development" as const,
		phase: "tuning" as const,
		strata: ["cold" as const, "warm" as const],
		arms: [
			{ id: "A" as const, label: "a", checkout: "/tmp/arm-A", entry: "dist/cli/index.js", commit: null },
			{ id: "B" as const, label: "b", checkout: "/tmp/arm-B", entry: "dist/cli/index.js", commit: null },
		],
		pinned: trialRecord({}).pinned,
		warm: { prefixTurns: ["ready"] },
		outDir: dir,
		coldResetSettleMs: 0,
		coldResetCommand: null,
	};
}

// ---------------------------------------------------------------------------
// recipe-bound skill expectation (measurement defect 8)
// ---------------------------------------------------------------------------

test("recipeBoundSkills reads the arm's own recipe, and reports null when it cannot", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-ab-recipe-"));
	try {
		const builtins = join(root, "src/domains/agents/builtins");
		mkdirSync(builtins, { recursive: true });
		writeFileSync(
			join(builtins, "coder.md"),
			"---\nversion: 1\nname: Coder\nskills: [fix-issue, ship]\n---\n\n# Coder\n",
			"utf8",
		);
		writeFileSync(
			join(builtins, "debugger.md"),
			"---\nversion: 1\nname: Debugger\nskills: []\n---\n\n# Debugger\n",
			"utf8",
		);
		const arm = { checkout: root } as unknown as PromptAbArmIdentity;
		deepStrictEqual(recipeBoundSkills(arm, "coder"), ["fix-issue", "ship"]);
		deepStrictEqual(recipeBoundSkills(arm, "debugger"), []);
		strictEqual(recipeBoundSkills(arm, "nonexistent"), null, "an unreadable recipe must not invent an expectation");
		strictEqual(recipeBoundSkills(arm, null), null, "a main-agent run has no recipe to bind");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the repaired gate passes the worker that loaded exactly its recipe's bound skills", () => {
	// The event shapes are the ones the recorded `dev.recipe-bound-worker-skill`
	// trial actually emitted: a `context` call per bound skill, which is how the
	// worker loads what its recipe named. The old gate expected clio-coder-dev
	// and failed all six of these.
	const stdout = [
		'{"type":"tool_execution_start","payload":{"toolCallId":"1","toolName":"context","args":{"scope":"skills","name":"fix-issue"}}}',
		'{"type":"tool_execution_start","payload":{"toolCallId":"2","toolName":"context","args":{"scope":"skills","name":"ship"}}}',
	].join("\n");
	const observed = skillsFrom(stdout, "");
	deepStrictEqual(observed.loaded, ["fix-issue", "ship"]);

	const spec = scenario("bound-worker", [
		{
			id: "bound",
			severity: "hard",
			expectation: "The worker loaded its recipe's bound skills and no other.",
			spec: { kind: "skills-match-recipe-bound" },
		},
	]);

	const matching = scorePromptAbTrial(
		spec,
		baseObservation({ skills: { ...observed, recipeBound: ["ship", "fix-issue"] } }),
	);
	strictEqual(matching.hardGate.pass, true, "order must not matter; the sets are equal");

	const extra = scorePromptAbTrial(spec, baseObservation({ skills: { ...observed, recipeBound: ["fix-issue"] } }));
	deepStrictEqual(extra.hardGate.failed, ["bound"], "loading a skill the recipe does not bind still fails");

	const unreadable = scorePromptAbTrial(spec, baseObservation({ skills: { ...observed, recipeBound: null } }));
	deepStrictEqual(unreadable.hardGate.unresolved, ["bound"], "an unreadable recipe fails closed, never silently passes");
});

test("--max-pairs stops on a block boundary and never leaves an unpaired arm", async () => {
	const dir = scratch("clio-prompt-ab-canary-");
	try {
		const config = testConfig(dir);
		const scenarios = [scenario("s1", [])];
		const manifest = buildPromptAbManifest(config, [ARM_A, ARM_B], "d".repeat(64), 8, "2026-09-01T00:00:00.000Z");
		const plan = buildPromptAbPlan({
			experimentId: config.experimentId,
			seed: config.seed,
			repetitions: config.repetitions,
			strata: config.strata,
			scenarios,
			arms: ["A", "B"],
		});
		const observations = new Map(plan.trials.map((trial) => [trial.trialId, baseObservation()]));

		const canary = await runPromptAbExperiment({
			config,
			scenarios,
			arms: [ARM_A, ARM_B],
			executor: createOfflineExecutor(observations),
			store: openPromptAbStore(manifest, dir),
			retainTranscripts: false,
			maxBlocks: 2,
		});
		ok(canary.executed < plan.trials.length, "a canary must not run the whole plan");
		const byBlock = new Map<string, string[]>();
		for (const record of canary.records) {
			byBlock.set(record.blockId, [...(byBlock.get(record.blockId) ?? []), record.armId]);
		}
		strictEqual(byBlock.size, 2, "exactly two blocks were started");
		for (const [blockId, armIds] of byBlock) {
			deepStrictEqual([...armIds].sort(), ["A", "B"], `block ${blockId} must carry both arms`);
		}

		// Resuming is additive: the recorded canary trials are skipped and the
		// remaining plan runs, so a canary never costs a trial.
		const rest = await runPromptAbExperiment({
			config,
			scenarios,
			arms: [ARM_A, ARM_B],
			executor: createOfflineExecutor(observations),
			store: openPromptAbStore(manifest, dir),
			retainTranscripts: false,
		});
		strictEqual(rest.skipped, canary.executed);
		strictEqual(rest.executed + canary.executed, plan.trials.length);

		// A resumed run's already-recorded history must not consume the next
		// invocation's budget, or a second canary would execute nothing.
		const second = await runPromptAbExperiment({
			config,
			scenarios,
			arms: [ARM_A, ARM_B],
			executor: createOfflineExecutor(observations),
			store: openPromptAbStore(manifest, dir),
			retainTranscripts: false,
			maxBlocks: 1,
		});
		strictEqual(second.executed, 0, "nothing is left to run");
		strictEqual(second.skipped, plan.trials.length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
