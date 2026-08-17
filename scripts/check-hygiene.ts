#!/usr/bin/env node
/**
 * Source and doc drift checks, run from `npm run lint`.
 *
 * Every check here used to be a `tests/contracts/*.test.ts` file that read
 * source text, docs, README, config, or workflow YAML off disk and asserted
 * on its structure. None of them exercised product code, so `node --test`
 * was the wrong host: it paid full per-file startup and coverage overhead
 * for a check that is really one process reading the tree once. This file
 * is that one process. Every assertion below has a comment naming the test
 * it replaced and the incident, where the original did, so the history isn't
 * lost in the move.
 */

import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../src/core/defaults.js";
import { resolvePackageRoot } from "../src/core/package-root.js";
import { OPTIONAL_RECIPE_KEYS, RECIPE_KEYS } from "../src/domains/agents/recipe-schema.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";
import { runBoundaryCheck } from "../tests/boundaries/check-boundaries.js";

const root = resolvePackageRoot(import.meta.url);
const errors: string[] = [];

function fail(rule: string, message: string): void {
	errors.push(`${rule}: ${message}`);
}

function readRoot(relPath: string): string {
	return readFileSync(join(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// export-hygiene: no export keyword on a function used by exactly the file
// that declares it. Was tests/contracts/export-hygiene.test.ts, 57.9s on its
// own, the single most expensive file in the suite.
// ---------------------------------------------------------------------------
/**
 * Every file under `dirs` whose extension is in `extensions`, read once. The
 * original check spent its 57.9s asking `grep -rlw` once per exported
 * symbol; reading each file's identifier tokens once and looking them up in
 * memory does the same word-boundary match without the process-per-symbol
 * cost.
 */
function collectFiles(dirs: string[], extensions: string[]): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
		}
	};
	for (const dir of dirs) walk(dir);
	return found;
}

const IDENTIFIER = /[A-Za-z0-9_]+/g;
const EXPORTED_FUNCTION = /^export (?:async )?function ([A-Za-z0-9_]+)/gm;

function checkExportHygiene(): void {
	const usageFiles = collectFiles([join(root, "src"), join(root, "tests"), join(root, "apps")], [".ts", ".mjs"]);
	const tokensByFile = usageFiles.map((file) => new Set(readFileSync(file, "utf8").match(IDENTIFIER) ?? []));

	const sweptAreas = ["src/entry", "src/cli", "src/core", "src/engine", "src/tools", "src/interactive", "src/domains"];
	for (const area of sweptAreas) {
		const areaFiles = collectFiles([join(root, area)], [".ts"]);
		const symbols = new Set<string>();
		for (const file of areaFiles) {
			for (const match of readFileSync(file, "utf8").matchAll(EXPORTED_FUNCTION)) symbols.add(match[1] as string);
		}
		const dead: string[] = [];
		for (const symbol of symbols) {
			let hits = 0;
			for (const tokens of tokensByFile) {
				if (tokens.has(symbol)) {
					hits++;
					if (hits > 1) break;
				}
			}
			if (hits === 1) dead.push(symbol);
		}
		if (dead.length > 0) fail("export-hygiene", `unnecessary export keyword in ${area}: ${dead.sort().join(", ")}`);
	}
}

// ---------------------------------------------------------------------------
// boundaries: the static import-boundary rules in tests/boundaries/check-boundaries.ts,
// checked against src/ and against synthetic fixtures that pin each rule's
// wording. Was tests/boundaries/boundaries.test.ts.
// ---------------------------------------------------------------------------
function fixtureProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-boundary-"));
	for (const [file, content] of Object.entries(files)) {
		const full = join(dir, file);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return dir;
}

