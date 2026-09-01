import { strict as assert } from "node:assert";

const artifact = (taskId, failureClass = null) => ({
	version: 4,
	evalId: "eval-grader",
	suite: { id: "grader's-suite", hash: "a".repeat(64) },
	clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
	environment: { platform: "linux-x64", node: process.version },
	matrix: { target: "mini", model: "qwen", thinking: "off" },
	summary: {
		runs: 1,
		passed: failureClass === null ? 1 : 0,
		failed: failureClass === null ? 0 : 1,
		passRate: failureClass === null ? 1 : 0,
		tokens: { measured: false, runs: 1, measuredRuns: 0 },
		wallTimeMs: 1,
	},
	results: [
		{
			assignmentId: null,
			terminalReceiptDigest: null,
			taskId,
			repeatIndex: 0,
			target: { id: "mini", model: "qwen", thinking: "off" },
			pass: failureClass === null,
			failureClass,
			metrics: { "result.pass": failureClass === null },
			artifacts: {},
		},
	],
});

const cases = {
	async "latency-nonnegative"() {
		const { wallTimeMetric } = await import("../src/domains/eval/metrics/latency.ts");
		assert.equal(wallTimeMetric({ "latency.wallMs": -12 }), 0);
		assert.equal(wallTimeMetric({ "latency.wallMs": 3.5 }), 3.5);
	},

	async "safe-id-controls"() {
		const { assertSafeId, InvalidIdError } = await import("../src/core/safe-id.ts");
		assert.throws(() => assertSafeId("line\nbreak", "eval"), InvalidIdError);
		assert.throws(() => assertSafeId("tab\tbreak", "eval"), InvalidIdError);
		assert.doesNotThrow(() => assertSafeId("eval-42", "eval"));
	},

	async "shell-quote-nul"() {
		const { shellQuote } = await import("../src/core/shell-quote.ts");
		assert.throws(() => shellQuote("left\0right"));
		assert.equal(shellQuote("it's"), "'it'\\''s'");
	},

	async "junit-apostrophe"() {
		const { renderEvalJunitReportV4 } = await import("../src/domains/eval/reports/junit.ts");
		const xml = renderEvalJunitReportV4(artifact("owner's-task"));
		assert.match(xml, /owner&apos;s-task/u);
		assert.doesNotMatch(xml, /owner's-task/u);
	},

	async "markdown-pipe"() {
		const { renderEvalMarkdownReportV4 } = await import("../src/domains/eval/reports/markdown.ts");
		const markdown = renderEvalMarkdownReportV4(artifact("parse|render", "bad|output"));
		assert.match(markdown, /parse\\\|render/u);
		assert.match(markdown, /bad\\\|output/u);
	},

	async "suite-override-trim"() {
		const { resolveSuiteForRun } = await import("../src/domains/eval/suites/resolve.ts");
		const suite = {
			version: 2,
			suite: { id: "trim", title: "trim", visibility: "local" },
			matrix: { targets: [{ id: "mini", model: "old" }], repeats: 1 },
			tasks: [],
		};
		const resolved = resolveSuiteForRun(suite, { target: " mini ", model: " qwen " });
		assert.deepEqual(resolved.matrix.targets, [{ id: "mini", model: "qwen" }]);
	},

	async "truncate-marker-budget"() {
		const { byteLength, truncateUtf8 } = await import("../src/tools/truncate-utf8.ts");
		const result = truncateUtf8("abcdef", 5, "…");
		assert.equal(result, "ab…");
		assert.ok(byteLength(result) <= 5);
		assert.equal(truncateUtf8("éé", 4, "…"), "éé");
	},

	async "response-count-validation"() {
		const { addResponseModelIdObservationCount, emptyResponseModelIdObservationCounts } = await import(
			"../src/core/response-model-id.ts"
		);
		const counts = emptyResponseModelIdObservationCounts();
		addResponseModelIdObservationCount(counts, { state: "reported", reportedModelId: "qwen" }, -1);
		addResponseModelIdObservationCount(counts, { state: "reported", reportedModelId: "qwen" }, 1.5);
		assert.equal(counts.reportedCalls, 0);
		addResponseModelIdObservationCount(counts, { state: "reported", reportedModelId: "qwen" }, 2);
		assert.equal(counts.reportedCalls, 2);
	},

	async "relative-future"() {
		const { relative } = await import("../src/interactive/format-time.ts");
		const now = Date.parse("2026-08-29T12:00:00.000Z");
		assert.equal(relative(now + 10_000, now), "in 10s");
		assert.equal(relative(now + 4_000, now), "just now");
	},

	async "acp-unicode-boundary"() {
		const { acpErrorMessage, ACP_MAX_ERROR_MESSAGE_CHARS } = await import("../src/engine/acp/errors.ts");
		const message = acpErrorMessage(new Error("🙂".repeat(200)));
		assert.ok(message.length <= ACP_MAX_ERROR_MESSAGE_CHARS);
		assert.ok(message.endsWith("…"));
		const lastBodyUnit = message.charCodeAt(message.length - 2);
		assert.ok(lastBodyUnit < 0xd800 || lastBodyUnit > 0xdbff);
	},
};

const caseId = process.argv[2];
const grader = cases[caseId];
if (grader === undefined) {
	process.stderr.write(`unknown tracked metrics grader case: ${caseId ?? "missing"}\n`);
	process.exitCode = 2;
} else {
	try {
		await grader();
		process.stdout.write(`pass ${caseId}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	}
}
