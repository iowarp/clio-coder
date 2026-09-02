#!/usr/bin/env node
/**
 * CLI for the prompt A/B harness.
 *
 * Development instrument only. Nothing here is shipped: `scripts/` is absent
 * from the package.json `files` allowlist, so this tree never enters the npm
 * tarball, `dist`, or any runtime code path.
 *
 *   node --import tsx scripts/prompt-optimization/run.ts plan    --config <file>
 *   node --import tsx scripts/prompt-optimization/run.ts run     --config <file> [--live] [--allow-dirty]
 *   node --import tsx scripts/prompt-optimization/run.ts freeze  --config <file> --note "<why>"
 *   node --import tsx scripts/prompt-optimization/run.ts compare --config <file>
 *   node --import tsx scripts/prompt-optimization/run.ts promote --config <file>
 *
 * `run` refuses to call a model unless `--live` is passed. The default is a
 * dry run that builds and prints the plan, so an accidental invocation costs
 * nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildPromptAbBlindReview, comparePromptAbRecords, evaluatePromptAbPromotion } from "./analyze.js";
import { assertPromptAbArmsDiffer, promptAbArmDelta, resolvePromptAbArm } from "./arms.js";
import { parsePromptAbConfig, promptAbExperimentHash } from "./config.js";
import type { PromptAbArmIdentity, PromptAbScenario } from "./contract.js";
import {
	buildPromptAbFreezeRecord,
	loadPromptAbCorpus,
	parsePromptAbFreezeRecord,
	promptAbCorpusHash,
} from "./corpus.js";
import { createLiveExecutor, knownCapabilities } from "./executor.js";
import { openPromptAbStore, readPromptAbTrialRecords } from "./records.js";
import { buildPromptAbManifest, runPromptAbExperiment } from "./runner.js";
import { buildPromptAbPlan, promptAbOrderBalance } from "./schedule.js";

const FREEZE_FILE = "freeze.json";

/** Metrics the paired comparison reports a delta for. */
const COMPARISON_METRICS = [
	// The deterministic per-turn system-prompt size. This is the audit's actual
	// subject; tokens.input confounds it with how many turns a run accumulated.
	"prompt.systemTokenEstimate",
	"tokens.input",
	"tokens.total",
	"tokens.cacheRead",
	"tokens.cacheReadRatio",
	"tools.totalCalls",
	"tools.failed",
];

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const configPath = flagValue(argv, "--config");
	if (command === undefined || configPath === undefined) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	const resolvedConfig = resolve(configPath);
	const config = parsePromptAbConfig(JSON.parse(readFileSync(resolvedConfig, "utf8")), dirname(resolvedConfig));
	const allowDirty = argv.includes("--allow-dirty");
	const allowIdentical = argv.includes("--allow-identical-arms");

	const arms = config.arms.map((arm) => resolvePromptAbArm(arm, { allowDirty }));
	assertPromptAbArmsDiffer(arms, allowIdentical);

	const freeze = readFreeze(config.outDir);
	const loaded = loadPromptAbCorpus({ corpus: config.corpus, phase: config.phase, arms, freeze });
	// `--only` narrows the corpus to a comma-separated set of scenario ids. It
	// is what lets several workstreams run different families on different
	// nodes at once. It changes which trials exist, so the manifest records the
	// resulting corpus hash and a promotion decision reads that, not the name of
	// the full corpus.
	const only = flagValue(argv, "--only");
	const wanted = only === undefined ? null : new Set(only.split(",").map((id) => id.trim()));
	const scenarios = wanted === null ? loaded : loaded.filter((entry) => wanted.has(entry.id));
	if (scenarios.length === 0) {
		process.stderr.write(`--only ${String(only)} matched no scenario in the ${config.corpus} corpus\n`);
		return 2;
	}
	if (wanted !== null) {
		const missing = [...wanted].filter((id) => !scenarios.some((entry) => entry.id === id));
		if (missing.length > 0) {
			process.stderr.write(`--only names unknown scenarios: ${missing.join(", ")}\n`);
			return 2;
		}
	}

	switch (command) {
		case "plan":
			return commandPlan(config, scenarios, arms);
		case "run":
			return await commandRun(config, scenarios, arms, argv.includes("--live"), maxBlocks(argv));
		case "freeze":
			return commandFreeze(config, arms, flagValue(argv, "--note") ?? "arms frozen before the holdout run");
		case "compare":
			return commandCompare(config, scenarios);
		case "promote":
			return commandPromote(config);
		default:
			process.stderr.write(`unknown command ${command}\n${usage()}\n`);
			return 2;
	}
}

