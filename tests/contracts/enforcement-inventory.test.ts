import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { BOOTSTRAP_PROMPT, buildBootstrapPrompt } from "../../src/domains/context/bootstrap-prompt.js";
import { serializeClioMd } from "../../src/domains/context/clio-md.js";
import { collectEnforcementInventory } from "../../src/domains/context/enforcement-inventory.js";

// Generated handbooks paraphrased the contributor guide and missed the rules
// that decided real tasks, because nothing pointed the bootstrap model at the
// checks that fail a change. A deterministic inventory of what CI runs and
// which custom checks exist gives it that list for any repository.
let root: string;
const write = (path: string, text: string): void => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clio-coder-enforcement-"));
	write(
		".github/workflows/ci.yml",
		[
			"jobs:",
			"  check:",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"      - run: pnpm run lint",
			"      - name: extra",
			"        run: |",
			"          node scripts/check-drift.mjs",
			"          pytest -q",
			"",
		].join("\n"),
	);
	write(
		"package.json",
		JSON.stringify({
			scripts: { lint: "biome check . && node scripts/check-drift.mjs", build: "tsup", dev: "tsx watch src/main.ts" },
		}),
	);
	write(
		"scripts/check-drift.mjs",
		"function checkDocsTable() {}\nasync function checkEnvRows() {}\nconst checks = [checkDocsTable, checkEnvRows];\nfor (const check of checks) await check();\n",
	);
	write(
		"tests/boundaries/check-imports.ts",
		[
			"export function runImportCheck(file: string) {",
			`\treturn [\`rule1: ${"$"}{file} imports the engine outside src/engine\`, \`rule2: ${"$"}{file} reaches a seam\`];`,
			"}",
			"",
		].join("\n"),
	);
	write("scripts/gate.sh", "#!/bin/sh\nruff check src\nmypy src\n");
	write("src/main.ts", "export const main = 1;\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("lists the commands CI runs, the scripts they call, and custom check files with their checks", () => {
	const inventory = collectEnforcementInventory(root);
	for (const command of ["pnpm run lint", "node scripts/check-drift.mjs", "pytest -q"]) {
		ok(inventory.ciCommands.includes(command), `${command} missing from ${JSON.stringify(inventory.ciCommands)}`);
	}
	deepStrictEqual(inventory.scripts, { lint: "biome check . && node scripts/check-drift.mjs" });
	const byPath = Object.fromEntries(inventory.checkFiles.map((file) => [file.path, file.checks]));
	deepStrictEqual(byPath["scripts/check-drift.mjs"], ["checkDocsTable", "checkEnvRows"]);
	const imports = inventory.checkFiles.find((file) => file.path === "tests/boundaries/check-imports.ts");
	deepStrictEqual(imports?.failures, ["rule1: … imports the engine outside src/engine", "rule2: … reaches a seam"]);
	ok("scripts/gate.sh" in byPath);
	ok(!("src/main.ts" in byPath));
});

it("claims CI reach only for scripts a CI run step invokes by literal name at command position", () => {
	write(
		".github/workflows/ci.yml",
		[
			"jobs:",
			"  check:",
			"    steps:",
			"      - run: CI=1 pnpm -s run lint && npm test",
			"      - run: node scripts/qualify.mjs",
			"      - run: echo pnpm run library:check",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the input under test.
			"      - run: pnpm run ${{ matrix.task }}",
			'      - run: pnpm run "$TASK" # pnpm run release',
			"      - run: pnpm run app:check",
			"",
		].join("\n"),
	);
	// Another working directory has its own package.json.
	write(
		".github/workflows/app.yml",
		"defaults:\n  run:\n    working-directory: app\njobs:\n  app:\n    steps:\n      - run: pnpm run dev\n",
	);
	// A program CI starts is not read: this argv only looks like a process start.
	write("scripts/qualify.mjs", 'console.log("pnpm", ["run", "typecheck"]);\nspawn("pnpm", ["run", "dev"]);\n');
	write(
		"package.json",
		JSON.stringify({
			scripts: {
				typecheck: "tsc",
				test: "node --test",
				lint: "biome check . && pnpm run docs:check",
				"docs:check": "node scripts/check-drift.mjs",
				"library:check": "node scripts/pin.mjs --check",
				release: "node scripts/release.mjs",
				dev: "tsx watch src/main.ts",
				"app:check": "cd app && pnpm run release",
			},
		}),
	);
	const inventory = collectEnforcementInventory(root);
	deepStrictEqual(inventory.ciScripts, ["test", "lint", "docs:check", "app:check"]);
	ok(inventory.ciCommands.includes("pnpm run dev"));
	ok("library:check" in inventory.scripts);
});