function checkBoundaries(): void {
	const fixtureDirs: string[] = [];
	try {
		const real = runBoundaryCheck(root);
		if (real.violations.length > 0) fail("boundaries", `violations across src/:\n  ${real.violations.join("\n  ")}`);

		const cases: ReadonlyArray<{ name: string; files: Record<string, string>; expectRule: string | null }> = [
			{
				name: "non-engine pi-ai type import",
				files: {
					"src/domains/providers/types/runtime-descriptor.ts":
						'import type { Api, Model } from "@earendil-works/pi-ai";\nexport type RuntimeModel = Model<Api>;',
				},
				expectRule: "rule1",
			},
			{
				name: "tool reaching into interactive code",
				files: {
					"src/tools/read.ts":
						'import { createChatPanel } from "../interactive/chat-panel.js";\nexport const panel = createChatPanel;',
					"src/interactive/chat-panel.ts": "export function createChatPanel() {}",
				},
				expectRule: "rule4",
			},
			{
				name: "chat-loop turn module importing the entry point",
				files: {
					"src/interactive/turn-runtime.ts":
						'import { bootOrchestrator } from "../entry/orchestrator.js";\nexport const boot = bootOrchestrator;',
					"src/entry/orchestrator.ts": "export function bootOrchestrator() {}",
				},
				expectRule: "rule5",
			},
			{
				name: "non-turn interactive module importing entry wiring (allowed)",
				files: {
					"src/interactive/index.ts":
						'import type { BootOptions } from "../entry/orchestrator.js";\nexport type Opts = BootOptions;',
					"src/entry/orchestrator.ts": "export interface BootOptions { headless?: boolean }",
				},
				expectRule: null,
			},
			{
				name: "non-engine pi value import",
				files: {
					"src/domains/providers/registry.ts":
						'import { getModel } from "@earendil-works/pi-ai";\nexport const model = getModel;',
				},
				expectRule: "rule1",
			},
			{
				name: "worker-safe provider runtime rehydration imports (allowed)",
				files: {
					"src/worker/runtime-registry.ts": [
						'import { loadPluginRuntimes } from "../domains/providers/plugins.js";',
						'import { getRuntimeRegistry } from "../domains/providers/registry.js";',
						'import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";',
						'import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";',
					].join("\n"),
					"src/domains/providers/plugins.ts": "",
					"src/domains/providers/registry.ts": "",
					"src/domains/providers/runtimes/builtins.ts": "",
					"src/domains/providers/types/target-descriptor.ts": "",
				},
				expectRule: null,
			},
			{
				name: "worker value import from non-provider domain",
				files: {
					"src/worker/entry.ts": 'import { createConfigBundle } from "../domains/config/extension.js";',
					"src/domains/config/extension.ts": "export const createConfigBundle = {};",
				},
				expectRule: "rule2",
			},
			{
				name: "worker value import from non-runtime provider module",
				files: {
					"src/worker/entry.ts": 'import { createProvidersBundle } from "../domains/providers/extension.js";',
					"src/domains/providers/extension.ts": "export const createProvidersBundle = {};",
				},
				expectRule: "rule2",
			},
			{
				name: "mixed type/value import treated as a value import",
				files: {
					"src/worker/entry.ts": 'import { type ConfigContract, createConfigBundle } from "../domains/config/extension.js";',
					"src/domains/config/extension.ts": "export type ConfigContract = {};\nexport const createConfigBundle = {};",
				},
				expectRule: "rule2",
			},
		];

		for (const testCase of cases) {
			const dir = fixtureProject(testCase.files);
			fixtureDirs.push(dir);
			const result = runBoundaryCheck(dir);
			if (testCase.expectRule === null) {
				if (result.violations.length > 0) {
					fail("boundaries", `fixture "${testCase.name}" expected no violations, got:\n  ${result.violations.join("\n  ")}`);
				}
			} else if (!result.violations.some((v) => v.includes(testCase.expectRule as string))) {
				fail(
					"boundaries",
					`fixture "${testCase.name}" expected a ${testCase.expectRule} violation, got:\n  ${result.violations.join("\n  ")}`,
				);
			}
		}
	} finally {
		for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// ci-scripts: package.json scripts and the CI/release workflows held against
// what they must do. Was tests/contracts/ci-scripts.test.ts.
// ---------------------------------------------------------------------------
interface WorkflowStep {
	run?: string;
	uses?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
}
interface WorkflowJob {
	steps: WorkflowStep[];
	permissions?: Record<string, unknown>;
	strategy?: { matrix?: Record<string, unknown> };
}

function packageScripts(): Record<string, string> {
	return (JSON.parse(readRoot("package.json")) as { scripts: Record<string, string> }).scripts;
}

function workflow(relPath: string): Record<string, unknown> {
	return parseYaml(readRoot(relPath)) as Record<string, unknown>;
}

function workflowJob(relPath: string, jobId: string): WorkflowJob {
	const jobs = (workflow(relPath).jobs ?? {}) as Record<string, WorkflowJob>;
	const job = jobs[jobId];
	if (!job) throw new Error(`workflow ${relPath} has no job ${jobId}`);
	return job;
}

function runCommands(relPath: string, jobId: string): string[] {
	return workflowJob(relPath, jobId).steps.flatMap((step) => (step.run ? [step.run] : []));
}

function matrixValues(relPath: string, jobId: string, key: string): unknown[] {
	const value = workflowJob(relPath, jobId).strategy?.matrix?.[key];
	return Array.isArray(value) ? value : [];
}

function checkCiScripts(): void {
	// Both runtime identity fragments must be exact package resources the
	// release gate requires.
	const manifestFiles = (JSON.parse(readRoot("scripts/release-manifest.json")) as { requiredFiles: string[] })
		.requiredFiles;
	for (const fragment of [
		"src/domains/prompts/fragments/identity/clio.md",
		"src/domains/prompts/fragments/identity/clio-worker.md",
	]) {
		if (!manifestFiles.includes(fragment))
			fail("ci-scripts", `scripts/release-manifest.json requiredFiles must include ${fragment}`);
	}

	// The release gate's own recipe frontmatter allowlist must not drift from
	// the schema the parser defines (see incident note in the deleted test).
	const gate = readRoot("scripts/check-release.mjs");
	const listed = (name: string): string[] => {
		const match = gate.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
		if (!match) {
			fail("ci-scripts", `scripts/check-release.mjs must declare ${name}`);
			return [];
		}
		return [...(match[1] as string).matchAll(/"([^"]+)"/g)].map((entry) => entry[1] as string);
	};
	const requiredListed = listed("requiredRecipeKeys").sort();
	const requiredExpected = [...RECIPE_KEYS].sort();
	if (JSON.stringify(requiredListed) !== JSON.stringify(requiredExpected)) {
		fail(
			"ci-scripts",
			`scripts/check-release.mjs requiredRecipeKeys (${requiredListed}) must match RECIPE_KEYS (${requiredExpected})`,
		);
	}
	const optionalListed = listed("optionalRecipeKeys").sort();
	const optionalExpected = [...OPTIONAL_RECIPE_KEYS].sort();
	if (JSON.stringify(optionalListed) !== JSON.stringify(optionalExpected)) {
		fail(
			"ci-scripts",
			`scripts/check-release.mjs optionalRecipeKeys (${optionalListed}) must match OPTIONAL_RECIPE_KEYS (${optionalExpected})`,
		);
	}

	// The deterministic local ci script must stay aligned with the
	// release-relevant checks.
	const scripts = packageScripts();
	const expectScript = (name: string, expected: string) => {
		if (scripts[name] !== expected)
			fail("ci-scripts", `package.json scripts.${name} must be "${expected}", got "${scripts[name]}"`);
	};
	expectScript(
		"ci",
		"npm run typecheck && npm run lint && npm run skills:check && npm run build && npm run test && npm run test:trace-viewer",
	);
	expectScript("skills:check", "node --import tsx scripts/pin-skills.ts --check");
	expectScript("ci:release", "npm run ci && node scripts/check-release.mjs");
	expectScript("test:live", "node scripts/live-smoke.mjs");
	expectScript("test:repeat", "node tests/harness/repeat-tests.mjs");
	if (!scripts["test:coverage"]?.includes("--experimental-test-coverage"))
		fail("ci-scripts", "scripts.test:coverage must set --experimental-test-coverage");
	if (!scripts["test:coverage"]?.includes("--test-coverage-include='src/**/*.ts'"))
		fail("ci-scripts", "scripts.test:coverage must scope coverage to src/**/*.ts");
	expectScript("prepublishOnly", "npm run ci:release");

	// Hosted CI is one job. The node-version matrix applies to the same work
	// on both lanes: no step may single out a lane with `if:`, so neither lane
	// can pass while silently skipping half the gate.
	const ciCommands = runCommands(".github/workflows/ci.yml", "ci");
	const ciSteps = workflowJob(".github/workflows/ci.yml", "ci").steps;
	const setupNode = ciSteps.find((step) => step.uses === "actions/setup-node@v6");
	const nodeVersions = matrixValues(".github/workflows/ci.yml", "ci", "node-version");
	if (JSON.stringify(nodeVersions) !== JSON.stringify([22, 24]))
		fail("ci-scripts", `ci.yml matrix node-version must be [22, 24], got ${JSON.stringify(nodeVersions)}`);
	if (setupNode?.with?.["node-version"] !== "$" + "{{ matrix.node-version }}")
		fail("ci-scripts", "ci.yml setup-node must read node-version from the matrix");
	if (ciCommands.includes("npm run test:live"))
		fail("ci-scripts", "ordinary CI must not run live/model-dependent smoke tests");
	// A check runs on every node lane, because runtime behavior can differ
	// between versions and a check pinned to one lane leaves the other
	// unverified. A report describes the suite rather than a runtime, so
	// running it twice pays for the same numbers twice. The coverage summary
	// is the one report here, and it is named rather than pattern-matched so
	// that adding a second pinned step is a deliberate edit to this list.
	const REPORT_STEPS = new Set(["Tests with coverage summary"]);
	const gatedSteps = ciSteps.filter((step) => typeof step.if === "string" && !REPORT_STEPS.has(step.name ?? ""));
	if (gatedSteps.length > 0)
		fail(
			"ci-scripts",
			`no ci.yml check may gate on matrix.node-version: ${gatedSteps.map((step) => step.name ?? step.run).join(", ")}`,
		);
	const gateStep = ciSteps.find((step) => step.run === "npm run ci:release");
	if (!gateStep) fail("ci-scripts", "ci.yml must run the full release gate on every lane");
	const coverageStep = ciSteps.find((step) => step.run?.includes("npm run test:coverage"));
	if (!coverageStep) fail("ci-scripts", "ci.yml must run the coverage-instrumented suite");
	if (!coverageStep?.run?.includes("set -o pipefail"))
		fail("ci-scripts", "the coverage run must set -o pipefail so tee cannot mask a failing suite");
	const repeatStep = ciSteps.find((step) => step.run === "npm run test:repeat");
	if (!repeatStep) fail("ci-scripts", "ci.yml must run the shuffled repeat lane on every lane");
	if (ciCommands.includes("npm run test") || ciCommands.includes("npm run build"))
		fail("ci-scripts", "no ci.yml step may run the plain suite or build outside npm run ci:release");

	// Release triggers from version tags and refuses a tag that disagrees with
	// package.json.
	const release = workflow(".github/workflows/release.yml");
	const trigger = release.on as { push?: { tags?: unknown } };
	if (JSON.stringify(trigger.push?.tags) !== JSON.stringify(["v*"]))
		fail("ci-scripts", "release.yml must trigger on v* tags only");
	const releaseCommands = runCommands(".github/workflows/release.yml", "release");
	if (!releaseCommands.some((command) => command.includes("does not match tag"))) {
		fail("ci-scripts", "release.yml must refuse a tag that disagrees with package.json's version");
	}

	// npm publish is a manual maintainer step: no publish path anywhere in the
	// release workflow.
	const releaseJob = workflowJob(".github/workflows/release.yml", "release");
	const permissions = [
		...Object.keys((release.permissions ?? {}) as Record<string, unknown>),
		...Object.keys(releaseJob.permissions ?? {}),
	];
	for (const step of releaseJob.steps) {
		if ((step.run ?? "").includes("npm publish")) fail("ci-scripts", `no release step may publish: ${step.run}`);
		if ((step.uses ?? "").includes("npm publish")) fail("ci-scripts", `no release action may publish: ${step.uses}`);
		if ("registry-url" in (step.with ?? {}))
			fail("ci-scripts", `no release step may point setup-node at a registry: ${step.uses}`);
	}
	if (permissions.includes("id-token"))
		fail("ci-scripts", `release.yml must not request an OIDC token, has: ${permissions.join(", ")}`);

	// Live smoke stays local/operator-run, never in hosted CI or release.
	if (existsSync(join(root, ".github/workflows/live-smoke.yml")))
		fail("ci-scripts", "live smoke must stay local/operator-run, no .github/workflows/live-smoke.yml");
	if (ciCommands.some((command) => command.includes("test:live")))
		fail("ci-scripts", "ordinary CI must not run live smoke");
	if (releaseCommands.some((command) => command.includes("test:live")))
		fail("ci-scripts", "release CI must not run live smoke");
}

// ---------------------------------------------------------------------------
// skills-pin: skills/registry.yaml must match the catalog content hashes.
// be2b5ccb rewrote a skill's instructions and never repinned; `npm run
// skills:check` (`pin-skills.ts --check`) only ran inside the full `ci`
// chain, and `npm run lint` never called it, so nothing caught the drift
// until the full gate ran. This delegates to the same `--check` mode `lint`
// now runs, rather than reimplementing the hash comparison, so there is one
// definition of "stale".
// ---------------------------------------------------------------------------
async function checkSkillsPin(): Promise<void> {
	const result = await runProcess("node", ["--import", "tsx", "scripts/pin-skills.ts", "--check"], {});
	if (result.status !== 0) fail("skills-pin", result.output.trim());
}

// ---------------------------------------------------------------------------
// defaults-yaml: DEFAULT_SETTINGS_YAML must parse to exactly DEFAULT_SETTINGS.
// Was tests/contracts/defaults-yaml.test.ts.
// ---------------------------------------------------------------------------
function checkDefaultsYaml(): void {
	const parsed = parseYaml(DEFAULT_SETTINGS_YAML);
	if (!isDeepStrictEqual(parsed, DEFAULT_SETTINGS)) {
		fail("defaults-yaml", "DEFAULT_SETTINGS_YAML has drifted from DEFAULT_SETTINGS");
	}
}

// ---------------------------------------------------------------------------
// settings-inventory: docs/configuration-and-targets.md's settings table held
// against the schema it claims to describe. Was
// tests/contracts/settings-inventory.test.ts.
// ---------------------------------------------------------------------------
const OPAQUE_SETTINGS_PATHS = new Set([
	"targets",
	"runtimePlugins",
	"delegation.agents",
	"fleet.nodes",
	"scope",
	"keybindings",
]);

function leafPaths(value: unknown, prefix = ""): string[] {
	if (prefix.length > 0 && OPAQUE_SETTINGS_PATHS.has(prefix)) return [prefix];
	if (value === null || typeof value !== "object" || Array.isArray(value)) return prefix.length > 0 ? [prefix] : [];
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return prefix.length > 0 ? [prefix] : [];
	return entries.flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function settingsInventorySection(): string {
	const doc = readRoot("docs/configuration-and-targets.md");
	const start = doc.indexOf("## Settings inventory");
	if (start < 0) throw new Error("docs/configuration-and-targets.md has no ## Settings inventory section");
	const end = doc.indexOf("\n## ", start + 1);
	return doc.slice(start, end === -1 ? undefined : end);
}

function checkSettingsInventory(): void {
	const section = settingsInventorySection();

	const missing = leafPaths(DEFAULT_SETTINGS).filter((path) => !section.includes(`| \`${path}\` |`));
	if (missing.length > 0)
		fail("settings-inventory", `docs/configuration-and-targets.md has no inventory row for:\n  ${missing.join("\n  ")}`);

	// Spot-checked across the value shapes a row can carry, including the one
	// that had diverged from its policy fallback and the two that read as a
	// bare word rather than a literal.
	const expectations: ReadonlyArray<readonly [string, string]> = [
		["memory.intervention.timeoutMs", "`180000`"],
		["memory.intervention.everyNTools", "`10`"],
		["guardrails.turnToolCallBudget", "`60`"],
		["compaction.threshold", "`0.8`"],
		["compaction.auto", "`true`"],
		["budget.sessionCeilingUsd", "`5`"],
		["budget.concurrency", "`auto`"],
		["autonomy", "`auto-edit`"],
		["orchestrator.target", "`null`"],
		["terminal.outputVerbosity", "`default`"],
	];
	const rowFor = (path: string): string => section.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
	for (const [path, expected] of expectations) {
		const row = rowFor(path);
		if (row.length === 0) {
			fail("settings-inventory", `no inventory row for ${path}`);
			continue;
		}
		if (!row.includes(expected))
			fail("settings-inventory", `${path} should document its default as ${expected}, row reads: ${row}`);
	}

	// Scoped to the inventory section; the page carries other tables whose
	// first column is also a backticked lowercase word.
	const rows = section.split("\n").filter((line) => /^\| `[a-z]/.test(line));
	if (rows.length < 40)
		fail("settings-inventory", `expected the inventory to have at least 40 rows, found ${rows.length}`);
	const vague = rows.filter((row) => !/(immediately|next turn|next session|next dispatch|restart)/.test(row));
	if (vague.length > 0) fail("settings-inventory", `inventory rows with no effect timing:\n  ${vague.join("\n  ")}`);
}

// ---------------------------------------------------------------------------
// environment-variable-inventory: docs/environment-variables.md claims to
// list every CLIO_* variable src reads. Was
// tests/contracts/environment-variable-inventory.test.ts.
// ---------------------------------------------------------------------------
const DOCUMENTED_ENV_FAMILIES: ReadonlyArray<RegExp> = [
	/^CLIO_CODER_WORKER_FAUX(_[A-Z_]+)?$/, // documented as `CLIO_CODER_WORKER_FAUX` (+ suffixes)
	/^CLIO_CODER_HOOK_BUDGET_[A-Z_]+_MS$/, // documented as `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS`
];

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...sourceFiles(full));
			continue;
		}
		if (full.endsWith(".ts") || full.endsWith(".mts")) found.push(full);
	}
	return found;
}

function readEnvNames(): Map<string, string[]> {
	const byName = new Map<string, string[]>();
	const pattern =
		/(?:env(?:\.(CLIO_[A-Z0-9_]+|NO_COLOR)|\[["'](CLIO_[A-Z0-9_]+|NO_COLOR)["']\])|(?:const\s+[A-Z0-9_]+_ENV\s*=\s*["'](CLIO_[A-Z0-9_]+)["']))/g;
	for (const file of sourceFiles(join(root, "src"))) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(pattern)) {
			const name = match[1] ?? match[2] ?? match[3];
			if (name === undefined) continue;
			const relPath = file.slice(root.length);
			const sites = byName.get(name) ?? [];
			if (!sites.includes(relPath)) sites.push(relPath);
			byName.set(name, sites);
		}
	}
	return byName;
}

function checkEnvironmentVariableInventory(): void {
	const doc = readRoot("docs/environment-variables.md");
	const missing: string[] = [];
	for (const [name, sites] of readEnvNames()) {
		if (doc.includes(`\`${name}\``)) continue;
		if (DOCUMENTED_ENV_FAMILIES.some((family) => family.test(name))) continue;
		missing.push(`${name} (read at ${sites.join(", ")})`);
	}
	if (missing.length > 0) {
		fail(
			"environment-variable-inventory",
			`docs/environment-variables.md claims to list every variable src reads, and omits:\n  ${missing.join("\n  ")}`,
		);
	}

	// Both were read as on/off toggles because they sit beside seven that are.
	// Setting either to `1` writes a file called `1` in the working directory.
	if (!doc.includes("These two take a path, not `1`"))
		fail("environment-variable-inventory", "the path-not-toggle exception must be stated");
	if (!doc.includes("CLIO_CODER_RENDER_TRACE") || !doc.includes("CLIO_CODER_MEMORY_TRACE")) {
		fail(
			"environment-variable-inventory",
			"the path-not-toggle exception must name CLIO_CODER_RENDER_TRACE and CLIO_CODER_MEMORY_TRACE",
		);
	}

	const memoryTraceRow = doc.split("\n").find((line) => line.includes("`CLIO_CODER_MEMORY_TRACE`"));
	if (memoryTraceRow === undefined) fail("environment-variable-inventory", "CLIO_CODER_MEMORY_TRACE has no row");
	else if (!memoryTraceRow.includes("content-bearing")) {
		fail(
			"environment-variable-inventory",
			`the CLIO_CODER_MEMORY_TRACE row must state it carries conversation text: ${memoryTraceRow}`,
		);
	}
}

// ---------------------------------------------------------------------------
// theme-discipline: src/interactive outside theme/ carries no raw color
// escapes. Was tests/contracts/theme-discipline.test.ts.
// ---------------------------------------------------------------------------
function collectInteractiveSources(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "theme") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectInteractiveSources(full));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
	}
	return files;
}

