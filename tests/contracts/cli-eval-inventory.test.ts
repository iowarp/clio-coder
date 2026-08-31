/**
 * `clio-coder eval inventory --json`, the fixed read a GUI host may run.
 *
 * An eval artifact carries the whole session transcript under
 * `results[].artifacts`: the operator's task text, every tool argument and
 * result, provider endpoint URLs, error prose, and the prepared workspace path.
 * None of it belongs in a GUI projection at any width, so these cases assert
 * counts where the contents are and prove the contents never appear.
 *
 * The fixtures are typed `EvalArtifactV4` values rather than loose objects, so
 * a schema change fails them at compile time.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EVAL_INVENTORY_MAX_REPORTS, evalInventorySnapshot } from "../../src/cli/eval-inventory.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { EVAL_VERDICT_SCHEMA_V1, type EvalTrackedMetricsV1 } from "../../src/domains/eval/schema/verdict.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const AT = "2026-08-31T12:00:00.000Z";
const now = () => Date.parse(AT);

const SUITE_HASH = `6bae168d${"0".repeat(56)}`;
const OTHER_SUITE_HASH = `4607d71d${"0".repeat(56)}`;

/**
 * One string that exists in the fixture and must never reach the frame.
 *
 * It is planted in the transcript attachment, the workspace path, and a string
 * metric value, so a forbidden-substring assertion over it is testing the
 * boundary rather than the prose around it.
 */
const SECRET = "marmalade-ridgeway";

const TRACKED: EvalTrackedMetricsV1 = {
	modelCalls: { value: 2, source: "ledger" },
	uncachedPrefillTokens: { value: 11, source: "ledger" },
	cacheReadTokens: { value: 7, source: "ledger" },
	generatedTokens: { value: 5, source: "ledger" },
	reasoningTokens: { value: null, source: "estimated" },
	toolCalls: { value: 1, source: "ledger" },
	toolErrors: { value: 0, source: "ledger" },
	ttftMsFirstCall: { value: 120, source: "ledger" },
	wallClockMs: { value: 4_000, source: "ledger" },
	contextTokensAtEnd: { value: 900, source: "ledger" },
	compactions: { value: 0, source: "ledger" },
	expectedColdReasons: {},
};

interface ResultOptions {
	readonly taskId: string;
	readonly repeatIndex?: number;
	readonly pass: boolean;
	readonly failureClass?: string;
	readonly assignmentId?: string;
	readonly terminalReceiptDigest?: string;
}

function result(options: ResultOptions): EvalArtifactResultV4 {
	const pass = options.pass;
	const failureClass = pass ? null : (options.failureClass ?? "runner_failed");
	return {
		assignmentId: options.assignmentId ?? null,
		terminalReceiptDigest: options.terminalReceiptDigest ?? null,
		taskId: options.taskId,
		repeatIndex: options.repeatIndex ?? 0,
		target: { id: "mini", model: "qwen3.8-27b-dense", thinking: "off" },
		pass,
		failureClass,
		metrics: {
			"result.pass": pass,
			"result.failureClass": failureClass,
			"tools.calls.read": 1,
			// Two names the suite schema does not declare, one of them carrying the
			// planted string as its value.
			"workspace.codeword": SECRET,
			"workspace.structural": "3f2a",
		},
		artifacts: {
			stdout: `{"type":"text_delta","delta":"the codeword is ${SECRET}"}`,
			stderr: `clio: could not reach https://192.0.2.10:8080/models/load`,
			workspace: `/home/researcher/.cache/clio-workspace-${SECRET}`,
		},
		verdict: {
			schema: EVAL_VERDICT_SCHEMA_V1,
			scenarioId: options.taskId,
			trialIndex: options.repeatIndex ?? 0,
			outcome: pass ? "pass" : "fail",
			machinery: pass || failureClass === "grader_failed" ? "ok" : "infrastructure_failure",
			reason: pass ? null : failureClass,
			trackedMetrics: TRACKED,
			behavioral: null,
			evidence: {
				assignmentId: options.assignmentId ?? null,
				terminalReceiptDigest: options.terminalReceiptDigest ?? null,
				graderExitCode: pass ? 0 : 1,
			},
		},
	};
}

interface ArtifactOptions {
	readonly evalId: string;
	readonly suiteId?: string;
	readonly suiteHash?: string;
	readonly results: readonly EvalArtifactResultV4[];
	readonly compiledPromptHash?: string | null;
	readonly serving?: boolean;
	readonly measured?: boolean;
	readonly aggregates?: EvalArtifactV4["aggregates"];
}

