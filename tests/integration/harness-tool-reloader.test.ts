import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadToolFile } from "../../src/harness/tool-reloader.js";
import type { ToolRegistry, ToolSpec } from "../../src/tools/registry.js";

function fakeRegistry(): ToolRegistry & { lastRegistered: ToolSpec | null } {
	let last: ToolSpec | null = null;
	return {
		lastRegistered: null,
		get lastRegistered_(): ToolSpec | null {
			return last;
		},
		register(spec: ToolSpec) {
			last = spec;
			(this as ToolRegistry & { lastRegistered: ToolSpec | null }).lastRegistered = spec;
		},
		listAll: () => (last ? [last] : []),
		listVisible: () => (last ? [last] : []),
		get: (name: string) => (last && last.name === name ? last : undefined),
		listForMode: () => (last ? [last.name] : []),
		invoke: async () => ({ kind: "not_visible", reason: "stub" }),
	} as unknown as ToolRegistry & { lastRegistered: ToolSpec | null };
}

describe("reloadToolFile", () => {
	let tmp: string;
	let cache: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "clio-tool-reload-"));
		cache = join(tmp, "cache");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("compiles, imports, and re-registers a valid tool file", async () => {
		const source = join(tmp, "fake.ts");
		writeFileSync(
			source,
			`export const fakeTool = {
				name: "fake",
				description: "fake",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				baseActionClass: "read",
				async run() { return { kind: "ok", output: "v1" }; },
			};\n`,
		);
		const registry = fakeRegistry();
		const allowedModesByName = new Map<string, ReadonlyArray<string>>([["fake", ["default"]]]);
		const result = await reloadToolFile(source, cache, registry, allowedModesByName);
		strictEqual(result.kind, "ok");
		strictEqual(registry.lastRegistered?.name, "fake");
		const run = await registry.lastRegistered?.run({});
		strictEqual(run?.kind, "ok");
		if (run?.kind === "ok") strictEqual(run.output, "v1");
	});

	it("re-running on an edited file swaps the behavior", async () => {
		const source = join(tmp, "fake.ts");
		writeFileSync(
			source,
			`export const fakeTool = { name: "fake", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v1" }; } };\n`,
		);
		const registry = fakeRegistry();
		const allowedModesByName = new Map<string, ReadonlyArray<string>>();
		await reloadToolFile(source, cache, registry, allowedModesByName);
		writeFileSync(
			source,
			`export const fakeTool = { name: "fake", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v2" }; } };\n`,
		);
		await reloadToolFile(source, cache, registry, allowedModesByName);
		const run = await registry.lastRegistered?.run({});
		strictEqual(run?.kind, "ok");
		if (run?.kind === "ok") strictEqual(run.output, "v2");
	});

	it("returns an error when compile fails", async () => {
		const source = join(tmp, "broken.ts");
		writeFileSync(source, "export const broken: = }\n");
		const registry = fakeRegistry();
		const result = await reloadToolFile(source, cache, registry, new Map());
		strictEqual(result.kind, "error");
	});

	it("returns an error when the module exports no recognizable tool", async () => {
		const source = join(tmp, "empty.ts");
		writeFileSync(source, "export const unrelated = 42;\n");
		const registry = fakeRegistry();
		const result = await reloadToolFile(source, cache, registry, new Map());
		strictEqual(result.kind, "error");
	});
});