const ESC = String.fromCharCode(27);
const SGR_ESCAPE = new RegExp(`(?:${ESC}|\\\\x1b|\\\\u001b)\\[[0-9;]*m`);
const SGR_COLOR_FRAGMENT = /38;2;|48;2;|38;5;|48;5;/;
const HEX_COLOR = /#[0-9a-fA-F]{6}\b/;

function checkThemeDiscipline(): void {
	const interactiveRoot = join(root, "src/interactive");
	const sources = collectInteractiveSources(interactiveRoot)
		.sort()
		.map((path) => ({ path: relative(interactiveRoot, path), text: readFileSync(path, "utf8") }));

	if (sources.length === 0) {
		fail("theme-discipline", "expected to find interactive source files to scan");
		return;
	}
	const sgrOffenders = sources.filter((file) => SGR_ESCAPE.test(file.text)).map((file) => file.path);
	if (sgrOffenders.length > 0)
		fail("theme-discipline", `raw SGR escape sequences found outside theme/ in: ${sgrOffenders.join(", ")}`);
	const fragmentOffenders = sources.filter((file) => SGR_COLOR_FRAGMENT.test(file.text)).map((file) => file.path);
	if (fragmentOffenders.length > 0)
		fail(
			"theme-discipline",
			`SGR color fragments (38;2;/48;2;/38;5;/48;5;) found outside theme/ in: ${fragmentOffenders.join(", ")}`,
		);
	const hexOffenders = sources.filter((file) => HEX_COLOR.test(file.text)).map((file) => file.path);
	if (hexOffenders.length > 0)
		fail("theme-discipline", `hex colors found outside theme/ in: ${hexOffenders.join(", ")}`);
}

