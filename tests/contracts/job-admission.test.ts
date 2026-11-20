import { strictEqual } from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { jobCommandEffect } from "../../src/tools/job-command.js";
import { createRegistry } from "../../src/tools/registry.js";

test("a scheduled command the session admits directly is admitted for a job", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-job-admission-")));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	const runner = { kind: "command" as const, argv: ["git", "rev-list", "--count", "lane/x080-csurf"] };
	const effect = jobCommandEffect({ ...runner, executableSha256: "x" }, cwd)[0]?.call;
	registry.register({ ...bashTool, run: async () => ({ kind: "ok", output: "" }) });
	registry.register({
		...bashTool,
		name: ToolNames.Job,
		hostEffectCalls: () => jobCommandEffect({ ...runner, executableSha256: "x" }, cwd),
		run: async () => ({ kind: "ok", output: "scheduled" }),
	});
	const direct = await registry.invoke({ tool: ToolNames.Bash, args: { command: String(effect?.args?.command) } });
	strictEqual(direct.kind, "ok", direct.kind === "blocked" ? direct.reason : "");
	const job = await registry.invoke({ tool: ToolNames.Job, args: {} });
	strictEqual(job.kind, "ok", job.kind === "blocked" ? job.reason : "");
});

test("a scheduled probe bash would run contained is admitted and runs in the same sandbox (XR-12)", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-job-admission-")));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	const runner = {
		kind: "command" as const,
		argv: ["python3", "-c", "import os; print(os.path.exists('out/done.flag'))"],
		executableSha256: "x",
	};
	const effect = jobCommandEffect(runner, cwd)[0]?.call;
	const seen: { bash?: boolean; job?: boolean } = {};
	registry.register({
		...bashTool,
		run: async (_args, options) => {
			seen.bash = options?.shellSandbox !== undefined;
			return { kind: "ok", output: "" };
		},
	});
	registry.register({
		...bashTool,
		name: ToolNames.Job,
		hostEffectCalls: () => jobCommandEffect(runner, cwd),
		run: async (_args, options) => {
			seen.job = options?.shellSandbox !== undefined;
			return { kind: "ok", output: "scheduled" };
		},
	});
	const direct = await registry.invoke({ tool: ToolNames.Bash, args: { command: String(effect?.args?.command) } });
	strictEqual(direct.kind, "ok", direct.kind === "blocked" ? direct.reason : "");
	strictEqual(seen.bash, true);
	const job = await registry.invoke({ tool: ToolNames.Job, args: {} });
	strictEqual(job.kind, "ok", job.kind === "blocked" ? job.reason : "");
	strictEqual(seen.job, true);
});
