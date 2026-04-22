import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ToolName } from "../../src/core/tool-names.js";
import { startHarness } from "../../src/harness/index.js";
import type { ToolRegistry, ToolSpec } from "../../src/tools/registry.js";

function fakeRegistry(): ToolRegistry & { specs: ToolSpec[] } {
	const specs: ToolSpec[] = [];
	return {
		specs,
		register(spec: ToolSpec) {
			const idx = specs.findIndex((s) => s.name === spec.name);
			if (idx === -1) specs.push(spec);
			else specs[idx] = spec;
		},
		listAll: () => specs,
		listVisible: () => specs,
		get: (name: string) => specs.find((s) => s.name === name),
		listForMode: () => specs.map((s) => s.name),
		invoke: async () => ({ kind: "not_visible", reason: "stub" }),
	} as unknown as ToolRegistry & { specs: ToolSpec[] };
}

describe("startHarness", () => {
	let repo: string;
	let cache: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "clio-harness-"));
		mkdirSync(join(repo, "src", "tools"), { recursive: true });
		cache = mkdtempSync(join(tmpdir(), "clio-harness-cache-"));
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(cache, { recursive: true, force: true });
	});

	it("hot-swaps a changed tool file and updates registry + state", async () => {
		const source = join(repo, "src", "tools", "fake.ts");
		writeFileSync(
			source,
			`export const fakeTool = { name: "fake", description: "f", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v1" }; } };\n`,
		);
		const registry = fakeRegistry();
		const bus = createSafeEventBus();
		const allowedModesByName = new Map<string, ReadonlyArray<string>>([["fake", ["default"]]]);
		const handle = startHarness({ repoRoot: repo, cacheRoot: cache, toolRegistry: registry, bus, allowedModesByName });
		try {
			await delay(100);
			writeFileSync(
				source,
				`export const fakeTool = { name: "fake", description: "f", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v2" }; } };\n`,
			);
			await delay(400);
			const spec = registry.get("fake" as ToolName);
			ok(spec, "expected fake to be registered");
			const run = await spec?.run({});
			strictEqual(run?.kind, "ok");
			if (run?.kind === "ok") strictEqual(run.output, "v2");
			const snap = handle.state.snapshot();
			ok(snap.kind === "hot-ready" || snap.kind === "idle", `unexpected state ${snap.kind}`);
		} finally {
			handle.stop();
		}
	});

	it("sets restart-required when an engine file changes", async () => {
		mkdirSync(join(repo, "src", "engine"), { recursive: true });
		const engineFile = join(repo, "src", "engine", "agent.ts");
		writeFileSync(engineFile, "export const x = 1;\n");
		const registry = fakeRegistry();
		const bus = createSafeEventBus();
		const handle = startHarness({
			repoRoot: repo,
			cacheRoot: cache,
			toolRegistry: registry,
			bus,
			allowedModesByName: new Map(),
		});
		try {
			await delay(100);
			writeFileSync(engineFile, "export const x = 2;\n");
			await delay(400);
			const snap = handle.state.snapshot();
			strictEqual(snap.kind, "restart-required");
		} finally {
			handle.stop();
		}
	});
});
