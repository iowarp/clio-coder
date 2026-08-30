import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyEvalTrackedMetrics } from "../../src/domains/eval/metrics/tracked.js";
import {
	adaptSuiteV2ResultToBehaviorV1,
	adaptSuiteV2ResultToVerdictV1,
} from "../../src/domains/eval/schema/adapter.js";
import { EVAL_BEHAVIOR_CATEGORIES } from "../../src/domains/eval/schema/behavioral.js";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILTIN_DIR = join(ROOT, "src/domains/agents/builtins");
const EVAL_DIR = join(ROOT, "benchmarks/eval");

describe("contracts/public behavioral corpus", () => {
	it("covers every built-in role with stable positive and adversarial machinery scenarios", async () => {
		const suite = (await loadEvalSuiteFile(join(EVAL_DIR, "behavioral-machinery.yaml"))).suite;
		const builtins = readdirSync(BUILTIN_DIR)
			.filter((entry) => entry.endsWith(".md"))
			.map((entry) => entry.slice(0, -3))
			.sort();
		const covered = [...new Set(suite.tasks.map((task) => task.behavioral?.execution.subject.role))].sort();
		deepStrictEqual(covered, builtins);
		for (const role of builtins) {
			deepStrictEqual(
				suite.tasks.filter((task) => task.behavioral?.execution.subject.role === role).map((task) => task.id),
				[`${role}-positive`, `${role}-adversarial`],
			);
		}
		strictEqual(suite.tasks.length, builtins.length * 2);
	});

	it("drives real admission and receipt sealing for every machinery scenario without a model", async () => {
		const suite = (await loadEvalSuiteFile(join(EVAL_DIR, "behavioral-machinery.yaml"))).suite;
		for (const task of suite.tasks) {
			const scenario = task.behavioral;
			if (scenario === undefined) throw new Error(`missing behavioral scenario ${task.id}`);
			strictEqual(scenario.execution.mode, "machinery-only");
			strictEqual(scenario.corpus.version, "1.0.0");
			const polarity = task.tags.includes("positive") ? "positive" : "adversarial";
			execFileSync(
				process.execPath,
				["--import", "tsx", join(EVAL_DIR, "behavioral-machinery-driver.ts"), scenario.execution.subject.role, polarity],
				{ cwd: ROOT, stdio: "pipe" },
			);
			const result = {
				assignmentId: null,
				terminalReceiptDigest: null,
				taskId: task.id,
				repeatIndex: 0,
				pass: true,
				failureClass: null,
				metrics: { "task.solved": true, "task.exitCode": 0, "result.pass": true },
			};
			const verdict = adaptSuiteV2ResultToVerdictV1(result, emptyEvalTrackedMetrics());
			strictEqual(adaptSuiteV2ResultToBehaviorV1(result, verdict, scenario).outcome, "pass", task.id);
		}
	});

	it("covers every main-agent category with independently discriminating model facts", async () => {
		const suite = (await loadEvalSuiteFile(join(EVAL_DIR, "behavioral-model.yaml"))).suite;
		deepStrictEqual(
			suite.tasks.map((task) => task.id),
			["main-focused-edit", "main-adversarial-scope", "main-delegation-required", "main-denied-bash-recovery"],
		);
		const covered = new Set<string>();
		const factKeys = new Set<string>();
		for (const task of suite.tasks) {
			const scenario = task.behavioral;
			if (scenario === undefined) throw new Error(`missing behavioral scenario ${task.id}`);
			strictEqual(scenario.execution.mode, "model-required");
			strictEqual(scenario.execution.subject.kind, "main-agent");
			for (const rule of [...scenario.expectedBehavior, ...scenario.forbiddenBehavior]) {
				covered.add(rule.category);
				factKeys.add(rule.fact.key);
			}
		}
		deepStrictEqual([...covered].sort(), [...EVAL_BEHAVIOR_CATEGORIES].sort());
		for (const key of [
			"tools.calls.read",
			"tools.calls.dispatch",
			"tools.blocked.bash",
			"tools.read.outsideAllowed",
			"tools.read.decoyHits",
			"claims.unsupported",
			"completion.reported",
			"task.solved",
		]) {
			strictEqual(factKeys.has(key), true, `missing discriminating fact ${key}`);
		}
		const control = (await loadEvalSuiteFile(join(EVAL_DIR, "behavioral-model-negative-control.yaml"))).suite.tasks[0];
		strictEqual(control?.tags.includes("negative-control"), true);
		deepStrictEqual(control?.behavioral?.forbiddenBehavior.map((rule) => rule.category).sort(), [
			"exploration",
			"safety_comprehension",
		]);
	});

	it("contains no private endpoints, credential values, or mutable external inputs", () => {
		const corpus = [
			"behavioral-machinery.yaml",
			"behavioral-model.yaml",
			"behavioral-model-negative-control.yaml",
			"behavioral-corpus-grader.mjs",
			"behavioral-machinery-driver.ts",
		]
			.map((file) => readFileSync(join(EVAL_DIR, file), "utf8"))
			.join("\n");
		strictEqual(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(corpus), false);
		strictEqual(/(?:api[_-]?key|password|token)\s*[:=]\s*["'][^"']+/iu.test(corpus), false);
		strictEqual(/https?:\/\//u.test(corpus), false);
	});

	it("emits a grader fact that distinguishes a supported claim from an unsupported one", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-behavior-grader-"));
		const transcript = join(scratch, "runner.jsonl");
		try {
			for (const [assistantText, expectedExit, unsupported, completed] of [
				["The fixture exports 2 functions.", 0, 0, true],
				["The fixture exports 99 functions.", 1, 1, true],
				["I could not inspect the fixture; try again.", 1, 0, false],
			] as const) {
				writeFileSync(
					transcript,
					[
						JSON.stringify({ type: "text_delta", delta: "An earlier tool-use turn guessed 17." }),
						JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } }),
						JSON.stringify({ type: "text_delta", delta: assistantText }),
						JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }),
					].join("\n"),
				);
				const result = spawnSync(
					process.execPath,
					[join(EVAL_DIR, "behavioral-corpus-grader.mjs"), "main", "main-delegation-required"],
					{
						cwd: ROOT,
						encoding: "utf8",
						env: { ...process.env, CLIO_EVAL_RUNNER_STDOUT_FILE: transcript },
					},
				);
				strictEqual(result.status, expectedExit, result.stderr);
				const line = result.stdout
					.split(/\r?\n/u)
					.find((candidate) => candidate.includes('"schema":"clio.eval.measure.v1"'));
				if (line === undefined) throw new Error("grader did not emit clio.eval.measure.v1");
				const measure = JSON.parse(line) as { metrics?: Record<string, unknown> };
				strictEqual(measure.metrics?.["claims.unsupported"], unsupported);
				strictEqual(measure.metrics?.["completion.reported"], completed);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
