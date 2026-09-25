import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type HeadlessScratch, headlessScratch, runCli, sealedReceipt } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatFleetDefault,
	seedOpenAICompatOrchestrator,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

const PROOF = "written under --cwd\n";

const fixtures: OpenAICompatFixture[] = [];
const scratches: HeadlessScratch[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
	for (const scratch of scratches.splice(0)) scratch.cleanup();
});

/** A scratch home whose chat target scripts one `write` of `c1-proof.txt`, then answers "done". */
async function writingHome(): Promise<{ scratch: HeadlessScratch; fixture: OpenAICompatFixture }> {
	const scratch = headlessScratch("clio-coder-run-cwd-");
	scratches.push(scratch);
	const fixture = await startOpenAICompatFixture("done", {
		toolCall: { name: "write", arguments: { path: "c1-proof.txt", content: PROOF } },
	});
	fixtures.push(fixture);
	seedOpenAICompatToolOrchestrator(scratch.configDir, fixture.url, "default");
	return { scratch, fixture };
}

describe("clio-coder run --cwd", () => {
	it("behaves as if started in the named directory when launched from another one", async () => {
		const { scratch, fixture } = await writingHome();
		const project = join(scratch.root, "project");
		const launch = join(scratch.root, "elsewhere");
		mkdirSync(project);
		mkdirSync(launch);
		// A relative value resolves against the launch directory, as `cd` would.
		const turn = await runCli(
			[
				"--no-context-files",
				"--no-skills",
				"run",
				"--cwd",
				relative(launch, project),
				"--autonomy",
				"default",
				"Write the proof file.",
			],
			{ env: scratch.env, cwd: launch },
		);
		strictEqual(turn.code, 0, turn.stderr);
		ok(fixture.requests.length > 0, "the run must reach the model");
		strictEqual(readFileSync(join(project, "c1-proof.txt"), "utf8"), PROOF);
		ok(!existsSync(join(launch, "c1-proof.txt")), "the write must not land in the launch directory");
		const { receipt, envelope } = sealedReceipt(scratch.stateDir);
		strictEqual(envelope.cwd, realpathSync(project));
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.toolStats.find((stat) => stat.tool === "write")?.ok, 1);
	});

	it("enters the directory before an --agent dispatch too", async () => {
		const scratch = headlessScratch("clio-coder-run-cwd-agent-");
		scratches.push(scratch);
		const fixture = await startOpenAICompatFixture("done", {
			toolCall: { name: "write", arguments: { path: "c1-proof.txt", content: PROOF } },
		});
		fixtures.push(fixture);
		seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
		seedOpenAICompatFleetDefault(scratch.configDir);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		const turn = await runCli(
			[
				"--no-context-files",
				"--no-skills",
				"run",
				"--cwd",
				project,
				"--autonomy",
				"default",
				"--agent",
				"coder",
				"Write the proof file.",
			],
			{ env: scratch.env, cwd: scratch.root, timeoutMs: 60_000 },
		);
		// The fixture's plain "done" does not satisfy the coder recipe's JSON
		// result contract, so the worker's own exit is not the point here; where
		// its write landed and what its receipt recorded are.
		ok(turn.code === 0 || turn.code === 1, `unexpected exit ${turn.code}: ${turn.stderr}`);
		strictEqual(readFileSync(join(project, "c1-proof.txt"), "utf8"), PROOF);
		ok(!existsSync(join(scratch.root, "c1-proof.txt")), "the write must not land in the launch directory");
		const { receipt, envelope } = sealedReceipt(scratch.stateDir);
		strictEqual(receipt.agentId, "coder");
		strictEqual(envelope.cwd, realpathSync(project));
		strictEqual(receipt.reproducibility?.cwd, realpathSync(project));
	});

	for (const kind of ["missing", "file"] as const) {
		for (const agent of [false, true]) {
			it(`refuses a ${kind} path${agent ? " on the --agent path" : ""} before any model call`, async () => {
				const { scratch, fixture } = await writingHome();
				const target = join(scratch.root, kind === "missing" ? "no-such-dir" : "plain-file.txt");
				if (kind === "file") writeFileSync(target, "not a directory\n");
				const turn = await runCli(
					[
						"--no-context-files",
						"--no-skills",
						"run",
						"--cwd",
						target,
						...(agent ? ["--agent", "coder"] : []),
						"Write the proof file.",
					],
					{ env: scratch.env, cwd: scratch.root },
				);
				strictEqual(turn.code, 2, turn.stderr);
				match(turn.stderr, /--cwd is not a directory this process can enter/);
				ok(turn.stderr.includes(target), `stderr must name ${target}: ${turn.stderr}`);
				strictEqual(fixture.requests.length, 0, "no model call may happen");
				strictEqual(receiptCount(scratch.stateDir), 0, "a refused run seals nothing");
			});
		}
	}

	it("treats --cwd with no value as a usage error", async () => {
		const { scratch, fixture } = await writingHome();
		for (const args of [
			["run", "--cwd"],
			["run", "--cwd", "--json", "Write the proof file."],
		]) {
			const turn = await runCli(args, { env: scratch.env, cwd: scratch.root });
			strictEqual(turn.code, 2, turn.stderr);
			match(turn.stderr, /--cwd requires a value/);
		}
		strictEqual(fixture.requests.length, 0);
	});
});

function receiptCount(stateDir: string): number {
	const dir = join(stateDir, "receipts");
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0;
}
