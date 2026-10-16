import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureWorkspaceSnapshot, enforceWriteBoundary } from "../../src/domains/dispatch/write-boundary.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("a change no step recorded names the window and step and says it came from outside the fleet", async () => {
	const scratch = await isolateClioEnv("clio-coder-write-boundary-diagnostic-");
	try {
		const repo = join(realpathSync(scratch.dir), "repo");
		mkdirSync(join(repo, "runs"), { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "fixture@example.invalid");
		git("config", "user.name", "Fixture");
		writeFileSync(join(repo, "runs", "report.md"), "before\n");
		git("add", ".");
		git("commit", "-q", "-m", "fixture");
		const snapshot = captureWorkspaceSnapshot(repo);
		// Written by another process while a read-only step's window was open.
		writeFileSync(join(repo, "runs", "report.md"), "after\n");
		const verdict = enforceWriteBoundary({
			snapshot,
			window: "wave-5",
			stepIds: ["detector"],
			allow: [],
			attribution: { recorded: [], complete: true, downgrades: [] },
		});
		strictEqual(verdict.status, "clean");
		deepStrictEqual(verdict.unattributed, ["runs/report.md"]);
		match(
			verdict.detail ?? "",
			/^While step 'detector' ran in window wave 5 \(\S+ to \S+\), something outside this fleet run changed paths no step of it recorded writing: runs\/report\.md\. They were left untouched/u,
		);
	} finally {
		scratch.restore();
	}
});
