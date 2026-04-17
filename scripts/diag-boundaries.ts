import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBoundaryCheck } from "./check-boundaries.js";

/**
 * Regression fixtures for scripts/check-boundaries.ts.
 *
 * Each case builds a synthetic src/ tree in a tempdir, runs the boundary
 * checker against it, and asserts the violation set. This is the guard rail
 * that catches regressions in the enforcer itself (e.g. the Phase 1 .js→.ts
 * resolver bug from commit 65c2d37, or a future regex tweak that silently
 * stops matching `export * from`).
 *
 * Run: `npm run diag:boundaries`.
 *
 * Cases:
 *   1. Clean tree. Expect zero violations.
 *   2. Rule 1: domain importing pi-mono at runtime.
 *   3. Rule 1 (type-only): domain `import type` from pi-mono.
 *   4. Rule 1 via triple-slash reference types directive.
 *   5. Rule 2: worker importing a domain.
 *   6. Rule 2 (type-only): worker `import type` from a domain.
 *   7. Rule 3 via .js suffix (the retro-bug regression test).
 *   8. Rule 3 via `import type` from another domain's extension.ts.
 *   9. Rule 3 via re-export chain (`export { Foo } from "../other/extension.js"`).
 *  10. Rule 3 via static `import("...")` dynamic specifier.
 *  11. Engine importing pi-mono is fine.
 *  12. Domain importing peer domain's index.ts (the contract) is fine.
 *  13. Commented-out violations are ignored (the stripper works).
 *  14. Template-literal dynamic import is NOT caught (documented limitation).
 */

interface FixtureCase {
	name: string;
	build: (root: string) => void;
	expect: (violations: string[]) => string | null;
}

function write(root: string, rel: string, contents: string): void {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, contents, "utf8");
}

function includesAll(haystack: string[], needles: string[]): boolean {
	return needles.every((n) => haystack.some((h) => h.includes(n)));
}

function includesNone(haystack: string[], needles: string[]): boolean {
	return needles.every((n) => !haystack.some((h) => h.includes(n)));
}