function artifact(options: ArtifactOptions): EvalArtifactV4 {
	const results = options.results;
	const passed = results.filter((entry) => entry.pass).length;
	const measured = options.measured ?? true;
	return {
		version: 4,
		evalId: options.evalId,
		suite: { id: options.suiteId ?? "public-main-agent-behavior", hash: options.suiteHash ?? SUITE_HASH },
		clio: {
			version: "0.4.0",
			commit: "7cf5b06a5e2d429a2ed06b086cb335793fa5a9c7",
			// The entry path is host-only; the projection must not echo it.
			entry: `/home/researcher/code/${SECRET}/dist/cli/index.js`,
		},
		environment: { platform: "linux-x64", node: "v24.9.0" },
		matrix: { target: "mini", model: "qwen3.8-27b-dense", thinking: "off", dimensions: ["target", "wireModel"] },
		...(options.serving === false
			? {}
			: {
					servingConfiguration: {
						targetId: "mini",
						runtimeId: "llamacpp",
						modelId: "qwen3.8-27b-dense",
						serverBuild: "b1-c841aee",
						total_slots: 1,
						thinkingLevel: "off",
						compiledPromptHash: options.compiledPromptHash === undefined ? "a".repeat(64) : options.compiledPromptHash,
					},
				}),
		summary: {
			runs: results.length,
			passed,
			failed: results.length - passed,
			passRate: results.length === 0 ? 0 : passed / results.length,
			tokens: measured
				? {
						measured: true,
						runs: results.length,
						measuredRuns: results.length,
						input: 11_547,
						output: 81,
						total: 23_173,
						cacheRead: 11_545,
						cacheWrite: 0,
					}
				: { measured: false, runs: results.length, measuredRuns: 0 },
			wallTimeMs: 49_265,
		},
		...(options.aggregates === undefined ? {} : { aggregates: options.aggregates }),
		results: [...results],
	};
}

function aggregate(
	scenarioId: string,
	passed: number,
	failed: number,
): NonNullable<EvalArtifactV4["aggregates"]>[number] {
	const trials = passed + failed;
	return {
		scenarioId,
		trials,
		k: trials,
		passed,
		failed,
		unmeasured: 0,
		machineryFailures: failed,
		passAtK: passed > 0 ? 1 : 0,
		passPowK: passed === trials ? 1 : 0,
		trackedMetrics: { expectedColdReasons: {} } as NonNullable<EvalArtifactV4["aggregates"]>[number]["trackedMetrics"],
	};
}

