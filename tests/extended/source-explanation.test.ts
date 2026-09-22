import { match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RESULT_SUMMARY_DEFAULT_MAX_BYTES, validateResultContract } from "../../src/domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../../src/domains/agents/result-contract-filesystem.js";
import { createWorkerOutputCapture, WORKER_OUTPUT_MAX_BYTES } from "../../src/domains/dispatch/event-pump.js";
import { readTool } from "../../src/tools/read.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/source-explanation.json", import.meta.url), "utf8")) as {
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

test("source explanation: explicit Coder delivers 1200 cited words inline and reports a limitation only under a narrower allowance", () => {
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
	// Under a narrower dispatch allowance the same content cannot fit, and the
	// honest answer is a stated limitation, not a shortened explanation.
	strictEqual(validate(delivered, 2048).conformance, "fail");
	const limitation = coderReport(fixture.coderLimitation);
	strictEqual(validate(limitation, 2048).conformance, "pass");
	strictEqual(validate(coderReport("x".repeat(RESULT_SUMMARY_DEFAULT_MAX_BYTES + 1))).conformance, "fail");
	strictEqual(validate(coderReport(fixture.coderLimitation, false)).quality, "fail");
	const invalid = validate(
		'{"mutatedPaths":[],"validations":[{"name":"source read","passed":true,"evidence":"unfinished',
	);
	strictEqual(invalid.conformance, "fail");
	match(invalid.reason ?? "", /valid JSON/u);
});

test("source explanation: separately selected Scout delivers 1200 cited words within the receipt bound", async () => {
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
		const firstFinding = fixture.findings[0];
		ok(firstFinding);
		strictEqual(validate(scoutReport([firstFinding])).conformance, "pass");
		const unsupported = scoutReport(fixture.findings.map((finding) => ({ ...finding, line: 9999 })));
		strictEqual(validate(unsupported).conformance, "fail");
		for (const [path, content] of Object.entries(fixture.files))
			strictEqual(readFileSync(join(scratch.dir, path), "utf8"), content);
	} finally {
		scratch.cleanup();
	}
});
