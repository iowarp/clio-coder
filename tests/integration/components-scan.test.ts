import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { scanComponents } from "../../src/domains/components/index.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-components-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("components scanner", () => {
	it("scans deterministic component rows from the filesystem", async () => {
		seedComponentFixture(scratch);
		const first = await scanComponents(scratch);
		const second = await scanComponents(scratch);
		deepStrictEqual(second, first);
		ok(first.some((component) => component.id === "prompt-fragment:src/domains/prompts/fragments/identity/clio.md"));
		ok(first.some((component) => component.id === "agent-recipe:src/domains/agents/builtins/scout.md"));
		ok(first.some((component) => component.id === "runtime-descriptor:src/domains/providers/runtimes/cloud/openai.ts"));
		ok(first.some((component) => component.id === "context-file:CLIO.md"));
		ok(first.some((component) => component.id === "doc-spec:docs/specs/fixture.md"));
	});

	it("uses unique stable ids", async () => {
		seedComponentFixture(scratch);
		const components = await scanComponents(scratch);
		const ids = components.map((component) => component.id);
		strictEqual(new Set(ids).size, ids.length);
		ok(ids.includes("tool-implementation:src/tools/bash.ts"));
		ok(ids.includes("tool-helper:src/tools/registry.ts"));
	});

	it("changes content hashes when content changes", async () => {
		writeFixture("src/domains/prompts/fragments/test.md", "first\n");
		const first = await scanComponents(scratch);
		const firstComponent = first.find(
			(component) => component.id === "prompt-fragment:src/domains/prompts/fragments/test.md",
		);
		ok(firstComponent);
		writeFixture("src/domains/prompts/fragments/test.md", "second\n");
		const second = await scanComponents(scratch);
		const secondComponent = second.find((component) => component.id === firstComponent.id);
		ok(secondComponent);
		equal(firstComponent.contentHash.length, 64);
		equal(secondComponent.contentHash.length, 64);
		ok(firstComponent.contentHash !== secondComponent.contentHash);
	});

	it("does not throw when optional component directories are missing", async () => {
		const components = await scanComponents(scratch);
		deepStrictEqual(components, []);
	});

	it("represents parseable safety rule packs as logical components", async () => {
		writeFixture(
			"damage-control-rules.yaml",
			[
				"version: 2",
				"packs:",
				"  - id: base",
				"    rules:",
				"      - id: block-rm",
				"        description: block rm",
				"        pattern: rm",
				"        class: execute",
				"        block: true",
				"  - id: dev",
				"    rules: []",
				"  - id: super",
				"    rules: []",
				"",
			].join("\n"),
		);
		const components = await scanComponents(scratch);
		const packs = components.filter((component) => component.kind === "safety-rule-pack");
		deepStrictEqual(
			packs.map((pack) => pack.id),
			["safety-rule-pack:base", "safety-rule-pack:dev", "safety-rule-pack:super"],
		);
		for (const pack of packs) {
			strictEqual(pack.path, "damage-control-rules.yaml");
			strictEqual(pack.ownerDomain, "safety");
			strictEqual(pack.authority, "enforcing");
			strictEqual(pack.reloadClass, "restart-required");
			equal(pack.contentHash.length, 64);
			ok(pack.description?.startsWith("damage-control rule pack: "));
		}
	});
});

function seedComponentFixture(root: string): void {
	writeFixture("src/domains/prompts/fragments/identity/clio.md", "---\nid: identity.clio\n---\nbody\n", root);
	writeFixture("src/domains/agents/builtins/scout.md", "---\nid: scout\n---\nbody\n", root);
	writeFixture("src/tools/bash.ts", "export const bash = true;\n", root);
	writeFixture("src/tools/registry.ts", "export const registry = true;\n", root);
	writeFixture("src/domains/providers/runtimes/cloud/openai.ts", "export const runtime = true;\n", root);
	writeFixture("src/core/defaults.ts", "export const defaults = true;\n", root);
	writeFixture("src/core/config.ts", "export const config = true;\n", root);
	writeFixture("src/domains/config/schema.ts", "export const schema = true;\n", root);
	writeFixture("src/domains/session/entries.ts", "export const entries = true;\n", root);
	writeFixture("src/domains/session/contract.ts", "export const contract = true;\n", root);
	writeFixture("src/engine/session.ts", "export const session = true;\n", root);
	writeFixture("src/domains/dispatch/types.ts", "export const types = true;\n", root);
	writeFixture("src/domains/dispatch/receipt-integrity.ts", "export const receipt = true;\n", root);
	writeFixture("CLIO.md", "# CLIO\n", root);
	writeFixture("CONTRIBUTING.md", "# Contributing\n", root);
	writeFixture("SECURITY.md", "# Security\n", root);
	writeFixture("docs/specs/fixture.md", "# Spec\n", root);
}

function writeFixture(repoPath: string, content: string, root = scratch): void {
	const fullPath = join(root, repoPath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content, "utf8");
}
