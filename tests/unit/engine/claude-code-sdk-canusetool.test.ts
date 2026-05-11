import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildCanUseTool } from "../../../src/engine/claude-code-sdk-runtime.js";
import { createWorkerSafety } from "../../../src/engine/worker-tools.js";

describe("engine/sdk: canUseTool integration", () => {
	const cwd = mkdtempSync(join(tmpdir(), "clio-sdk-canuse-"));
	after(() => rmSync(cwd, { recursive: true, force: true }));
	const safety = createWorkerSafety({ cwd });

	it("allows when safety returns allow", async () => {
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async () => {
				throw new Error("should not be called");
			},
			emit: () => {},
		});
		const res = await canUseTool("Bash", { command: "ls -la", cwd }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "allow");
	});

	it("denies when safety returns block", async () => {
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async () => {
				throw new Error("nope");
			},
			emit: () => {},
		});
		const res = await canUseTool("Bash", { command: "echo hi | cat", cwd }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "deny");
	});

	it("honors autoApprove=allow for unmapped tools", async () => {
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: "allow",
			awaitApproval: async () => {
				throw new Error("no ipc");
			},
			emit: () => {},
		});
		const res = await canUseTool("MysteryTool", {}, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "allow");
	});

	it("honors autoApprove=deny for unmapped tools", async () => {
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: "deny",
			awaitApproval: async () => {
				throw new Error("no ipc");
			},
			emit: () => {},
		});
		const res = await canUseTool("MysteryTool", {}, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "deny");
	});

	it("emits a request and uses awaitApproval when supervised and ask", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async (requestId) => ({ requestId, decision: "allow", reason: "user said yes" }),
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("MysteryTool", { foo: 1 }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "allow");
		ok(emitted.some((e) => (e as { type?: string }).type === "clio_tool_approval_request"));
	});

	interface FinishLike {
		type: string;
		payload: { tool: string; decision: string; outcome: string };
	}
	function findFinish(events: ReadonlyArray<unknown>): FinishLike | undefined {
		return events.find((e): e is FinishLike => (e as { type?: string }).type === "clio_tool_finish") as
			| FinishLike
			| undefined;
	}
	function filterFinish(events: ReadonlyArray<unknown>): FinishLike[] {
		return events.filter((e): e is FinishLike => (e as { type?: string }).type === "clio_tool_finish") as FinishLike[];
	}

	it("emits clio_tool_finish with decision=allowed when policy allows", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async () => {
				throw new Error("not expected");
			},
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("Bash", { command: "ls -la", cwd }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "allow");
		const finish = findFinish(emitted);
		ok(finish, "expected clio_tool_finish event");
		strictEqual(finish.payload.decision, "allowed");
		strictEqual(finish.payload.outcome, "ok");
		strictEqual(finish.payload.tool, "bash");
	});

	it("emits clio_tool_finish with decision=blocked when policy blocks", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async () => {
				throw new Error("not expected");
			},
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("Bash", { command: "echo hi | cat", cwd }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "deny");
		const finish = findFinish(emitted);
		ok(finish, "expected clio_tool_finish event");
		strictEqual(finish.payload.decision, "blocked");
		strictEqual(finish.payload.outcome, "blocked");
	});

	it("emits clio_tool_finish with decision=elevated when autoApprove allow flips an ask", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: "allow",
			awaitApproval: async () => {
				throw new Error("not expected");
			},
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("MysteryTool", { foo: 1 }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "allow");
		const finish = findFinish(emitted);
		ok(finish, "expected clio_tool_finish event");
		strictEqual(finish.payload.decision, "elevated");
		strictEqual(finish.payload.tool, "claude:MysteryTool");
	});

	it("emits clio_tool_finish with decision=blocked when autoApprove deny denies an ask", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: "deny",
			awaitApproval: async () => {
				throw new Error("not expected");
			},
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("MysteryTool", { foo: 1 }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "deny");
		const finish = findFinish(emitted);
		ok(finish, "expected clio_tool_finish event");
		strictEqual(finish.payload.decision, "blocked");
		strictEqual(finish.payload.outcome, "blocked");
	});

	it("emits clio_tool_finish with decision=elevated when supervised IPC approves", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async (requestId) => ({ requestId, decision: "allow", reason: "user approved" }),
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("MysteryTool", { foo: 1 }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "allow");
		const finishes = filterFinish(emitted);
		strictEqual(finishes.length, 1);
		strictEqual(finishes[0]?.payload.decision, "elevated");
	});

	it("emits clio_tool_finish with decision=blocked when supervised IPC denies", async () => {
		const emitted: unknown[] = [];
		const canUseTool = buildCanUseTool({
			safety,
			mode: "default",
			autoApprove: undefined,
			awaitApproval: async (requestId) => ({ requestId, decision: "deny", reason: "user denied" }),
			emit: (event) => emitted.push(event),
		});
		const res = await canUseTool("MysteryTool", { foo: 1 }, { toolUseID: "x" } as never);
		strictEqual(res.behavior, "deny");
		const finishes = filterFinish(emitted);
		strictEqual(finishes.length, 1);
		strictEqual(finishes[0]?.payload.decision, "blocked");
	});
});
