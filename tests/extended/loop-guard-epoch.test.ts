import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { hashToolCall } from "../../src/domains/safety/loop-detector.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { readTool } from "../../src/tools/read.js";

function before(turnId: string, toolName: string, fingerprint: string): MiddlewareHookInput {
	return {
		hook: "before_tool",
		turnId,
		toolName,
		toolArgs: { q: fingerprint },
		metadata: { callFingerprint: fingerprint },
	};
}

function afterOk(turnId: string, toolName: string): MiddlewareHookInput {
	return { hook: "after_tool", turnId, toolName, toolArgs: {}, metadata: { resultKind: "ok" }, toolResultDetails: {} };
}

const collectArgs = { mode: "collect", batch_id: "batch-1" };

function beforeCollect(turnId: string): MiddlewareHookInput {
	return {
		hook: "before_tool",
		turnId,
		toolName: ToolNames.Monitor,
		toolArgs: collectArgs,
		metadata: { callFingerprint: hashToolCall(ToolNames.Monitor, collectArgs) },
	};
}

function afterCollect(turnId: string, pendingCount: number, resultKind: "ok" | "error" = "ok"): MiddlewareHookInput {
	return {
		hook: "after_tool",
		turnId,
		toolName: ToolNames.Monitor,
		toolArgs: collectArgs,
		metadata: { resultKind },
		toolResultDetails: {
			mode: "collect",
			complete: false,
			runCount: 2,
			pendingCount,
			pendingRunIds: ["run-1", "run-2"].slice(0, pendingCount),
		},
	};
}

function afterCompleteCollect(turnId: string): MiddlewareHookInput {
	return {
		...afterCollect(turnId, 0),
		toolResultDetails: { mode: "collect", complete: true, runCount: 2, runs: [{ runId: "run-1" }, { runId: "run-2" }] },
	};
}

