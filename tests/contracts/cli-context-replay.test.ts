import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/context-replay/fixture-01.jsonl", import.meta.url));

describe("contracts/cli context replay overrides", () => {
	const scratch = makeScratchHome("clio-context-replay-home-");
	const outputs: string[] = [];
	after(async () => {
		for (const output of outputs) await rm(output, { recursive: true, force: true });
		scratch.cleanup();
	});

	for (const [flag, value] of [
		["--protect-last-turns", "0"],
		["--protect-last-turns", "1.5"],
		["--min-evictable-tokens", "-1"],
		["--min-evictable-tokens", "2.5"],
	] as const) {
		it(`rejects ${flag} ${value}`, async () => {
			const result = await runCli(["context", "replay", "--sessions", FIXTURE, flag, value], {
				env: scratch.env,
			});
			assert.equal(result.code, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
			assert.match(result.stderr, new RegExp(flag));
		});
	}

	it("records valid replay-only overrides and the saturation metric", async () => {
		const output = await mkdtemp(join(tmpdir(), "clio-context-replay-output-"));
		outputs.push(output);
		const jsonPath = join(output, "replay.json");
		const markdownPath = join(output, "replay.md");
		const result = await runCli(
			[
				"context",
				"replay",
				"--sessions",
				FIXTURE,
				"--no-filter",
				"--policies",
				"none",
				"--budgets",
				"12000",
				"--protect-last-turns",
				"2",
				"--min-evictable-tokens",
				"17",
				"--json",
				jsonPath,
				"--md",
				markdownPath,
			],
			{ env: scratch.env },
		);
		assert.equal(result.code, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
		const artifact = JSON.parse(await readFile(jsonPath, "utf8")) as {
			config: { settings: { protectLastTurns: number; minEvictableTokens: number } };
			results: Array<{ metrics: { mean: { saturatedEvents: number } } }>;
		};
		assert.equal(artifact.config.settings.protectLastTurns, 2);
		assert.equal(artifact.config.settings.minEvictableTokens, 17);
		assert.equal(artifact.results[0]?.metrics.mean.saturatedEvents, 0);
		assert.match(await readFile(markdownPath, "utf8"), /\| saturated events \|/);
	});
});
