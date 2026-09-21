import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function fixture() {
	const bank = new TaskMemoryBank();
	const memory = createMemoryInterventionRegistration({ bank, windowSteps: 20 });
	let call = 0;
	memory.evaluate({ hook: "turn_start", sessionId: "A", text: "Fix the failing check." });
	const receipt = (resultKind: string | undefined, command = "pnpm test") => {
		const input: MiddlewareHookInput = {
			hook: "after_tool",
			sessionId: "A",
			toolName: "bash",
			toolCallId: String(++call),
			toolArgs: { command },
			...(resultKind === undefined ? {} : { metadata: { resultKind, errorMessage: "fixture check failed" } }),
		};
		return memory.evaluate(input);
	};
	return { bank, memory, receipt };
}

test("an observed same-operation success closes an episode and two fresh errors can warn in the same turn", () => {
	const { bank, memory, receipt } = fixture();
	try {
		deepStrictEqual(receipt("error"), []);
		strictEqual(receipt("error")[0]?.kind, "annotate_tool_result");
		const historical = bank.snapshot().procedural[0];
		ok(historical);
		deepStrictEqual(receipt("ok"), []);
		deepStrictEqual(bank.snapshot().procedural, [historical], "success must preserve procedure history");
		deepStrictEqual(receipt("error"), [], "old trajectory errors cannot count into the fresh episode");
		deepStrictEqual(memory.evaluate({ hook: "turn_end", sessionId: "A" }), []);
		strictEqual(
			receipt("error")[0]?.kind,
			"annotate_tool_result",
			"new two-error episode may warn without a new turn_start",
		);
		const entries = bank.snapshot().procedural;
		strictEqual(entries.length, 2);
		const fresh = entries.find((entry) => entry.id !== historical.id);
		ok(fresh);
		match(fresh.content, /failed 2 times; first observed at step 4/);
		notStrictEqual(fresh.id, historical.id);
		deepStrictEqual(
			entries.find((entry) => entry.id === historical.id),
			historical,
		);
	} finally {
		memory.dispose();
	}
});

test("turn-end scanning does not revive a closed episode hidden behind another operation's annotation", () => {
	const { memory, receipt } = fixture();
	try {
		receipt("error", "command A");
		receipt("error", "command A");
		receipt("error", "command B");
		receipt("error", "command B");
		receipt("ok", "command A");
		deepStrictEqual(memory.evaluate({ hook: "turn_end", sessionId: "A" }), []);
		deepStrictEqual(receipt("error", "command A"), []);
		deepStrictEqual(memory.evaluate({ hook: "turn_end", sessionId: "A" }), []);
		strictEqual(receipt("error", "command A")[0]?.kind, "annotate_tool_result");
	} finally {
		memory.dispose();
	}
});

for (const resultKind of [undefined, "unknown", "success", "OK", ""] as const) {
	test(`resultKind ${String(resultKind)} does not close a failure episode`, () => {
		const { bank, memory, receipt } = fixture();
		try {
			receipt("error");
			receipt(resultKind);
			strictEqual(receipt("error")[0]?.kind, "annotate_tool_result");
			strictEqual(bank.snapshot().procedural.length, 1);
			match(bank.snapshot().procedural[0]?.content ?? "", /failed 2 times; first observed at step 1/);
		} finally {
			memory.dispose();
		}
	});
}

test("successful receipts for different commands/tools and prose completion do not close the failing operation", () => {
	const { bank, memory, receipt } = fixture();
	try {
		receipt("error");
		receipt("ok", "pnpm lint");
		memory.evaluate({
			hook: "after_tool",
			sessionId: "A",
			toolName: "read",
			toolArgs: { command: "pnpm test" },
			metadata: { resultKind: "ok" },
		});
		memory.evaluate({ hook: "turn_end", sessionId: "A", text: "All tests passed; the work is complete." });
		strictEqual(receipt("error")[0]?.kind, "annotate_tool_result");
		strictEqual(bank.snapshot().procedural.length, 1);
	} finally {
		memory.dispose();
	}
});

test("canonical argument ordering retains the existing operation identity", () => {
	const { bank, memory } = fixture();
	try {
		const observe = (args: Record<string, unknown>, resultKind: string) =>
			memory.evaluate({
				hook: "after_tool",
				sessionId: "A",
				toolName: "bash",
				toolArgs: args,
				metadata: { resultKind, errorMessage: "fixture error" },
			});
		observe({ command: "pnpm test", cwd: "/fixture" }, "error");
		observe({ cwd: "/fixture", command: "pnpm test" }, "ok");
		deepStrictEqual(observe({ command: "pnpm test", cwd: "/fixture" }, "error"), []);
		strictEqual(observe({ cwd: "/fixture", command: "pnpm test" }, "error")[0]?.kind, "annotate_tool_result");
		strictEqual(bank.snapshot().procedural.length, 2);
	} finally {
		memory.dispose();
	}
});

test("registry-produced error/ok receipts close and reopen the actual same read operation", async () => {
	const scratch = await isolateClioEnv("clio-coder-memory-failure-episode-");
	const bank = new TaskMemoryBank();
	const memory = createMemoryInterventionRegistration({ bank, windowSteps: 20 });
	try {
		const middleware = createMiddlewareBundle({ registrations: [memory] }).contract;
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch.dir }), middleware });
		registry.register(readTool);
		const path = join(scratch.dir, "same-file.txt");
		const invoke = async () => {
			const verdict = await registry.invoke({ tool: "read", args: { path } });
			ok(verdict.kind === "ok");
			return verdict.result;
		};
		const first = await invoke();
		strictEqual(first.kind, "error");
		const second = await invoke();
		ok(second.kind === "error");
		ok(second.message.includes("[middleware:warn] Memory:"));
		const oldId = bank.snapshot().procedural[0]?.id;
		writeFileSync(path, "A successful read receipt is evidence of this read only.\n");
		strictEqual((await invoke()).kind, "ok");
		rmSync(path);
		const fresh = await invoke();
		ok(fresh.kind === "error");
		ok(!fresh.message.includes("[middleware:warn] Memory:"));
		const repeated = await invoke();
		ok(repeated.kind === "error");
		ok(repeated.message.includes("[middleware:warn] Memory:"));
		strictEqual(bank.snapshot().procedural.length, 2);
		ok(bank.snapshot().procedural.some((entry) => entry.id === oldId));
	} finally {
		memory.dispose();
		scratch.restore();
	}
});