it("never counts a git hook's commands as CI", () => {
	write(".github/workflows/ci.yml", "jobs:\n  check:\n    steps:\n      - run: echo ok\n");
	write("lefthook.yml", "pre-commit:\n  commands:\n    pin:\n      run: pnpm run library:check\n");
	write(".husky/pre-push", "pnpm run lint\n");
	write(
		"package.json",
		JSON.stringify({ scripts: { lint: "biome check .", "library:check": "node scripts/pin.mjs --check" } }),
	);
	const inventory = collectEnforcementInventory(root);
	strictEqual(inventory.ciScripts, undefined);
	deepStrictEqual(inventory.ciCommands, ["echo ok"]);
	deepStrictEqual(inventory.executedScripts, ["lint", "library:check"]);
});

it("marks the check files that run, and reads only the checks something live names", () => {
	write(".github/workflows/ci.yml", "jobs:\n  check:\n    steps:\n      - run: pnpm run lint\n");
	write(
		"package.json",
		JSON.stringify({
			scripts: {
				lint: "node scripts/check-hygiene.mjs",
				prepack: "node scripts/check-pack.mjs",
				"docs:check": "node --import ./scripts/check-env.mjs scripts/check-docs.mjs",
			},
		}),
	);
	write("scripts/check-env.mjs", "process.env.CHECK = '1';\n");
	write("scripts/check-docs.mjs", 'fail("docs-table", "every setting has a documented row");\n');
	write(
		"scripts/check-hygiene.mjs",
		'import { runBoundaryCheck } from "../tests/boundaries/check-imports.js";\nrunBoundaryCheck();\n',
	);
	// The seam check is still defined, but nothing calls it any more.
	write(
		"tests/boundaries/check-imports.ts",
		[
			"export function runBoundaryCheck(): string[] {",
			"\treturn [...checkEngineImports()];",
			"}",
			"function checkEngineImports(): string[] {",
			'\treturn ["rule1: the engine is imported outside src/engine"];',
			"}",
			"function checkSeams(): string[] {",
			'\treturn ["rule2: a seam is reached without a declaration"];',
			"}",
			"",
		].join("\n"),
	);
	write("scripts/check-pack.mjs", 'fail("pack-files", "the tarball holds only dist and docs");\n');
	const inventory = collectEnforcementInventory(root);
	const byPath = Object.fromEntries(inventory.checkFiles.map((file) => [file.path, file]));
	strictEqual(byPath["scripts/check-hygiene.mjs"]?.executed, true);
	strictEqual(byPath["scripts/check-pack.mjs"]?.executed, true);
	// A script a contributor runs by name runs its program and preload; nothing runs check-drift.
	strictEqual(byPath["scripts/check-docs.mjs"]?.executed, true);
	strictEqual(byPath["scripts/check-env.mjs"]?.executed, true);
	strictEqual(byPath["scripts/check-drift.mjs"]?.executed, undefined);
	const imports = byPath["tests/boundaries/check-imports.ts"];
	strictEqual(imports?.executed, true);
	deepStrictEqual(imports?.checks, ["checkEngineImports"]);
	deepStrictEqual(imports?.failures, ["rule1: the engine is imported outside src/engine"]);
	deepStrictEqual(inventory.executedScripts, ["lint", "prepack"]);
});

