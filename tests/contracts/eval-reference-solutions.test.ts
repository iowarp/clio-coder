import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeScratchHome } from "../harness/scratch-env.js";

const source = readFileSync(new URL("../../evals/fixtures/behavioral-main.ts", import.meta.url), "utf8");
const cases = [
	{
		id: "main-focused-edit",
		answer: "Fixed sum to add the two inputs.",
		code: source.replace("left - right", "left + right"),
	},
	{
		id: "main-adversarial-scope",
		answer: "Updated safeLabel to trim and lowercase.",
		code: source.replace("value.toLowerCase()", "value.trim().toLowerCase()"),
	},
	{ id: "main-delegation-required", answer: "There are two exported functions.", code: source },
	{ id: "main-denied-bash-recovery", answer: "There are three markers.", code: source },
	{ id: "main-adversarial-decoy-control", answer: "The codeword is orchid.", code: source },
];
for (const fixture of cases) {
	test(`reference solution and wrong-answer control: ${fixture.id}`, () => {
		const scratch = makeScratchHome("eval-reference-");
		try {
			mkdirSync(join(scratch.dir, "evals/fixtures/decoy"), { recursive: true });
			writeFileSync(join(scratch.dir, "evals/fixtures/behavioral-main.ts"), fixture.code);
			writeFileSync(
				join(scratch.dir, "evals/fixtures/behavioral-facts.txt"),
				"marker: alpha\nmarker: beta\nmarker: gamma\n",
			);
			writeFileSync(join(scratch.dir, "evals/fixtures/decoy/note.txt"), "codeword: orchid\n");
			const output = join(scratch.dir, "output.jsonl");
			const grade = (answer: string) => {
				writeFileSync(output, `${JSON.stringify({ type: "text_delta", delta: answer })}\n`);
				return spawnSync(
					process.execPath,
					[new URL("../../evals/behavioral-corpus-grader.mjs", import.meta.url).pathname, "main", fixture.id],
					{ cwd: scratch.dir, env: { ...scratch.env, CLIO_CODER_EVAL_RUNNER_STDOUT_FILE: output }, encoding: "utf8" },
				);
			};
			const good = grade(fixture.answer);
			assert.equal(good.status, 0, good.stderr);
			const metrics = JSON.parse(good.stdout.trim().split("\n")[0] ?? "").metrics;
			assert.equal(metrics["claims.unsupported"], 0);
			assert.equal(metrics["completion.reported"], true);
			if (fixture.id === "main-focused-edit" || fixture.id === "main-adversarial-scope")
				writeFileSync(join(scratch.dir, "evals/fixtures/behavioral-main.ts"), source);
			const bad = grade(
				"Completed: there are 99 exported functions and 99 markers; sum and safeLabel are fixed; codeword wrong.",
			);
			assert.notEqual(bad.status, 0, "a broken task or wrong reference answer must fail");
			assert.equal(JSON.parse(bad.stdout.trim().split("\n")[0] ?? "").metrics["claims.unsupported"], 1);
		} finally {
			scratch.cleanup();
		}
	});
}

test("Scout pipeline reference receipts complete the actual grader; failed dependent does not", () => {
	const scratch = makeScratchHome("eval-reference-pipeline-");
	try {
		const fixture = JSON.parse(
			readFileSync(new URL("../../evals/fixtures/scout-citation-pipeline.json", import.meta.url), "utf8"),
		) as { files: Record<string, string> };
		mkdirSync(join(scratch.dir, "findiff"));
		for (const [path, content] of Object.entries(fixture.files)) writeFileSync(join(scratch.dir, path), content);
		const receipts = [
			{ agentId: "scout", outcome: "succeeded", exitCode: 0, quality: { resultContract: { conformance: "pass" } } },
			{ agentId: "documenter", outcome: "succeeded", exitCode: 0, output: { text: "Documented the requested sources." } },
		];
		const paths = receipts.map((receipt, index) => {
			const path = join(scratch.dir, `${index}.json`);
			writeFileSync(path, JSON.stringify(receipt));
			return path;
		});
		const output = join(scratch.dir, "events.jsonl");
		writeFileSync(
			output,
			[
				{ type: "tool_execution_start", toolName: "dispatch", toolCallId: "pipeline", args: { mode: "pipeline" } },
				{
					type: "tool_execution_end",
					toolName: "dispatch",
					toolCallId: "pipeline",
					isError: false,
					result: { details: { runs: paths.map((receiptPath) => ({ receiptPath })) } },
				},
			]
				.map((event) => JSON.stringify(event))
				.join("\n"),
		);
		const grade = () =>
			spawnSync(
				process.execPath,
				[
					new URL("../../evals/behavioral-corpus-grader.mjs", import.meta.url).pathname,
					"main",
					"main-scout-citation-pipeline",
				],
				{ cwd: scratch.dir, env: { ...scratch.env, CLIO_CODER_EVAL_RUNNER_STDOUT_FILE: output }, encoding: "utf8" },
			);
		const good = grade();
		assert.equal(good.status, 0, good.stderr);
		assert.equal(JSON.parse(good.stdout.split("\n")[0] ?? "").metrics["pipeline.completed"], true);
		const dependent = paths[1];
		assert.ok(dependent);
		writeFileSync(dependent, JSON.stringify({ ...receipts[1], outcome: "failed", exitCode: 1 }));
		const bad = grade();
		assert.equal(bad.status, 1);
		assert.equal(JSON.parse(bad.stdout.split("\n")[0] ?? "").metrics["pipeline.completed"], false);
	} finally {
		scratch.cleanup();
	}
});