// ---------------------------------------------------------------------------
// readme-install-block: the README's documented install steps stay in step
// with what scripts/install-local.sh actually prints and does. Was
// tests/contracts/readme-install-block.test.ts.
// ---------------------------------------------------------------------------
function installerBinDir(): string {
	const script = readRoot("scripts/install-local.sh");
	const binDir = script.match(/^bin_dir=.*\$\{CLIO_CODER_BIN_DIR:-(?<fallback>[^}]+)\}/mu)?.groups?.fallback;
	if (!binDir) throw new Error("scripts/install-local.sh no longer has a default bin dir");
	return binDir;
}

function installerExportLine(): string {
	const script = readRoot("scripts/install-local.sh");
	if (!/export PATH="%s:\$PATH"/.test(script))
		throw new Error("scripts/install-local.sh no longer prints an export PATH line");
	return `export PATH="${installerBinDir()}:$PATH"`;
}

function readmeBashBlockAfter(marker: string): string[] {
	const readme = readRoot("README.md").split(/\r?\n/);
	const heading = readme.indexOf("## Install");
	if (heading < 0) throw new Error("README.md has no ## Install section");
	const anchor = readme.findIndex((line, index) => index > heading && line.startsWith(marker));
	if (anchor <= heading)
		throw new Error(`the Install section no longer introduces its steps with ${JSON.stringify(marker)}`);
	const open = readme.indexOf("```bash", anchor);
	if (open <= anchor) throw new Error(`${JSON.stringify(marker)} does not open a shell block`);
	const close = readme.indexOf("```", open + 1);
	if (close <= open) throw new Error(`the shell block after ${JSON.stringify(marker)} is never closed`);
	return readme.slice(open + 1, close);
}