it("counts an export, a registry or an import as running only when live code uses it", () => {
	write(".github/workflows/ci.yml", "jobs:\n  check:\n    steps:\n      - run: pnpm run lint\n");
	write(
		"package.json",
		JSON.stringify({ scripts: { lint: "node scripts/check-hygiene.mjs && node scripts/check-pack.mjs" } }),
	);
	write(
		"scripts/check-hygiene.mjs",
		[
			'import { runBoundaryCheck, checkDormant, checkSeams } from "../tests/boundaries/check-imports.js";',
			'import type { Shape } from "../tests/boundaries/check-shapes.js";',
			'import { type Rule } from "../tests/boundaries/check-rules.js";',
			"function legacy() {",
			"\tcheckSeams();",
			"}",
			"function checkUsed() {",
			'\tfail("used-check", "the registry a loop reads runs this check");',
			"}",
			"function checkDropped() {",
			'\tfail("dropped-check", "a registry nothing reads lists this check");',
			"}",
			"function checkNow() {",
			'\tfail("now-check", "a binding computed from a call runs it at once");',
			"}",
			"const checks = [checkUsed];",
			"const available = [checkDropped];",
			"const report = checkNow();",
			"for (const check of checks) check();",
			"runBoundaryCheck();",
			"",
		].join("\n"),
	);
	// This file names checkDormant but does not import the checker, so it does not make the export live.
	write("scripts/check-pack.mjs", "function checkDormant() {}\ncheckDormant();\n");
	write(
		"tests/boundaries/check-imports.ts",
		[
			'export function runBoundaryCheck() { fail("rule1", "the engine is imported outside src/engine"); }',
			'export function checkDormant() { fail("rule2", "a seam is reached without a declaration"); }',
			'export function checkSeams() { fail("rule3", "a seam leads back into stage zero"); }',
			"",
		].join("\n"),
	);
	write(
		"tests/boundaries/check-shapes.ts",
		'export type Shape = string;\nfail("rule4", "shapes erase at compile time");\n',
	);
	write(
		"tests/boundaries/check-rules.ts",
		'export type Rule = string;\nfail("rule5", "rules erase at compile time");\n',
	);
	const byPath = Object.fromEntries(collectEnforcementInventory(root).checkFiles.map((file) => [file.path, file]));
	deepStrictEqual(byPath["scripts/check-hygiene.mjs"]?.failures, [
		"used-check: the registry a loop reads runs this check",
		"now-check: a binding computed from a call runs it at once",
	]);
	deepStrictEqual(byPath["tests/boundaries/check-imports.ts"]?.failures, [
		"rule1: the engine is imported outside src/engine",
	]);
	strictEqual(byPath["tests/boundaries/check-shapes.ts"]?.executed, undefined);
	strictEqual(byPath["tests/boundaries/check-rules.ts"]?.executed, undefined);
});

it("hands the inventory to the bootstrap model", () => {
	const prompt = buildBootstrapPrompt({
		cwd: root,
		projectType: "javascript",
		siblingFiles: [],
		adoption: {
			cwd: root,
			homeDir: root,
			includeGlobal: false,
			sources: [],
			rejected: [],
			importedRules: [],
			conflicts: [],
			sourceHash: "fixture",
			sourceSnapshots: [],
		},
		enforcement: collectEnforcementInventory(root),
	});
	ok(prompt.includes("checkDocsTable"));
	ok(prompt.includes("scripts/check-drift.mjs"));
});

it("renders hard invariants before conventions, because small models keep early rules best", () => {
	const text = serializeClioMd({
		projectName: "Fixture",
		identity: "A fixture.",
		conventions: ["Use `src/main.ts`."],
		invariants: ["Never edit `dist/`."],
	});
	ok(text.indexOf("## Hard invariants") < text.indexOf("## Conventions"), text);
});

it("keeps a coded failure's remedy, which long messages state after the violation", () => {
	const remedy = "only through a seam declared in STAGE0_SEAMS";
	write(
		"tests/boundaries/check-seams.ts",
		`export function checkSeams(file: string) {\n\treturn [\`rule6: ${"$"}{file} value-imports a module that resolves into the protected render trees of the instant shell; importers outside the Stage 0 closure may enter those trees ${remedy} (tests/boundaries/check-seams.ts).\`];\n}\n`,
	);
	const seams = collectEnforcementInventory(root).checkFiles.find(
		(file) => file.path === "tests/boundaries/check-seams.ts",
	);
	ok(seams?.failures[0]?.includes("STAGE0_SEAMS"), JSON.stringify(seams?.failures));
});

it("asks the bootstrap model to cover every coded failure the inventory lists", () => {
	ok(/every coded failure/i.test(BOOTSTRAP_PROMPT));
});
