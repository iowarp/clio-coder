import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { runFleetWithShutdown } from "../../src/cli/fleet-lifecycle.js";
import { createFleetReporter } from "../../src/cli/fleet-reporting.js";
import type { Hook } from "../../src/core/termination.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import {
	fleetEventJournalPath,
	fleetManifestDigest,
	readFleetEventJournal,
} from "../../src/domains/dispatch/fleet-event-journal.js";
import { executeFleetRun } from "../../src/domains/dispatch/fleet-run.js";
import { fleetWorkspaceLockPath } from "../../src/domains/dispatch/fleet-workspace-lock.js";
import { readFleetRun } from "../../src/domains/dispatch/state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const mode of ["SIGINT", "SIGTERM", "SIGHUP", "forced", "deadline", "closed-stdout", "closed-stderr"]) {
	test(`fleet ${mode} shutdown seals the journal and releases the lock`, async () => {
		const scratch = await isolateClioEnv("clio-coder-fleet-interrupt-");
		const brokenPipe = new Writable({
			write(_chunk, _encoding, callback) {
				callback(Object.assign(new Error("reader closed"), { code: "EPIPE" }));
			},
		});
		const sink = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const reporter = createFleetReporter(
			mode === "closed-stdout" ? brokenPipe : sink,
			mode === "closed-stderr" ? brokenPipe : sink,
		);
		try {
			const root = join(scratch.dir, "workspace");
			mkdirSync(root);
			const rootId = "fleet-interrupt";
			const plan = compileExecutionPlan({
				topology: "fleet",
				rootTask: "check",
				maxWorkers: 1,
				onFailure: "stop",
				steps: ["check", "later"].map((id, index) => ({
					kind: "code" as const,
					id,
					commandId: "test",
					scope: "readonly" as const,
					dependencies: index === 0 ? [] : ["check"],
				})),
			});
			let forceExit: (() => void) | undefined;
			const notices: string[] = [];
			let hook: Hook | undefined;
			let shutdown: Promise<void> | undefined;
			let installed = false;
			let unregistered = false;
			const dispatched: string[] = [];
			const lifecycle: string[] = [];
			const outcome = await runFleetWithShutdown(
				(signal, registerEmergencySeal) =>
					executeFleetRun({
						registerEmergencySeal,
						plan,
						signal,
						playbookName: "check",
						workspaceRoot: root,
						fleetRootId: rootId,
						commands: {
							version: 1,
							path: join(root, "commands.yaml"),
							commands: new Map([
								[
									"test",
									{
										id: "test",
										argv: [process.execPath, "-e", "process.exit(0)"],
										cwd: "",
										timeoutMs: 10000,
										env: [],
										description: "test",
									},
								],
							]),
						},
						dispatch: {} as Parameters<typeof executeFleetRun>[0]["dispatch"],
						agents: {} as Parameters<typeof executeFleetRun>[0]["agents"],
						attributionEnabled: false,
						onStepSettled: () => reporter.stdout("step settled\n"),
						onStepDispatched: (step) => {
							dispatched.push(step.stepId);
							ok(installed && hook);
							const deadline = new AbortController();
							shutdown = Promise.resolve(hook(deadline.signal)).then(() => {
								lifecycle.push("shutdown finished");
							});
							if (mode === "forced" || mode === "deadline") {
								if (mode === "forced") {
									ok(forceExit);
									forceExit();
								} else deadline.abort();
								const seal = readFleetEventJournal(rootId)?.lines.at(-1);
								ok(seal?.type === "fleet_sealed" && seal.outcome === "aborted" && seal.forced === true);
								ok(readFleetRun(rootId)?.endedAt);
								strictEqual(existsSync(fleetWorkspaceLockPath(root)), false);
							}
						},
					}),
				async () => {
					ok(readFleetRun(rootId)?.endedAt);
					const sealed = readFleetEventJournal(rootId)?.lines.at(-1);
					ok(sealed?.type === "fleet_sealed");
					strictEqual(sealed.outcome, "aborted");
					strictEqual(
						sealed.manifestDigest,
						fleetManifestDigest(readFileSync(join(dirname(fleetEventJournalPath(rootId)), `${rootId}.json`), "utf8")),
					);
					strictEqual(existsSync(fleetWorkspaceLockPath(root)), false);
					lifecycle.push("cleanup finished");
				},
				0,
				{
					getExitCode: () => (mode === "SIGTERM" ? 143 : mode === "SIGHUP" ? 129 : 130),
					installSignalHandlers: () => {
						installed = true;
					},
					onForceExit: (callback) => {
						forceExit = callback;
						return () => {};
					},
					onTerminate: (callback) => {
						hook = callback;
						return () => {
							unregistered = true;
						};
					},
				},
				{
					notice: (text) => {
						notices.push(text);
						reporter.stderr(`${text}\n`);
					},
				},
			);
			await shutdown;
			reporter.stdout("summary\n");
			reporter.stderr("shutdown complete\n");
			strictEqual(notices.length, 1);
			strictEqual(
				notices[0],
				mode === "SIGTERM" || mode === "SIGHUP"
					? "Fleet run is sealing."
					: "Fleet run is sealing; a second Ctrl-C exits without completing sealing.",
			);
			strictEqual(outcome.cleanRun, false);
			deepStrictEqual(dispatched, ["check"]);
			deepStrictEqual(lifecycle, ["cleanup finished", "shutdown finished"]);
			ok(unregistered);
		} finally {
			await reporter.dispose();
			scratch.restore();
		}
	});
}

