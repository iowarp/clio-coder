import { deepStrictEqual, ok } from "node:assert/strict";
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
		"function checkDocsTable() {}\nasync function checkEnvRows() {}\nconst checks = [checkDocsTable, checkEnvRows];\n",
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
	const seams = collectEnforcementInventory(root).checkFiles.find((file) => file.path === "tests/boundaries/check-seams.ts");
	ok(seams?.failures[0]?.includes("STAGE0_SEAMS"), JSON.stringify(seams?.failures));
});

it("asks the bootstrap model to cover every coded failure the inventory lists", () => {
	ok(/every coded failure/i.test(BOOTSTRAP_PROMPT));
});
