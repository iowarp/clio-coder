import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { DispatchPrefixGroup } from "../../src/domains/dispatch/contract.js";
import {
	claimSharedPrefix,
	startAfterPrefixHold,
	waitForPrefixLeader,
} from "../../src/domains/dispatch/prefix-stagger.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";

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
