import { ok, strictEqual } from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SelfDevMode } from "../../src/selfdev/mode.js";
import { clioIntrospectTool } from "../../src/selfdev/tools/introspect.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../../src/tools/registry.js";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const mode: SelfDevMode = {
	enabled: true,
	source: "--dev",
	repoRoot,
	cwd: repoRoot,
	branch: "selfdev-test",
	dirtySummary: "clean",
	engineWritesAllowed: false,
};

const sampleTool = {
	name: ToolNames.Read,
	allowedModes: ["default"],
	sourceInfo: { path: "src/tools/read.ts", scope: "core" },
} as unknown as ToolSpec;

const registry = { listAll: () => [sampleTool] } as unknown as ToolRegistry;

function json(result: ToolResult): unknown {
	strictEqual(result.kind, "ok");
	return JSON.parse(result.output) as unknown;
}

describe("clio_introspect", () => {
	for (const view of ["whoami", "domains", "tools", "fragments", "harness", "recent"] as const) {
		it(`returns ${view} JSON shape`, async () => {
			const tool = clioIntrospectTool({
				mode,
				registry,
				getHarnessIntrospection: () => ({
					last_restart_required_paths: ["src/engine/types.ts"],
					last_hot_succeeded: { path: "src/tools/read.ts", elapsedMs: 12, at: 1 },
					last_hot_failed: null,
					queue_depth: 0,
				}),
			});
			const value = json(await tool.run({ view }));
			if (view === "whoami") ok(typeof (value as { repo_root?: unknown }).repo_root === "string");
			if (view === "domains") ok(Array.isArray(value));
			if (view === "tools") strictEqual((value as Array<{ source_path: string }>)[0]?.source_path, "src/tools/read.ts");
			if (view === "fragments") ok((value as Array<{ id: string }>).some((row) => row.id === "selfdev.identity"));
			if (view === "harness") strictEqual((value as { queue_depth: number }).queue_depth, 0);
			if (view === "recent") ok(Array.isArray((value as { commit_subjects: unknown[] }).commit_subjects));
		});
	}
});
