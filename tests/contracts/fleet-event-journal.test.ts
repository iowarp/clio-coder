import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runFleetEvents } from "../../src/cli/fleet-events.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { claimAssignmentVerdict } from "../../src/domains/dispatch/assignment-store.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import {
	createFleetEventJournal,
	fleetEventJournalPath,
	fleetManifestDigest,
	fleetStepEntryDigest,
	readFleetEventJournal,
} from "../../src/domains/dispatch/fleet-event-journal.js";
import { executeFleetRun } from "../../src/domains/dispatch/fleet-run.js";
import { readFleetRun, writeFleetRun } from "../../src/domains/dispatch/state.js";
import { readCallJournalSync } from "../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function git(root: string, ...args: string[]) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("a fleet appends a hash-chained journal whose settled steps name the manifest bytes on disk", async () => {
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
		const recordPath = join(dirname(fleetEventJournalPath(rootId)), `${rootId}.json`);
		// The record is rewritten as the fleet goes on; the bytes stage's settle
		// wrote are on disk only until the next write, which follows check's dispatch.
		let afterStage: string | null = null;
		const progress: string[] = [];
		const notices: string[] = [];
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
			onStepSettled: (step) => {
				progress.push(step.stepId);
				const rows = readCallJournalSync(telemetryRunDirectory(clioStateDir(), rootId)).records;
				ok(rows.some(({ record }) => record.k === "code_step.settled" && record.data.runId === step.terminalRunId));
				ok(step.recordPath && existsSync(step.recordPath));
			},
			onNotice: (text) => notices.push(text),
			onStepDispatched: (event) => {
				if (event.stepId === "check") afterStage = readFileSync(recordPath, "utf8");
			},
		});
		strictEqual(outcome.cleanRun, true);
		deepStrictEqual(progress, ["stage", "check"]);
		deepStrictEqual(notices, [], "step callbacks must not also emit human notices in text or JSON mode");
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
		const stageSettled = read.lines[2];
		ok(stageSettled?.type === "step_settled");
		ok(afterStage !== null);
		strictEqual(stageSettled.manifestDigest, createHash("sha256").update(afterStage).digest("hex"));
		const final = readFleetRun(rootId);
		ok(final);
		strictEqual(stageSettled.manifestStepCount, 1);
		strictEqual(stageSettled.stepEntryDigest, fleetStepEntryDigest(final.steps[0] ?? { stepId: "", result: null }));
		const sealed = read.lines.at(-1);
		ok(sealed?.type === "fleet_sealed");
		strictEqual(sealed.outcome, "succeeded");
		strictEqual(sealed.manifestDigest, fleetManifestDigest(readFileSync(recordPath, "utf8")));
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

test("a fleet with a failed step seals failed", async () => {
	const env = await isolateClioEnv("clio-coder-fleet-events-red-");
	const root = mkdtempSync(join(tmpdir(), "clio-coder-fleet-events-red-repo-"));
	try {
		git(root, "init", "-q");
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "check",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [{ kind: "code", id: "check", commandId: "check", scope: "readonly", dependencies: [] }],
		});
		const rootId = "fleet-0123456789ac";
		const outcome = await executeFleetRun({
			plan,
			playbookName: "red",
			commands: {
				version: 1,
				path: join(root, "commands.yaml"),
				commands: new Map([
					[
						"check",
						{
							id: "check",
							argv: [process.execPath, "-e", "process.exit(1)"],
							cwd: "",
							timeoutMs: 10000,
							env: [],
							description: "check",
						},
					],
				]),
			},
			workspaceRoot: root,
			fleetRootId: rootId,
			dispatch: {} as Parameters<typeof executeFleetRun>[0]["dispatch"],
			agents: {} as Parameters<typeof executeFleetRun>[0]["agents"],
			attributionEnabled: false,
		});
		strictEqual(outcome.cleanRun, false);
		const sealed = readFleetEventJournal(rootId)?.lines.at(-1);
		ok(sealed?.type === "fleet_sealed");
		strictEqual(sealed.outcome, "failed");
	} finally {
		rmSync(root, { recursive: true, force: true });
		env.restore();
	}
});

test("a fleet whose final record write throws seals failed without naming an unwritten end", async () => {
	const env = await isolateClioEnv("clio-coder-fleet-events-lost-");
	const root = mkdtempSync(join(tmpdir(), "clio-coder-fleet-events-lost-repo-"));
	try {
		git(root, "init", "-q");
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "check",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [{ kind: "code", id: "check", commandId: "check", scope: "readonly", dependencies: [] }],
		});
		const rootId = "fleet-0123456789ad";
		// After dispatch the record is serialized twice: the step's settle, then the
		// final write. The var throws on the second, so only the final write fails.
		// toJSON sits on the prototype because the journal's canonical encoder
		// refuses an own function property.
		let armed = false;
		let writes = 0;
		const lossy = Object.create({
			toJSON() {
				if (armed && ++writes === 2) throw new Error("disk full");
				return "v";
			},
		});
		let thrown: unknown = null;
		try {
			await executeFleetRun({
				plan,
				playbookName: "lost",
				vars: { lossy } as unknown as Record<string, string>,
				commands: {
					version: 1,
					path: join(root, "commands.yaml"),
					commands: new Map([
						[
							"check",
							{
								id: "check",
								argv: [process.execPath, "-e", "process.exit(0)"],
								cwd: "",
								timeoutMs: 10000,
								env: [],
								description: "check",
							},
						],
					]),
				},
				workspaceRoot: root,
				fleetRootId: rootId,
				dispatch: {} as Parameters<typeof executeFleetRun>[0]["dispatch"],
				agents: {} as Parameters<typeof executeFleetRun>[0]["agents"],
				attributionEnabled: false,
				onStepDispatched: () => {
					armed = true;
				},
			});
		} catch (error) {
			thrown = error;
		}
		ok(thrown instanceof Error && thrown.message === "disk full");
		const sealed = readFleetEventJournal(rootId)?.lines.at(-1);
		ok(sealed?.type === "fleet_sealed");
		strictEqual(sealed.outcome, "failed");
		const onDisk = readFleetRun(rootId);
		ok(onDisk);
		strictEqual(onDisk.endedAt, null);
		ok(sealed.endedAt !== onDisk.endedAt);
	} finally {
		rmSync(root, { recursive: true, force: true });
		env.restore();
	}
});

