import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RESULT_SUMMARY_DEFAULT_MAX_BYTES, validateResultContract } from "../../src/domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../../src/domains/agents/result-contract-filesystem.js";
import { createWorkerOutputCapture, WORKER_OUTPUT_MAX_BYTES } from "../../src/domains/dispatch/event-pump.js";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";
import { readTool } from "../../src/tools/read.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const fixture = JSON.parse(
	readFileSync(new URL("../../evals/fixtures/source-explanation.json", import.meta.url), "utf8"),
) as {
	task: string;
	files: Record<string, string>;
	sourceSha256: Record<string, string>;
	findings: Array<{ claim: string; path: string; line: number }>;
	shortExplanation: string;
	coderLimitation: string;
};
const scoutReport = (findings = fixture.findings) =>
	JSON.stringify({ findings, needsSplit: false, proposedSubtasks: [] });
// The same 1200 cited words as an explicit Coder delivers them: inline in
// summary, each claim closed by its file:line, under the default allowance.
const coderExplanation = fixture.findings
	.map((finding) => `${finding.claim} (${finding.path}:${finding.line})`)
	.join("\n\n");
const coderReport = (summary: string, passed = true) =>
	JSON.stringify({
		mutatedPaths: [],
		validations: [{ name: "source read", passed, evidence: "Read only the four requested files; no tests ran." }],
		summary,
	});

// Reuse the corpus grader, which is also run as a plain Node command in model evals.
async function grader() {
	const modulePath = new URL("../../evals/source-explanation-grader.mjs", import.meta.url).href;
	return (await import(modulePath)) as {
		assessExplanation: (agent: string, output: string, conformance: string) => Record<string, unknown>;
	};
}

test("source explanation: explicit Coder delivers 1200 cited words inline and reports a limitation only under a narrower allowance", async () => {
	const { assessExplanation } = await grader();
	const validate = (output: string, maxSummaryBytes?: number) =>
		validateResultContract({
			contract: maxSummaryBytes === undefined ? { kind: "mutation-report" } : { kind: "mutation-report", maxSummaryBytes },
			output,
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => null },
		});
	strictEqual(validate(coderReport(fixture.shortExplanation)).conformance, "pass");
	const delivered = coderReport(coderExplanation);
	ok(Buffer.byteLength(delivered) > 1000 * 7, "the explanation is far past the old 1000-byte cap");
	strictEqual(validate(delivered).conformance, "pass");
	const full = assessExplanation("coder", delivered, "pass");
	strictEqual(full["explanation.recipeSuitable"], true);
	strictEqual(full["explanation.delivered"], true);
	strictEqual(full["explanation.limited"], false);
	// Under a narrower dispatch allowance the same content cannot fit, and the
	// honest answer is a stated limitation, not a shortened explanation.
	strictEqual(validate(delivered, 2048).conformance, "fail");
	const limitation = coderReport(fixture.coderLimitation);
	strictEqual(validate(limitation, 2048).conformance, "pass");
	const assessed = assessExplanation("coder", limitation, "pass");
	strictEqual(assessed["explanation.delivered"], false);
	strictEqual(assessed["explanation.limited"], true);
	strictEqual(validate(coderReport("x".repeat(RESULT_SUMMARY_DEFAULT_MAX_BYTES + 1))).conformance, "fail");
	strictEqual(validate(coderReport(fixture.coderLimitation, false)).quality, "fail");
	const invalid = validate(
		'{"mutatedPaths":[],"validations":[{"name":"source read","passed":true,"evidence":"unfinished',
	);
	strictEqual(invalid.conformance, "fail");
	match(invalid.reason ?? "", /valid JSON/u);
});