function commandPlan(
	config: ReturnType<typeof parsePromptAbConfig>,
	scenarios: readonly PromptAbScenario[],
	arms: readonly PromptAbArmIdentity[],
): number {
	const plan = buildPromptAbPlan({
		experimentId: config.experimentId,
		seed: config.seed,
		repetitions: config.repetitions,
		strata: config.strata,
		scenarios,
		arms: arms.map((arm) => arm.id),
	});
	const balance = promptAbOrderBalance(plan);
	const imbalanced = [...balance.entries()].filter(([, cell]) => Math.abs(cell.ab - cell.ba) > 1);
	process.stdout.write(
		[
			`experiment ${config.experimentId} (${promptAbExperimentHash(config).slice(0, 12)})`,
			`corpus ${config.corpus} hash ${promptAbCorpusHash(scenarios).slice(0, 12)} (${scenarios.length} scenarios)`,
			`arms ${arms.map((arm) => `${arm.id}=${arm.buildHash.slice(0, 12)}@${arm.commit?.slice(0, 8) ?? "unknown"}`).join(" ")}`,
			`delta ${JSON.stringify(arms.length === 2 ? promptAbArmDelta(arms[0] as PromptAbArmIdentity, arms[1] as PromptAbArmIdentity) : {})}`,
			`blocks ${plan.blocks.length}, trials ${plan.trials.length}, cells ${balance.size}`,
			`order balance: ${imbalanced.length === 0 ? "every cell within one block of even" : `IMBALANCED ${imbalanced.length} cells`}`,
			"",
		].join("\n"),
	);
	return imbalanced.length === 0 ? 0 : 1;
}

/**
 * `--max-pairs N`: stop after N complete AB/BA blocks in this invocation.
 *
 * A canary has to stop where the evidence is interpretable. Stopping mid-block
 * leaves an unpaired arm the comparison then excludes, so the budget is counted
 * in blocks. Absent means run the whole plan.
 */
