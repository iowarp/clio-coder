import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { publishAgentLedgerEntry } from "../../src/domains/dispatch/agent-ledger-hub.js";
import { appendAgentLedgerEntry, openAgentLedger } from "../../src/domains/dispatch/agent-ledger-store.js";
import type { DispatchPrefixGroup } from "../../src/domains/dispatch/contract.js";
import {
	claimSharedPrefix,
	PREFIX_HOLD_CAP_MS,
	startAfterPrefixHold,
	waitForPrefixLeader,
} from "../../src/domains/dispatch/prefix-stagger.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const liveTimeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
const clock = { now: () => 1_000, monotonicNow: () => 7 };

function fakeWorker(): { worker: SpawnedWorker; finish: () => void } {
	let finish!: (result: SpawnedWorkerResult) => void;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		finish = resolve;
	});
	const worker: SpawnedWorker = {
		pid: 42,
		promise,
		heartbeatAt: { current: 5, monotonic: 3 },
		events: (async function* () {
			yield { type: "message_start" };
			await promise;
		})(),
		abort() {
			finish({ exitCode: null, signal: "SIGTERM" });
		},
	};
	return { worker, finish: () => finish({ exitCode: 0, signal: null }) };
}

/** Admits a batch the way dispatchBatch does: every handle returns at admission, followers start after the hold. */
function admitBatch(groups: Map<string, DispatchPrefixGroup>, runIds: ReadonlyArray<string>, starts: string[]) {
	return runIds.map((runId) => {
		const claim = claimSharedPrefix(groups, "shared", runId);
		const spawn = (): SpawnedWorker => {
			starts.push(runId);
			return fakeWorker().worker;
		};
		if (claim?.role !== "follower") return { runId, worker: spawn() };
		const group = claim.group;
		return {
			runId,
			worker: startAfterPrefixHold(
				async (signal) => {
					await waitForPrefixLeader(group, { signal });
				},
				spawn,
				clock,
			),
		};
	});
}

test("a batch with a slow leader returns every handle while the shared-prefix hold is still active", async () => {
	const before = liveTimeouts();
	const groups = new Map<string, DispatchPrefixGroup>();
	const starts: string[] = [];
	const handles = admitBatch(groups, ["lead", "follow-1", "follow-2"], starts);
	strictEqual(handles.length, 3);
	const group = groups.get("shared");
	ok(group);
	strictEqual(group.isReleased(), false);
	await new Promise((resolve) => setImmediate(resolve));
	// Only the leader started; the followers' handles exist and read as live while they hold.
	strictEqual(starts.join(","), "lead");
	strictEqual(handles[1]?.worker.pid, null);
	strictEqual(handles[1]?.worker.heartbeatAt.monotonic, 7);
	strictEqual(handles[1]?.worker.send?.({}), false);
	group.release();
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(starts.join(","), "lead,follow-1,follow-2");
	strictEqual(handles[1]?.worker.pid, 42);
	const first = await handles[1]?.worker.events.next();
	strictEqual((first?.value as { type?: string } | undefined)?.type, "message_start");
	for (const handle of handles) handle.worker.abort();
	strictEqual(liveTimeouts(), before);
});

test("abort during the hold ends the follower cleanly without starting its worker", async () => {
	const groups = new Map<string, DispatchPrefixGroup>();
	const starts: string[] = [];
	const [, follower] = admitBatch(groups, ["lead", "follow"], starts);
	ok(follower);
	follower.worker.abort();
	const result = await follower.worker.promise;
	strictEqual(result.exitCode, null);
	strictEqual(result.signal, "SIGTERM");
	strictEqual((await follower.worker.events.next()).done, true);
	strictEqual(starts.join(","), "lead");
	// The group is still held for others until the batch releases it, which clears the cap timer.
	strictEqual(groups.get("shared")?.isReleased(), false);
	groups.get("shared")?.release();
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(starts.join(","), "lead");
});

test("the hold's cap timer keeps the process alive until the group releases", () => {
	const before = liveTimeouts();
	const groups = new Map<string, DispatchPrefixGroup>();
	const lead = claimSharedPrefix(groups, "shared", "lead");
	ok(lead);
	// A hold whose cap could not fire would strand its followers if nothing else kept the loop alive.
	strictEqual(liveTimeouts(), before + 1);
	lead.group.release();
	strictEqual(liveTimeouts(), before);
});

test("the cap releases a follower whose leader never streams", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const groups = new Map<string, DispatchPrefixGroup>();
	const lead = claimSharedPrefix(groups, "shared", "lead");
	const follow = claimSharedPrefix(groups, "shared", "follow");
	ok(lead);
	strictEqual(follow?.role, "follower");
	let now = 100;
	const held = waitForPrefixLeader(lead.group, { now: () => now });
	t.mock.timers.tick(PREFIX_HOLD_CAP_MS - 1);
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(lead.group.isReleased(), false);
	now = 100 + PREFIX_HOLD_CAP_MS;
	t.mock.timers.tick(1);
	deepStrictEqual(await held, { role: "follower", leaderRunId: "lead", heldMs: PREFIX_HOLD_CAP_MS });
	strictEqual(lead.group.isReleased(), true);
	strictEqual(claimSharedPrefix(groups, "shared", "late"), null);
});

