import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createWorktreeBootRecovery, type WorktreeBootRecovery } from "../../src/domains/dispatch/boot-recovery.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import {
	claimCompeteGroup,
	recoverCleanupReadyCompeteGroups,
	registerCompeteGroupRun,
} from "../../src/tools/compete-worktrees.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** The signal that ended a worker this test spawned, once it has been reaped. */
async function exitSignal(child: ChildProcess | null): Promise<NodeJS.Signals | null> {
	if (child === null) return null;
	if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
	return child.signalCode;
}

/**
 * A crashed coordinator's compete group: its owner lease names this PID under
 * a birth token it never had, and its one leased worker ignores SIGTERM, so
 * recovery spends the full exit grace before it escalates.
 */
describe("compete recovery after a restart", () => {
	let root: string;
	let worker: ChildProcess | null = null;
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-boot-recovery-home-");
		root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-boot-recovery-")));
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "t@local");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, ".gitignore"), ".clio-coder/\n");
		git(root, "add", ".");
		git(root, "commit", "-q", "-m", "init");
		worker = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		await new Promise((resolve) => worker?.stdout?.once("data", resolve));
		const ownership = claimCompeteGroup(root, "g1");
		registerCompeteGroupRun(ownership, { runId: "r1", pid: worker.pid ?? null, runtimeKind: "http" });
		const manifestPath = join(ownership.directory, ".clio-coder-compete-owner.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { owner: Record<string, unknown> };
		manifest.owner = { ...manifest.owner, birthToken: "linux:1" };
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	});

	afterEach(() => {
		if (worker !== null && worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
		scratch.restore();
	});

	it("terminates a leased worker without holding the event loop", async () => {
		let settled = false;
		const recovery = recoverCleanupReadyCompeteGroups(root).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(settled, false);
		const result = await recovery;
		deepStrictEqual(result, { cleaned: ["g1"], preserved: [], failed: [] });
		strictEqual(await exitSignal(worker), "SIGKILL");
		strictEqual(existsSync(join(root, ".clio-coder", "worktrees", "g1")), false);
	});

	it("runs nothing until boot starts it, then settles once", async () => {
		const lines: string[] = [];
		const handle = createWorktreeBootRecovery({ cwd: root, worktreeRootSetting: "disk", report: (l) => lines.push(l) });
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(handle.started, false);
		strictEqual(worker?.signalCode, null);
		const first = handle.start();
		strictEqual(handle.start(), first);
		await handle.settled;
		deepStrictEqual(lines, []);
		strictEqual(await exitSignal(worker), "SIGKILL");
		strictEqual(existsSync(join(root, ".clio-coder", "worktrees", "g1")), false);
	});
});

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "researcher",
	task: "Inspect isolated fixture evidence.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

/** A boot recovery the test settles by hand. */
function heldRecovery(): WorktreeBootRecovery & { starts: number; release(): void } {
	let release!: () => void;
	const settled = new Promise<void>((resolve) => {
		release = resolve;
	});
	const handle = {
		starts: 0,
		started: false,
		settled,
		release,
		start() {
			handle.starts += 1;
			handle.started = true;
			return settled;
		},
	};
	return handle;
}

describe("dispatch admission during boot recovery", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-boot-admission-");
	});
	afterEach(() => scratch.restore());

	function fleet(recovery: WorktreeBootRecovery) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [{ id: "default", runtime: "openai", defaultModel: "gpt-4o" }];
		settings.fleet.default.target = "default";
		settings.fleet.default.model = "gpt-4o";
		let spawned = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			heartbeatIntervalMs: 3_600_000,
			bootRecovery: recovery,
			spawnWorker: () => {
				spawned += 1;
				const worker: SpawnedWorker = {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					send: () => true,
					events: (async function* () {
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "stop",
								content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
							},
						};
					})(),
				};
				return worker;
			},
		});
		return { bundle, spawned: () => spawned };
	}

	it("starts recovery on the first dispatch and admits it only once recovery settles", async () => {
		const abandoned = openLedger({ maxRuns: 10 });
		const row = abandoned.create({
			agentId: "coder",
			executionRole: "builder",
			task: "interrupted work",
			targetId: "default",
			wireModelId: "gpt-4o",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		abandoned.update(row.id, { status: "running", pid: 999_999, heartbeatAt: row.startedAt });
		await abandoned.persist();

		const recovery = heldRecovery();
		const { bundle, spawned } = fleet(recovery);
		try {
			await bundle.extension.start();
			strictEqual(recovery.starts, 0);
			strictEqual(openLedger({ maxRuns: 10 }).get(row.id)?.status, "running");

			const admitted = bundle.contract.dispatch({ ...REQUEST, cwd: scratch.dir });
			await new Promise((resolve) => setImmediate(resolve));
			strictEqual(recovery.starts, 1);
			strictEqual(spawned(), 0);

			recovery.release();
			const handle = await admitted;
			await handle.finalPromise;
			strictEqual(spawned(), 1);
			strictEqual(openLedger({ maxRuns: 10 }).get(row.id)?.status, "dead");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("stops without waiting on a recovery boot never started", async () => {
		const recovery = heldRecovery();
		const { bundle } = fleet(recovery);
		await bundle.extension.start();
		await bundle.extension.stop?.();
		strictEqual(recovery.starts, 0);
	});
});
