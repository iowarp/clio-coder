/**
 * What Clio says when the artifact a command was pointed at is not there.
 *
 * Four surfaces used to print node:fs verbatim: `ENOENT: no such file or
 * directory, open '<store path>'`. That names a path the operator never typed
 * (they typed an id), it does not name what kind of thing was missing, and it
 * names no remedy. The sibling surfaces that own their wording (`clio-coder memory
 * approve`, `clio-coder skills inspect`, `clio-coder extensions install`) all say
 * `<artifact> not found: <what the user typed>`, and that is the shape pinned
 * here. Where a listing command actually exists, the miss names it; `clio-coder eval`
 * has no list subcommand, so its message invents nothing.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("contracts/cli not-found voice", () => {
	const scratch = makeScratchHome("clio-not-found-");
	after(() => scratch.cleanup());

	const cases: ReadonlyArray<{ name: string; args: string[]; expect: RegExp }> = [
		{
			name: "eval report names the missing eval artifact by id",
			args: ["eval", "report", "nosuchid", "--format", "text"],
			expect: /^error: eval artifact not found: nosuchid$/m,
		},
		{
			name: "eval compare names the first id it could not load",
			args: ["eval", "compare", "nosuchbaseline", "nosuchcandidate"],
			expect: /^error: eval artifact not found: nosuchbaseline$/m,
		},
		{
			name: "evidence inspect names the missing bundle by id",
			args: ["evidence", "inspect", "nosuch"],
			expect: /^error: evidence artifact not found: nosuch$/m,
		},
		{
			name: "evolve manifest validate names the missing manifest by path",
			args: ["evolve", "manifest", "validate", "/nope/m.yaml"],
			expect: /^error: change manifest not found: \/nope\/m\.yaml$/m,
		},
		{
			name: "components diff names the missing snapshot by path",
			args: ["components", "diff", "--from", "/nope/a.json", "--to", "/nope/b.json"],
			expect: /^error: component snapshot not found: \/nope\/a\.json$/m,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			const result = await runCli(testCase.args, { env: scratch.env });
			strictEqual(result.code, 1, `stderr=${result.stderr}`);
			match(result.stderr, testCase.expect);
			ok(!/ENOENT/.test(result.stderr), `raw node:fs text is not the product's error: ${result.stderr}`);
		});
	}

	it("evidence inspect names the listing command, and that command runs", async () => {
		const missing = await runCli(["evidence", "inspect", "nosuch"], { env: scratch.env });
		match(missing.stderr, /run `clio-coder evidence list` to see local bundles/);

		// The named remedy has to be a command that exists and exits clean.
		const listed = await runCli(["evidence", "list"], { env: scratch.env });
		strictEqual(listed.code, 0, `stderr=${listed.stderr}`);
		match(listed.stdout, /evidence artifacts/);
	});

	it("eval report invents no listing command, because clio-coder eval has none", async () => {
		const result = await runCli(["eval", "report", "nosuchid"], { env: scratch.env });
		ok(!/eval list/.test(result.stderr), `no such subcommand may be advertised: ${result.stderr}`);

		const bogus = await runCli(["eval", "list"], { env: scratch.env });
		strictEqual(bogus.code, 2, "clio-coder eval list is still not a command");
	});

	it("separates a bundle that is absent from one that is incomplete", async () => {
		// A directory holding an overview but no findings.json is a damaged
		// bundle, not a missing one, and saying "not found" over it would send the
		// operator to `evidence list`, where it is listed.
		const evidenceId = "ev-partial";
		const dir = join(scratch.dir, "data", "evidence", evidenceId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "overview.json"),
			`${JSON.stringify({
				version: 1,
				evidenceId,
				source: { kind: "run", runId: "run-1" },
				generatedAt: "2026-01-01T00:00:00.000Z",
				runIds: ["run-1"],
				sessionId: null,
				statuses: ["ok"],
				startedAt: null,
				endedAt: null,
				tasks: [],
				cwds: [],
				agentIds: [],
				targetIds: [],
				runtimeIds: [],
				modelIds: [],
				totals: {
					runs: 1,
					receipts: 0,
					toolCalls: 0,
					toolErrors: 0,
					blockedToolCalls: 0,
					tokens: 0,
					costUsd: 0,
					wallTimeMs: 0,
				},
				tags: [],
				files: [],
			})}\n`,
			"utf8",
		);

		const result = await runCli(["evidence", "inspect", evidenceId], { env: scratch.env });
		strictEqual(result.code, 1, `stderr=${result.stderr}`);
		match(result.stderr, /evidence artifact ev-partial is missing findings\.json/);
		ok(!/not found/.test(result.stderr), `a bundle that exists must not be reported missing: ${result.stderr}`);
		ok(!/ENOENT/.test(result.stderr), `raw node:fs text is not the product's error: ${result.stderr}`);
	});
});