const cases: FixtureCase[] = [
	{
		name: "clean tree has zero violations",
		build(root) {
			write(root, "src/engine/ai.ts", `import { stream } from "@mariozechner/pi-ai";\nexport { stream };\n`);
			write(root, "src/core/x.ts", "export const x = 1;\n");
		},
		expect(v) {
			return v.length === 0 ? null : `expected clean, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule1: domain runtime import of pi-mono",
		build(root) {
			write(
				root,
				"src/domains/config/extension.ts",
				`import { stream } from "@mariozechner/pi-ai";\nexport const x = stream;\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule1:", "@mariozechner/pi-ai"]) ? null : `expected rule1 fire, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule1: domain type-only import of pi-mono",
		build(root) {
			write(
				root,
				"src/domains/config/extension.ts",
				`import type { Agent } from "@mariozechner/pi-agent-core";\nexport type X = Agent;\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule1:", "type-only", "@mariozechner/pi-agent-core"])
				? null
				: `expected rule1 (type-only) fire, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule1: triple-slash reference types directive",
		build(root) {
			write(
				root,
				"src/domains/config/extension.ts",
				`/// <reference types="@mariozechner/pi-ai" />\nexport const x = 1;\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule1:", "@mariozechner/pi-ai", "reference"])
				? null
				: `expected rule1 via reference directive, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule2: worker runtime import from domains",
		build(root) {
			write(root, "src/domains/config/index.ts", "export const noop = () => {};\n");
			write(root, "src/worker/entry.ts", `import { noop } from "../domains/config/index.js";\nnoop();\n`);
		},
		expect(v) {
			return includesAll(v, ["rule2:", "src/domains"]) ? null : `expected rule2 fire, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule2: worker type-only import from domains",
		build(root) {
			write(root, "src/domains/config/index.ts", "export type Settings = {};\n");
			write(
				root,
				"src/worker/entry.ts",
				`import type { Settings } from "../domains/config/index.js";\nexport type X = Settings;\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule2:", "type-only"]) ? null : `expected rule2 type-only fire, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule3: cross-domain extension.ts via .js suffix",
		build(root) {
			write(root, "src/domains/alpha/extension.ts", "export function factory() { return 1; }\n");
			write(
				root,
				"src/domains/beta/extension.ts",
				`import { factory } from "../alpha/extension.js";\nexport const x = factory();\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule3:", "src/domains/alpha/extension.ts"])
				? null
				: `expected rule3 via .js suffix, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule3: cross-domain extension.ts via import type",
		build(root) {
			write(root, "src/domains/alpha/extension.ts", "export type Shape = { a: number };\n");
			write(
				root,
				"src/domains/beta/extension.ts",
				`import type { Shape } from "../alpha/extension.js";\nexport type X = Shape;\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule3:", "type-only", "src/domains/alpha/extension.ts"])
				? null
				: `expected rule3 type-only fire, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule3: re-export chain from cross-domain extension.ts",
		build(root) {
			write(root, "src/domains/alpha/extension.ts", "export const value = 1;\n");
			write(root, "src/domains/beta/extension.ts", `export { value } from "../alpha/extension.js";\n`);
		},
		expect(v) {
			return includesAll(v, ["rule3:", "src/domains/alpha/extension.ts"])
				? null
				: `expected rule3 via re-export, got: ${v.join("; ")}`;
		},
	},
	{
		name: "rule3: static import() with quoted specifier",
		build(root) {
			write(root, "src/domains/alpha/extension.ts", "export const value = 1;\n");
			write(
				root,
				"src/domains/beta/extension.ts",
				`export async function load() { return import("../alpha/extension.js"); }\n`,
			);
		},
		expect(v) {
			return includesAll(v, ["rule3:", "src/domains/alpha/extension.ts"])
				? null
				: `expected rule3 via dynamic import, got: ${v.join("; ")}`;
		},
	},
	{
		name: "engine may import pi-mono",
		build(root) {
			write(root, "src/engine/ai.ts", `import { stream } from "@mariozechner/pi-ai";\nexport { stream };\n`);
			write(
				root,
				"src/engine/agent.ts",
				`import type { Agent } from "@mariozechner/pi-agent-core";\nexport type X = Agent;\n`,
			);
		},
		expect(v) {
			return v.length === 0 ? null : `engine must be allowed pi-mono, got: ${v.join("; ")}`;
		},
	},
	{
		name: "cross-domain import via index.ts contract is allowed",
		build(root) {
			write(root, "src/domains/alpha/index.ts", "export type Contract = { id: string };\n");
			write(
				root,
				"src/domains/beta/extension.ts",
				`import type { Contract } from "../alpha/index.js";\nexport type X = Contract;\n`,
			);
		},
		expect(v) {
			return v.length === 0 ? null : `contract import must be allowed, got: ${v.join("; ")}`;
		},
	},
	{
		name: "comments do not trigger false positives",
		build(root) {
			write(
				root,
				"src/domains/alpha/extension.ts",
				`// import { bad } from "@mariozechner/pi-ai";\n/* import { alsoBad } from "@mariozechner/pi-agent-core"; */\nexport const x = 1;\n`,
			);
		},
		expect(v) {
			return v.length === 0 ? null : `comments should be stripped, got: ${v.join("; ")}`;
		},
	},
	{
		name: "template-literal dynamic imports are intentionally not caught",
		build(root) {
			write(root, "src/domains/alpha/extension.ts", "export const value = 1;\n");
			write(
				root,
				"src/domains/beta/extension.ts",
				'const name = "alpha";\nexport async function load() {\n  return import(`../${name}/extension.js`);\n}\n',
			);
		},
		expect(v) {
			return includesNone(v, ["rule3:"])
				? null
				: `template-literal dynamic import should not be caught (documented), got: ${v.join("; ")}`;
		},
	},
];

function runCase(c: FixtureCase): string | null {
	const root = mkdtempSync(path.join(tmpdir(), "clio-boundary-"));
	try {
		c.build(root);
		const { violations } = runBoundaryCheck(root);
		return c.expect(violations);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

let failed = 0;
for (const c of cases) {
	const err = runCase(c);
	if (err) {
		console.error(`FAIL ${c.name}: ${err}`);
		failed++;
	} else {
		console.log(`ok   ${c.name}`);
	}
}

if (failed > 0) {
	console.error(`\n${failed} of ${cases.length} boundary fixtures failed`);
	process.exit(1);
}

console.log(`\n${cases.length} boundary fixtures passed`);
