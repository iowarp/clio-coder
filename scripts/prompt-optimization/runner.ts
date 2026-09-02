/**
 * The run loop: plan, skip what is already recorded, execute, score, append.
 *
 * Nothing here decides anything the plan did not already decide. The plan is a
 * pure function of the configuration, the store is append-only, and a trial
 * that throws is recorded as an error rather than dropped — a run whose
 * failures vanish reports a pass rate over a sample it silently chose.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptAbExperimentConfig } from "./config.js";
import { promptAbExperimentHash } from "./config.js";
import type {
	PromptAbArmIdentity,
	PromptAbFailureClass,
	PromptAbManifestV1,
	PromptAbScenario,
	PromptAbTrialRecordV1,
} from "./contract.js";
import { PROMPT_AB_HARNESS_VERSION, PROMPT_AB_MANIFEST_SCHEMA_V1, PROMPT_AB_TRIAL_SCHEMA_V1 } from "./contract.js";
import { promptAbScenarioHash } from "./corpus.js";
import type { PromptAbTrialExecutor } from "./executor.js";
import type { PromptAbStore } from "./records.js";
import { buildPromptAbPlan } from "./schedule.js";
import { scorePromptAbTrial } from "./scoring.js";

export interface RunPromptAbInput {
	config: PromptAbExperimentConfig;
	scenarios: readonly PromptAbScenario[];
	arms: readonly PromptAbArmIdentity[];
	executor: PromptAbTrialExecutor;
	store: PromptAbStore;
	/** Retain each trial's transcript for blind review. */
	retainTranscripts: boolean;
	/** Called after each trial so a long run reports progress. */
	onTrial?: (record: PromptAbTrialRecordV1) => void;
	/**
	 * Stop after this many blocks have been completed in this invocation.
	 *
	 * A canary needs to stop where the evidence is interpretable, and that is a
	 * block boundary: a block is the AB/BA pair, so stopping inside one leaves an
	 * unpaired arm that the comparison must then exclude. Counting blocks rather
	 * than trials makes "run two pairs, look, then continue" exact instead of a
	 * race against an interrupt. Resume is unaffected — the plan is recomputed
	 * and recorded trials are skipped.
	 */
	maxBlocks?: number;
}

export interface RunPromptAbResult {
	planned: number;
	executed: number;
	skipped: number;
	records: readonly PromptAbTrialRecordV1[];
}

export function buildPromptAbManifest(
	config: PromptAbExperimentConfig,
	arms: readonly PromptAbArmIdentity[],
	corpusHash: string,
	plannedTrials: number,
	createdAt: string,
): PromptAbManifestV1 {
	return {
		schema: PROMPT_AB_MANIFEST_SCHEMA_V1,
		harnessVersion: PROMPT_AB_HARNESS_VERSION,
		experimentId: config.experimentId,
		experimentHash: promptAbExperimentHash(config),
		corpus: config.corpus,
		corpusHash,
		phase: config.phase,
		seed: config.seed,
		repetitions: config.repetitions,
		strata: config.strata,
		arms: arms.map((arm) => ({ ...arm })),
		pinned: config.pinned,
		createdAt,
		plannedTrials,
	};
}