test("source explanation: separately selected Scout delivers 1200 cited words within the receipt bound", async () => {
	const { assessExplanation } = await grader();
	const scratch = makeScratchHome("clio-coder-source-explanation-");
	try {
		const ranges = new Map<string, Array<readonly [number, number]>>();
		for (const [path, content] of Object.entries(fixture.files)) {
			strictEqual(createHash("sha256").update(content).digest("hex"), fixture.sourceSha256[path]);
			const absolute = join(scratch.dir, path);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, content);
			// Ten bounded source reads cover the four files within Scout's budget.
			// Confirm returned bytes before treating a range as observed evidence.
			const lines = content.replace(/\n$/u, "").split("\n");
			for (let start = 0; start < lines.length; start += 150) {
				const end = Math.min(start + 150, lines.length);
				const result = await readTool.run({ path: absolute, offset: start + 1, limit: 150 });
				ok(result.kind === "ok");
				ok(result.output.includes(lines.slice(start, end).join("\n")));
				ranges.set(absolute, [...(ranges.get(absolute) ?? []), [start + 1, end]]);
			}
		}
		const validate = (output: string) =>
			validateResultContract({
				contract: { kind: "scout-report" },
				output,
				cwd: scratch.dir,
				networkAllowed: false,
				filesystem: nodeResultContractFilesystem(),
				observedReadRanges: ranges,
			});
		const output = scoutReport();
		ok(Buffer.byteLength(output) <= WORKER_OUTPUT_MAX_BYTES);
		const capture = createWorkerOutputCapture();
		capture.observe({ type: "message_end", message: { role: "assistant", content: output, stopReason: "stop" } });
		strictEqual(capture.snapshot()?.truncated, false);
		strictEqual(capture.snapshot()?.text, output);
		strictEqual(fixture.findings.flatMap((finding) => finding.claim.split(/\s+/u)).length, 1200);
		const result = validate(output);
		strictEqual(result.conformance, "pass");
		strictEqual(result.quality, "pass");
		const assessed = assessExplanation("scout", output, result.conformance);
		strictEqual(assessed["explanation.recipeSuitable"], true);
		strictEqual(assessed["explanation.conforms"], true);
		strictEqual(assessed["explanation.delivered"], true);
		const firstFinding = fixture.findings[0];
		ok(firstFinding);
		const short = scoutReport([firstFinding]);
		strictEqual(validate(short).conformance, "pass");
		strictEqual(
			assessExplanation("scout", short, "pass")["explanation.delivered"],
			false,
			"one conforming finding is not the requested content",
		);
		const unsupported = scoutReport(fixture.findings.map((finding) => ({ ...finding, line: 9999 })));
		strictEqual(validate(unsupported).conformance, "fail");
		strictEqual(assessExplanation("scout", output, "fail")["explanation.delivered"], false);
		for (const [path, content] of Object.entries(fixture.files))
			strictEqual(readFileSync(join(scratch.dir, path), "utf8"), content);
	} finally {
		scratch.cleanup();
	}
});

test("source explanation corpus keeps explicit Coder and Scout cases separate and leaves watch lifecycle unmeasured", async () => {
	const loaded = await loadEvalSuiteFile(fileURLToPath(new URL("../../evals/behavioral-model.yaml", import.meta.url)));
	const tasks = loaded.suite.tasks.filter((task) => task.id.startsWith("main-source-explanation-"));
	deepStrictEqual(
		tasks.map((task) => task.id),
		["main-source-explanation-coder", "main-source-explanation-scout"],
	);
	for (const task of tasks) {
		strictEqual(task.behavioral?.execution.mode, "model-required");
		ok(task.runner.kind === "clio-coder-run");
		match(task.runner.prompt ?? "", /Keep my explicit recipe choice/u);
		strictEqual(task.behavioral?.expectedBehavior.length, 4);
		ok(!task.metrics.collect.some((key) => key.includes("watch")), "headless corpus cannot claim a watch lifecycle pass");
	}
});

test("source explanation grader exits failed for limitation and incomplete content, and passes full delivery", () => {
	const scratch = makeScratchHome("clio-coder-source-grader-");
	try {
		for (const [path, content] of Object.entries(fixture.files)) {
			mkdirSync(dirname(join(scratch.dir, path)), { recursive: true });
			writeFileSync(join(scratch.dir, path), content);
		}
		for (const [agent, output, expectedExit, quality] of [
			["coder", coderReport(fixture.coderLimitation), 1, "unmeasured"],
			["coder", coderReport(coderExplanation), 0, "unmeasured"],
			["coder", coderReport(fixture.shortExplanation), 1, "unmeasured"],
			["scout", scoutReport(), 0, "pass"],
			["scout", scoutReport(fixture.findings.slice(0, 1)), 1, "pass"],
			["scout", scoutReport(), 1, "fail"],
		] as const) {
			const receiptPath = join(scratch.dir, "receipt.json");
			writeFileSync(
				receiptPath,
				JSON.stringify({
					agentId: agent,
					outcome: "succeeded",
					exitCode: 0,
					quality: { resultContract: { conformance: "pass", quality } },
					output: { state: "final", text: output, truncated: false },
				}),
			);
			const eventsPath = join(scratch.dir, "runner.ndjson");
			writeFileSync(
				eventsPath,
				[
					{ type: "tool_execution_start", toolName: "dispatch", toolCallId: "source", args: { agent, task: fixture.task } },
					{
						type: "tool_execution_end",
						toolName: "dispatch",
						toolCallId: "source",
						result: { details: { runs: [{ receiptPath }] } },
					},
				]
					.map((event) => JSON.stringify(event))
					.join("\n"),
			);
			// Only the standalone grader starts here; no Clio binary, worker, or provider.
			const graded = spawnSync(
				process.execPath,
				[fileURLToPath(new URL("../../evals/source-explanation-grader.mjs", import.meta.url)), agent],
				{
					cwd: scratch.dir,
					env: { ...process.env, CLIO_CODER_EVAL_RUNNER_STDOUT_FILE: eventsPath },
					encoding: "utf8",
					timeout: 5000,
				},
			);
			strictEqual(graded.status, expectedExit, graded.stderr);
			match(graded.stdout, expectedExit === 0 ? /"task.solved":true/u : /"task.solved":false/u);
		}
	} finally {
		scratch.cleanup();
	}
});