function seed(dataDir: string, fileStem: string, value: unknown): void {
	const directory = join(dataDir, "evals");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, `${fileStem}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

describe("contracts/cli-eval-inventory", () => {
	const scratch = makeScratchHome("clio-eval-inventory-");
	after(() => scratch.cleanup());

	it("separates an installation with no eval store from one holding no reports", async () => {
		const missing = await evalInventorySnapshot(now, join(scratch.dir, "no-store"));
		strictEqual(missing.version, 1);
		strictEqual(missing.generatedAt, AT);
		strictEqual(missing.available, false);
		strictEqual(missing.stored, 0);
		deepStrictEqual(missing.reports, []);
		strictEqual(missing.truncated, false);

		const empty = join(scratch.dir, "empty-store");
		mkdirSync(join(empty, "evals"), { recursive: true });
		const listed = await evalInventorySnapshot(now, empty);
		strictEqual(listed.available, true);
		strictEqual(listed.stored, 0);
		deepStrictEqual(listed.reports, []);
	});

	it("projects identity, provenance, accounting, and scenarios without the transcript behind them", async () => {
		const dataDir = join(scratch.dir, "one-report");
		const evalId = `eval-20260830T205857010Z-6bae168d-${"7".repeat(12)}`;
		seed(
			dataDir,
			evalId,
			artifact({
				evalId,
				results: [result({ taskId: "main-focused-edit", pass: true })],
				aggregates: [aggregate("main-focused-edit", 1, 0)],
			}),
		);

		const snapshot = await evalInventorySnapshot(now, dataDir);
		strictEqual(snapshot.available, true);
		strictEqual(snapshot.stored, 1);
		strictEqual(snapshot.unreadable, 0);
		strictEqual(snapshot.reports.length, 1);
		const report = snapshot.reports[0];
		ok(report !== undefined);
		strictEqual(report.evalId, evalId);
		// The artifact has no timestamp field. The id is the only record of when it
		// ran, and this reads it back.
		strictEqual(report.startedAt, "2026-08-30T20:58:57.010Z");
		strictEqual(report.suiteId, "public-main-agent-behavior");
		strictEqual(report.servingGroup, 1);
		strictEqual(report.clioVersion, "0.4.0");
		strictEqual(report.clioCommit, "7cf5b06a5e2d429a2ed06b086cb335793fa5a9c7");
		strictEqual(report.platform, "linux-x64");
		deepStrictEqual(report.matrix.dimensions, ["target", "wireModel"]);
		strictEqual(report.serving.observed, true);
		strictEqual(report.serving.serverBuild, "b1-c841aee");
		strictEqual(report.serving.compiledPromptPinned, true);
		strictEqual(report.summary.runs, 1);
		strictEqual(report.summary.passed, 1);
		strictEqual(report.summary.passRate, 1);
		strictEqual(report.summary.tokens.measured, true);
		strictEqual(report.summary.tokens.total, 23_173);
		strictEqual(report.results.total, 1);
		strictEqual(report.results.withVerdict, 1);
		// Three attachments and two undeclared metric names, counted where their
		// contents do not cross.
		strictEqual(report.results.attachments, 3);
		strictEqual(report.results.canonicalMetrics, 3);
		strictEqual(report.results.otherMetrics, 2);
		deepStrictEqual(report.failureClasses, []);
		deepStrictEqual(report.scenarios, [
			{
				scenarioId: "main-focused-edit",
				trials: 1,
				passed: 1,
				failed: 0,
				unmeasured: 0,
				machineryFailures: 0,
				passAtK: 1,
				passPowK: 1,
			},
		]);
		strictEqual(report.scenariosTruncated, false);

		const framed = JSON.stringify(snapshot);
		for (const forbidden of [
			SECRET,
			"/home/researcher",
			"text_delta",
			"192.0.2.10",
			"dist/cli/index.js",
			SUITE_HASH,
			"a".repeat(64),
		])
			ok(!framed.includes(forbidden), `eval inventory leaked ${forbidden}`);
	});

	it("classifies failure classes, keeps an unknown one, and counts machinery failures", async () => {
		const dataDir = join(scratch.dir, "failures");
		const evalId = `eval-20260830T210000000Z-6bae168d-${"8".repeat(12)}`;
		seed(
			dataDir,
			evalId,
			artifact({
				evalId,
				results: [
					result({ taskId: "task-a", pass: false, failureClass: "verifier_failed" }),
					result({ taskId: "task-b", repeatIndex: 1, pass: false, failureClass: "grader_failed" }),
					// A class the suite runner does not mint. The result still failed,
					// which is the part an operator can act on.
					result({ taskId: "task-c", repeatIndex: 2, pass: false, failureClass: "quota_denied" }),
				],
			}),
		);

		const report = (await evalInventorySnapshot(now, dataDir)).reports[0];
		ok(report !== undefined);
		strictEqual(report.summary.failed, 3);
		deepStrictEqual(report.failureClasses, [
			{ failureClass: "grader_failed", count: 1 },
			{ failureClass: "verifier_failed", count: 1 },
			{ failureClass: "other", count: 1 },
		]);
		// A declared grader failure is the task failing, not the machinery.
		strictEqual(report.results.machineryFailures, 2);
		// Every failure carries a class, so the tally accounts for the failures exactly.
		strictEqual(
			report.failureClasses.reduce((sum, entry) => sum + entry.count, 0),
			report.summary.failed,
		);
	});

	it("reports unmeasured accounting as absent counts rather than zero", async () => {
		const dataDir = join(scratch.dir, "unmeasured");
		const evalId = `eval-20260830T211500000Z-6bae168d-${"9".repeat(12)}`;
		seed(dataDir, evalId, artifact({ evalId, measured: false, results: [result({ taskId: "task-a", pass: true })] }));

		const report = (await evalInventorySnapshot(now, dataDir)).reports[0];
		ok(report !== undefined);
		strictEqual(report.summary.tokens.measured, false);
		strictEqual(report.summary.tokens.measuredRuns, 0);
		strictEqual(report.summary.tokens.total, null);
		strictEqual(report.summary.tokens.cacheRead, null);
	});

	it("groups reports by the same rule eval compare uses to accept a baseline", async () => {
		const dataDir = join(scratch.dir, "groups");
		const newest = `eval-20260830T230000000Z-6bae168d-${"a".repeat(12)}`;
		const middle = `eval-20260830T220000000Z-6bae168d-${"b".repeat(12)}`;
		const oldest = `eval-20260830T210000000Z-6bae168d-${"c".repeat(12)}`;
		seed(dataDir, newest, artifact({ evalId: newest, results: [result({ taskId: "task-a", pass: true })] }));
		// A different compiled prompt is serving drift, and the compare command
		// refuses it without --allow-config-drift.
		seed(
			dataDir,
			middle,
			artifact({
				evalId: middle,
				compiledPromptHash: "b".repeat(64),
				results: [result({ taskId: "task-a", pass: true })],
			}),
		);
		seed(dataDir, oldest, artifact({ evalId: oldest, results: [result({ taskId: "task-a", pass: true })] }));

		const snapshot = await evalInventorySnapshot(now, dataDir);
		deepStrictEqual(
			snapshot.reports.map((report) => report.evalId),
			[newest, middle, oldest],
		);
		deepStrictEqual(
			snapshot.reports.map((report) => report.servingGroup),
			[1, 2, 1],
		);
	});

	it("counts a retired artifact and a renamed one rather than dropping them silently", async () => {
		const dataDir = join(scratch.dir, "unreadable");
		const good = `eval-20260830T230000000Z-6bae168d-${"d".repeat(12)}`;
		const retired = `eval-20260830T220000000Z-6bae168d-${"e".repeat(12)}`;
		const renamed = `eval-20260830T210000000Z-6bae168d-${"f".repeat(12)}`;
		seed(dataDir, good, artifact({ evalId: good, results: [result({ taskId: "task-a", pass: true })] }));
		// Routing accepts artifact v4 only, so a v1 report still on disk is a real
		// thing in this store that this read cannot open.
		seed(dataDir, retired, { version: 1, evalId: retired, results: [] });
		// The id inside the file is authoritative: a copied file answering to two
		// names is not the report it claims to be.
		seed(dataDir, renamed, artifact({ evalId: good, results: [] }));

		const snapshot = await evalInventorySnapshot(now, dataDir);
		strictEqual(snapshot.stored, 3);
		strictEqual(snapshot.unreadable, 2);
		strictEqual(snapshot.reports.length, 1);
		strictEqual(snapshot.truncated, false);
	});

	it("reports no start instant when the id disagrees with the suite it names", async () => {
		const dataDir = join(scratch.dir, "mismatched-id");
		const evalId = `eval-20260830T230000000Z-6bae168d-${"1".repeat(12)}`;
		seed(
			dataDir,
			evalId,
			artifact({ evalId, suiteHash: OTHER_SUITE_HASH, results: [result({ taskId: "task-a", pass: true })] }),
		);

		const report = (await evalInventorySnapshot(now, dataDir)).reports[0];
		ok(report !== undefined);
		strictEqual(report.evalId, evalId);
		strictEqual(report.startedAt, null);
	});

	it("bounds the window newest first and says the store holds more", async () => {
		const dataDir = join(scratch.dir, "bounded");
		for (let index = 0; index < EVAL_INVENTORY_MAX_REPORTS + 3; index += 1) {
			const minute = String(index).padStart(2, "0");
			const evalId = `eval-20260830T21${minute}00000Z-6bae168d-${String(index).padStart(12, "0")}`;
			seed(dataDir, evalId, artifact({ evalId, results: [result({ taskId: "task-a", pass: true })] }));
		}

		const snapshot = await evalInventorySnapshot(now, dataDir);
		strictEqual(snapshot.stored, EVAL_INVENTORY_MAX_REPORTS + 3);
		strictEqual(snapshot.reports.length, EVAL_INVENTORY_MAX_REPORTS);
		strictEqual(snapshot.truncated, true);
		const stamps = snapshot.reports.map((report) => report.startedAt);
		deepStrictEqual([...stamps].sort().reverse(), stamps);
	});

	it("accepts the exact fixed argv and nothing else", async () => {
		const ok0 = await runCli(["eval", "inventory", "--json"], { env: scratch.env });
		strictEqual(ok0.code, 0);
		const parsed = JSON.parse(ok0.stdout) as { version: number; available: boolean };
		strictEqual(parsed.version, 1);
		strictEqual(parsed.available, false);

		for (const argv of [
			["eval", "inventory"],
			["eval", "inventory", "--json", "--all"],
			["eval", "inventory", "eval-20260830T205857010Z-6bae168d-777777777777", "--json"],
		]) {
			const rejected = await runCli(argv, { env: scratch.env });
			strictEqual(rejected.code, 2, `expected a usage error for ${argv.join(" ")}`);
		}
	});
});
