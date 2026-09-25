import { ok, rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ContextContract } from "../../src/domains/context/contract.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Repositories often keep CLIO-CODER.md out of git. A `worktree: true` task
// checks out the committed tree, so the handbook was absent there, and the
// handbook walk stops at the worktree's own `.git` file: coders dispatched into
// task worktrees received no project rules at all.
const handbook = [
	"# Fixture",
	"",
	"## Hard invariants",
	"",
	"1. Never write `src/generated/**` by hand; `scripts/gen.sh` owns it.",
	"",
].join("\n");

test("a worker in a task worktree receives the source checkout's untracked handbook", async () => {
	const env = await isolateClioEnv("clio-coder-worktree-handbook-");
	const repo = join(env.dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	writeFileSync(join(repo, ".gitignore"), "CLIO-CODER.md\n.clio-coder/\n");
	writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "fixture");
	writeFileSync(join(repo, "CLIO-CODER.md"), handbook);

	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const base = dispatchStubContext({ settings });
	let delivered: ReadonlyArray<{ body: string }> = [];
	let workerCwd = "";
	const context: Pick<ContextContract, "renderPromptContext"> = {
		renderPromptContext: (cwd) => renderPromptContext(cwd),
	};
	const bundle = makeDispatchBundle(
		{
			bus: base.bus,
			getContract: ((name: string) => (name === "context" ? context : base.getContract(name))) as typeof base.getContract,
		},
		{
			spawnWorker(spec, opts) {
				delivered = spec.dynamicPromptMessages ?? [];
				workerCwd = opts?.cwd ?? "";
				throw new Error("captured prompt");
			},
		},
	);
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({
				agentId: "coder",
				task: "Edit src/index.ts.",
				executionRole: "builder",
				requestOrigin: "internal",
				cwd: repo,
				worktree: true,
			}),
			/captured prompt/,
		);
		ok(workerCwd.length > 0 && workerCwd !== repo, `worker ran in ${workerCwd}`);
		ok(
			delivered.some(({ body }) => body.includes("`scripts/gen.sh` owns it")),
			JSON.stringify(delivered.map(({ body }) => body.slice(0, 200))),
		);
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});
