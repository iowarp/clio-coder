import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { HarnessState } from "../../src/harness/state.js";

describe("HarnessState", () => {
	it("starts idle", () => {
		const state = new HarnessState({ now: () => 1000 });
		deepStrictEqual(state.snapshot(), { kind: "idle" });
	});

	it("transitions to hot-ready with expiry", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.hotSucceeded("src/tools/read.ts", 14);
		deepStrictEqual(state.snapshot(), {
			kind: "hot-ready",
			message: "read.ts (14ms)",
			until: 4000,
		});
	});

	it("hot-ready expires back to idle after the TTL", () => {
		let t = 1000;
		const state = new HarnessState({ now: () => t });
		state.hotSucceeded("src/tools/read.ts", 14);
		t = 3999;
		strictEqual(state.snapshot().kind, "hot-ready");
		t = 4001;
		deepStrictEqual(state.snapshot(), { kind: "idle" });
	});

	it("hot-failed shows error message", () => {
		const state = new HarnessState({ now: () => 2000 });
		state.hotFailed("src/tools/edit.ts", "syntax error line 42");
		deepStrictEqual(state.snapshot(), {
			kind: "hot-failed",
			message: "edit.ts: syntax error line 42",
			until: 5000,
		});
	});

	it("restart-required accumulates files and persists", () => {
		let t = 1000;
		const state = new HarnessState({ now: () => t });
		state.restartRequired("src/domains/session/manifest.ts", "manifest");
		t = 5000;
		state.restartRequired("src/engine/agent.ts", "engine");
		deepStrictEqual(state.snapshot(), {
			kind: "restart-required",
			files: ["src/domains/session/manifest.ts", "src/engine/agent.ts"],
		});
	});

	it("restart-required dedupes repeated paths", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.restartRequired("src/core/config.ts", "core");
		state.restartRequired("src/core/config.ts", "core");
		const snap = state.snapshot();
		if (snap.kind !== "restart-required") throw new Error("expected restart-required");
		deepStrictEqual(snap.files, ["src/core/config.ts"]);
	});

	it("hot events do not clear restart-required", () => {
		let t = 1000;
		const state = new HarnessState({ now: () => t });
		state.restartRequired("src/engine/agent.ts", "engine");
		t = 2000;
		state.hotSucceeded("src/tools/read.ts", 7);
		strictEqual(state.snapshot().kind, "restart-required");
	});

	it("workerPending accumulates and is informational", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.workerChanged("src/worker/entry.ts");
		state.workerChanged("src/worker/heartbeat.ts");
		deepStrictEqual(state.snapshot(), { kind: "worker-pending", count: 2 });
	});

	it("restart-required supersedes worker-pending", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.workerChanged("src/worker/entry.ts");
		state.restartRequired("src/engine/agent.ts", "engine");
		strictEqual(state.snapshot().kind, "restart-required");
	});
});