function readmeInstallBlock(): string[] {
	return readmeBashBlockAfter("From source");
}

function readmeNpmBlock(): string[] {
	const readme = readRoot("README.md").split(/\r?\n/);
	for (let open = readme.indexOf("```bash"); open >= 0; open = readme.indexOf("```bash", open + 1)) {
		const close = readme.indexOf("```", open + 1);
		if (close <= open) throw new Error("README.md has a shell block that is never closed");
		const block = readme.slice(open + 1, close);
		if (block.some((line) => line.startsWith("npm install -g"))) return block;
	}
	throw new Error("README.md has no shell block that runs npm install -g");
}

function runProcess(
	command: string,
	args: string[],
	env: Record<string, string>,
): Promise<{ status: number | null; output: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env } });
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("close", (status) => resolvePromise({ status, output }));
	});
}

async function checkReadmeInstallBlock(): Promise<void> {
	const pkg = JSON.parse(readRoot("package.json")) as { name: string; version: string };

	const npmInstall = readmeNpmBlock().find((line) => line.includes("npm install"));
	if (!npmInstall) fail("readme-install-block", "the npm block no longer installs the package");
	else if (!npmInstall.includes(pkg.name))
		fail("readme-install-block", `the npm block must install ${pkg.name}: ${npmInstall}`);

	const block = readmeInstallBlock();
	const expectedExport = installerExportLine();
	if (!block.includes(expectedExport)) {
		fail(
			"readme-install-block",
			`README install block is missing ${JSON.stringify(expectedExport)}: ${JSON.stringify(block)}`,
		);
	}

	const exportedAt = block.findIndex((line) => line.startsWith("export PATH="));
	const versionAt = block.findIndex((line) => line.includes("--version"));
	if (versionAt < 0) fail("readme-install-block", "the block no longer verifies the install");
	else if (!(exportedAt < versionAt))
		fail("readme-install-block", "the export has to come before the command that resolves through PATH");

	// The block cloned the default branch and never left it, so a stranger
	// following the README installed whatever was on main that day rather than
	// the release the rest of the page documents.
	const clone = block.find((line) => line.includes("git clone"));
	if (!clone) fail("readme-install-block", "the block no longer clones the repository");
	else if (!clone.includes(`--branch v${pkg.version}`)) {
		fail("readme-install-block", `the clone must pin v${pkg.version}, the version package.json declares: ${clone}`);
	}

	// A bare `clio-coder` resolves through PATH and can answer for an older
	// install earlier on it. The installer warns about exactly that shadowing;
	// the README's own verification step must not walk into it.
	const verify = block.find((line) => line.includes("--version"));
	if (!verify) fail("readme-install-block", "the block no longer verifies the install");
	else {
		if (!(verify.includes("/clio") && !/^clio-coder --version/u.test(verify.trim()))) {
			fail("readme-install-block", `verification must name the installed launcher by path: ${verify}`);
		}
		const binDir = installerBinDir();
		if (!verify.includes(binDir))
			fail("readme-install-block", `verification must be the path the installer links (${binDir}): ${verify}`);
	}

	// The README must ask which file the bare name reaches rather than compare
	// version output, which passes even when a stale clio-coder shadows the one
	// just installed.
	const readme = readRoot("README.md");
	const section = readme.slice(readme.indexOf("## Install"), readme.indexOf("To remove it"));
	if (!section.includes("command -v clio-coder"))
		fail("readme-install-block", "the README no longer asks which file the bare name reaches");
	if (/`clio-coder --version` and\s+`[^`]*\/clio" --version` agree/u.test(section)) {
		fail(
			"readme-install-block",
			"the README must not treat agreeing versions as proof the bare name resolves to this install",
		);
	}

	// The shadowing claim is a claim about a program: run it. A stub
	// `clio-coder` earlier on PATH, an install into a bin dir that is not, and
	// a dry run that changes nothing. The two dry runs are independent once
	// their fixtures exist, so they run concurrently rather than back to back;
	// each spawn of install-local.sh pays its own ~1s of real dependency and
	// version checks.
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-install-shadow-"));
	try {
		const shadowDir = join(scratch, "shadow");
		const binDir = join(scratch, "bin");
		mkdirSync(shadowDir);
		mkdirSync(binDir);
		const shadow = join(shadowDir, "clio-coder");
		writeFileSync(shadow, '#!/bin/sh\necho "clio-coder 0.0.0-other"\n');
		chmodSync(shadow, 0o755);

		// The same stub, reached through a link into the launcher this run is
		// about, is one installation and must not be reported as two.
		const linked = join(scratch, "linked");
		mkdirSync(linked);
		symlinkSync(resolve(join(root, "scripts/install-local.sh")), join(binDir, "clio-coder"));
		symlinkSync(join(binDir, "clio-coder"), join(linked, "clio-coder"));

		const dryRunArgs = ["scripts/install-local.sh", "--dry-run", "--skip-deps", "--no-build"];
		const [run, sameInstall] = await Promise.all([
			runProcess("bash", dryRunArgs, { PATH: `${shadowDir}:${process.env.PATH ?? ""}`, CLIO_CODER_BIN_DIR: binDir }),
			runProcess("bash", dryRunArgs, { PATH: `${linked}:${process.env.PATH ?? ""}`, CLIO_CODER_BIN_DIR: binDir }),
		]);

		if (run.status !== 0) fail("readme-install-block", `install-local.sh --dry-run should succeed: ${run.output}`);
		if (!run.output.includes(`another clio-coder is on your PATH at ${shadow}`))
			fail("readme-install-block", `installer must name the shadowing clio-coder: ${run.output}`);
		if (!run.output.includes(`check it with: ${shadow} --version`))
			fail("readme-install-block", `installer must say how to identify the shadowing clio-coder: ${run.output}`);

		if (sameInstall.output.includes("another clio-coder is on your PATH")) {
			fail(
				"readme-install-block",
				"a name that resolves through to this launcher must not be reported as a second installation",
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// packaging: the package.json `files` allowlist ships everything the release
// gate requires and everything src/ resolves from the installed package
// root. Was tests/contracts/packaging.test.ts.
// ---------------------------------------------------------------------------
interface ReleaseManifest {
	requiredFiles: string[];
	requiredPrefixes: string[];
}

function shippedBy(packageFiles: string[], path: string): boolean {
	for (const pattern of packageFiles) {
		if (pattern.startsWith("!")) continue;
		if (pattern === path) return true;
		if (pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -2))) return true;
		if (!pattern.includes("*") && path.startsWith(`${pattern}/`)) return true;
		const star = pattern.indexOf("*");
		if (star !== -1 && !pattern.includes("**")) {
			const [dir, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
			if (path.startsWith(dir) && path.endsWith(suffix) && !path.slice(dir.length).includes("/")) return true;
		}
	}
	return false;
}

function shipsUnder(packageFiles: string[], dir: string): boolean {
	if (shippedBy(packageFiles, `${dir}/probe`)) return true;
	return packageFiles.some((pattern) => !pattern.startsWith("!") && pattern.startsWith(`${dir}/`));
}

const NPM_IMPLICIT_FILES = new Set(["package.json"]);
const ROOT_ONLY_RESOLVERS = new Set([
	// Runs `git rev-parse HEAD` with the package root as cwd.
	"src/domains/eval/provenance.ts",
	// Hands the root to the component scanner, which walks whatever is present.
	"src/cli/components.ts",
]);
const PATH_JOINERS = new Set(["join", "resolve"]);

interface PackageRootUse {
	file: string;
	line: number;
	path: string | null;
}

function typescriptSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...typescriptSources(abs));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(abs);
	}
	return out;
}