export async function runPromptAbExperiment(input: RunPromptAbInput): Promise<RunPromptAbResult> {
	const { config, scenarios, arms, store } = input;
	const plan = buildPromptAbPlan({
		experimentId: config.experimentId,
		seed: config.seed,
		repetitions: config.repetitions,
		strata: config.strata,
		scenarios,
		arms: arms.map((arm) => arm.id),
	});
	const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
	const armsById = new Map(arms.map((arm) => [arm.id, arm]));
	const done = new Set(store.completed);
	const transcriptDir = join(store.dir, "transcripts");
	if (input.retainTranscripts) mkdirSync(transcriptDir, { recursive: true });

	const records: PromptAbTrialRecordV1[] = [];
	let executed = 0;
	let skipped = 0;

	// Blocks whose every trial is now recorded, counted only for blocks this
	// invocation actually ran, so a resume's skipped history never consumes the
	// canary's budget.
	const startedBlocks = new Set<string>();
	const completedBlocks = new Set<string>();
	const blockSize = new Map<string, number>();
	const blockDone = new Map<string, number>();
	for (const planned of plan.trials) {
		blockSize.set(planned.blockId, (blockSize.get(planned.blockId) ?? 0) + 1);
	}

	for (const planned of plan.trials) {
		if (done.has(planned.trialId)) {
			skipped += 1;
			blockDone.set(planned.blockId, (blockDone.get(planned.blockId) ?? 0) + 1);
			continue;
		}
		if (input.maxBlocks !== undefined && completedBlocks.size >= input.maxBlocks && !startedBlocks.has(planned.blockId)) {
			break;
		}
		startedBlocks.add(planned.blockId);
		const scenario = scenariosById.get(planned.scenarioId);
		const arm = armsById.get(planned.armId);
		if (scenario === undefined || arm === undefined) {
			throw new Error(`plan references unknown scenario or arm for trial ${planned.trialId}`);
		}

		const startedAt = new Date();
		let record: PromptAbTrialRecordV1;
		try {
			const observation = await input.executor.execute({
				trialId: planned.trialId,
				scenario,
				arm,
				pinned: config.pinned,
				stratum: planned.stratum,
				warmPrefix: config.warm.prefixTurns,
			});
			const score = scorePromptAbTrial(scenario, observation);
			let transcriptRef: string | null = null;
			if (input.retainTranscripts && observation.transcript.length > 0) {
				transcriptRef = join("transcripts", `${planned.trialId.replaceAll("|", "__")}.txt`);
				writeFileSync(join(store.dir, transcriptRef), observation.transcript, "utf8");
			}
			const failureClass: PromptAbFailureClass | null = observation.timedOut
				? "timeout"
				: score.hardGate.pass
					? null
					: "hard_gate_failed";
			record = {
				schema: PROMPT_AB_TRIAL_SCHEMA_V1,
				harnessVersion: PROMPT_AB_HARNESS_VERSION,
				trialId: planned.trialId,
				experimentId: config.experimentId,
				experimentHash: store.manifest.experimentHash,
				blockId: planned.blockId,
				pairIndex: planned.pairIndex,
				repetition: planned.repetition,
				corpus: config.corpus,
				scenarioId: scenario.id,
				scenarioHash: promptAbScenarioHash(scenario),
				stratum: planned.stratum,
				armId: arm.id,
				startedAt: startedAt.toISOString(),
				endedAt: new Date().toISOString(),
				wallTimeMs: observation.wallTimeMs,
				status: score.hardGate.pass ? "passed" : "failed",
				failureClass,
				arm: { ...arm },
				pinned: config.pinned,
				serving: observation.serving,
				metrics: observation.metrics,
				invariants: score.outcomes,
				hardGate: score.hardGate,
				transcriptRef,
				error: null,
			};
		} catch (error) {
			// An executor failure is a recorded result, not a gap. A run that
			// silently drops the trials that crashed reports a pass rate over a
			// sample it chose for itself.
			record = {
				schema: PROMPT_AB_TRIAL_SCHEMA_V1,
				harnessVersion: PROMPT_AB_HARNESS_VERSION,
				trialId: planned.trialId,
				experimentId: config.experimentId,
				experimentHash: store.manifest.experimentHash,
				blockId: planned.blockId,
				pairIndex: planned.pairIndex,
				repetition: planned.repetition,
				corpus: config.corpus,
				scenarioId: planned.scenarioId,
				scenarioHash: promptAbScenarioHash(scenario),
				stratum: planned.stratum,
				armId: planned.armId,
				startedAt: startedAt.toISOString(),
				endedAt: new Date().toISOString(),
				wallTimeMs: Date.now() - startedAt.getTime(),
				status: "error",
				failureClass: "executor_error",
				arm: { ...arm },
				pinned: config.pinned,
				serving: {
					targetId: config.pinned.target,
					runtimeId: config.pinned.runtime,
					modelId: config.pinned.model,
					serverBuild: null,
					total_slots: config.pinned.serverConcurrency,
					thinkingLevel: config.pinned.thinking,
					compiledPromptHash: null,
				},
				metrics: {},
				invariants: [],
				hardGate: { pass: false, failed: [], unresolved: ["executor"] },
				transcriptRef: null,
				error: { message: error instanceof Error ? error.message : String(error) },
			};
		}

		store.append(record);
		records.push(record);
		executed += 1;
		input.onTrial?.(record);

		const finished = (blockDone.get(planned.blockId) ?? 0) + 1;
		blockDone.set(planned.blockId, finished);
		if (finished >= (blockSize.get(planned.blockId) ?? 0)) completedBlocks.add(planned.blockId);
	}

	return { planned: plan.trials.length, executed, skipped, records };
}
