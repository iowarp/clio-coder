import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchPrefixGroup } from "../../src/domains/dispatch/contract.js";
import {
	claimSharedPrefix,
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

test("a held follower's run row names a live process, then its worker's pid once it starts", async () => {
	await isolateDispatchState();
	const spawned: Array<{ worker: SpawnedWorker; finish: () => void }> = [];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings: structuredClone(DEFAULT_SETTINGS) }), {
		spawnWorker: () => {
			const next = fakeWorker();
			spawned.push(next);
			return { ...next.worker, pid: 4_000 + spawned.length };
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
		// The leader exits, which releases the hold and starts the follower.
		spawned[0]?.finish();
		const deadline = Date.now() + 5_000;
		while (spawned.length < 2) {
			ok(Date.now() < deadline, "the follower never started");
			await sleep(5);
		}
		const followerPid = rows.map((row) => bundle.contract.getRun(row.id)?.pid).find((pid) => pid === 4_002);
		strictEqual(followerPid, 4_002);
		spawned[1]?.finish();
		await batch.finalPromise.catch(() => undefined);
	} finally {
		for (const worker of spawned) worker.finish();
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});