describe("loop guard identical-call epoch", () => {
	it("admits the next identical collect after the observed batch advances from two pending runs to one", () => {
		const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
		const turn = "collect-progress";
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		guard.evaluate(afterCollect(turn, 2));
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		guard.evaluate(afterCollect(turn, 1));
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		guard.evaluate(afterCollect(turn, 1));
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		ok(guard.evaluate(beforeCollect(turn)).some((effect) => effect.kind === "block_tool"));
	});

	it("treats a completed batch as one final advance and then blocks unchanged polls", () => {
		const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
		const turn = "collect-complete";
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		guard.evaluate(afterCollect(turn, 1));
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		guard.evaluate(afterCompleteCollect(turn));
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		guard.evaluate(afterCompleteCollect(turn));
		deepStrictEqual(guard.evaluate(beforeCollect(turn)), []);
		ok(guard.evaluate(beforeCollect(turn)).some((effect) => effect.kind === "block_tool"));
	});

	it("blocks an unchanged third collect and ignores unverified progress", () => {
		for (const caseName of ["unchanged", "failed-result", "wrong-mode", "different-batch"] as const) {
			const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
			deepStrictEqual(guard.evaluate(beforeCollect(caseName)), []);
			guard.evaluate(afterCollect(caseName, 2));
			deepStrictEqual(guard.evaluate(beforeCollect(caseName)), []);
			const second = afterCollect(
				caseName,
				caseName === "unchanged" ? 2 : 1,
				caseName === "failed-result" ? "error" : "ok",
			);
			if (caseName === "wrong-mode") second.toolResultDetails = { ...second.toolResultDetails, mode: "status" };
			if (caseName === "different-batch") second.toolArgs = { mode: "collect", batch_id: "batch-2" };
			guard.evaluate(second);
			ok(
				guard.evaluate(beforeCollect(caseName)).some((effect) => effect.kind === "block_tool"),
				caseName,
			);
		}
	});

	it("permits recovery through a different successful call before locking the turn", () => {
		const guard = createLoopGuardRegistration({
			safety: createWorkerSafety(),
			turnBlockBudget: 2,
			turnSynthesisLockout: true,
		});
		const turn = "recovery";
		guard.evaluate(before(turn, ToolNames.Bash, "stuck"));
		guard.evaluate(before(turn, ToolNames.Bash, "stuck"));
		ok(guard.evaluate(before(turn, ToolNames.Bash, "stuck")).some((effect) => effect.kind === "block_tool"));
		guard.evaluate({
			hook: "after_tool",
			turnId: turn,
			toolName: ToolNames.Bash,
			toolArgs: { q: "new-evidence" },
			metadata: { resultKind: "ok" },
			toolResultDetails: {},
		});
		const retry = guard.evaluate(before(turn, ToolNames.Bash, "stuck"));
		ok(!retry.some((effect) => effect.kind === "block_tool" && effect.reason.includes("Tools are disabled")));
	});

	it("blocks the third verbatim repeat when nothing changed in between", () => {
		const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
		const turn = "t1";
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-grep")).length, 0);
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-grep")).length, 0);
		const third = guard.evaluate(before(turn, ToolNames.Bash, "fp-grep"));
		ok(
			third.some((effect) => effect.kind === "block_tool"),
			JSON.stringify(third),
		);
	});

	it("lets a check rerun after a successful edit: the repeat count restarts at the write", () => {
		const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
		const turn = "t2";
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		guard.evaluate(afterOk(turn, ToolNames.Edit));
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		const third = guard.evaluate(before(turn, ToolNames.Bash, "fp-test"));
		ok(
			third.some((effect) => effect.kind === "block_tool"),
			JSON.stringify(third),
		);
	});

	it("restarts only after sealed delegated work changed the parent workspace", () => {
		const cases: Array<{
			name: string;
			details: MiddlewareHookInput["toolResultDetails"];
			restarts: boolean;
		}> = [
			{
				name: "failed dispatch with one applied worktree change",
				details: {
					runs: [
						{ receiptIntegrity: { ok: true }, placement: { mode: "worktree", applied: true, changedPaths: ["fix.ts"] } },
						{ receiptIntegrity: { ok: true }, placement: { mode: "current", changedPaths: [] } },
					],
				},
				restarts: true,
			},
			{
				name: "failed subprocess with an observed current-workspace change",
				details: {
					runs: [{ receiptIntegrity: { ok: true }, placement: { mode: "current", changedPaths: ["fix.ts"] } }],
				},
				restarts: true,
			},
			{
				name: "failed in-process worker with a successful mutating call",
				details: { runs: [{ receiptIntegrity: { ok: true }, toolActivity: { mutatingSucceeded: true } }] },
				restarts: true,
			},
			{
				name: "read-only worker",
				details: {
					runs: [
						{
							receiptIntegrity: { ok: true },
							readOnly: true,
							placement: { mode: "current", changedPaths: ["fix.ts"] },
							toolActivity: { mutatingSucceeded: true },
						},
					],
				},
				restarts: false,
			},
			{
				name: "legacy read-only receipt",
				details: {
					runs: [
						{
							receiptIntegrity: { ok: true },
							autonomyEnforcement: { autonomy: "read-only" },
							placement: { mode: "current", changedPaths: ["fix.ts"] },
						},
					],
				},
				restarts: false,
			},
			{
				name: "integrity-invalid receipt",
				details: {
					runs: [{ receiptIntegrity: { ok: false }, placement: { mode: "current", changedPaths: ["fix.ts"] } }],
				},
				restarts: false,
			},
			{
				name: "unapplied worktree",
				details: {
					runs: [
						{
							receiptIntegrity: { ok: true },
							placement: { mode: "worktree", applied: false, changedPaths: ["fix.ts"] },
							toolActivity: { mutatingSucceeded: true },
						},
					],
				},
				restarts: false,
			},
			{
				name: "applied worktree without changed paths",
				details: {
					runs: [{ receiptIntegrity: { ok: true }, placement: { mode: "worktree", applied: true, changedPaths: [] } }],
				},
				restarts: false,
			},
			{
				name: "unchanged current workspace",
				details: {
					runs: [
						{
							receiptIntegrity: { ok: true },
							placement: { mode: "current", changedPaths: [] },
							toolActivity: { mutatingSucceeded: true },
						},
					],
				},
				restarts: false,
			},
		];

		for (const scenario of cases) {
			const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
			const turn = scenario.name;
			strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "same-validation")).length, 0, scenario.name);
			strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "same-validation")).length, 0, scenario.name);
			guard.evaluate({
				hook: "after_tool",
				turnId: turn,
				toolName: ToolNames.Dispatch,
				toolArgs: { task: "fix validation" },
				metadata: { resultKind: "error" },
				...(scenario.details === undefined ? {} : { toolResultDetails: scenario.details }),
			});
			const third = guard.evaluate(before(turn, ToolNames.Bash, "same-validation"));
			strictEqual(
				third.some((effect) => effect.kind === "block_tool"),
				!scenario.restarts,
				scenario.name,
			);
			if (scenario.restarts) {
				strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "same-validation")).length, 0, scenario.name);
				ok(
					guard.evaluate(before(turn, ToolNames.Bash, "same-validation")).some((effect) => effect.kind === "block_tool"),
					scenario.name,
				);
			}
		}
	});
});

