import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateGate } from "../../src/domains/eval/compare/gates.js";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SOAK_SUITE = fileURLToPath(new URL("../../benchmarks/soak/clio-soak.yaml", import.meta.url));
const BOUNDARY_SUITE = fileURLToPath(new URL("../../benchmarks/soak/clio-soak-boundary.yaml", import.meta.url));
const BUILT_CLIO_ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

/**
 * A Clio that seals whatever this fixture tells it to. It stands in for the
 * real binary so the soak's own gate can be exercised against a machinery
 * failure without a provider, which is the only way to know the gate can fail
 * at all.
 */
function fakeClio(entryPath: string, body: string): void {
	writeFileSync(
		entryPath,
		[
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"const stateDir = process.env.CLIO_CODER_STATE_DIR;",
			"if (stateDir === undefined) { process.stderr.write('no state dir\\n'); process.exit(90); }",
			"mkdirSync(join(stateDir, 'receipts'), { recursive: true });",
			"mkdirSync(join(stateDir, 'sessions', 'cwd-hash', 'session-1'), { recursive: true });",
			"writeFileSync(join(stateDir, 'sessions', 'cwd-hash', 'session-1', 'current.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: '2026-08-06T00:00:00.000Z', cwd: process.cwd() }) + '\\n');",
			"const runId = 'soakrun00001';",
			body,
			"process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 2, totalTokens: 5 } } }) + '\\n');",
		].join("\n"),
		"utf8",
	);
}

const SEALED_RECEIPT = [
	"const receipt = {",
	"  runId, agentId: 'main-agent', executionRole: 'builder', task: 'soak',",
	"  targetId: 'mini', wireModelId: 'model', runtimeId: 'llamacpp', runtimeKind: 'http',",
	"  outcome: 'succeeded', exitCode: 0, startedAt: '2026-08-06T00:00:00.000Z', endedAt: '2026-08-06T00:00:01.000Z',",
	"  lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },",
	"  tokenCount: 5, costUsd: 0, sessionId: null, toolCalls: 0, toolStats: [],",
	"  integrity: { version: 15, algorithm: 'sha256', digest: 'f'.repeat(64) },",
	"};",
	"writeFileSync(join(stateDir, 'receipts', runId + '.json'), JSON.stringify(receipt, null, 2));",
	"writeFileSync(join(stateDir, 'runs.json'), JSON.stringify([{ id: runId, agentId: 'main-agent' }]));",
].join("\n");

