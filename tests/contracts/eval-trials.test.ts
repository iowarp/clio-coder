import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";
import { resolveSuiteForRun } from "../../src/domains/eval/suites/resolve.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("contracts/eval trials", { concurrency: false }, () => {
	it("runs three trials in three distinct fresh workspaces", async () => {
		const scratch = makeScratchHome("clio-eval-trials-");
		try {
			const source = join(scratch.dir, "source");
			const workspaceLog = join(scratch.dir, "workspaces.txt");
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, "fixture.txt"), "original\n", "utf8");
			const runnerScript = [
				"const fs=require('node:fs')",
				`fs.appendFileSync(${JSON.stringify(workspaceLog)}, process.cwd()+'\\n')`,
				"fs.writeFileSync('trial-marker.txt','isolated')",
			].join(";");
			const suitePath = join(scratch.dir, "trials.yaml");
			writeFileSync(
				suitePath,
				[
					"version: 2",
					"suite:",
					"  id: trials-contract",
					"  title: Trials contract",
					"  visibility: local",
					"matrix:",
					"  targets:",
					"    - id: local",
					"  repeats: 1",
					"tasks:",
					"  - id: isolated-edit",
					"    tags:",
					"      - contract",
					"    workspace:",
					"      kind: local",
					"      path: source",
					"    runner:",
					"      kind: external-command",
					"      commands:",
					`        - ${JSON.stringify(`${process.execPath} -e ${JSON.stringify(runnerScript)}`)}`,
					"    verify:",
					"      measure:",
					`        - ${JSON.stringify(`${process.execPath} -e ${JSON.stringify("if(!require('node:fs').existsSync('trial-marker.txt'))process.exit(1)")}`)}`,
					"    metrics:",
					"      collect:",
					"        - task.solved",
					"    timeoutMs: 10000",
					"",
				].join("\n"),
				"utf8",
			);

			const run = await runCli(["eval", "run", "--suite", suitePath, "--trials", "3"], {
				env: scratch.env,
				cwd: scratch.dir,
				timeoutMs: 30_000,
			});
			strictEqual(run.code, 0, `stderr=${run.stderr}`);
			const evalId = /eval: (eval-[^\s]+)/u.exec(run.stdout)?.[1];
			if (evalId === undefined) throw new Error(`eval id missing from stdout: ${run.stdout}`);
			const dataDir = scratch.env.CLIO_CODER_DATA_DIR;
			if (dataDir === undefined) throw new Error("scratch data directory missing");
			const artifact = JSON.parse(readFileSync(join(dataDir, "evals", `${evalId}.json`), "utf8")) as EvalArtifactV4;
			const workspaces = readFileSync(workspaceLog, "utf8").trim().split("\n");

			strictEqual(artifact.results.length, 3);
			deepStrictEqual(
				artifact.results.map((result) => result.repeatIndex),
				[0, 1, 2],
			);
			strictEqual(
				artifact.results.every((result) => result.verdict?.outcome === "pass"),
				true,
			);
			strictEqual(new Set(workspaces).size, 3);
			strictEqual(new Set(artifact.results.map((result) => result.artifacts.workspace)).size, 3);
			strictEqual(existsSync(join(source, "trial-marker.txt")), false);
		} finally {
			scratch.cleanup();
		}
	});

	it("prepares one trial at a time and cleans workspace and state directories when copy trial 2 throws", async () => {
		const scratch = makeScratchHome("clio-eval-trial-cleanup-");
		try {
			const source = join(scratch.dir, "source");
			const tempRoot = join(scratch.dir, "temp");
			const runnerLog = join(scratch.dir, "completed-trials.txt");
			mkdirSync(source, { recursive: true });
			mkdirSync(tempRoot, { recursive: true });
			writeFileSync(join(source, "fixture.txt"), "original\n", "utf8");
			const runnerScript = `require('node:fs').appendFileSync(${JSON.stringify(runnerLog)},'ran\\n')`;
			const suitePath = join(scratch.dir, "copy-failure.yaml");
			writeFileSync(
				suitePath,
				[
					"version: 2",
					"suite:",
					"  id: copy-failure-contract",
					"  title: Copy failure contract",
					"  visibility: local",
					"matrix:",
					"  targets:",
					"    - id: local",
					"  repeats: 1",
					"tasks:",
					"  - id: copy-failure",
					"    tags: [contract]",
					"    workspace:",
					"      kind: local",
					"      path: source",
					"    runner:",
					"      kind: external-command",
					"      commands:",
					`        - ${JSON.stringify(`${process.execPath} -e ${JSON.stringify(runnerScript)}`)}`,
					"    verify: {}",
					"    metrics:",
					"      collect: []",
					"    timeoutMs: 10000",
					"",
				].join("\n"),
				"utf8",
			);
			const loaded = await loadEvalSuiteFile(suitePath);
			let copyAttempt = 0;
			const artifact = await runEvalSuiteV2(
				{ ...loaded, suite: resolveSuiteForRun(loaded.suite, { trials: 3 }) },
				{
					clioEntry: join(scratch.dir, "unused-entry.js"),
					freshWorkspaces: true,
					tempCopy: {
						tempRoot,
						copy: async (copySource, destination, options) => {
							copyAttempt += 1;
							if (copyAttempt === 2) {
								strictEqual(readFileSync(runnerLog, "utf8"), "ran\n", "trial 1 ran before trial 2 copied");
								throw Object.assign(new Error("fake copy ENOSPC"), { code: "ENOSPC" });
							}
							await cp(copySource, destination, options);
						},
					},
				},
			);

			strictEqual(copyAttempt, 3);
			deepStrictEqual(
				artifact.results.map((result) => result.pass),
				[true, false, true],
			);
			strictEqual(artifact.results[1]?.failureClass, "command_error");
			strictEqual(artifact.summary.failed, 1);
			strictEqual(readFileSync(runnerLog, "utf8"), "ran\nran\n");
			deepStrictEqual(
				readdirSync(tempRoot).filter(
					(entry) => entry.startsWith("clio-eval-workspace-") || entry.startsWith("clio-eval-state-"),
				),
				[],
			);
		} finally {
			scratch.cleanup();
		}
	});
});
