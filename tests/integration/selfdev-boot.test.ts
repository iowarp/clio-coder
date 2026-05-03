import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { bootOrchestrator } from "../../src/entry/orchestrator.js";
import { registerSelfDevTools, resolveSelfDevMode } from "../../src/selfdev/index.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import type { ToolRegistry, ToolSpec } from "../../src/tools/registry.js";

function tmpRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "clio-selfdev-boot-"));
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "package.json"), '{"name":"tmp","version":"0.0.0"}');
	writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
	writeFileSync(join(repo, "CLIO-dev.md"), "# local dev gate\n");
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "selfdev-test"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
	execFileSync("git", ["-C", repo, "add", "."]);
	execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
	return repo;
}

describe("selfdev boot wiring", () => {
	it("boots dev mode, registers private tools, and exposes worker preamble", async () => {
		const repo = tmpRepo();
		const home = mkdtempSync(join(tmpdir(), "clio-selfdev-home-"));
		const oldCwd = process.cwd();
		process.chdir(repo);
		process.env.CLIO_HOME = home;
		resetXdgCache();
		try {
			strictEqual((await bootOrchestrator({ dev: true })).exitCode, 0);
			const specs: ToolSpec[] = [];
			const registry = { register: (spec: ToolSpec) => specs.push(spec), listAll: () => specs } as unknown as ToolRegistry;
			registerAllTools(registry);
			ok(!specs.some((tool) => tool.name === "clio_introspect"));
			const mode = resolveSelfDevMode({ cliDev: true });
			strictEqual(mode?.repoRoot, repo);
			if (!mode) throw new Error("selfdev mode did not resolve");
			registerSelfDevTools(registry, { mode });
			ok(specs.some((tool) => tool.name === "clio_introspect"));
			const prompts = createPromptsBundle(
				{ bus: createSafeEventBus(), getContract: () => undefined },
				{ devRepoRoot: repo },
			);
			await prompts.extension.start();
			ok(prompts.contract.getSelfDevWorkerPreamble()?.includes("You are running under Clio self-development."));
		} finally {
			process.chdir(oldCwd);
			rmSync(repo, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
			delete process.env.CLIO_HOME;
			resetXdgCache();
		}
	});
});
