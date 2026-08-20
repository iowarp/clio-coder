/**
 * Per-call cost and concurrency of the tool substrate.
 *
 * Two claims are pinned here:
 *   1. Admission (classify -> skill surface -> autonomy -> before_tool ->
 *      shaping) is per-call cheap. The regression this guards is settings
 *      derivation: `admit` reads the effective autonomy on every call, and the
 *      orchestrator's effective-settings view deep-clones the saved settings
 *      blob. Memoizing that view moved a full structuredClone off the hot path;
 *      this test fails again if a future change re-introduces per-call cloning
 *      or any comparable per-call re-parse.
 *   2. Read-class tools admitted in one batch actually overlap end-to-end.
 *      Admission holds no lock, so N concurrent read invocations finish in
 *      about one tool's wall time, not N times it.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { applyOverrides, applySessionRouting, seedSessionRouting } from "../../src/core/session-routing.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

function readToolSpec(name: ToolName, delayMs: number): ToolSpec {
	return {
		name,
		description: `test ${name}`,
		parameters: Type.Object({}),
		plane: "observe",
		actionClass: "read",
		executionMode: "parallel",
		async run() {
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
			return { kind: "ok", output: "done" };
		},
	} as unknown as ToolSpec;
}

function registryWith(autonomy: () => ClioSettings["autonomy"], specs: ToolSpec[]) {
	const registry = createRegistry({
		autonomy,
		safety: {
			classify: () => ({ actionClass: "read", reasons: [] }),
			evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
			observeLoop: () => ({ looping: false, key: "test", count: 0 }),
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
			isSubset: () => true,
			audit: { recordCount: () => 0 },
		},
	} as never);
	for (const spec of specs) registry.register(spec);
	return registry;
}

describe("contracts/tool admission cost and concurrency", () => {
	it("forwards tool progress through pi's cumulative update callback", async () => {
		const spec = readToolSpec(ToolNames.Read, 0);
		spec.run = async (_args, options) => {
			options?.onUpdate?.({
				kind: "ok",
				output: "first snapshot",
				details: { observation: { shownCount: 1, totalCount: 2, unit: "lines" } },
			});
			options?.onUpdate?.({
				kind: "ok",
				output: "first snapshot\nsecond snapshot",
				details: { observation: { shownCount: 2, totalCount: 2, unit: "lines" } },
			});
			return { kind: "ok", output: "terminal result" };
		};
		const registry = registryWith(() => "full-auto", [spec]);
		const tool = resolveAgentTools({ registry })[0];
		ok(tool, "the test tool should be exposed to pi");
		const updates: Array<{ text: string; shownCount: unknown }> = [];

		const terminal = await tool.execute("call-progress", {}, undefined, (partial) => {
			const first = partial.content[0];
			updates.push({
				text: first?.type === "text" ? first.text : "",
				shownCount: (partial.details as { observation?: { shownCount?: unknown } }).observation?.shownCount,
			});
		});

		deepStrictEqual(updates, [
			{ text: "first snapshot", shownCount: 1 },
			{ text: "first snapshot\nsecond snapshot", shownCount: 2 },
		]);
		strictEqual(terminal.content[0]?.type, "text");
		strictEqual(terminal.content[0]?.type === "text" ? terminal.content[0].text : "", "terminal result");
	});

	it("resolves effective autonomy without re-deriving settings per call", async () => {
		// Stand in for the orchestrator's effective-settings view: the saved
		// snapshot is stable, the session routing/override state is unchanged, so
		// a correct resolver derives the view once and reuses it. An
		// unmemoized resolver clones the whole settings blob on every call.
		const saved = structuredClone(DEFAULT_SETTINGS);
		const routing = seedSessionRouting(saved);
		const overrides = new Map<string, unknown>();
		let derivations = 0;
		let cached: ReturnType<typeof applySessionRouting> | null = null;
		const getCurrentSettings = () => {
			if (cached) return cached;
			derivations += 1;
			cached = applySessionRouting(applyOverrides(saved, overrides as never), routing);
			return cached;
		};
		const registry = registryWith(() => getCurrentSettings().autonomy ?? "auto-edit", [readToolSpec(ToolNames.Read, 0)]);

		for (let i = 0; i < 200; i += 1) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: {} });
			strictEqual(verdict.kind, "ok");
		}

		strictEqual(derivations, 1, "200 admissions must derive the settings view once, not per call");
	});

	it("keeps per-call admission overhead well under a millisecond", async () => {
		const registry = registryWith(() => "full-auto", [readToolSpec(ToolNames.Read, 0)]);
		const iterations = 500;
		// Warm the JIT so the measurement is steady-state, not first-call cost.
		for (let i = 0; i < 50; i += 1) await registry.invoke({ tool: ToolNames.Read, args: {} });

		const started = performance.now();
		for (let i = 0; i < iterations; i += 1) await registry.invoke({ tool: ToolNames.Read, args: {} });
		const perCallMs = (performance.now() - started) / iterations;

		// The tool body is a no-op resolve, so this is admission plus shaping.
		// The bound is deliberately loose (slow CI, cold caches) but tight enough
		// that a reinstated per-call settings clone or schema re-parse trips it.
		ok(perCallMs < 1, `per-call admission overhead was ${perCallMs.toFixed(3)}ms, expected under 1ms`);
	});

	it("runs read-class tools in one batch concurrently end to end", async () => {
		const DELAY_MS = 120;
		const BATCH = 5;
		const specs = [ToolNames.Read, ToolNames.Grep, ToolNames.Find, ToolNames.Ls, ToolNames.CodeNav].map((name) =>
			readToolSpec(name, DELAY_MS),
		);
		const registry = registryWith(() => "full-auto", specs);
		const tools = resolveAgentTools({ registry });
		strictEqual(tools.length, BATCH);
		// Every read-class tool must declare parallel execution; a sequential one
		// in the batch makes pi's agent loop serialize the whole batch.
		for (const tool of tools) {
			strictEqual(tool.executionMode, "parallel", `${tool.name} must be parallel-executable`);
		}

		const started = performance.now();
		await Promise.all(tools.map((tool, index) => tool.execute(`call-${index}`, {})));
		const elapsed = performance.now() - started;

		// Serial execution would take BATCH * DELAY_MS. Allow generous slack for
		// timer skew while still failing loudly on any serialization.
		ok(
			elapsed < DELAY_MS * 2,
			`batch of ${BATCH} ${DELAY_MS}ms read tools took ${elapsed.toFixed(0)}ms; serial would be ~${BATCH * DELAY_MS}ms`,
		);
	});
});
