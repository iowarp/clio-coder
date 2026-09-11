import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { HookReceipt } from "../../src/domains/middleware/hooks.js";
import { buildUserHookRegistrations } from "../../src/domains/middleware/hooks-io.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("before-tool annotations reach successful and failed tool results in hook order", async () => {
	const scratch = await isolateClioEnv("clio-coder-tool-hook-annotations-");
	try {
		const cwd = scratch.dir;
		mkdirSync(join(cwd, ".clio-coder"));
		writeFileSync(join(cwd, "sample.txt"), "observed content");
		writeFileSync(
			join(cwd, ".clio-coder", "hooks.yaml"),
			JSON.stringify([
				{
					id: "before-annotation",
					on: "before_tool",
					tools: ["read"],
					kind: "command",
					argv: [process.execPath, "-e", "process.stdout.write('before annotation')"],
					as: "annotate",
				},
				{
					id: "after-annotation",
					on: "after_tool",
					tools: ["read"],
					kind: "effect",
					effect: { kind: "annotate_tool_result", message: "after annotation" },
				},
			]),
		);
		const reviewed = captureProjectSurface(cwd, "hooks");
		ok(reviewed.contentHash);
		recordProjectSurfaceTrust(cwd, "hooks", reviewed.contentHash);
		const receipts: HookReceipt[] = [];
		const hooks = buildUserHookRegistrations({ cwd, recordReceipt: (receipt) => receipts.push(receipt) });
		deepStrictEqual(hooks.issues, []);
		deepStrictEqual(hooks.fileIssues, []);
		strictEqual(hooks.registrations.length, 2);
		const middleware = createMiddlewareBundle().contract;
		middleware.replaceRegistrations("user-hooks", 1, hooks.registrations);
		const registry = createRegistry({ safety: createWorkerSafety({ cwd }), middleware });
		registry.register(readTool);
		for (const path of ["sample.txt", "missing.txt"]) {
			const verdict = await registry.invoke({ tool: "read", args: { path: join(cwd, path) } });
			ok(verdict.kind === "ok");
			strictEqual(verdict.result.kind, path === "sample.txt" ? "ok" : "error");
			const text = verdict.result.kind === "ok" ? verdict.result.output : verdict.result.message;
			match(text, /\[middleware:info\] before annotation\n\[middleware:info\] after annotation$/u);
		}
		deepStrictEqual(
			receipts.map((receipt) => receipt.outcome),
			["command-ok", "emitted", "command-ok", "emitted"],
		);
	} finally {
		scratch.restore();
	}
});