async function runSoakAgainst(entryBody: string | null): Promise<{ gatePass: boolean; failures: string[] }> {
	const root = mkdtempSync(join(tmpdir(), "clio-soak-suite-"));
	try {
		const entry = join(root, "fake-clio.mjs");
		fakeClio(entry, entryBody ?? "");
		const loaded = await loadEvalSuiteFile(SOAK_SUITE);
		// One task, one repeat: this exercises the shipped suite's thresholds,
		// not its matrix breadth.
		const suite = { ...loaded.suite, tasks: loaded.suite.tasks.slice(0, 1) };
		const artifact = await runEvalSuiteV2({ ...loaded, suite }, { clioEntry: entry });
		const thresholds = suite.thresholds;
		if (thresholds === undefined) throw new Error("the shipped soak suite must declare thresholds");
		const gate = evaluateGate(artifact, thresholds);
		return { gatePass: gate.pass, failures: gate.failures.map((failure) => failure.assertion.metric) };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("contracts/soak suite", { concurrency: false }, () => {
	it("every shipped soak suite file still loads", async () => {
		// The boundary, chaos, and loop suites have no runner in CI; this is the
		// one place a schema change finds them before an operator does.
		for (const name of ["clio-soak", "clio-soak-boundary", "clio-soak-chaos", "clio-soak-loop"]) {
			const loaded = await loadEvalSuiteFile(
				fileURLToPath(new URL(`../../benchmarks/soak/${name}.yaml`, import.meta.url)),
			);
			strictEqual(loaded.suite.suite.id, name);
			ok(loaded.suite.tasks.length > 0, `${name} must declare tasks`);
		}
	});

	it("ships a suite whose fixture, setup, and thresholds all load", async () => {
		const loaded = await loadEvalSuiteFile(SOAK_SUITE);

		strictEqual(loaded.suite.suite.id, "clio-soak");
		ok(loaded.suite.tasks.length > 0);
		for (const task of loaded.suite.tasks) {
			// Every soak task measures the outcome and asserts nothing about it.
			ok((task.verify.measure ?? []).length > 0, `${task.id} must measure the task outcome`);
			// Task assertions carry surface-specific invariants and never the task
			// outcome: a model that failed the workload must not fail the item.
			for (const assertion of task.verify.assertions ?? []) {
				strictEqual(assertion.metric.startsWith("task."), false, `${task.id} must not gate on ${assertion.metric}`);
			}
			ok((task.workspace.setup ?? []).length > 0, `${task.id} must seed its fixture`);
		}
		ok((loaded.suite.thresholds?.fail ?? []).length > 0, "the soak gates on invariants");
		const mainAgent = loaded.suite.tasks.find((task) => task.id === "single-file-bug.main-agent");
		const dispatch = loaded.suite.tasks.find((task) => task.id === "single-file-bug.dispatch");
		const ledgerAssertions = [
			"ledger.formatVersion",
			"ledger.toolPairsUnmatched",
			"ledger.assistantBetweenCallAndResult",
		];
		for (const metric of ledgerAssertions) {
			ok(
				(mainAgent?.verify.assertions ?? []).some((assertion) => assertion.metric === metric),
				`${metric} must gate main-agent`,
			);
			strictEqual(
				(dispatch?.verify.assertions ?? []).some((assertion) => assertion.metric === metric),
				false,
				`${metric} is absent on dispatch`,
			);
			strictEqual(
				loaded.suite.thresholds?.fail.some((assertion) => assertion.metric === metric),
				false,
				`${metric} is not surface-independent`,
			);
		}
		const continuity = loaded.suite.tasks.find((task) => task.id === "compaction-continuity.main-agent");
		strictEqual(continuity?.runner.kind, "external-command");
		strictEqual(continuity?.runner.commands?.length, 3);
		for (const command of continuity?.runner.commands ?? []) ok(command.includes('node "$CLIO_CODER_ENTRY" run'));
		ok(continuity?.runner.commands?.[1]?.includes("--continue"));
		ok(continuity?.runner.commands?.[2]?.includes("CLIO_CODER_FORCE_COMPACT=1"));
		for (const metric of ["continuity.compactionSummaryPresent", "continuity.answeredFromPreCompaction"]) {
			ok(
				(continuity?.verify.assertions ?? []).some((assertion) => assertion.metric === metric),
				`${metric} must gate only the continuity task`,
			);
			strictEqual(
				loaded.suite.thresholds?.fail.some((assertion) => assertion.metric === metric),
				false,
				`${metric} must not become a suite-wide threshold`,
			);
		}
	});

	it("executes the shipped boundary suite against built Clio without a model", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-");
		try {
			// The test preload requires every child-process Clio root to stay below
			// CLIO_CODER_HOME. Eval workspaces and per-item journals use os.tmpdir(),
			// so keep that scratch inside this serialized isolated-env window too.
			const nestedTmp = join(isolated.dir, "tmp");
			mkdirSync(nestedTmp, { recursive: true });
			process.env.TMPDIR = nestedTmp;

			const loaded = await loadEvalSuiteFile(BOUNDARY_SUITE);
			strictEqual(loaded.suite.suite.provenance?.offline, true);
			for (const task of loaded.suite.tasks) {
				strictEqual(task.runner.kind, "external-command");
				strictEqual(task.runner.commands?.length, 1);
				ok(task.runner.commands?.every((command) => command.includes('node "$CLIO_CODER_ENTRY" fleet run')));
			}

			const artifact = await runEvalSuiteV2(loaded, { clioEntry: BUILT_CLIO_ENTRY });
			strictEqual(artifact.summary.runs, 2);
			strictEqual(artifact.summary.passed, 2);
			strictEqual(artifact.summary.failed, 0);
			strictEqual(artifact.summary.tokens.measured, false);

			const rolledBack = artifact.results.find((result) => result.taskId === "write-boundary.rolled-back");
			strictEqual(rolledBack?.pass, true);
			strictEqual(rolledBack?.failureClass, null);
			strictEqual(rolledBack?.target.model, null);
			strictEqual(rolledBack?.metrics["boundary.verdictCount"], 1);
			strictEqual(rolledBack?.metrics["boundary.verdictSealed"], true);
			strictEqual(rolledBack?.metrics["boundary.violationsDetected"], 1);
			strictEqual(rolledBack?.metrics["boundary.violationsRolledBack"], 1);
			strictEqual(rolledBack?.metrics["boundary.rollbackIncomplete"], 0);
			strictEqual(rolledBack?.metrics["patch.filesChanged"], 0);
			strictEqual(rolledBack?.metrics["verifier.exitCode"], 0);
			strictEqual(rolledBack?.artifacts.verifierStdout, "write-boundary: rolled-back workspace state ok\n");

			const incomplete = artifact.results.find((result) => result.taskId === "write-boundary.rollback-incomplete");
			strictEqual(incomplete?.pass, true);
			strictEqual(incomplete?.failureClass, null);
			strictEqual(incomplete?.target.model, null);
			strictEqual(incomplete?.metrics["boundary.verdictCount"], 1);
			strictEqual(incomplete?.metrics["boundary.verdictSealed"], true);
			strictEqual(incomplete?.metrics["boundary.violationsDetected"], 1);
			strictEqual(incomplete?.metrics["boundary.violationsRolledBack"], 0);
			strictEqual(incomplete?.metrics["boundary.rollbackIncomplete"], 1);
			strictEqual(incomplete?.metrics["patch.filesChanged"], 1);
			strictEqual(incomplete?.metrics["verifier.exitCode"], 0);
			strictEqual(incomplete?.artifacts.verifierStdout, "write-boundary: rollback-incomplete workspace state ok\n");
		} finally {
			isolated.restore();
		}
	});

	it("fails its own gate when the receipt does not authenticate", async () => {
		const { gatePass, failures } = await runSoakAgainst(SEALED_RECEIPT);

		strictEqual(gatePass, false);
		ok(failures.includes("receipt.integrityValid"), `expected an integrity failure, got ${failures.join(", ")}`);
	});

	it("fails its own gate when nothing sealed a receipt at all", async () => {
		const { gatePass, failures } = await runSoakAgainst(null);

		strictEqual(gatePass, false);
		ok(failures.includes("receipt.sealed"), `expected a sealing failure, got ${failures.join(", ")}`);
		// Nothing sealed, so the invariants that judge a seal were never
		// measured. They fail closed rather than passing on absence.
		ok(failures.includes("receipt.integrityValid"));
		ok(failures.includes("receipt.outcomeMatchesExit"));
	});

	it("keeps the fixture's known-answer test red before the repair", () => {
		// A fixture whose test already passes measures nothing: the defect has to
		// be real before a repair can be observed.
		const fixture = fileURLToPath(new URL("../../benchmarks/soak/fixtures/single-file-bug", import.meta.url));
		const result = spawnSync(process.execPath, ["test/known-answers.test.mjs"], { cwd: fixture, stdio: "ignore" });

		strictEqual(result.status === 0, false, "the fixture test must fail against the seeded defect");
	});
});
