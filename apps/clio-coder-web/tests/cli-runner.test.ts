import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type CliCommand, commandPlan } from "../server/cli-commands.js";
import { CliCancelled, CliRunner } from "../server/services/cli-runner.js";
import { AppProblem } from "../server/services/problem.js";
import { scratchHome } from "./harness/scratch-home.js";

const fixture = fileURLToPath(new URL("./fixtures/cli-command-child.mjs", import.meta.url));
test("CLI runner: closed command table, exact argv, canonical cwd and prose outcomes", async () => {
	for (const input of [
		[],
		["targets", "--json"],
		{ kind: "shell", text: "echo hi" },
		{ kind: "targets.list", extra: "--probe" },
		{ kind: "targets.use", id: "--help" },
		{ kind: "targets.remove", id: "a;echo bad" },
	])
		assert.throws(() => commandPlan(input), AppProblem);
	const h = await scratchHome(),
		log = join(h.path, "commands.jsonl");
	const runner = new CliRunner({ ...h.env, CLIO_CODER_WEB_CLI: fixture, CLIO_CODER_WEB_COMMAND_LOG: log });
	try {
		const commands: { command: CliCommand; argv: string[] }[] = [
			{ command: { kind: "targets.list" }, argv: ["targets", "--json"] },
			{ command: { kind: "targets.probe", id: "local-1" }, argv: ["targets", "--json", "--probe", "--target", "local-1"] },
			{ command: { kind: "targets.use", id: "local-1" }, argv: ["targets", "use", "local-1"] },
			{ command: { kind: "targets.remove", id: "local-1" }, argv: ["targets", "remove", "local-1"] },
			{ command: { kind: "routing.models" }, argv: ["models", "--json", "--offline"] },
			{ command: { kind: "routing.profiles" }, argv: ["targets", "profile", "list", "--json"] },
			{ command: { kind: "routing.bindings" }, argv: ["targets", "profile", "bindings", "--json"] },
		];
		for (const { command, argv } of commands) {
			const value = await runner.run(command, h.path);
			assert.deepEqual(value, commandPlan(command).output === "json" ? { argv } : { exitCode: 0 });
		}
		const records = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			records.map((row) => row.argv),
			commands.map((row) => row.argv),
		);
		assert.ok(records.every((row) => row.cwd === h.path));
		await assert.rejects(runner.run({ kind: "targets.list" }, "."), AppProblem);
	} finally {
		await runner.close();
		await h.close();
	}
});

test("CLI runner: output/time bounds, strict decoding and sanitized exit errors", async () => {
	const h = await scratchHome();
	try {
		for (const scenario of ["stdout-limit", "stderr-limit", "utf8", "json", "fail", "ignore-term"]) {
			const runner = new CliRunner(
				{ ...h.env, CLIO_CODER_WEB_CLI: fixture, CLIO_CODER_WEB_COMMAND_SCENARIO: scenario },
				scenario === "ignore-term" ? 150 : 10_000,
			);
			try {
				await assert.rejects(runner.run({ kind: "targets.list" }, h.path), (error) => {
					assert.ok(error instanceof AppProblem);
					assert.equal(error.problem.code, "operation_failed");
					assert.ok(!JSON.stringify(error.problem).includes("fixture-private-stderr-content"));
					if (scenario === "fail") assert.match(error.problem.detail, /exit code 7/);
					return true;
				});
			} finally {
				await runner.close();
			}
		}
	} finally {
		await h.close();
	}
});

test("CLI runner: cancellation observes SIGTERM, reaps the child, and closes admitted jobs", async () => {
	const h = await scratchHome(),
		log = join(h.path, "commands.jsonl");
	const runner = new CliRunner({
		...h.env,
		CLIO_CODER_WEB_CLI: fixture,
		CLIO_CODER_WEB_COMMAND_LOG: log,
		CLIO_CODER_WEB_COMMAND_SCENARIO: "slow",
	});
	try {
		const controller = new AbortController();
		const pending = runner.run({ kind: "targets.probe", id: "local" }, h.path, controller.signal);
		const rejected = assert.rejects(pending, CliCancelled);
		let pid = 0;
		for (let i = 0; i < 100; i++) {
			const line = await readFile(log, "utf8").catch(() => "");
			if (line) {
				pid = JSON.parse(line.split("\n")[0] ?? "{}").pid;
				break;
			}
			await setTimeout(10);
		}
		assert.ok(pid);
		controller.abort();
		await rejected;
		assert.ok((await readFile(log, "utf8")).includes("SIGTERM"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		const jobs = Array.from({ length: 4 }, () => runner.run({ kind: "targets.list" }, h.path));
		const results = Promise.allSettled(jobs);
		await assert.rejects(runner.run({ kind: "targets.list" }, h.path), /full or stopping/);
		await runner.close();
		assert.ok((await results).every((row) => row.status === "rejected"));
		assert.equal(runner.activeCount, 0);
	} finally {
		await runner.close();
		await h.close();
	}
});
