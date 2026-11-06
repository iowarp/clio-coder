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

it("marks which scripts CI reaches, including those a CI-run program spawns, apart from available checks", () => {
	write(".github/workflows/ci.yml", "jobs:\n  check:\n    steps:\n      - run: node scripts/qualify.mjs\n");
	write(
		"scripts/qualify.mjs",
		[
			'for (const step of ["typecheck", "lint"]) spawn("pnpm", ["run", step]);',
			'if (!["release", "dev"].includes(mode)) throw new Error("bad mode");',
			"",
		].join("\n"),
	);
	write(
		"package.json",
		JSON.stringify({
			scripts: {
				typecheck: "tsc",
				lint: "biome check . && pnpm run docs:check",
				"docs:check": "node scripts/check-drift.mjs",
				"library:check": "node scripts/pin.mjs --check",
				release: "node scripts/release.mjs",
				dev: "tsx watch src/main.ts",
			},
		}),
	);
	const inventory = collectEnforcementInventory(root);
	deepStrictEqual(inventory.ciScripts, ["typecheck", "lint", "docs:check"]);
	ok("library:check" in inventory.scripts);
	strictEqual(inventory.ciUnresolved, undefined);
});

it("reaches a script only through an invocation that names it, however many programs deep", () => {
	write(".github/workflows/ci.yml", "jobs:\n  check:\n    steps:\n      - run: node scripts/ci.mjs\n");
	// A script name near an unrelated invocation is not run by it.
	write(
		"scripts/ci.mjs",
		[
			'const available = ["library:check"];',
			'spawn("pnpm", ["run", "typecheck"]);',
			'execFileSync(process.execPath, ["scripts/checks.mjs"]);',
			"",
		].join("\n"),
	);
	// The second program runs the first again; the walk visits each program once.
	write("scripts/checks.mjs", 'spawnSync("pnpm", ["run", "lint"]);\nspawnSync("node", ["scripts/ci.mjs"]);\n');
	write(
		"package.json",
		JSON.stringify({
			scripts: { typecheck: "tsc", lint: "biome check .", "library:check": "node scripts/pin.mjs --check" },
		}),
	);
	const inventory = collectEnforcementInventory(root);
	deepStrictEqual(inventory.ciScripts, ["typecheck", "lint"]);
	strictEqual(inventory.ciUnresolved, undefined);
});

it("marks the check files that run, and reads only the checks something live names", () => {
	write(".github/workflows/ci.yml", "jobs:\n  check:\n    steps:\n      - run: pnpm run lint\n");
	write(
		"package.json",
		JSON.stringify({
			scripts: {
				lint: "node scripts/check-hygiene.mjs",
				prepack: "node scripts/check-pack.mjs",
				"docs:check": "node scripts/check-drift.mjs",
			},
		}),
	);
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
	strictEqual(byPath["scripts/check-drift.mjs"]?.executed, undefined);
	const imports = byPath["tests/boundaries/check-imports.ts"];
	strictEqual(imports?.executed, true);
	deepStrictEqual(imports?.checks, ["checkEngineImports"]);
	deepStrictEqual(imports?.failures, ["rule1: the engine is imported outside src/engine"]);
	deepStrictEqual(inventory.executedScripts, ["lint", "prepack"]);
});

it("reports an invocation whose script it cannot read as unresolved, not as unreached", () => {
	write(
		".github/workflows/ci.yml",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the input under test.
		"jobs:\n  check:\n    steps:\n      - run: pnpm run ${{ matrix.task }}\n      - run: node scripts/ci.mjs\n",
	);
	write("scripts/ci.mjs", 'spawn("pnpm", ["run", process.env.TASK]);\n');
	write("package.json", JSON.stringify({ scripts: { lint: "biome check .", "library:check": "node scripts/pin.mjs" } }));
	const inventory = collectEnforcementInventory(root);
	strictEqual(inventory.ciScripts, undefined);
	deepStrictEqual(inventory.ciUnresolved, [
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the input under test.
		"CI: pnpm run ${{ matrix.task }}",
		'scripts/ci.mjs: spawn("pnpm", ["run", process.env.TASK])',
	]);
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
		enforcement: inventory,
	});
	ok(prompt.includes("process.env.TASK"), prompt);
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