function coverageGuard() {
	let locks = 0;
	const guard = createLoopGuardRegistration({
		safety: createWorkerSafety(),
		toolBudgetAdvisory: true,
		readResultMaxBytes: 128 * 1024,
		toolCallCap: 150,
		toolCallSoftLimit: 18,
		turnBlockBudget: 2,
		turnSynthesisLockout: true,
		onSynthesisLockout: () => {
			locks += 1;
		},
	});
	return { guard, locks: () => locks };
}

function observedRead(
	offset: number,
	shownCount: number,
	overrides: Partial<MiddlewareHookInput> = {},
): MiddlewareHookInput {
	return {
		hook: "after_tool",
		turnId: "coverage",
		toolName: ToolNames.Read,
		toolArgs: { path: "coverage.ts", offset, limit: shownCount },
		metadata: { resultKind: "ok", resultBytes: 1000 },
		toolResultDetails: {
			file: { bytes: 10000, mtimeMs: 123 },
			observation: { tool: "read", unit: "lines", format: "text", shownCount, truncated: false },
		},
		...overrides,
	};
}

describe("read coverage stagnation", () => {
	it("does not double count nested results or record source that final shaping could shorten", () => {
		for (const metadata of [
			{ resultKind: "ok", resultBytes: 1000, nested: true },
			{ resultKind: "ok", resultBytes: 1024 * 1024 },
		]) {
			const f = coverageGuard();
			for (let i = 0; i < 8; i += 1) deepStrictEqual(f.guard.evaluate(observedRead(1, 100, { metadata })), []);
			// No phantom full-file coverage should make these fresh reads redundant.
			for (const offset of [10, 20, 30, 40]) deepStrictEqual(f.guard.evaluate(observedRead(offset, 10)), []);
			strictEqual(f.locks(), 0);
		}
	});

	it("does not turn a canonicalization failure into a tool failure", (t) => {
		const f = coverageGuard();
		const cwd = t.mock.method(process, "cwd", () => {
			throw new Error("workspace unavailable");
		});
		try {
			deepStrictEqual(f.guard.evaluate(observedRead(1, 100)), []);
		} finally {
			cwd.mock.restore();
		}
	});

	it("locks repeated subsets after successful reads, preserving the existing loop budget", () => {
		const f = coverageGuard();
		f.guard.evaluate(observedRead(1, 747));
		// Other useful evidence does not erase already observed source coverage.
		f.guard.evaluate(afterOk("coverage", ToolNames.Grep));
		for (const offset of [560, 640]) deepStrictEqual(f.guard.evaluate(observedRead(offset, 20)), []);
		const warning = f.guard.evaluate(observedRead(628, 15));
		ok(JSON.stringify(warning).includes("already observed"));
		strictEqual(f.locks(), 0);
		const locked = f.guard.evaluate(observedRead(598, 12));
		strictEqual(f.locks(), 1);
		ok(locked.every((effect) => effect.kind === "annotate_tool_result"));
		ok(JSON.stringify(locked).includes("required result format"));
		ok(
			f.guard.evaluate(before("coverage", ToolNames.Read, "new-request")).some((effect) => effect.kind === "block_tool"),
		);
	});

	it("merges complementary windows and allows partially overlapping windows with new lines", () => {
		const f = coverageGuard();
		for (const offset of [1, 11, 21, 26, 36, 46, 56]) {
			deepStrictEqual(f.guard.evaluate(observedRead(offset, 10)), []);
		}
		// A subset spanning two formerly separate windows is now redundant.
		for (const offset of [5, 15, 25, 35]) f.guard.evaluate(observedRead(offset, 10));
		strictEqual(f.locks(), 1);
	});

	it("does not count gaps between observed windows as evidence", () => {
		const f = coverageGuard();
		f.guard.evaluate(observedRead(1, 10));
		f.guard.evaluate(observedRead(21, 10));
		f.guard.evaluate(observedRead(2, 3));
		f.guard.evaluate(observedRead(22, 3));
		deepStrictEqual(f.guard.evaluate(observedRead(8, 16)), []);
		strictEqual(f.locks(), 0);
	});

	it("resets on observed metadata changes and successful writes or edits", () => {
		for (const change of ["mtime", "size", "write", "edit"] as const) {
			const f = coverageGuard();
			f.guard.evaluate(observedRead(1, 100));
			f.guard.evaluate(observedRead(10, 10));
			f.guard.evaluate(observedRead(20, 10));
			// The prospective read still runs; version checking happens after it.
			deepStrictEqual(f.guard.evaluate(before("coverage", ToolNames.Read, `fresh-${change}`)), []);
			if (change === "write" || change === "edit") f.guard.evaluate(afterOk("coverage", change));
			const next = observedRead(30, 10);
			if (change === "mtime" || change === "size")
				next.toolResultDetails = {
					...next.toolResultDetails,
					file: { bytes: change === "size" ? 10001 : 10000, mtimeMs: change === "mtime" ? 124 : 123 },
				};
			deepStrictEqual(f.guard.evaluate(next), []);
			strictEqual(f.locks(), 0);
		}
	});

	it("counts returned lines rather than requested limits and excludes truncated boundary lines", () => {
		const f = coverageGuard();
		const truncated = observedRead(1, 5);
		truncated.toolArgs = { path: "coverage.ts", offset: 1, limit: 1000 };
		truncated.toolResultDetails = {
			...truncated.toolResultDetails,
			observation: { tool: "read", unit: "lines", format: "text", shownCount: 5, truncated: true },
		};
		f.guard.evaluate(truncated);
		f.guard.evaluate(observedRead(1, 2));
		f.guard.evaluate(observedRead(2, 2));
		deepStrictEqual(f.guard.evaluate(observedRead(5, 1)), []);
		for (const offset of [6, 10, 20, 30]) deepStrictEqual(f.guard.evaluate(observedRead(offset, 4)), []);
		strictEqual(f.locks(), 0);
	});

	it("ignores non-text, empty, tail, failed, or changing reads", () => {
		for (const variant of ["json", "empty", "tail", "error", "changing"] as const) {
			const f = coverageGuard();
			for (let i = 0; i < 8; i += 1) {
				const input = observedRead(1, 100);
				if (variant === "tail") input.toolArgs = { path: "coverage.ts", tail: 100 };
				if (variant === "error") input.metadata = { resultKind: "error" };
				if (variant === "changing")
					input.toolResultDetails = { ...input.toolResultDetails, fileChange: { bytes: 10100, mtimeMs: 124 } };
				if (variant === "empty" || variant === "json")
					input.toolResultDetails = {
						...input.toolResultDetails,
						observation: {
							tool: "read",
							unit: "lines",
							format: variant === "json" ? "json" : "text",
							shownCount: variant === "empty" ? 0 : 100,
							truncated: true,
						},
					};
				deepStrictEqual(f.guard.evaluate(input), []);
			}
			strictEqual(f.locks(), 0);
		}
	});

	it("does not store unknown partial single lines as complete evidence", () => {
		const f = coverageGuard();
		f.guard.evaluate(observedRead(1, 10));
		f.guard.evaluate(observedRead(2, 2));
		f.guard.evaluate(observedRead(3, 2));
		const partial = observedRead(20, 1);
		partial.toolResultDetails = {
			...partial.toolResultDetails,
			observation: { tool: "read", unit: "lines", format: "text", shownCount: 1, truncated: true },
		};
		for (let i = 0; i < 8; i += 1) deepStrictEqual(f.guard.evaluate(partial), []);
		// Completing the previously partial line is still new evidence.
		deepStrictEqual(f.guard.evaluate(observedRead(20, 1)), []);
		strictEqual(f.locks(), 0);
	});

	it("counts the captured single-line citation rereads against prior complete numbered coverage", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-single-line-coverage-"));
		try {
			const path = join(root, "run-identity.ts");
			writeFileSync(path, Array.from({ length: 63 }, (_, i) => `const line${i} = ${i};`).join("\n"));
			const f = coverageGuard();
			const read = async (args: Record<string, unknown>) => {
				const result = await readTool.run({ path, ...args });
				strictEqual(result.kind, "ok");
				return f.guard.evaluate({
					hook: "after_tool",
					toolName: "read",
					toolArgs: { path, ...args },
					metadata: { resultKind: result.kind, resultBytes: Buffer.byteLength(result.output) },
					toolResultDetails: result.details ?? {},
				});
			};
			deepStrictEqual(await read({}), []);
			// The first numbered citation view remains useful, not redundant.
			deepStrictEqual(await read({ line_numbers: true }), []);
			// Captured calls 29–32 from j1n6i2odzmuh; limit=1 reports truncated=true.
			deepStrictEqual(await read({ offset: 16, limit: 30, line_numbers: true }), []);
			deepStrictEqual(await read({ offset: 9, limit: 2, line_numbers: true }), []);
			ok(JSON.stringify(await read({ offset: 30, limit: 1, line_numbers: true })).includes("already observed"));
			strictEqual(f.locks(), 0);
			ok(JSON.stringify(await read({ offset: 20, limit: 1, line_numbers: true })).includes("required result format"));
			strictEqual(f.locks(), 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows a first numbered citation reread even after unnumbered rereads", () => {
		const f = coverageGuard();
		f.guard.evaluate(observedRead(1, 100));
		f.guard.evaluate(observedRead(10, 10));
		f.guard.evaluate(observedRead(20, 10));
		deepStrictEqual(
			f.guard.evaluate(
				observedRead(10, 30, {
					toolArgs: { path: "coverage.ts", offset: 10, limit: 30, line_numbers: true },
				}),
			),
			[],
		);
		strictEqual(f.locks(), 0);
	});

	it("uses real read metadata and canonical aliases for the same source", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-read-coverage-"));
		try {
			const path = join(root, "source.ts");
			const alias = join(root, "alias.ts");
			writeFileSync(path, Array.from({ length: 747 }, (_, i) => `const line${i} = ${i};`).join("\n"));
			symlinkSync(path, alias);
			const f = coverageGuard();
			for (const args of [{ path }, ...[560, 640, 628, 598].map((offset) => ({ path: alias, offset, limit: 12 }))]) {
				const result = await readTool.run(args);
				strictEqual(result.kind, "ok");
				f.guard.evaluate({
					hook: "after_tool",
					toolName: "read",
					toolArgs: args,
					metadata: { resultKind: result.kind, resultBytes: result.kind === "ok" ? Buffer.byteLength(result.output) : 0 },
					toolResultDetails: result.details ?? {},
				});
			}
			strictEqual(f.locks(), 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("changing-offset EOF loops", () => {
	it("uses real read errors to warn on the second EOF and lock on the third, regardless of offset", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eof-loop-"));
		try {
			const path = join(root, "source.ts");
			writeFileSync(path, "one\ntwo\n");
			const f = coverageGuard();
			for (const [index, offset] of [1655, 1695, 1735].entries()) {
				const result = await readTool.run({ path, offset, limit: 40 });
				ok(result.kind === "error");
				strictEqual(result.details?.code, "read_past_eof");
				const effects = f.guard.evaluate({
					hook: "after_tool",
					turnId: "eof",
					toolName: ToolNames.Read,
					toolArgs: { path, offset, limit: 40 },
					metadata: { resultKind: result.kind },
					toolResultDetails: result.details,
				});
				strictEqual(
					effects.some((e) => e.kind === "annotate_tool_result"),
					index > 0,
				);
			}
			strictEqual(f.locks(), 1);
			ok(f.guard.evaluate(before("eof", ToolNames.Grep, "fresh")).some((e) => e.kind === "block_tool"));
			strictEqual(f.guard.evaluate(before("next-turn", ToolNames.Grep, "fresh")).length, 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not combine different files, changed versions, other errors, successful reads or nested results", () => {
		const f = coverageGuard();
		const eof = (path = "a.ts", mtimeMs = 1): MiddlewareHookInput => ({
			hook: "after_tool",
			turnId: "eof",
			toolName: ToolNames.Read,
			toolArgs: { path, offset: 100 },
			metadata: { resultKind: "error" },
			toolResultDetails: { code: "read_past_eof", totalLines: 2, file: { bytes: 8, mtimeMs } },
		});
		for (let i = 0; i < 5; i++) {
			f.guard.evaluate(eof("a.ts", i));
			f.guard.evaluate(eof("b.ts", i));
			f.guard.evaluate({ ...eof("b.ts", i), metadata: { resultKind: "error", nested: true } });
			f.guard.evaluate({ ...eof(), toolResultDetails: { code: "permission_denied" } });
			f.guard.evaluate(eof());
			f.guard.evaluate(afterOk("eof", ToolNames.Read));
		}
		strictEqual(f.locks(), 0);
	});
});
