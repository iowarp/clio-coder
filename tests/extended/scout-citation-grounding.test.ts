import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	RESULT_CONTRACT_REPAIR_LIMIT,
	resultContractRepairMessages,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../../src/domains/agents/result-contract-filesystem.js";
import type { Observation } from "../../src/tools/observation.js";
import { readTool } from "../../src/tools/read.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const fixture = JSON.parse(
	readFileSync(new URL("../fixtures/scout-citation-pipeline.json", import.meta.url), "utf8"),
) as {
	files: Record<string, string>;
	evidence: { sourceSha256: Record<string, string> };
	findings: Array<{ claim: string; path: string; line: number }>;
};

test("retained Scout citation: actual reads exclude the trailing newline and unread source", async () => {
	const scratch = makeScratchHome("clio-coder-scout-grounding-");
	try {
		mkdirSync(join(scratch.dir, "findiff"));
		for (const [path, content] of Object.entries(fixture.files)) {
			strictEqual(createHash("sha256").update(content).digest("hex"), fixture.evidence.sourceSha256[path]);
			writeFileSync(join(scratch.dir, path), content);
		}
		const observed = new Map<string, Array<readonly [number, number]>>();
		for (const [path, total] of [
			["findiff/grids.py", 86],
			["findiff/interface.py", 63],
		] as const) {
			const absolute = join(scratch.dir, path);
			const read = await readTool.run({ path: absolute });
			ok(read.kind === "ok");
			strictEqual((read.details?.observation as Observation | undefined)?.shownCount, total);
			strictEqual((read.details?.observation as Observation | undefined)?.totalCount, total);
			strictEqual(read.output, fixture.files[path], "the model sees unnumbered source bytes");
			observed.set(absolute, [[1, total]]);
		}
		const validate = (line: number) =>
			validateResultContract({
				contract: { kind: "scout-report" },
				cwd: scratch.dir,
				networkAllowed: false,
				filesystem: nodeResultContractFilesystem(),
				observedReadRanges: observed,
				output: JSON.stringify({
					findings: fixture.findings.map((finding) =>
						finding.path === "findiff/interface.py" ? { ...finding, line } : finding,
					),
					needsSplit: false,
					proposedSubtasks: [],
				}),
			});
		const failure = validate(64);
		strictEqual(failure.conformance, "fail");
		match(failure.reason ?? "", /past end of file: findiff\/interface.py:64; current file has 63 lines/u);
		strictEqual(validate(62).conformance, "pass");
		// Range validity alone is not semantic validity: the fixture's expected
		// claim is independently tied to the source statement, not clamped to 63.
		strictEqual(
			fixture.files["findiff/interface.py"]?.split("\n")[61]?.trim(),
			"grid_axis = make_axis(axis, grid, periodic)",
		);
		const narrow = await readTool.run({ path: join(scratch.dir, "findiff/interface.py"), offset: 59, limit: 2 });
		ok(narrow.kind === "ok");
		strictEqual((narrow.details?.observation as Observation | undefined)?.shownCount, 2);
		observed.set(join(scratch.dir, "findiff/interface.py"), [[59, 60]]);
		strictEqual(validate(62).conformance, "fail", "existing but unread source remains rejected");
		const confirmed = await readTool.run({ path: join(scratch.dir, "findiff/interface.py"), offset: 62, limit: 1 });
		ok(confirmed.kind === "ok");
		strictEqual((confirmed.details?.observation as Observation | undefined)?.shownCount, 1);
		match(confirmed.output, /^ {8}grid_axis = make_axis\(axis, grid, periodic\)/u);
		observed.set(join(scratch.dir, "findiff/interface.py"), [[62, 62]]);
		strictEqual(validate(62).conformance, "pass");
		strictEqual(validate(63).conformance, "fail");
	} finally {
		scratch.cleanup();
	}
});

