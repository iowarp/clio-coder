import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseExtensionRuntimeV2 } from "../../src/domains/extensions/runtime-schema-v2.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import {
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
} from "../../src/engine/loop-guard.js";

const READ = "extension_wtfp__read_record";
const RECORD = "extension_wtfp__record";
const MANIFEST = { uri: "project://manifest" };

type Call = { tool: string; args: Record<string, unknown>; traits?: { readOnly: boolean; idempotent: boolean } };

const read: Call = { tool: READ, args: MANIFEST, traits: { readOnly: true, idempotent: true } };
const write: Call = {
	tool: RECORD,
	args: { uri: "project://manifest", record: {} },
	traits: { readOnly: false, idempotent: false },
};

/** The orchestrator's guard, with its interactive budgets and the synthesis lockout. */
function orchestratorGuard() {
	let loopState = createLoopState();
	const safety = {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"];
	const guard = createLoopGuardRegistration({
		safety,
		turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
		sameCallBlockLimit: INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
		turnSynthesisLockout: true,
	});
	const reasons: string[] = [];
	const metadataOf = (call: Call) =>
		call.traits === undefined ? {} : { toolReadOnly: call.traits.readOnly, toolIdempotent: call.traits.idempotent };
	const before = (call: Call, batch?: string): boolean => {
		const effects = guard.evaluate({
			hook: "before_tool",
			turnId: "turn-1",
			toolName: call.tool,
			toolArgs: call.args,
			...(batch !== undefined ? { correlationId: batch } : {}),
			metadata: { ...metadataOf(call), callFingerprint: hashToolCall(call.tool, call.args) },
		} as MiddlewareHookInput);
		const block = effects.find((effect) => effect.kind === "block_tool");
		if (block?.kind === "block_tool") reasons.push(block.reason);
		return block === undefined;
	};
	const after = (call: Call, output = "manifest rev 1"): void => {
		guard.evaluate({
			hook: "after_tool",
			turnId: "turn-1",
			toolName: call.tool,
			toolArgs: call.args,
			metadata: { ...metadataOf(call), resultKind: "ok", outcomeFingerprint: output, resultFingerprint: output },
		} as MiddlewareHookInput);
	};
	/** One model response: every before_tool runs first, as a parallel batch does, then each admitted call settles. */
	const batch = (id: string, calls: ReadonlyArray<Call>, output?: string): boolean[] => {
		const admitted = calls.map((call) => before(call, id));
		calls.forEach((call, index) => {
			if (admitted[index]) after(call, output);
		});
		return admitted;
	};
	return { batch, reasons };
}

describe("loop guard resets identical-call counts on a mutation between them (WTF-P 0.8.3 A1)", () => {
	it("admits read, read, write, read", () => {
		const { batch } = orchestratorGuard();
		deepStrictEqual(
			[read, read, write, read].map((call, index) => batch(`r${index}`, [call])[0]),
			[true, true, true, true],
		);
	});

	it("still blocks read, read, read with no write between", () => {
		const { batch, reasons } = orchestratorGuard();
		deepStrictEqual(
			[read, read, read].map((call, index) => batch(`r${index}`, [call])[0]),
			[true, true, false],
		);
		ok(/loop detected/u.test(reasons[0] ?? ""), reasons[0]);
	});

	it("reads a bash command that may write as a mutation, and a plain read command as none", () => {
		const build: Call = { tool: "bash", args: { command: "pnpm run build" } };
		const status: Call = { tool: "bash", args: { command: "git status --short 2>/dev/null" } };
		const withBuild = orchestratorGuard();
		deepStrictEqual(
			[read, read, build, read].map((call, index) => withBuild.batch(`r${index}`, [call])[0]),
			[true, true, true, true],
		);
		const withStatus = orchestratorGuard();
		deepStrictEqual(
			[read, read, status, read].map((call, index) => withStatus.batch(`r${index}`, [call])[0]),
			[true, true, true, false],
		);
	});

	it("never counts a tool declared neither read-only nor idempotent as a verbatim repeat", () => {
		const nextStep: Call = {
			tool: "extension_wtfp__next_step",
			args: { after: "start" },
			traits: { readOnly: false, idempotent: false },
		};
		const { batch } = orchestratorGuard();
		ok([0, 1, 2, 3].every((index) => batch(`r${index}`, [nextStep], `step ${index}`)[0]));
	});

	it("parses readOnly and idempotent on an api 2 tool, and a read tool defaults to read-only", () => {
		const runtime = parseExtensionRuntimeV2({
			api: 2,
			entrypoint: "runtime/extension.ts",
			tools: [
				{
					name: "read_record",
					description: "Read one record.",
					inputSchema: { type: "object" },
					readOnly: true,
					idempotent: true,
				},
				{ name: "record", description: "Write one record.", inputSchema: { type: "object" } },
			],
			permissions: { fs: { read: ["workspace"], write: [".planning"] }, exec: false, net: false },
		});
		deepStrictEqual(
			runtime.tools.map((tool) => [tool.name, tool.readOnly, tool.idempotent]),
			[
				["read_record", true, true],
				["record", false, false],
			],
		);
	});
});

describe("one loop block never disables the rest of its batch (WTF-P 0.8.3 A2)", () => {
	it("leaves the other three calls of a parallel batch of four admitted", () => {
		const { batch, reasons } = orchestratorGuard();
		batch("r1", [read]);
		batch("r2", [read]);
		const others: Call[] = ["sections", "sources", "evidence"].map((family) => ({
			tool: READ,
			args: { uri: `project://${family}` },
			traits: { readOnly: true, idempotent: true },
		}));
		deepStrictEqual(batch("r3", [read, ...others]), [false, true, true, true]);
		strictEqual(reasons.length, 1);
		ok(!/disabled/u.test(reasons[0] ?? ""), reasons[0]);
	});

	it("keeps next_step running when two repeated reads share its batch, as in session 12a2ef54ae558d9f", () => {
		const { batch, reasons } = orchestratorGuard();
		const state: Call = { tool: READ, args: { uri: "project://state" }, traits: { readOnly: true, idempotent: true } };
		const validation: Call = {
			tool: READ,
			args: { uri: "project://validations/milestone-submission-01" },
			traits: { readOnly: true, idempotent: true },
		};
		const nextStep: Call = {
			tool: "extension_wtfp__next_step",
			args: { after: "submit-milestone" },
			traits: { readOnly: false, idempotent: false },
		};
		batch("r1", [read, state]);
		batch("r2", [read, state]);
		deepStrictEqual(batch("r3", [read, state, validation, nextStep]), [false, false, true, true]);
		ok(
			reasons.every((reason) => !/disabled/u.test(reason)),
			reasons.join("\n"),
		);
	});

	it("locks only when the same call is blocked twice, and spares the siblings of the turn's first block", () => {
		const { batch, reasons } = orchestratorGuard();
		const status: Call = { tool: "extension_wtfp__status", args: {}, traits: { readOnly: true, idempotent: true } };
		batch("r1", [read]);
		batch("r2", [read]);
		// Both copies of the repeat are blocked; the second locks the turn, but the
		// status call the same response emitted still runs.
		deepStrictEqual(batch("r3", [read, read, status]), [false, false, true]);
		ok(/disabled for the rest of this turn/u.test(reasons[1] ?? ""), reasons[1]);
		deepStrictEqual(batch("r4", [status]), [false]);
	});

	it("tolerates two blocks of different calls before the third locks the turn", () => {
		const { batch, reasons } = orchestratorGuard();
		const calls: Call[] = ["a", "b", "c"].map((family) => ({
			tool: READ,
			args: { uri: `project://${family}` },
			traits: { readOnly: true, idempotent: true },
		}));
		let round = 0;
		for (const call of calls) {
			batch(`r${round++}`, [call]);
			batch(`r${round++}`, [call]);
		}
		for (const call of calls) deepStrictEqual(batch(`r${round++}`, [call]), [false]);
		ok(!/disabled/u.test(reasons[1] ?? ""), reasons[1]);
		ok(/disabled/u.test(reasons[2] ?? ""), reasons[2]);
	});
});
