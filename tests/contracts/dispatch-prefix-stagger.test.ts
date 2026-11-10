import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { DispatchPrefixGroup } from "../../src/domains/dispatch/contract.js";
import { holdForSharedPrefix, PREFIX_HOLD_CAP_MS } from "../../src/domains/dispatch/prefix-stagger.js";

const liveTimeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("a follower holds until its leader releases, and the leader's cap timer keeps the loop alive until then", async () => {
	const groups = new Map<string, DispatchPrefixGroup>();
	const before = liveTimeouts();
	const leader = await holdForSharedPrefix(groups, "k", "lead");
	strictEqual(leader?.role, "leader");
	// An unref'd cap let Node drain the loop under a waiting follower, so dispatchBatch never returned.
	strictEqual(liveTimeouts(), before + 1);
	let clock = 100;
	let held = 0;
	let settled = false;
	const follower = holdForSharedPrefix(groups, "k", "follow", { now: () => clock, onHold: () => held++ }).then(
		(hold) => {
			settled = true;
			return hold;
		},
	);
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(held, 1);
	strictEqual(settled, false);
	clock = 350;
	if (leader?.role === "leader") leader.group.release();
	deepStrictEqual(await follower, { role: "follower", leaderRunId: "lead", heldMs: 250 });
	strictEqual(liveTimeouts(), before);
	strictEqual(await holdForSharedPrefix(groups, "k", "late"), null);
});

test("the cap releases a follower whose leader never streams, and abort ends a hold early", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const groups = new Map<string, DispatchPrefixGroup>();
	await holdForSharedPrefix(groups, "capped", "lead");
	const capped = holdForSharedPrefix(groups, "capped", "follow");
	await new Promise((resolve) => setImmediate(resolve));
	t.mock.timers.tick(PREFIX_HOLD_CAP_MS);
	strictEqual((await capped)?.role, "follower");

	await holdForSharedPrefix(groups, "aborted", "lead");
	const controller = new AbortController();
	const aborted = holdForSharedPrefix(groups, "aborted", "follow", { signal: controller.signal });
	controller.abort();
	strictEqual((await aborted)?.role, "follower");
	strictEqual(groups.get("aborted")?.isReleased(), false);
	strictEqual(await holdForSharedPrefix(groups, "aborted", "again", { signal: controller.signal }), null);
});
