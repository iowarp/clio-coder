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
});
