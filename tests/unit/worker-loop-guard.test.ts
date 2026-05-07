import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canonicalJson,
	createWorkerLoopGuard,
	createWorkerSafety,
	DEFAULT_MAX_TOOL_CALLS,
	hashToolCall,
	MAX_TOOL_CALLS_ENV,
} from "../../src/engine/worker-tools.js";

describe("engine/worker-loop-guard", () => {
	it("blocks after the same tool+args repeats five times in the window", () => {
		const safety = createWorkerSafety();
		const guard = createWorkerLoopGuard({ safety, cap: 1000, env: {} });
		const args = { path: "src/foo.js" };
		// First four calls pass; the fifth crosses the maxRepeats=5 threshold
		// because the loop detector counts the current call as well.
		for (let i = 0; i < 4; i++) {
			const decision = guard.check("read", args, i);
			strictEqual(decision.block, false);
		}
		const fifth = guard.check("read", args, 4);
		strictEqual(fifth.block, true);
		strictEqual(typeof fifth.reason, "string");
		strictEqual((fifth.reason ?? "").includes("loop detected"), true);
		strictEqual((fifth.reason ?? "").includes("read"), true);
	});

	it("does not interfere across distinct tool+args fingerprints", () => {
		const safety = createWorkerSafety();
		const guard = createWorkerLoopGuard({ safety, cap: 1000, env: {} });
		// Alternating two distinct keys never accumulates five of either.
		for (let i = 0; i < 8; i++) {
			const tool = i % 2 === 0 ? "read" : "where_is";
			const decision = guard.check(tool, { path: `src/${tool}.js` }, i);
			strictEqual(decision.block, false);
		}
	});

	it("resets when calls age out of the sliding window", () => {
		const safety = createWorkerSafety();
		const guard = createWorkerLoopGuard({ safety, cap: 1000, env: {} });
		const args = { path: "src/foo.js" };
		// Four calls inside the 30s window.
		for (let i = 0; i < 4; i++) {
			strictEqual(guard.check("read", args, i * 1000).block, false);
		}
		// Jump 60s ahead. All previous entries fall out of the window, so the
		// next observation counts as the first repetition and must not block.
		const recovered = guard.check("read", args, 60_000 + 5_000);
		strictEqual(recovered.block, false);
	});

	it("fires the iteration cap on the (cap + 1)th call", () => {
		const safety = createWorkerSafety();
		const guard = createWorkerLoopGuard({ safety, cap: 50, env: {} });
		// The guard counts every check, so 50 calls with rotating fingerprints
		// stay below the cap. The 51st must block with the cap reason.
		for (let i = 0; i < 50; i++) {
			const decision = guard.check("read", { path: `src/file-${i}.js` }, i);
			strictEqual(decision.block, false);
		}
		const fiftyFirst = guard.check("read", { path: "src/file-extra.js" }, 51);
		strictEqual(fiftyFirst.block, true);
		strictEqual(fiftyFirst.reason, "tool-call cap reached (50); abort turn");
	});

	it("lets the cap win cleanly when cap and loop detector could both block", () => {
		const safety = createWorkerSafety();
		const guard = createWorkerLoopGuard({ safety, cap: 4, env: {} });
		const args = { path: "src/foo.js" };
		for (let i = 0; i < 4; i++) {
			const decision = guard.check("read", args, i);
			strictEqual(decision.block, false);
		}
		const fifth = guard.check("read", args, 4);
		strictEqual(fifth.block, true);
		strictEqual(fifth.reason, "tool-call cap reached (4); abort turn");
	});

	it("reads the cap from CLIO_MAX_TOOL_CALLS when present", () => {
		const safety = createWorkerSafety();
		const env: NodeJS.ProcessEnv = { [MAX_TOOL_CALLS_ENV]: "3" };
		const guard = createWorkerLoopGuard({ safety, env });
		strictEqual(guard.cap, 3);
		strictEqual(guard.check("read", { path: "a" }, 0).block, false);
		strictEqual(guard.check("read", { path: "b" }, 1).block, false);
		strictEqual(guard.check("read", { path: "c" }, 2).block, false);
		const fourth = guard.check("read", { path: "d" }, 3);
		strictEqual(fourth.block, true);
		strictEqual(fourth.reason, "tool-call cap reached (3); abort turn");
	});

	it("falls back to the default cap when the env value is invalid", () => {
		const safety = createWorkerSafety();
		const guard = createWorkerLoopGuard({ safety, env: { [MAX_TOOL_CALLS_ENV]: "not-a-number" } });
		strictEqual(guard.cap, DEFAULT_MAX_TOOL_CALLS);
	});

	it("falls back to the default cap for non-positive and NaN env values", () => {
		for (const value of ["-1", "NaN", "0"]) {
			const safety = createWorkerSafety();
			const guard = createWorkerLoopGuard({ safety, env: { [MAX_TOOL_CALLS_ENV]: value } });
			strictEqual(guard.cap, DEFAULT_MAX_TOOL_CALLS);
		}
	});
});

describe("engine/worker-tools/canonicalJson", () => {
	it("produces a stable key independent of object insertion order", () => {
		strictEqual(hashToolCall("read", { a: 1, b: 2 }), hashToolCall("read", { b: 2, a: 1 }));
	});

	it("canonicalizes nested objects and arrays of objects", () => {
		const lhs = canonicalJson({
			z: [{ b: 2, a: 1 }],
			a: { keep: true, drop: undefined, list: [{ y: 2, x: 1 }, undefined] },
		});
		const rhs = canonicalJson({
			a: { list: [{ x: 1, y: 2 }, undefined], keep: true },
			z: [{ a: 1, b: 2 }],
		});
		strictEqual(lhs, rhs);
		strictEqual(lhs, '{"a":{"keep":true,"list":[{"x":1,"y":2},null]},"z":[{"a":1,"b":2}]}');
	});

	it("differentiates by tool name even with identical args", () => {
		const lhs = hashToolCall("read", { path: "x" });
		const rhs = hashToolCall("write", { path: "x" });
		strictEqual(lhs === rhs, false);
	});

	it("rejects non-finite numbers at the canonical layer", () => {
		let threw = false;
		try {
			canonicalJson({ x: Number.POSITIVE_INFINITY });
		} catch {
			threw = true;
		}
		strictEqual(threw, true);
	});

	it("falls back to a tool-only fingerprint when args are unrepresentable", () => {
		const key = hashToolCall("read", { fn: () => 1 });
		strictEqual(key, "read<unrepresentable>");
	});

	it("serializes Date values through their JSON representation", () => {
		const key = canonicalJson({ at: new Date("2026-05-07T12:34:56.000Z") });
		strictEqual(key, '{"at":"2026-05-07T12:34:56.000Z"}');
	});

	it("falls back to a tool-only fingerprint for circular args", () => {
		const circular: Record<string, unknown> = { path: "src/foo.js" };
		circular.self = circular;
		strictEqual(hashToolCall("read", circular), "read<unrepresentable>");
	});
});