test("a held follower's run row names a live process, then its worker's pid once it starts", async () => {
	await isolateDispatchState();
	const spawned: Array<{ worker: SpawnedWorker; finish: () => void }> = [];
	let followerStarted!: () => void;
	const followerSpawned = new Promise<void>((resolve) => {
		followerStarted = resolve;
	});
	const settings = structuredClone(DEFAULT_SETTINGS);
	// The fake workers end without a result; a retry would start workers nothing finishes.
	settings.fleet.retry.maxRetries = 0;
	const context = dispatchStubContext({ settings });
	const started: Array<{ pid: number | null; processCommand?: string | undefined }> = [];
	context.bus.subscribe("run.started", (payload) => {
		started.push({ pid: payload.pid, processCommand: payload.processCommand });
	});
	const bundle = makeDispatchBundle(context, {
		spawnWorker: () => {
			const next = fakeWorker();
			spawned.push(next);
			if (spawned.length === 2) followerStarted();
			const pid = 4_000 + spawned.length;
			return { ...next.worker, pid, processCommand: JSON.stringify(["worker", String(pid)]) };
		},
	});
	await bundle.extension.start();
	try {
		const request = {
			agentId: "scout",
			executionRole: "researcher" as const,
			task: "Inspect the fixture.",
			requestOrigin: "internal" as const,
		};
		const batch = await bundle.contract.dispatchBatch([request, request]);
		strictEqual(spawned.length, 1, "the follower is held behind its leader");
		const rows = bundle.contract.listRuns();
		strictEqual(rows.length, 2);
		// Recovery in a second Clio settles a row whose pid is not alive, so a held row is vouched for by this process.
		for (const row of rows) strictEqual(typeof row.pid, "number", `${row.id} has no live pid while held`);
		// run.started means the child process is live, so a held follower has not started yet.
		deepStrictEqual(started, [{ pid: 4_001, processCommand: '["worker","4001"]' }]);
		// The leader exits, which releases the hold and starts the follower.
		spawned[0]?.finish();
		await followerSpawned;
		const followerPid = rows.map((row) => bundle.contract.getRun(row.id)?.pid).find((pid) => pid === 4_002);
		strictEqual(followerPid, 4_002);
		deepStrictEqual(started[1], { pid: 4_002, processCommand: '["worker","4002"]' });
		strictEqual(started.length, 2);
		spawned[1]?.finish();
		await batch.finalPromise.catch(() => undefined);
	} finally {
		for (const worker of spawned) worker.finish();
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});

test("a held follower receives the board posts made during its hold once its worker starts", async () => {
	await isolateDispatchState();
	const spawned: Array<{ worker: SpawnedWorker; finish: () => void; sent: unknown[] }> = [];
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const context = dispatchStubContext({ settings });
	// The start hook joins the board, then publishes run.started.
	let starts = 0;
	let followerStarted!: () => void;
	const followerLive = new Promise<void>((resolve) => {
		followerStarted = resolve;
	});
	context.bus.subscribe("run.started", () => {
		starts += 1;
		if (starts === 2) followerStarted();
	});
	const bundle = makeDispatchBundle(context, {
		spawnWorker: () => {
			const next = { ...fakeWorker(), sent: [] as unknown[] };
			spawned.push(next);
			return {
				...next.worker,
				pid: 5_000 + spawned.length,
				send: (value: unknown) => {
					next.sent.push(value);
					return true;
				},
			};
		},
	});
	await bundle.extension.start();
	try {
		const ledgerId = "ledger-board-batch";
		await openAgentLedger(ledgerId);
		const request = {
			agentId: "scout",
			executionRole: "researcher" as const,
			task: "Inspect the fixture.",
			requestOrigin: "internal" as const,
			ledger: { id: ledgerId, sequence: 0 },
		};
		const batch = await bundle.contract.dispatchBatch([request, request]);
		// The board rides after the prompt the members share, so the second member holds behind the first.
		strictEqual(spawned.length, 1, "the follower is held behind its leader");
		const posted = await appendAgentLedgerEntry(
			ledgerId,
			{ runId: "other-run", assignmentId: "other-run", agentId: "coder", nodeId: "local" },
			{ kind: "message", to: "all", text: "posted during the hold" },
		);
		ok(posted.ok);
		publishAgentLedgerEntry(ledgerId, posted.entry);
		spawned[0]?.finish();
		await followerLive;
		const delivered = JSON.stringify(spawned[1]?.sent ?? []);
		ok(delivered.includes("posted during the hold"), `the held follower never received the board: ${delivered}`);
		spawned[1]?.finish();
		await batch.finalPromise.catch(() => undefined);
	} finally {
		for (const worker of spawned) worker.finish();
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});