function maxBlocks(argv: readonly string[]): number | undefined {
	const raw = flagValue(argv, "--max-pairs");
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--max-pairs must be a positive integer, got ${raw}`);
	return parsed;
}

async function commandRun(
	config: ReturnType<typeof parsePromptAbConfig>,
	scenarios: readonly PromptAbScenario[],
	arms: readonly PromptAbArmIdentity[],
	live: boolean,
	maxPairs: number | undefined,
): Promise<number> {
	if (!live) {
		process.stdout.write("dry run: pass --live to execute trials against the pinned target\n");
		return commandPlan(config, scenarios, arms);
	}
	const plan = buildPromptAbPlan({
		experimentId: config.experimentId,
		seed: config.seed,
		repetitions: config.repetitions,
		strata: config.strata,
		scenarios,
		arms: arms.map((arm) => arm.id),
	});
	const manifest = buildPromptAbManifest(
		config,
		arms,
		promptAbCorpusHash(scenarios),
		plan.trials.length,
		new Date().toISOString(),
	);
	const store = openPromptAbStore(manifest, config.outDir);
	const executor = createLiveExecutor({
		coldResetCommand: config.coldResetCommand,
		coldResetSettleMs: config.coldResetSettleMs,
		knownCapabilities: knownCapabilities(arms[0] as PromptAbArmIdentity),
	});
	const result = await runPromptAbExperiment({
		config,
		scenarios,
		arms,
		executor,
		store,
		retainTranscripts: true,
		...(maxPairs === undefined ? {} : { maxBlocks: maxPairs }),
		onTrial: (record) => {
			process.stdout.write(
				`${record.trialId} ${record.status}` +
					`${record.hardGate.failed.length > 0 ? ` failed=${record.hardGate.failed.join(",")}` : ""}` +
					`${record.hardGate.unresolved.length > 0 ? ` unresolved=${record.hardGate.unresolved.join(",")}` : ""}\n`,
			);
		},
	});
	process.stdout.write(`planned ${result.planned}, executed ${result.executed}, resumed-skipped ${result.skipped}\n`);
	return 0;
}

function commandFreeze(
	config: ReturnType<typeof parsePromptAbConfig>,
	arms: readonly PromptAbArmIdentity[],
	note: string,
): number {
	const record = buildPromptAbFreezeRecord({
		experimentId: config.experimentId,
		arms,
		note,
		frozenAt: new Date().toISOString(),
	});
	writeFileSync(join(config.outDir, FREEZE_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	process.stdout.write(
		`froze ${arms.length} arms; holdouts now unlock only for build hashes ` +
			`${arms.map((arm) => `${arm.id}=${arm.buildHash.slice(0, 12)}`).join(" ")}\n`,
	);
	return 0;
}

function commandCompare(
	config: ReturnType<typeof parsePromptAbConfig>,
	scenarios: readonly PromptAbScenario[],
): number {
	const records = readPromptAbTrialRecords(config.outDir);
	if (records.length === 0) {
		process.stderr.write("no trial records to compare\n");
		return 1;
	}
	const [baseline, candidate] = config.arms.map((arm) => arm.id) as [
		PromptAbArmIdentity["id"],
		PromptAbArmIdentity["id"],
	];
	const comparison = comparePromptAbRecords({
		records,
		baselineArm: baseline,
		candidateArm: candidate,
		metrics: COMPARISON_METRICS,
		seed: config.seed,
	});
	process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);

	const blind = buildPromptAbBlindReview(
		records,
		new Map(scenarios.map((scenario) => [scenario.id, scenario.reviewQuestions])),
		config.seed,
	);
	writeFileSync(join(config.outDir, "blind-review.json"), `${JSON.stringify(blind, null, 2)}\n`, "utf8");
	process.stdout.write(`wrote ${blind.length} blinded review items to blind-review.json\n`);
	return 0;
}

function commandPromote(config: ReturnType<typeof parsePromptAbConfig>): number {
	const records = readPromptAbTrialRecords(config.outDir);
	const development = records.filter((record) => record.corpus === "development");
	const holdout = records.filter((record) => record.corpus === "holdout");
	const [baseline, candidate] = config.arms.map((arm) => arm.id) as [
		PromptAbArmIdentity["id"],
		PromptAbArmIdentity["id"],
	];
	const developmentComparison = comparePromptAbRecords({
		records: development,
		baselineArm: baseline,
		candidateArm: candidate,
		metrics: COMPARISON_METRICS,
		seed: config.seed,
	});
	const holdoutComparison =
		holdout.length === 0
			? null
			: comparePromptAbRecords({
					records: holdout,
					baselineArm: baseline,
					candidateArm: candidate,
					metrics: COMPARISON_METRICS,
					seed: config.seed,
				});
	const verdict = evaluatePromptAbPromotion({
		development: developmentComparison,
		holdout: holdoutComparison,
		developmentRecords: development,
		holdoutRecords: holdout,
		nonInferiorityPoints: 2,
		requiredTokenReduction: 0.1,
	});
	for (const gate of verdict.gates) {
		process.stdout.write(`[${gate.status.toUpperCase().padEnd(5)}] ${gate.id}: ${gate.detail}\n`);
	}
	process.stdout.write(`\npromote: ${verdict.promote ? "yes" : "no"}\n`);
	return verdict.promote ? 0 : 1;
}

function readFreeze(outDir: string) {
	try {
		return parsePromptAbFreezeRecord(JSON.parse(readFileSync(join(outDir, FREEZE_FILE), "utf8")));
	} catch {
		return null;
	}
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

function usage(): string {
	return [
		"usage: node --import tsx scripts/prompt-optimization/run.ts <command> --config <file>",
		"commands: plan | run [--live] | freeze --note <why> | compare | promote",
		"flags:    --allow-dirty  --allow-identical-arms  --only <id[,id...]>",
	].join("\n");
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
