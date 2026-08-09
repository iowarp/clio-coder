import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import {
	createLeaderKeyController,
	IDLE_LEADER_STATE,
	type LeaderKeyControllerDeps,
	type LeaderKeyTimeout,
	routeLeaderKey,
} from "../../src/interactive/leader-key.js";

const LEADER = "\x07";
const ESC = "\x1b";

describe("interactive leader-key routing", () => {
	it("arms on the leader, swallows releases, and dispatches a case-insensitive target", () => {
		const dispatched: ClioKeybinding[] = [];
		const armed = routeLeaderKey(LEADER, IDLE_LEADER_STATE, {
			matchesLeader: (data) => data === LEADER,
			leaderTargets: [{ key: "m", id: "clio.model.select" }],
			dispatchAction: (id) => {
				dispatched.push(id);
				return true;
			},
			now: 100,
			timeoutMs: 50,
		});
		deepStrictEqual(armed, { state: { status: "pending", expiresAt: 150 }, consumed: true });

		const release = routeLeaderKey("release", armed.state, {
			matchesLeader: () => false,
			leaderTargets: [{ key: "m", id: "clio.model.select" }],
			dispatchAction: () => true,
			now: 110,
			isRelease: (data) => data === "release",
		});
		strictEqual(release.state, armed.state);
		strictEqual(release.consumed, true);

		const target = routeLeaderKey("M", release.state, {
			matchesLeader: () => false,
			leaderTargets: [{ key: "m", id: "clio.model.select" }],
			dispatchAction: (id) => {
				dispatched.push(id);
				return true;
			},
			now: 120,
		});
		deepStrictEqual(target, { state: IDLE_LEADER_STATE, consumed: true });
		deepStrictEqual(dispatched, ["clio.model.select"]);
	});

	it("swallows escape, unknown chords, and the first key observed after expiry", () => {
		const pending = { status: "pending", expiresAt: 50 } as const;
		const deps = {
			matchesLeader: () => false,
			leaderTargets: [],
			dispatchAction: () => true,
			now: 10,
		};
		deepStrictEqual(routeLeaderKey(ESC, pending, deps), { state: IDLE_LEADER_STATE, consumed: true });
		deepStrictEqual(routeLeaderKey("?", pending, deps), { state: IDLE_LEADER_STATE, consumed: true });
		deepStrictEqual(routeLeaderKey("m", pending, { ...deps, now: 51 }), {
			state: IDLE_LEADER_STATE,
			consumed: true,
		});
	});

	it("does not consume ordinary keys or leader release events while idle", () => {
		const deps = {
			matchesLeader: (data: string) => data === LEADER,
			leaderTargets: [],
			dispatchAction: () => true,
			now: 0,
			isRelease: (data: string) => data === "release",
		};
		deepStrictEqual(routeLeaderKey("x", IDLE_LEADER_STATE, deps), {
			state: IDLE_LEADER_STATE,
			consumed: false,
		});
		deepStrictEqual(routeLeaderKey("release", IDLE_LEADER_STATE, deps), {
			state: IDLE_LEADER_STATE,
			consumed: false,
		});
	});
});

describe("interactive leader-key timer ownership", () => {
	it("schedules expiry, unrefs the timer, and returns to idle when it fires", () => {
		let now = 1_000;
		let scheduledDelay = -1;
		let scheduledCallback: (() => void) | null = null;
		let unrefs = 0;
		let clears = 0;
		const timeout: LeaderKeyTimeout = {
			unref: () => {
				unrefs += 1;
			},
		};
		const deps: LeaderKeyControllerDeps = {
			matchesLeader: (data) => data === LEADER,
			leaderTargets: () => [],
			dispatchAction: () => true,
			isRelease: () => false,
			now: () => now,
			timeoutMs: 75,
			scheduleTimeout: (callback, delayMs) => {
				scheduledCallback = callback;
				scheduledDelay = delayMs;
				return timeout;
			},
			clearScheduledTimeout: (handle) => {
				strictEqual(handle, timeout);
				clears += 1;
			},
		};
		const controller = createLeaderKeyController(deps);

		strictEqual(controller.route(LEADER), true);
		strictEqual(controller.isPending(), true);
		strictEqual(scheduledDelay, 75);
		strictEqual(unrefs, 1);

		now = 1_075;
		const fire = scheduledCallback as (() => void) | null;
		if (!fire) throw new Error("leader expiry was not scheduled");
		fire();
		strictEqual(controller.isPending(), false);
		strictEqual(clears, 0, "a fired timer clears its own handle");
	});

	it("cancels the owned timer when reset or disposed", () => {
		let clears = 0;
		const timeout: LeaderKeyTimeout = {};
		const controller = createLeaderKeyController({
			matchesLeader: (data) => data === LEADER,
			leaderTargets: () => [],
			dispatchAction: () => true,
			isRelease: () => false,
			now: () => 0,
			scheduleTimeout: () => timeout,
			clearScheduledTimeout: () => {
				clears += 1;
			},
		});

		controller.route(LEADER);
		controller.reset();
		strictEqual(controller.isPending(), false);
		strictEqual(clears, 1);

		controller.route(LEADER);
		controller.dispose();
		strictEqual(controller.isPending(), false);
		strictEqual(clears, 2);
	});
});