function isPathJoiner(expression: ts.Expression): boolean {
	if (ts.isIdentifier(expression)) return PATH_JOINERS.has(expression.text);
	if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name))
		return PATH_JOINERS.has(expression.name.text);
	return false;
}

function isPackageRootCall(node: ts.Node): node is ts.CallExpression {
	return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "resolvePackageRoot";
}

function packageRootUses(absolute: string): { joined: PackageRootUse[]; rootOnly: boolean } {
	const text = readFileSync(absolute, "utf8");
	const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.ESNext, true);
	const file = relative(root, absolute).replaceAll("\\", "/");

	const stringConstants = new Map<string, string>();
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
				stringConstants.set(declaration.name.text, declaration.initializer.text);
			}
		}
	}

	const aliases = new Set<string>();
	const collectAliases = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			if (isPackageRootCall(node.initializer)) aliases.add(node.name.text);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			isPackageRootCall(node.right)
		) {
			aliases.add(node.left.text);
		}
		ts.forEachChild(node, collectAliases);
	};
	collectAliases(source);

	const isRootExpression = (expression: ts.Expression): boolean =>
		isPackageRootCall(expression) || (ts.isIdentifier(expression) && aliases.has(expression.text));

	const joined: PackageRootUse[] = [];
	let rootOnly = false;
	const collectUses = (node: ts.Node): void => {
		if (isPackageRootCall(node)) {
			const parent = node.parent;
			const joinedHere =
				(ts.isCallExpression(parent) && isPathJoiner(parent.expression) && parent.arguments[0] === node) ||
				ts.isVariableDeclaration(parent) ||
				ts.isBinaryExpression(parent);
			if (!joinedHere) rootOnly = true;
		}
		if (
			ts.isCallExpression(node) &&
			isPathJoiner(node.expression) &&
			node.arguments.length > 0 &&
			isRootExpression(node.arguments[0] as ts.Expression)
		) {
			const segments: string[] = [];
			for (const argument of node.arguments.slice(1)) {
				if (ts.isStringLiteral(argument)) segments.push(argument.text);
				else if (ts.isIdentifier(argument) && stringConstants.has(argument.text))
					segments.push(stringConstants.get(argument.text) as string);
				else break;
			}
			joined.push({
				file,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				path: segments.length > 0 ? segments.join("/").replaceAll(/\/+/g, "/") : null,
			});
		}
		ts.forEachChild(node, collectUses);
	};
	collectUses(source);
	return { joined, rootOnly };
}