test("fleet events prints the stored lines verbatim and ends at the seal", async () => {
	const env = await isolateClioEnv("clio-coder-fleet-events-cli-");
	try {
		const rootId = "fleet-abcdefabcdef";
		const journal = createFleetEventJournal(rootId);
		journal.append({
			type: "fleet_started",
			fleet: "f",
			planHash: "a".repeat(64),
			vars: {},
			resumedFrom: null,
			replayedStepIds: [],
			workspaceRoot: env.dir,
			stepIds: ["s"],
		});
		journal.append({
			type: "fleet_sealed",
			outcome: "succeeded",
			endedAt: "2026-10-01T00:00:00.000Z",
			stepCount: 0,
			manifestDigest: "c".repeat(64),
		});
		// Appending after the seal is refused, so a follower's EOF is final.
		journal.append({
			type: "fleet_sealed",
			outcome: "failed",
			endedAt: "2026-10-01T00:00:01.000Z",
			stepCount: 0,
			manifestDigest: "d".repeat(64),
		});
		const out = process.stdout.write.bind(process.stdout);
		let printed = "";
		// Without --follow every write happens before the first await, so the
		// capture is restored synchronously.
		process.stdout.write = ((chunk: string | Uint8Array) => {
			printed += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		let pending: Promise<number>;
		try {
			pending = runFleetEvents([rootId, "--json", "--all", "--follow"]);
		} finally {
			process.stdout.write = out;
		}
		strictEqual(await pending, 0);
		strictEqual(printed, readFileSync(fleetEventJournalPath(rootId), "utf8"));
		strictEqual(printed.trim().split("\n").length, 2);
	} finally {
		env.restore();
	}
});

test("fleet events --follow stops when the process running the fleet is gone", { timeout: 10000 }, async () => {
	const env = await isolateClioEnv("clio-coder-fleet-events-gone-");
	try {
		const rootId = "fleet-0123456789ad";
		await claimAssignmentVerdict(rootId, "fleet");
		// The same pid under another birth token is how a dead, reused pid reads.
		const storePath = join(clioStateDir(), "assignments.json");
		const store = JSON.parse(readFileSync(storePath, "utf8"));
		store.assignments[0].processOwner.processBirthToken = "gone";
		writeFileSync(storePath, JSON.stringify(store));
		await writeFleetRun({
			version: 1,
			id: rootId,
			fleet: "f",
			planHash: "a".repeat(64),
			stepIds: ["s"],
			planSteps: [],
			vars: {},
			startedAt: "2026-10-01T00:00:00.000Z",
			endedAt: null,
			resumedFrom: null,
			steps: [],
		});
		createFleetEventJournal(rootId).append({
			type: "fleet_started",
			fleet: "f",
			planHash: "a".repeat(64),
			vars: {},
			resumedFrom: null,
			replayedStepIds: [],
			workspaceRoot: env.dir,
			stepIds: ["s"],
		});
		let out = "";
		let err = "";
		const code = await runFleetEvents([rootId, "--follow", "--json", "--all"], {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		});
		strictEqual(code, 4);
		ok(err.includes(`the process running ${rootId} is gone`), err);
		strictEqual(out, readFileSync(fleetEventJournalPath(rootId), "utf8"));
	} finally {
		env.restore();
	}
});

test("a fleet refuses to execute code when its root telemetry journal cannot open", async () => {
	const env = await isolateClioEnv("clio-coder-fleet-no-telemetry-");
	try {
		const root = join(env.dir, "repo");
		mkdirSync(root);
		git(root, "init", "-q");
		const rootId = "fleet-no-telemetry";
		const directory = telemetryRunDirectory(clioStateDir(), rootId);
		mkdirSync(dirname(directory), { recursive: true });
		writeFileSync(directory, "blocks the journal directory");
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "check",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [{ kind: "code", id: "check", commandId: "check", scope: "readonly", dependencies: [] }],
		});
		let started = false;
		await rejects(
			executeFleetRun({
				plan,
				playbookName: "no-telemetry",
				workspaceRoot: root,
				fleetRootId: rootId,
				commands: {
					version: 1,
					path: join(root, "commands.yaml"),
					commands: new Map([
						[
							"check",
							{
								id: "check",
								argv: [process.execPath, "-e", "require('node:fs').writeFileSync('ran','yes')"],
								cwd: "",
								timeoutMs: 10000,
								env: [],
								description: "check",
							},
						],
					]),
				},
				dispatch: {} as Parameters<typeof executeFleetRun>[0]["dispatch"],
				agents: {} as Parameters<typeof executeFleetRun>[0]["agents"],
				attributionEnabled: false,
				onStarted: () => {
					started = true;
				},
			}),
			/fleet root telemetry journal unavailable/,
		);
		strictEqual(started, false);
		strictEqual(existsSync(join(root, "ran")), false);
		strictEqual(readFleetRun(rootId), null);
	} finally {
		env.restore();
	}
});
