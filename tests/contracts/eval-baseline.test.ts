import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildEvalBaseline,
	checkEvalBaseline,
	EVAL_BASELINE_SCHEMA_V1,
	EvalBaselineFileError,
	type EvalBaselineFileV1,
	loadEvalBaselineFile,
	serializeEvalBaseline,
} from "../../src/domains/eval/compare/baseline.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";

const PIN = ["task.solved", "custom.digest.behavior", "custom.counters.fs_ops"];

function result(
	taskId: string,
	metrics: Record<string, number | string | boolean | null>,
	repeatIndex = 0,
): EvalArtifactResultV4 {
	return {
		assignmentId: `${taskId}#${repeatIndex}`,
		terminalReceiptDigest: null,
		taskId,
		repeatIndex,
		target: { id: "default", model: null, thinking: null },
		pass: true,
		failureClass: null,
		metrics,
		artifacts: {},
	} as EvalArtifactResultV4;
}

function artifact(results: EvalArtifactResultV4[], suiteId = "s"): EvalArtifactV4 {
	return {
		version: 4,
		evalId: "eval-test",
		suite: { id: suiteId, hash: "h" },
		clioCoder: { version: "0.0.0-test", commit: "abc", entry: "dist/cli/index.js" },
		environment: { platform: "linux", node: "v22" },
		matrix: { target: "default", model: null, thinking: null },
		summary: { total: results.length, passed: results.length, failed: 0 },
		results,
	} as unknown as EvalArtifactV4;
}

const SOLVED = { "task.solved": true, "custom.digest.behavior": "aa", "custom.counters.fs_ops": 14 };

function recordedFile(tasks: EvalBaselineFileV1["tasks"]): EvalBaselineFileV1 {
	return {
		schema: EVAL_BASELINE_SCHEMA_V1,
		suite: "s",
		recordedAt: "2026-01-01T00:00:00.000Z",
		clioCoder: { version: "0.0.0-test", commit: "abc" },
		pin: [...PIN],
		tasks,
	};
}