function gitIgnored(paths: ReadonlyArray<string>): Set<string> {
	if (paths.length === 0) return new Set();
	try {
		const out = execFileSync("git", ["check-ignore", "--", ...paths], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new Set(out.split("\n").filter((line) => line.length > 0));
	} catch {
		// `git check-ignore` exits 1 when nothing matched, which is the clean case.
		return new Set();
	}
}

function checkPackaging(): void {
	const manifest = JSON.parse(readRoot("scripts/release-manifest.json")) as ReleaseManifest;
	const packageFiles = (JSON.parse(readRoot("package.json")) as { files: string[] }).files;

	const missingFiles = manifest.requiredFiles.filter((file) => !shippedBy(packageFiles, file));
	if (missingFiles.length > 0)
		fail("packaging", `release gate requires files the package.json allowlist does not ship: ${missingFiles.join(", ")}`);

	const missingPrefixes = manifest.requiredPrefixes.filter((prefix) => !shippedBy(packageFiles, `${prefix}probe`));
	if (missingPrefixes.length > 0)
		fail(
			"packaging",
			`release gate requires trees the package.json allowlist does not ship: ${missingPrefixes.join(", ")}`,
		);

	// A gitignored path is generated runtime state: npm packs from the working
	// tree, so shipping one publishes whatever the release machine happened to
	// generate, and requiring one fails the gate on a clean checkout.
	const candidates = [...new Set([...manifest.requiredFiles, ...packageFiles.filter((f) => !f.startsWith("!"))])];
	const ignored = gitIgnored(candidates.filter((path) => !path.includes("*")));
	const offenders = [...ignored].filter((path) => path !== "dist" && !path.startsWith("dist/"));
	if (offenders.length > 0) fail("packaging", `gitignored generated state on the publish path: ${offenders.join(", ")}`);

	const absent = manifest.requiredFiles
		.filter((file) => !file.startsWith("dist/"))
		.filter((file) => !existsSync(join(root, file)));
	if (absent.length > 0) fail("packaging", `release gate requires files absent from the checkout: ${absent.join(", ")}`);

	// `resolvePackageRoot()` returns the installed package root, so every path
	// built on it is a claim that the tarball carries that path. Read the
	// claims out of src/ so the allowlist is checked against what the code
	// actually reaches for, rather than a hand-kept list.
	const unshipped: string[] = [];
	const unclassified: string[] = [];
	for (const absolute of typescriptSources(join(root, "src"))) {
		const text = readFileSync(absolute, "utf8");
		if (!text.includes("resolvePackageRoot")) continue;
		const { joined, rootOnly } = packageRootUses(absolute);
		const file = relative(root, absolute).replaceAll("\\", "/");
		if (rootOnly && !ROOT_ONLY_RESOLVERS.has(file)) unclassified.push(file);
		for (const use of joined) {
			if (use.path === null) continue;
			if (NPM_IMPLICIT_FILES.has(use.path)) continue;
			const looksLikeFile = /\.[A-Za-z0-9]+$/.test(use.path);
			const shipped = looksLikeFile ? shippedBy(packageFiles, use.path) : shipsUnder(packageFiles, use.path);
			if (!shipped) unshipped.push(`${use.file}:${use.line} resolves ${use.path}`);
		}
	}
	if (unshipped.length > 0)
		fail(
			"packaging",
			`src/ resolves paths from the package root that the package.json allowlist does not ship: ${unshipped.join("; ")}`,
		);
	if (unclassified.length > 0) {
		fail(
			"packaging",
			`resolvePackageRoot() used as a bare directory outside ROOT_ONLY_RESOLVERS; resolve a literal path or record why the root itself is the resource: ${unclassified.join(", ")}`,
		);
	}

	// The scanner above is only as good as its reach.
	const scannedFiles = typescriptSources(join(root, "src")).filter((absolute) =>
		readFileSync(absolute, "utf8").includes("resolvePackageRoot("),
	);
	if (scannedFiles.length < 10)
		fail("packaging", `expected the package-root scanner to reach the known call sites, saw ${scannedFiles.length}`);
	const resolved = scannedFiles.flatMap((absolute) =>
		packageRootUses(absolute).joined.filter((use) => use.path !== null),
	);
	if (resolved.length < 10) fail("packaging", `expected literal package-root paths to resolve, saw ${resolved.length}`);

	if (!readRoot("scripts/check-release.mjs").includes("release-manifest.json")) {
		fail("packaging", "scripts/check-release.mjs must read the shared release-manifest.json rather than its own copy");
	}
}

// ---------------------------------------------------------------------------
// prompts: the one doc-existence assertion carried by
// tests/contracts/prompts.test.ts, which otherwise exercises real prompt
// compilation and stays a test.
// ---------------------------------------------------------------------------
function checkPromptsDocLinks(): void {
	const table = loadFragments();
	const selfAwareness = table.byId.get("identity.self-awareness");
	if (!selfAwareness) {
		fail("prompts", "identity.self-awareness must be registered");
		return;
	}
	const matches = [...selfAwareness.body.matchAll(/docs\/[a-zA-Z0-9_-]+\.md/g)].map((m) => m[0]);
	if (matches.length < 40)
		fail("prompts", `expected at least 40 doc links in identity.self-awareness, found ${matches.length}`);
	const pkg = JSON.parse(readRoot("package.json")) as { files: string[] };
	for (const docRel of matches) {
		if (!existsSync(join(root, docRel)))
			fail("prompts", `${docRel}, named in identity.self-awareness, must exist in the checkout`);
	}
	if (!pkg.files.includes("docs/*.md")) fail("prompts", "package.json files must include docs/*.md");
}

// ---------------------------------------------------------------------------

const checks: ReadonlyArray<[string, () => void | Promise<void>]> = [
	["export-hygiene", checkExportHygiene],
	["boundaries", checkBoundaries],
	["ci-scripts", checkCiScripts],
	["skills-pin", checkSkillsPin],
	["defaults-yaml", checkDefaultsYaml],
	["settings-inventory", checkSettingsInventory],
	["environment-variable-inventory", checkEnvironmentVariableInventory],
	["theme-discipline", checkThemeDiscipline],
	["readme-install-block", checkReadmeInstallBlock],
	["packaging", checkPackaging],
	["prompts", checkPromptsDocLinks],
];

const startedAt = performance.now();
for (const [name, check] of checks) {
	const t0 = performance.now();
	try {
		await check();
	} catch (error) {
		fail(name, error instanceof Error ? error.message : String(error));
	}
	if (process.env.CHECK_HYGIENE_PROFILE) console.error(`${name}: ${(performance.now() - t0).toFixed(0)}ms`);
}
const elapsedMs = performance.now() - startedAt;

if (errors.length > 0) {
	for (const error of errors) process.stderr.write(`check-hygiene: ${error}\n`);
	process.stderr.write(`check-hygiene: ${errors.length} drift condition(s) found\n`);
	process.exit(1);
}
process.stdout.write(`check-hygiene: ok (${checks.length} checks, ${elapsedMs.toFixed(0)}ms)\n`);
