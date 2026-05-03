import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { HarnessIntrospection } from "../../src/selfdev/harness/state.js";

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

	it("renders dynamic state, memory, and composes selfdev fragments in order", async () => {
		const bundle = createPromptsBundle(context(), {
			devRepoRoot: tmpRepo(),
			getHarnessIntrospection: () => ({
				last_restart_required_paths: [],
				last_hot_succeeded: { path: "src/tools/read.ts", elapsedMs: 7, at: 1 },
				last_hot_failed: null,
				queue_depth: 0,
			}),
			renderSelfDevMemory: async () => "## Dev memory\n- a remembered note",
		});
		await bundle.extension.start();
		const result = await bundle.contract.compileForTurn({ dynamicInputs: {} });
		const ids = result.fragmentManifest.map((row) => row.id);
		strictEqual(result.text.includes("## Live state"), true);
		strictEqual(result.text.includes("## Dev memory"), true);
		strictEqual(result.text.includes("- a remembered note"), true);
		strictEqual(ids.includes("selfdev.identity"), true);
		ok(ids.indexOf("selfdev.identity") < ids.indexOf("selfdev.authority"));
		ok(ids.indexOf("selfdev.authority") < ids.indexOf("selfdev.iteration"));
		ok(ids.indexOf("selfdev.iteration") < ids.indexOf("selfdev.state"));
		ok(ids.indexOf("selfdev.state") < ids.indexOf("selfdev.memory"));
	});

	it("omits selfdev fragments entirely when devRepoRoot is absent", async () => {
		const bundle = createPromptsBundle(context(), {});
		await bundle.extension.start();
		const result = await bundle.contract.compileForTurn({ dynamicInputs: {} });
		const ids = result.fragmentManifest.map((row) => row.id);
		ok(
			!ids.some((id) => id.startsWith("selfdev.")),
			`unexpected selfdev fragments: ${ids.filter((id) => id.startsWith("selfdev.")).join(",")}`,
		);
		ok(!result.text.includes("## Live state"));
		ok(!result.text.includes("## Dev memory"));
	});

	it("recomputes the dynamic state contentHash when harness state changes after the cache window", async () => {
		let snapshot: HarnessIntrospection = {
			last_restart_required_paths: [],
			last_hot_succeeded: { path: "src/tools/read.ts", elapsedMs: 7, at: 1 },
			last_hot_failed: null,
			queue_depth: 0,
		};
		const bundle = createPromptsBundle(context(), {
			devRepoRoot: tmpRepo(),
			getHarnessIntrospection: () => snapshot,
		});
		await bundle.extension.start();
		const first = await bundle.contract.compileForTurn({ dynamicInputs: {} });
		const stateA = first.fragmentManifest.find((row) => row.id === "selfdev.state");
		ok(stateA, "selfdev.state present in first render");

		// Same render inside the 1s cache window — same hash.
		const cached = await bundle.contract.compileForTurn({ dynamicInputs: {} });
		const stateCached = cached.fragmentManifest.find((row) => row.id === "selfdev.state");
		strictEqual(stateA.contentHash, stateCached?.contentHash, "cache window must return identical hash");

		// Change underlying harness state, wait past the 1s cache, render again.
		snapshot = {
			last_restart_required_paths: ["src/engine/types.ts"],
			last_hot_succeeded: { path: "src/tools/read.ts", elapsedMs: 7, at: 1 },
			last_hot_failed: null,
			queue_depth: 2,
		};
		await delay(1100);
		const second = await bundle.contract.compileForTurn({ dynamicInputs: {} });
		const stateB = second.fragmentManifest.find((row) => row.id === "selfdev.state");
		ok(stateB, "selfdev.state present in second render");
		ok(stateA.contentHash !== stateB.contentHash, "state hash must change when harness verdict changes");
	});

	it("exposes the worker preamble through PromptsContract", async () => {
		const bundle = createPromptsBundle(context(), { devRepoRoot: tmpRepo() });
		await bundle.extension.start();
		const preamble = bundle.contract.getSelfDevWorkerPreamble();
		ok(preamble?.includes("You are running under Clio self-development."), preamble ?? "<null>");
	});

	it("returns null worker preamble when selfdev fragments are not loaded", async () => {
		const bundle = createPromptsBundle(context(), {});
		await bundle.extension.start();
		strictEqual(bundle.contract.getSelfDevWorkerPreamble(), null);
	});
});
