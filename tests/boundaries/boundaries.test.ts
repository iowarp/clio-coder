import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runBoundaryCheck } from "./check-boundaries.js";

const PROJECT_ROOT = new URL("../..", import.meta.url).pathname;
const fixtureRoots: string[] = [];

function fixtureProject(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-boundary-"));
	fixtureRoots.push(root);
	for (const [file, content] of Object.entries(files)) {
		const full = path.join(root, file);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return root;
}

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("boundaries", () => {
	it("no rule1/rule2/rule3 violations across src/", () => {
		const result = runBoundaryCheck(PROJECT_ROOT);
		if (result.violations.length > 0) {
			console.error("Boundary violations:");
			for (const v of result.violations) console.error(`  ${v}`);
		}
		strictEqual(result.violations.length, 0);
	});

	it("allows explicit non-engine pi-ai type imports", () => {
		const root = fixtureProject({
			"src/domains/providers/types/runtime-descriptor.ts":
				'import type { Api, Model } from "@earendil-works/pi-ai";\nexport type RuntimeModel = Model<Api>;',
		});

		strictEqual(runBoundaryCheck(root).violations.length, 0);
	});

	it("rejects non-engine pi value imports", () => {
		const root = fixtureProject({
			"src/domains/providers/registry.ts":
				'import { getModel } from "@earendil-works/pi-ai";\nexport const model = getModel;',
		});

		const result = runBoundaryCheck(root);

		ok(
			result.violations.some((violation) => violation.includes("rule1") && violation.includes("value import")),
			result.violations.join("\n"),
		);
	});

	it("rejects non-engine pi type imports that are not explicitly allowed", () => {
		const root = fixtureProject({
			"src/domains/agents/state.ts":
				'import type { AgentState } from "@earendil-works/pi-agent-core";\nexport type AgentStateSnapshot = AgentState;',
		});

		const result = runBoundaryCheck(root);

		ok(
			result.violations.some(
				(violation) => violation.includes("rule1") && violation.includes("type-only import is not explicitly allowed"),
			),
			result.violations.join("\n"),
		);
	});

	it("allows only worker-safe provider runtime rehydration imports", () => {
		const root = fixtureProject({
			"src/worker/runtime-registry.ts": [
				'import { loadPluginRuntimes } from "../domains/providers/plugins.js";',
				'import { getRuntimeRegistry } from "../domains/providers/registry.js";',
				'import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";',
				'import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";',
			].join("\n"),
			"src/domains/providers/plugins.ts": "",
			"src/domains/providers/registry.ts": "",
			"src/domains/providers/runtimes/builtins.ts": "",
			"src/domains/providers/types/endpoint-descriptor.ts": "",
		});

		strictEqual(runBoundaryCheck(root).violations.length, 0);
	});

	it("rejects worker value imports from non-provider domains", () => {
		const root = fixtureProject({
			"src/worker/entry.ts": 'import { createConfigBundle } from "../domains/config/extension.js";',
			"src/domains/config/extension.ts": "export const createConfigBundle = {};",
		});

		const result = runBoundaryCheck(root);

		ok(
			result.violations.some((violation) => violation.includes("rule2")),
			result.violations.join("\n"),
		);
	});

	it("rejects worker value imports from non-runtime provider modules", () => {
		const root = fixtureProject({
			"src/worker/entry.ts": 'import { createProvidersBundle } from "../domains/providers/extension.js";',
			"src/domains/providers/extension.ts": "export const createProvidersBundle = {};",
		});

		const result = runBoundaryCheck(root);

		ok(
			result.violations.some((violation) => violation.includes("rule2")),
			result.violations.join("\n"),
		);
	});

	it("treats mixed type/value imports as value imports", () => {
		const root = fixtureProject({
			"src/worker/entry.ts": 'import { type ConfigContract, createConfigBundle } from "../domains/config/extension.js";',
			"src/domains/config/extension.ts": "export type ConfigContract = {};\nexport const createConfigBundle = {};",
		});

		const result = runBoundaryCheck(root);

		ok(
			result.violations.some((violation) => violation.includes("rule2")),
			result.violations.join("\n"),
		);
	});
});