test("fleet interruption aborts pending step admission and closes dispatch before waiting", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-admission-interrupt-");
	try {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "check",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [
				{
					kind: "agent",
					id: "check",
					agentId: "coder",
					executionRole: "builder",
					scope: "readonly",
					expectedResultContract: "mutation-report",
					requestedAuthority: "workspace-edit",
					approvedAuthority: "workspace-edit",
					dependencies: [],
					task: "check",
				},
			],
		});
		let hook: Hook | undefined;
		let shutdown: Promise<void> | undefined;
		let drainStarted = false;
		const dispatch = {
			preview: () => ({ costUpperBoundUsd: 0, node: { id: "local" } }),
			reservations: {
				prepare: () => ({ ownerId: "reservation" }),
				release: () => null,
				rollback: () => null,
				rollbackUnconsumed: () => null,
			},
			dispatch: async (_request: unknown, _observer: unknown, preparation: { signal?: AbortSignal } | undefined) => {
				ok(preparation?.signal, "pending admission must carry the fleet abort signal");
				const pending = new Promise<never>((_resolve, reject) => {
					preparation.signal?.addEventListener("abort", () => reject(preparation.signal?.reason), { once: true });
				});
				ok(hook);
				shutdown = Promise.resolve(hook(new AbortController().signal));
				return pending;
			},
		} as unknown as Parameters<typeof executeFleetRun>[0]["dispatch"];
		await rejects(
			runFleetWithShutdown(
				(signal) =>
					executeFleetRun({
						plan,
						signal,
						commands: null,
						playbookName: "check",
						workspaceRoot: scratch.dir,
						fleetRootId: "fleet-admission-interrupt",
						dispatch,
						agents: { getSpec: () => null },
						attributionEnabled: false,
					}),
				async () => {
					ok(drainStarted);
					ok(readFleetRun("fleet-admission-interrupt")?.endedAt);
					const seal = readFleetEventJournal("fleet-admission-interrupt")?.lines.at(-1);
					ok(seal?.type === "fleet_sealed" && seal.outcome === "aborted");
					strictEqual(existsSync(fleetWorkspaceLockPath(scratch.dir)), false);
				},
				0,
				{
					getExitCode: () => 130,
					installSignalHandlers: () => {},
					onTerminate: (callback) => {
						hook = callback;
						return () => {};
					},
				},
				{
					beginDrain: async () => {
						drainStarted = true;
					},
				},
			),
			/aborted/,
		);
		await shutdown;
		ok(shutdown, "the pending admission was reached");
	} finally {
		scratch.restore();
	}
});
