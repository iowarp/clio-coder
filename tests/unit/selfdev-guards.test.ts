import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { applySelfDevToolGuards } from "../../src/selfdev/guards.js";
import type { SelfDevMode } from "../../src/selfdev/mode.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../../src/tools/registry.js";

const dirs: string[] = [];
const ORIGINAL_STALE_OVERRIDE = process.env.CLIO_DEV_ALLOW_STALE_WRITES;

function tmpRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "clio-selfdev-guard-"));
	dirs.push(repo);
	return repo;
}

function mode(repoRoot: string): SelfDevMode {
	return {
		enabled: true,
		source: "--dev",
		repoRoot,
		cwd: repoRoot,
		branch: "selfdev/test",
		dirtySummary: "clean",
		engineWritesAllowed: true,
	};
}

function fakeRegistry(specs: ReadonlyArray<ToolSpec>): ToolRegistry {
	const map = new Map<ToolName, ToolSpec>(specs.map((spec) => [spec.name, spec]));
	return {
		register(spec) {
			map.set(spec.name, spec);
		},
		listAll: () => [...map.values()],
		listVisible: () => [...map.values()],
		get: (name) => map.get(name),
		listForMode: () => [...map.keys()],
		invoke: async () => ({ kind: "not_visible", reason: "stub" }),
		protectedArtifacts: () => ({ artifacts: [] }),
		replaceProtectedArtifacts: () => {},
		hasParkedCalls: () => false,
		resumeParkedCalls: async () => {},
		cancelParkedCalls: () => {},
		onSuperRequired: () => () => {},
	};
}

function readSpec(): ToolSpec {
	return {
		name: ToolNames.Read,
		description: "read",
		parameters: Type.Object({}),
		baseActionClass: "read",
		async run(): Promise<ToolResult> {
			return { kind: "ok", output: "read-ok" };
		},
	};
}

function writeSpec(calls: { count: number }): ToolSpec {
	return {
		name: ToolNames.Write,
		description: "write",
		parameters: Type.Object({}),
		baseActionClass: "write",
		async run(): Promise<ToolResult> {
			calls.count += 1;
			return { kind: "ok", output: "write-ok" };
		},
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (ORIGINAL_STALE_OVERRIDE === undefined) Reflect.deleteProperty(process.env, "CLIO_DEV_ALLOW_STALE_WRITES");
	else process.env.CLIO_DEV_ALLOW_STALE_WRITES = ORIGINAL_STALE_OVERRIDE;
});

describe("selfdev stale-process guards", () => {
	it("blocks source write tools while restart-required is active", async () => {
		const repo = tmpRepo();
		const calls = { count: 0 };
		const registry = fakeRegistry([readSpec(), writeSpec(calls)]);
		applySelfDevToolGuards(registry, mode(repo), {
			getHarnessSnapshot: () => ({ kind: "restart-required", files: ["src/core/config.ts"] }),
		});
		const write = registry.get(ToolNames.Write);
		const result = await write?.run({ path: join(repo, "src", "core", "config.ts"), content: "x" });
		strictEqual(result?.kind, "error");
		if (result?.kind === "error") {
			ok(result.message.includes("stale process guard"));
			strictEqual((result.details?.stale_process as { restart_required?: unknown }).restart_required, true);
		}
		strictEqual(calls.count, 0);
	});

	it("allows read-only tools while restart-required is active", async () => {
		const repo = tmpRepo();
		const registry = fakeRegistry([readSpec(), writeSpec({ count: 0 })]);
		applySelfDevToolGuards(registry, mode(repo), {
			getHarnessSnapshot: () => ({ kind: "restart-required", files: ["src/core/config.ts"] }),
		});
		const result = await registry.get(ToolNames.Read)?.run({ path: join(repo, "src", "core", "config.ts") });
		strictEqual(result?.kind, "ok");
		if (result?.kind === "ok") strictEqual(result.output, "read-ok");
	});

	it("allows explicit private stale-write override", async () => {
		const repo = tmpRepo();
		const calls = { count: 0 };
		const registry = fakeRegistry([writeSpec(calls)]);
		process.env.CLIO_DEV_ALLOW_STALE_WRITES = "1";
		applySelfDevToolGuards(registry, mode(repo), {
			getHarnessSnapshot: () => ({ kind: "restart-required", files: ["src/core/config.ts"] }),
		});
		const result = await registry.get(ToolNames.Write)?.run({
			path: join(repo, "src", "core", "config.ts"),
			content: "x",
		});
		strictEqual(result?.kind, "ok");
		strictEqual(calls.count, 1);
	});
});