test("Scout repair quotes the validator and inclusive ranges without inventing citations", () => {
	const reason = "Scout citation is not grounded in a live read: findiff/interface.py:64 (this run read only 1-63)";
	const exchange = resultContractRepairMessages(
		{
			contract: { kind: "scout-report" },
			reason,
			attempt: RESULT_CONTRACT_REPAIR_LIMIT,
			anchors: ["findiff/grids.py:1-86", "findiff/interface.py:1-63"],
		},
		{ provider: "fixture", api: "openai-completions", model: "fixture" },
	);
	deepStrictEqual(
		exchange.map((message) => message.role),
		["assistant", "toolResult"],
	);
	const content = exchange[1].content[0].text;
	ok(content.includes(`Validator reason: ${reason}`));
	match(content, /FINAL RESULT REQUIRED IN THIS RESPONSE/u);
	match(content, /Tool use is over/u);
	match(content, /path:start-end, inclusive/u);
	match(content, /Range endpoints are not suggested citations/u);
	match(content, /remove that finding and keep the confirmed findings/u);
	match(content, /Never shift a rejected citation into range/u);
	ok(content.includes("findiff/interface.py:1-63"));
});

test("Scout repair reports current physical bounds after a source snapshot shrinks", () => {
	const scratch = makeScratchHome("clio-scout-moving-source-");
	try {
		const file = join(scratch.dir, "moving.ts");
		writeFileSync(file, "// heading\nexport const answer = 42;\n// footer\n");
		const input = {
			contract: { kind: "scout-report" as const },
			cwd: scratch.dir,
			networkAllowed: false,
			filesystem: nodeResultContractFilesystem(),
			observedReadRanges: new Map([[file, [[1, 3] as const]]]),
		};
		const output = (line: number) =>
			JSON.stringify({
				findings: [{ claim: "Exports answer", path: "moving.ts", line }],
				needsSplit: false,
				proposedSubtasks: [],
			});
		strictEqual(validateResultContract({ ...input, output: output(2) }).conformance, "pass");
		writeFileSync(file, "export const answer = 42;\n");
		const stale = validateResultContract({ ...input, output: output(2) });
		strictEqual(stale.conformance, "fail");
		match(stale.reason ?? "", /moving\.ts:2; current file has 1 lines \(valid lines 1-1\)/);
		match(stale.reason ?? "", /Re-read.*remove the citation/);
		strictEqual(validateResultContract({ ...input, output: output(1) }).conformance, "pass");
	} finally {
		scratch.cleanup();
	}
});

// A live scout rejected one citation per submission and needed three submissions to land an
// eighteen-finding report, so the refusal names every citation that failed.
test("Scout refusal names every ungrounded citation in one message", () => {
	const scratch = makeScratchHome("clio-scout-all-refusals-");
	try {
		for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(scratch.dir, name), "export {};\n// x\n// y\n");
		const read = (name: string) => join(scratch.dir, name);
		const validate = (names: string[]) =>
			validateResultContract({
				contract: { kind: "scout-report" as const },
				cwd: scratch.dir,
				networkAllowed: false,
				filesystem: nodeResultContractFilesystem(),
				observedReadRanges: new Map([[read("a.ts"), [[1, 3] as const]]]),
				output: JSON.stringify({
					findings: names.map((name) => ({ claim: `Cites ${name}`, path: name, line: 1 })),
					needsSplit: false,
					proposedSubtasks: [],
				}),
			});
		const both = validate(["a.ts", "b.ts", "c.ts"]);
		strictEqual(both.conformance, "fail");
		match(both.reason ?? "", /b\.ts:1 \(this run never read that file\); .*c\.ts:1 \(this run never read that file\)/u);
		const many = validate(["a.ts", ...Array.from({ length: 10 }, (_, i) => `missing-${i}.ts`)]);
		match(many.reason ?? "", /; and 2 more citations were refused$/u);
		strictEqual(validate(["a.ts"]).conformance, "pass");
	} finally {
		scratch.cleanup();
	}
});
