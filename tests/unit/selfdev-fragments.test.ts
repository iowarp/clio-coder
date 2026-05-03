import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";

const dirs: string[] = [];

function context(): DomainContext {
	return { bus: createSafeEventBus(), getContract: () => undefined };
}

function tmpRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-selfdev-fragments-"));
	dirs.push(dir);
	execFileSync("git", ["-C", dir, "init", "-q", "-b", "selfdev-test"]);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("selfdev prompt fragments", () => {
	it("loads selfdev fragments only when requested", () => {
		strictEqual(loadFragments().byId.has("selfdev.identity"), false);
		const table = loadFragments({ includeSelfDev: true });
		strictEqual(table.byId.get("selfdev.identity")?.dynamic, false);
		strictEqual(table.byId.get("selfdev.state")?.dynamic, true);
	});

	it("renders dynamic state and composes selfdev fragments in order", async () => {
		const bundle = createPromptsBundle(context(), {
			devRepoRoot: tmpRepo(),
			getHarnessIntrospection: () => ({
				last_restart_required_paths: [],
				last_hot_succeeded: { path: "src/tools/read.ts", elapsedMs: 7, at: 1 },
				last_hot_failed: null,
				queue_depth: 0,
			}),
		});
		await bundle.extension.start();
		const result = await bundle.contract.compileForTurn({ dynamicInputs: {} });
		const ids = result.fragmentManifest.map((row) => row.id);
		strictEqual(result.text.includes("## Live state"), true);
		strictEqual(ids.includes("selfdev.identity"), true);
		ok(ids.indexOf("selfdev.identity") < ids.indexOf("selfdev.authority"));
		ok(ids.indexOf("selfdev.authority") < ids.indexOf("selfdev.iteration"));
		ok(ids.indexOf("selfdev.iteration") < ids.indexOf("selfdev.state"));
	});
});