describe("eval baseline", () => {
	it("records one pinned value per task and sorts for a stable diff", () => {
		const { tasks, findings } = buildEvalBaseline(artifact([result("b", SOLVED), result("a", SOLVED)]), PIN);
		deepStrictEqual(findings, []);
		deepStrictEqual(Object.keys(tasks), ["a", "b"]);
		deepStrictEqual(Object.keys(tasks.a ?? {}), ["custom.counters.fs_ops", "custom.digest.behavior", "task.solved"]);
		strictEqual(tasks.a?.["custom.counters.fs_ops"], 14);
	});

	it("refuses to pin a metric whose repeats disagree", () => {
		const { tasks, findings } = buildEvalBaseline(
			artifact([result("a", SOLVED, 0), result("a", { ...SOLVED, "custom.counters.fs_ops": 15 }, 1)]),
			PIN,
		);
		strictEqual(findings.length, 1);
		strictEqual(findings[0]?.kind, "nondeterministic");
		strictEqual(findings[0]?.metric, "custom.counters.fs_ops");
		deepStrictEqual(findings[0]?.observed, [14, 15]);
		// The stable metrics are still pinned; only the unstable one is withheld.
		ok(!("custom.counters.fs_ops" in (tasks.a ?? {})));
		strictEqual(tasks.a?.["task.solved"], true);
	});

	it("reports an absent pinned metric as unmeasured rather than pinning nothing", () => {
		const { findings } = buildEvalBaseline(artifact([result("a", { "task.solved": true })]), PIN);
		deepStrictEqual(findings.map((finding) => `${finding.kind}:${finding.metric}`).sort(), [
			"unmeasured:custom.counters.fs_ops",
			"unmeasured:custom.digest.behavior",
		]);
	});

	it("passes when every pinned value reproduces", () => {
		const check = checkEvalBaseline(artifact([result("a", SOLVED)]), recordedFile({ a: { ...SOLVED } }), PIN);
		strictEqual(check.pass, true);
		strictEqual(check.matched, 1);
		deepStrictEqual(check.failures, []);
	});

	it("names the task and metric that moved", () => {
		const check = checkEvalBaseline(
			artifact([result("a", { ...SOLVED, "custom.digest.behavior": "bb" })]),
			recordedFile({ a: { ...SOLVED } }),
			PIN,
		);
		strictEqual(check.pass, false);
		strictEqual(check.failures.length, 1);
		deepStrictEqual(
			{ ...check.failures[0] },
			{ kind: "changed", taskId: "a", metric: "custom.digest.behavior", recorded: "aa", actual: "bb" },
		);
	});

	it("fails on a recorded task the run did not produce", () => {
		const check = checkEvalBaseline(artifact([]), recordedFile({ a: { ...SOLVED } }), PIN);
		strictEqual(check.pass, false);
		strictEqual(check.failures[0]?.kind, "missing");
	});

	it("fails on a pinned metric the run stopped reporting", () => {
		const check = checkEvalBaseline(
			artifact([result("a", { "task.solved": true, "custom.digest.behavior": "aa" })]),
			recordedFile({ a: { ...SOLVED } }),
			PIN,
		);
		strictEqual(check.pass, false);
		strictEqual(check.failures[0]?.kind, "unmeasured");
		strictEqual(check.failures[0]?.metric, "custom.counters.fs_ops");
	});

	it("reports an unrecorded task as a notice, not a failure", () => {
		const check = checkEvalBaseline(
			artifact([result("a", SOLVED), result("b", SOLVED)]),
			recordedFile({ a: { ...SOLVED } }),
			PIN,
		);
		strictEqual(check.pass, true);
		strictEqual(check.matched, 1);
		deepStrictEqual(
			check.notices.map((notice) => `${notice.kind}:${notice.taskId}`),
			["new:b"],
		);
	});

	it("flags a pin list that drifted from the recorded one", () => {
		const check = checkEvalBaseline(artifact([result("a", SOLVED)]), recordedFile({ a: { ...SOLVED } }), ["task.solved"]);
		strictEqual(check.pinDrift, true);
	});

	it("round-trips through the serialized file", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-eval-baseline-"));
		try {
			const path = join(dir, "b.json");
			const file = recordedFile({ a: { ...SOLVED } });
			writeFileSync(path, serializeEvalBaseline(file), "utf8");
			ok(readFileSync(path, "utf8").endsWith("\n"));
			deepStrictEqual(loadEvalBaselineFile(path), file);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says a missing baseline is unrecorded rather than reporting a parse error", () => {
		throws(
			() => loadEvalBaselineFile(join(tmpdir(), "clio-eval-baseline-absent", "b.json")),
			(error: unknown) => {
				ok(error instanceof EvalBaselineFileError);
				ok(error.message.includes("not recorded yet"));
				return true;
			},
		);
	});

	it("rejects a baseline path that escapes the suite directory", () => {
		const suite = {
			version: 2,
			suite: { id: "s", title: "t", visibility: "public" },
			matrix: { targets: [{ id: "default" }], repeats: 1 },
			tasks: [],
			baseline: { file: "../../etc/b.json", pin: ["task.solved"] },
		};
		const validated = validateEvalSuiteV2(suite);
		strictEqual(validated.valid, false);
		ok(validated.valid === false && validated.issues.some((issue) => issue.path === "$.baseline.file"));
	});

	it("rejects a baseline block that pins nothing", () => {
		const validated = validateEvalSuiteV2({
			version: 2,
			suite: { id: "s", title: "t", visibility: "public" },
			matrix: { targets: [{ id: "default" }], repeats: 1 },
			tasks: [],
			baseline: { file: "b.json", pin: [] },
		});
		strictEqual(validated.valid, false);
	});
});
