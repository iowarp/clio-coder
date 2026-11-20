import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
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

test("the process's own output file in the checkout is not an outside change; any other change still is", async () => {
	const scratch = await isolateClioEnv("clio-coder-write-boundary-own-output-");
	const repo = join(realpathSync(scratch.dir), "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	writeFileSync(join(repo, "notes.md"), "before\n");
	git("add", ".");
	git("commit", "-q", "-m", "fixture");
	// What `fleet run ... > s.jsonl` leaves: the shell creates the file before the run starts.
	const redirect = openSync(join(repo, "s.jsonl"), "w");
	try {
		const enforce = (complete: boolean) => {
			const snapshot = captureWorkspaceSnapshot(repo);
			writeSync(redirect, `${JSON.stringify({ type: "fleet_step", complete })}\n`);
			writeFileSync(join(repo, "notes.md"), `after ${complete}\n`);
			return enforceWriteBoundary({
				snapshot,
				window: "wave-1",
				stepIds: ["detector"],
				allow: [],
				attribution: { recorded: [], complete, downgrades: [] },
				ownOutputFds: [redirect],
			});
		};
		const recorded = enforce(true);
		deepStrictEqual(recorded.unattributed, ["notes.md"]);
		match(recorded.detail ?? "", /recorded writing: notes\.md\./u);
		// Without a complete record every outside change is rolled back; the run's own output must survive that.
		const unrecorded = enforce(false);
		deepStrictEqual(unrecorded.violations, ["notes.md"]);
		match(readFileSync(join(repo, "s.jsonl"), "utf8"), /"complete":false/u);
	} finally {
		closeSync(redirect);
		scratch.restore();
	}
});
