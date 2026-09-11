import { match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import {
	closeServer,
	type OpenAICompatToolCallScript,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;

test("trusted user hooks protect paths before mutations and after observations in the running harness", async () => {
	const scratch = await isolateClioEnv("clio-coder-user-hook-protection-");
	const originalCwd = process.cwd();
	const calls: OpenAICompatToolCallScript[] = [
		{ name: "read", arguments: { path: "after.txt" } },
		{ name: "write", arguments: { path: "before.txt", content: "overwritten before" } },
		{ name: "write", arguments: { path: "after.txt", content: "overwritten after" } },
		{ name: "write", arguments: { path: "ordinary.txt", content: "allowed write" } },
	];
	let nextCall = 0;
	const fixture = await startOpenAICompatFixture("PROTECTION_CHECK_COMPLETE", {
		toolCall: () => calls[nextCall++] ?? null,
	});
	try {
		const cwd = join(scratch.dir, "workspace");
		mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
		process.chdir(cwd);
		ensureClioState();
		seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url);
		writeFileSync("before.txt", "original before");
		writeFileSync("after.txt", "original after");
		writeFileSync(
			join(cwd, ".clio-coder", "hooks.yaml"),
			JSON.stringify([
				{
					id: "protect-before-write",
					on: "before_tool",
					tools: ["write"],
					kind: "effect",
					effect: { kind: "protect_path", path: "before.txt", reason: "fixture sealed before mutation" },
				},
				{
					id: "protect-after-read",
					on: "after_tool",
					tools: ["read"],
					kind: "effect",
					effect: { kind: "protect_path", path: "after.txt", reason: "fixture sealed after observation" },
				},
			]),
		);
		const reviewed = captureProjectSurface(cwd, "hooks");
		ok(reviewed.contentHash);
		recordProjectSurfaceTrust(cwd, "hooks", reviewed.contentHash);
		const result = await promisify(execFile)(
			process.execPath,
			[
				CLI,
				"--no-context-files",
				"--no-skills",
				"run",
				"--json",
				"--autonomy",
				"full-auto",
				"Exercise the declared path protection hooks and finish.",
			],
			{
				cwd,
				env: { ...process.env, ...scratchClioEnvVars(scratch.dir), CLIO_CODER_TEST_OPENAI_KEY: "fixture-key" },
				timeout: 40_000,
				maxBuffer: 2_000_000,
			},
		);
		match(result.stdout, /PROTECTION_CHECK_COMPLETE/u);
		strictEqual(fixture.requests.filter((request) => request.stream !== false).length, 5);
		strictEqual(readFileSync("before.txt", "utf8"), "original before");
		strictEqual(readFileSync("after.txt", "utf8"), "original after");
		strictEqual(readFileSync("ordinary.txt", "utf8"), "allowed write");
		match(JSON.stringify(fixture.requests.at(-1)?.messages), /protected artifact blocked/u);
	} finally {
		await closeServer(fixture.server);
		process.chdir(originalCwd);
		scratch.restore();
	}
});
