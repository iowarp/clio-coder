import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import {
	fleetEventJournalPath,
	fleetManifestDigest,
	readFleetEventJournal,
} from "../../src/domains/dispatch/fleet-event-journal.js";
import { executeFleetRun } from "../../src/domains/dispatch/fleet-run.js";
import { readFleetRun } from "../../src/domains/dispatch/state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function git(root: string, ...args: string[]) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("a fleet appends a hash-chained journal whose settled steps are sealed manifest checkpoints", async () => {
	const env = await isolateClioEnv("clio-coder-fleet-events-");
	const root = mkdtempSync(join(tmpdir(), "clio-coder-fleet-events-repo-"));
	try {
		git(root, "init", "-q");
		git(root, "config", "user.name", "Contract");
		git(root, "config", "user.email", "contract@example.invalid");
		writeFileSync(join(root, "base.txt"), "base");
		git(root, "add", ".");
		git(root, "commit", "-qm", "base");
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "stage then check",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [
				{ kind: "code", id: "stage", commandId: "stage", scope: "workspace", dependencies: [] },
				{ kind: "code", id: "check", commandId: "check", scope: "readonly", dependencies: ["stage"] },
			],
		});
		const command = (id: string, script: string) => ({
			id,
			argv: [process.execPath, "-e", script],
			cwd: "",
			timeoutMs: 10000,
			env: [],
			description: id,
		});
		const rootId = "fleet-0123456789ab";
		const outcome = await executeFleetRun({
			plan,
			playbookName: "stage-check",
			commands: {
				version: 1,
				path: join(root, "commands.yaml"),
				commands: new Map([
					["stage", command("stage", "require('node:fs').writeFileSync('base.txt','staged')")],
					["check", command("check", "process.exit(require('node:fs').readFileSync('base.txt','utf8')==='staged'?0:1)")],
				]),
			},
			workspaceRoot: root,
			fleetRootId: rootId,
			dispatch: {} as Parameters<typeof executeFleetRun>[0]["dispatch"],
			agents: {} as Parameters<typeof executeFleetRun>[0]["agents"],
			attributionEnabled: false,
		});
		strictEqual(outcome.cleanRun, true);
		const read = readFleetEventJournal(rootId);
		ok(read);
		strictEqual(read.broken, null);
		strictEqual(read.sealed, true);
		deepStrictEqual(
			read.lines.map((line) => [line.seq, line.type, "stepId" in line ? line.stepId : null]),
			[
				[1, "fleet_started", null],
				[2, "step_dispatched", "stage"],
				[3, "step_settled", "stage"],
				[4, "step_dispatched", "check"],
				[5, "step_settled", "check"],
				[6, "fleet_sealed", null],
			],
		);
		for (const line of read.lines) {
			if (line.type === "step_settled") ok(existsSync(line.recordPath), line.recordPath);
		}
		const sealed = read.lines.at(-1);
		ok(sealed?.type === "fleet_sealed");
		strictEqual(sealed.outcome, "completed");
		strictEqual(sealed.manifestDigest, fleetManifestDigest(readFleetRun(rootId)));
		// A follower resumes from its cursor, and a forged line is caught.
		const text = readFileSync(fleetEventJournalPath(rootId), "utf8");
		appendFileSync(fleetEventJournalPath(rootId), `${JSON.stringify({ ...sealed, seq: 7 })}\n`);
		const tampered = readFleetEventJournal(rootId, {
			offset: Buffer.byteLength(text),
			seq: sealed.seq,
			prev: sealed.digest,
		});
		ok(tampered);
		strictEqual(tampered.broken, "line 7 does not extend the chain");
	} finally {
		rmSync(root, { recursive: true, force: true });
		env.restore();
	}
});
