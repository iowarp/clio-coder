import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it, mock } from "node:test";
import { modelBootstrapGenerate } from "../../src/cli/bootstrap-generate.js";
import { runInitCommand } from "../../src/cli/init.js";
import { type BootstrapRunTelemetry, runBootstrap } from "../../src/domains/context/bootstrap.js";
import { HANDBOOK_TARGETS, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { fitGeneratedHandbook } from "../../src/domains/context/handbook-budget.js";
import {
	compileHandbook,
	selectWorkerHandbook,
	workerHandbookAudience,
} from "../../src/domains/context/handbook-units.js";
import { readClioState } from "../../src/domains/context/state.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// A frontier bootstrap run returned 26 grounded rule lines for this repository
// and kept 3. The citation corpus held only indexed code paths and symbol names,
// each cut at a fixed length, so a rule citing `CONTRIBUTING.md`, a CI job name,
// a directory glob, or a symbol past the cut was deleted as if invented.
let isolated: IsolatedClioEnv;
let cwd: string;

beforeEach(async () => {
	isolated = await isolateClioEnv("clio-coder-bootstrap-grounding-");
	cwd = join(isolated.dir, "repo");
	mkdirSync(join(cwd, "src", "widgets"), { recursive: true });
	mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({ name: "harbor", type: "module", scripts: { check: "node scripts/check.js", test: "node --test" } }),
	);
	writeFileSync(join(cwd, "CONTRIBUTING.md"), "Run the drift checks before review.\n");
	writeFileSync(join(cwd, ".github", "workflows", "ci.yml"), "jobs:\n  build:\n    name: ci (22)\n");
	writeFileSync(
		join(cwd, "src", "widgets", "render.ts"),
		"export function renderWidget(): string {\n\treturn 'w';\n}\n",
	);
	writeFileSync(join(cwd, "src", "index.ts"), "export { renderWidget } from './widgets/render.js';\n");
});

afterEach(() => isolated.restore());

/** The Docs and prose rules of a generated handbook, without the section's `paths=none` override line. */
function docsRules(handbook: string): string {
	const body = handbook.split("## Docs and prose")[1]?.split("\n## ")[0]?.trim() ?? "";
	return body.replace(/^<!-- clio: paths=none -->\n/, "");
}

it("keeps model rules that cite real files, strings, globs and symbols, and drops invented ones", async () => {
	mkdirSync(join(cwd, "docs", "guide"), { recursive: true });
	writeFileSync(join(cwd, "docs", "index.md"), "# Docs\n");
	writeFileSync(join(cwd, "docs", "guide", "setup.md"), "# Setup\n");
	const result = await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [
					"Keep the `ci (22)` job name; branch protection keys on it.",
					"Never ship `src/missing-module.ts`; it holds credentials.",
					"Pin every action in `.github/workflows/ci.yml` to a commit.",
				],
				conventions: [
					"Follow `CONTRIBUTING.md` before review.",
					"Code under `src/widgets/**` renders through `renderWidget()`.",
					"Every relative link in `docs/*.md` must resolve.",
					"Every relative link in `docs/**/*.md` must resolve.",
					"Each `src/widgets/*.ts` module exports one renderer.",
				],
				sections: [
					{
						title: "Change recipes",
						body: [
							"- A new widget needs an export from `src/index.ts` and a check with `npm run check`.",
							"  - The export lives in `src/index.ts` beside `renderWidget()`.",
							"- Release with `npm run deploy` after tagging.",
						].join("\n"),
					},
				],
			};
		},
	});
	ok(result);
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes("`ci (22)`"), handbook);
	ok(handbook.includes("`CONTRIBUTING.md`"), handbook);
	ok(handbook.includes("`src/widgets/**`"), handbook);
	ok(handbook.includes("`src/index.ts`"), handbook);
	ok(handbook.includes("\n  - The export lives in `src/index.ts`"), handbook);
	strictEqual(handbook.includes("src/missing-module.ts"), false, handbook);
	strictEqual(handbook.includes("npm run deploy"), false, handbook);
	strictEqual(handbook.includes(".github/workflows"), false, handbook);
	ok(handbook.includes("- Every relative link in `docs/**/*.md` must resolve.\n"), handbook);
	ok(handbook.includes("- Each `src/widgets/*.ts` module exports one renderer.\n"), handbook);
	strictEqual(handbook.includes("`docs/*.md`"), false, handbook);
});

it("keeps a reviewer requirement its cited policy states, marks one its file does not state, and cuts workflow citations", async () => {
	writeFileSync(
		join(cwd, ".github", "workflows", "release.yml"),
		"jobs:\n  publish:\n    environment: release\n    steps:\n      - name: Present the approval receipt\n",
	);
	writeFileSync(join(cwd, "CONTRIBUTING.md"), "The `release` environment needs the owner as required reviewer.\n");
	mkdirSync(join(cwd, "docs"));
	writeFileSync(join(cwd, "docs", "release.md"), "Tag from main, then publish.\n");
	const carried = "Never push a release tag by hand: `CONTRIBUTING.md` documents the release.";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			`1. ${carried} The publish job lives in \`.github/workflows/release.yml\`.`,
			"",
		].join("\n"),
	);
	const approval =
		"- The publish job needs the protected `release` environment with owner approval (`CONTRIBUTING.md`, `.github/workflows/release.yml`).";
	writeFileSync(
		join(cwd, ".github", "branch-protection.json"),
		JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 } }),
	);
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [],
				conventions: [],
				sections: [
					{
						title: "Git and release",
						body: [
							"- The `release` environment in `.github/workflows/release.yml` requires the owner as reviewer. Keep the `ci (22)` job name in `.github/workflows/ci.yml`.",
							"- `.github/branch-protection.json` requires a reviewer before merging.",
							"- Follow `CONTRIBUTING.md` before review.",
							"- `docs/release.md` requires the owner as reviewer before publishing. Tag from `main` first.",
							approval,
							"- Owner approval of the `release` environment gates the publish job in `.github/workflows/release.yml`.",
						].join("\n"),
					},
				],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes(`1. ${carried}\n`), handbook);
	ok(handbook.includes("- `.github/branch-protection.json` requires a reviewer before merging.\n"), handbook);
	ok(handbook.includes("- Follow `CONTRIBUTING.md` before review."), handbook);
	ok(
		handbook.includes(
			"- `docs/release.md` requires the owner as reviewer before publishing (unverified: `docs/release.md` states no review policy). Tag from `main` first.\n",
		),
		handbook,
	);
	ok(
		handbook.includes(
			"- The publish job needs the protected `release` environment with owner approval (`CONTRIBUTING.md`).\n",
		),
		handbook,
	);
	strictEqual(handbook.includes(".github/workflows"), false, handbook);
});

it("cuts every sentence of a model line that names CI, and only the CI clauses of a carried invariant", async () => {
	const carried =
		"Never commit a path `.gitignore` excludes: the tracked-ignored check in `scripts/check.js` fails CI. Run `npm run check` before pushing.";
	mkdirSync(join(cwd, "scripts"));
	writeFileSync(join(cwd, ".gitignore"), "dist/\n");
	writeFileSync(join(cwd, "scripts", "check.js"), 'fail("tracked-ignored", "a tracked path is gitignored");\n');
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		["# harbor", "", "A widget renderer.", "", "## Hard invariants", "", `1. ${carried}`, ""].join("\n"),
	);
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [
					carried,
					"Export every widget from `src/index.ts`; `npm run check` is enforced in CI.",
					"CI enforces `scripts/check.js` on every push.",
					"CI will reject a change that breaks `scripts/check.js`.",
					"Keep `src/index.ts` exporting `renderWidget()`. `npm run check` is gated by continuous integration.",
				],
				conventions: [],
				sections: [
					{
						title: "Change recipes",
						body: "- Editing `src/widgets/render.ts`: rerun `npm run check`. It fails on CI on drift.",
					},
				],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes("1. Never commit a path `.gitignore` excludes. Run `npm run check` before pushing.\n"), handbook);
	strictEqual(handbook.split("Run `npm run check` before pushing.").length, 2, handbook);
	ok(handbook.includes("2. Keep `src/index.ts` exporting `renderWidget()`.\n"), handbook);
	ok(handbook.includes("- Editing `src/widgets/render.ts`: rerun `npm run check`.\n"), handbook);
	const generated = handbook.split("## Verification")[0] ?? "";
	strictEqual(/\bCI\b|continuous integration/i.test(generated), false, handbook);
	strictEqual(/scripts\/check\.js` on every push|breaks `scripts\/check\.js`/.test(handbook), false, handbook);
});

// A rewrite kept the model's "Keep X." beside the carried "Keep X: Y." as a second invariant.
it("drops a model rule that repeats a carried rule's leading clause", async () => {
	// Under 40 characters, so the final fit's clause test does not apply and only the carried keys catch it.
	const carried = "Keep `renderWidget()` exported: `src/widgets/render.ts` defines it.";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		["# harbor", "", "A widget renderer.", "", "## Hard invariants", "", `1. ${carried}`, ""].join("\n"),
	);
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: ["Keep `renderWidget()` exported."],
				conventions: [],
				sections: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const hard = handbook.split("## Hard invariants")[1]?.split("\n## ")[0] ?? "";
	deepStrictEqual(
		[...hard.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]),
		[carried],
		handbook,
	);
});

it("drops a model rule that a protected rule states as the clause before its colon", () => {
	const rule = "Keep `src/index.ts` exporting `renderWidget()` for every release";
	const fitted = fitGeneratedHandbook(
		{
			projectName: "harbor",
			identity: "A widget renderer.",
			invariants: [`${rule}: \`src/widgets/render.ts\` defines it.`, `${rule}.`],
			conventions: [],
			sections: [],
		},
		{ invariants: [`${rule}: \`src/widgets/render.ts\` defines it.`], sections: [] },
	);
	deepStrictEqual(fitted.invariants, [`${rule}: \`src/widgets/render.ts\` defines it.`]);
});

it("marks a module a rule calls preloaded when no plain node script preloads it", async () => {
	mkdirSync(join(cwd, "tests", "harness"), { recursive: true });
	mkdirSync(join(cwd, "scripts"));
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({
			name: "harbor",
			type: "module",
			scripts: {
				"test:file": "node --import tsx --import ./tests/harness/tmp-root.ts --test",
				test: "node scripts/run-tests.mjs",
				echo: "echo node --import ./tests/harness/echoed.ts",
				after: "node scripts/run-tests.mjs --import ./tests/harness/after.ts",
				"test:web": "cd apps/web && node --import ./tests/harness/no-network.ts --test",
				syntax: "node --check --import ./tests/harness/checked.ts scripts/run-tests.mjs",
				unknown: "node --clio-review-unknown-flag --import ./tests/harness/unknown.ts --test",
				invalid: "node --disable-proto=invalid --import ./tests/harness/invalid.ts --test",
				serial: "node --test-concurrency=0 --import ./tests/harness/serial.ts --test",
				"test:pool": "node --test-concurrency=2 --import ./tests/harness/pooled.ts --test",
			},
		}),
	);
	writeFileSync(join(cwd, "tests", "harness", "tmp-root.ts"), "export const root = process.env.TMPDIR;\n");
	writeFileSync(join(cwd, "tests", "harness", "scratch-env.ts"), "export function isolateEnv(): void {}\n");
	for (const name of ["echoed", "after", "no-network", "checked", "unknown", "invalid", "serial", "pooled"])
		writeFileSync(join(cwd, "tests", "harness", `${name}.ts`), `export const ${name.replace("-", "")} = true;\n`);
	const spawn = '["--import", "./tests/harness/tmp-root.ts", "--test"]';
	writeFileSync(join(cwd, "scripts", "run-tests.mjs"), `spawn(process.execPath, ${spawn});\n`);
	writeFileSync(join(cwd, "scripts", "spawn-tests.mjs"), `spawn(process.execPath, ${spawn});\n`);
	mkdirSync(join(cwd, "apps", "web", "tests", "harness"), { recursive: true });
	writeFileSync(
		join(cwd, "apps", "web", "package.json"),
		JSON.stringify({ name: "web", scripts: { test: "node --import ./tests/harness/no-network.ts --test" } }),
	);
	writeFileSync(join(cwd, "apps", "web", "tests", "harness", "no-network.ts"), "export const offline = true;\n");
	const workspace = "Web app tests preload `apps/web/tests/harness/no-network.ts` to block the network.";
	const claim =
		"The `test:file` script in `package.json` preloads `tests/harness/tmp-root.ts` and `tests/harness/scratch-env.ts` for isolation.";
	const launcher = "`scripts/run-tests.mjs` preloads `tests/harness/tmp-root.ts` for every test file.";
	const pooled = "Pooled suites preload `tests/harness/pooled.ts`.";
	// Each names text a script carries but no plain node command preloads or runs.
	const uncertain = {
		"tests/harness/echoed.ts": "Logging is set up by preloading `tests/harness/echoed.ts`.",
		"tests/harness/after.ts": "Timing hooks come from the preloaded `tests/harness/after.ts`.",
		"tests/harness/no-network.ts": "Root suites run offline because `tests/harness/no-network.ts` is preloaded.",
		"tests/harness/checked.ts": "Syntax checks preload `tests/harness/checked.ts`.",
		"scripts/spawn-tests.mjs": "`scripts/spawn-tests.mjs` preloads `tests/harness/tmp-root.ts` into every spawned suite.",
		"tests/harness/unknown.ts": "Review hooks preload `tests/harness/unknown.ts`.",
		"tests/harness/invalid.ts": "Prototype guards preload `tests/harness/invalid.ts`.",
		"tests/harness/serial.ts": "Serial suites preload `tests/harness/serial.ts`.",
	};
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [claim, ...Object.values(uncertain)],
				conventions: [launcher, workspace, pooled],
				sections: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	// No script names `scratch-env.ts`, so the claim is refuted outright and dropped rather than marked.
	ok(!handbook.includes("tests/harness/scratch-env.ts"), handbook);
	ok(handbook.includes(launcher), handbook);
	ok(handbook.includes(`${workspace}\n`), handbook);
	ok(handbook.includes(`${pooled}\n`), handbook);
	for (const [path, rule] of Object.entries(uncertain))
		ok(
			handbook.includes(`${rule.slice(0, -1)} (unverified: \`${path}\` is not preloaded by a package script).`),
			handbook,
		);
});

it("lists a checker rule a kept rule shares citations with but does not state", async () => {
	mkdirSync(join(cwd, "tests", "boundaries"), { recursive: true });
	writeFileSync(
		join(cwd, "tests", "boundaries", "check-totals.ts"),
		[
			"/**",
			" * 1. src/widgets/** sums no token or cost field, except the functions TOTAL_EXEMPTIONS names.",
			" */",
			"export const TOTAL_EXEMPTIONS: string[] = [];",
			"export function runTotalsCheck(): string[] {",
			'\treturn ["rule1: a widget sums a token field"];',
			"}",
			"",
		].join("\n"),
	);
	const gotcha =
		"- `TOTAL_EXEMPTIONS` in `tests/boundaries/check-totals.ts` only shrinks: remove a stale exemption rather than add one.";
	await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [],
				conventions: [],
				sections: [{ title: "Gotchas", body: gotcha }],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes(`${gotcha}\n`), handbook);
	ok(
		/sums no token or cost field, except .+ Checked as `rule1` by `tests\/boundaries\/check-totals\.ts`\./.test(handbook),
		handbook,
	);
});

it("carries every previous hard invariant, less its CI clauses, while its citations still exist", async () => {
	mkdirSync(join(cwd, "scripts"));
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({
			name: "harbor",
			type: "module",
			scripts: {
				check: "node scripts/check.js",
				prepublishOnly: "node -e \"throw new Error('publish from the release job')\"",
			},
		}),
	);
	writeFileSync(join(cwd, "scripts", "check.js"), 'fail("case-portable-paths", "paths differ only by case");\n');
	const kept = [
		"Do not add paths that differ only by case: they collide on case-insensitive filesystems; Linux CI never sees it, so the case-portable-paths check in `scripts/check.js` is the only guard.",
		// Policy only `CONTRIBUTING.md` states, which no check enforces.
		"Never move a published tag or republish different bytes: release artifacts are immutable (`CONTRIBUTING.md`).",
		"Never publish from a workstation: the `prepublishOnly` script in `package.json` throws.",
	];
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			`1. ${kept[0]}`,
			// The docs check file is gone, so this rule's citation no longer grounds.
			"2. Index every docs page: the docs-index check in `scripts/verify-docs.js` refuses an unindexed one.",
			`3. ${kept[1]}`,
			`4. ${kept[2]}`,
			"",
		].join("\n"),
	);
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: ["Widgets render only through `renderWidget` in `src/widgets/render.ts`."],
				conventions: [],
				sections: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const hard = handbook.split("## Hard invariants")[1]?.split("\n## ")[0] ?? "";
	deepStrictEqual(
		[...hard.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]),
		[
			"Do not add paths that differ only by case: they collide on case-insensitive filesystems; the case-portable-paths check in `scripts/check.js` is the only guard.",
			...kept.slice(1),
			"Widgets render only through `renderWidget` in `src/widgets/render.ts`.",
		],
		handbook,
	);
});

/** A repository whose `scripts/check.js` defines four checks, and a previous handbook whose invariants three of them and `prepublishOnly` enforce. */
function writeCarryFixture(): string[] {
	mkdirSync(join(cwd, "scripts"), { recursive: true });
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({
			name: "harbor",
			type: "module",
			scripts: {
				check: "node scripts/check.js",
				prepublishOnly: "node -e \"throw new Error('publish from the release job')\"",
			},
		}),
	);
	writeFileSync(
		join(cwd, ".github", "workflows", "ci.yml"),
		"jobs:\n  build:\n    name: ci (22)\n    steps:\n      - run: pnpm run check\n",
	);
	writeFileSync(
		join(cwd, "scripts", "check.js"),
		[
			'fail("case-portable-paths", "paths differ only by case and collide");',
			'fail("retired-html", "docs/html was retired; write Markdown pages");',
			'fail("gitignored-literal", "a joined literal names a gitignored path");',
			'fail("corpus", "a docs page is missing from the docs corpus");',
			"",
		].join("\n"),
	);
	const carried = [
		"Do not add paths that differ only by case: they collide on case-insensitive filesystems (case-portable-paths check in `scripts/check.js`).",
		"Never recreate the retired HTML documentation tree: the retired-html check in `scripts/check.js` refuses it.",
		"Never join a gitignored directory name into a string literal: the gitignored-literal check in `scripts/check.js` refuses it.",
		"Never publish from a workstation: the `prepublishOnly` script in `package.json` throws.",
	];
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			...carried.map((rule, i) => `${i + 1}. ${rule}`),
			"",
		].join("\n"),
	);
	return carried;
}

it("removes a model rule only when it states a carried invariant word for word", async () => {
	const carried = writeCarryFixture();
	const approval = "Get maintainer approval before disabling the case-portable-paths check in `scripts/check.js`.";
	const recipe =
		"Renaming `src/widgets/render.ts`: update the export in `src/index.ts` in the same commit; the case-portable-paths check in `scripts/check.js` refuses a case-only rename.";
	// Each resembles a carried rule in most of its words but states another obligation.
	const reworded =
		"Never join a gitignored directory name into a literal string: the gitignored-literal check in `scripts/check.js` refuses it.";
	const flipped =
		"Add paths that differ only by case: they collide on case-insensitive filesystems (case-portable-paths check in `scripts/check.js`).";
	const extended = `${carried[1]} Require maintainer approval before disabling that check.`;
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [
					// Only case and closing punctuation differ from carried invariant 3.
					(carried[2] ?? "").toLowerCase().replace(/\.$/, ""),
					reworded,
					flipped,
					extended,
					// The same script and file as a carried rule, with an obligation of its own.
					"The `prepublishOnly` script in `package.json` throws, so publication runs only from the release job.",
					approval,
				],
				conventions: [
					"`renderWidget` returns a string and never touches the DOM; a case-only rename of its file fails the case-portable-paths check in `scripts/check.js`.",
				],
				sections: [{ title: "Change recipes", body: `- ${recipe}` }],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const hard = handbook.split("## Hard invariants")[1]?.split("\n## ")[0] ?? "";
	deepStrictEqual(
		[...hard.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]),
		[
			...carried,
			reworded,
			flipped,
			extended,
			"The `prepublishOnly` script in `package.json` throws, so publication runs only from the release job.",
			approval,
		],
		handbook,
	);
	ok(handbook.includes("`renderWidget` returns a string and never touches the DOM"), handbook);
	ok(handbook.includes(recipe), handbook);
});

it("keeps rules that share a carried rule's citations but state another obligation", async () => {
	mkdirSync(join(cwd, "scripts"));
	mkdirSync(join(cwd, "docs"));
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");
	writeFileSync(
		join(cwd, "scripts", "check.js"),
		['fail("export-names", "an export is named after another file");', 'fail("corpus", "a page is unlinked");', ""].join(
			"\n",
		),
	);
	// Each model rule shares two citations with this one, and no more than one with another model rule.
	const carried =
		"Never export a widget from `src/index.ts` under a name other than its file's in `src/widgets/render.ts`: `scripts/check.js` refuses it.";
	const previousDocs =
		"- Every page is reachable from `docs/guide.md`; the corpus check in `scripts/check.js` fails otherwise.";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			`1. ${carried}`,
			"",
			"## Docs and prose",
			"",
			previousDocs,
			"",
		].join("\n"),
	);
	const approval =
		"Get maintainer approval before removing any public export of `src/index.ts`; `scripts/check.js` lists released names.";
	const convention =
		"Keep one widget per file such as `src/widgets/render.ts`, as `scripts/check.js` reads one name per file.";
	const recipe = "- Adding a widget: copy `src/widgets/render.ts`, then append its export to `src/index.ts`.";
	const modelDocs = "- Write page titles in sentence case in `docs/guide.md`; `scripts/check.js` reads every title.";
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [approval],
				conventions: [convention],
				sections: [
					{ title: "Change recipes", body: recipe },
					{ title: "Docs and prose", body: modelDocs },
				],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes(`1. ${carried}\n2. ${approval}\n`), handbook);
	ok(handbook.includes(`- ${convention}`), handbook);
	ok(handbook.includes(recipe), handbook);
	const docs = docsRules(handbook);
	strictEqual(docs, [previousDocs, modelDocs].join("\n"), handbook);
});

it("keeps every carried invariant when the model repeats one at the end of a full list", async () => {
	const carried = writeCarryFixture();
	const widgetRules = Array.from(
		{ length: 19 },
		(_, i) => `Widget ${i + 1} renders only through \`renderWidget\` in \`src/widgets/render.ts\`.`,
	);
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [...widgetRules, carried[2] ?? ""],
				conventions: [],
				sections: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const hard = handbook.split("## Hard invariants")[1]?.split("\n## ")[0] ?? "";
	const rules = [...hard.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]);
	deepStrictEqual(rules.slice(0, carried.length), carried, handbook);
	strictEqual(rules.length, HANDBOOK_TARGETS.invariants, handbook);
});

it("carries a section title the rewrite dropped with the blocks that name a defined check", async () => {
	const carried = writeCarryFixture();
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			...carried.map((rule, i) => `${i + 1}. ${rule}`),
			"",
			"## Docs and prose",
			"",
			"- Write new pages as Markdown under `docs/`; the retired-html check in `scripts/check.js` refuses an HTML tree.",
			"- Keep sentences short in `docs/guide.md`.",
			"- Every page under `docs/` is reachable from `docs/guide.md`; the corpus check in `scripts/check.js` fails otherwise.",
			"- Every anchor in `docs/guide.md` resolves; the stale-anchor check in `scripts/check.js` fails on a dead one.",
			"",
		].join("\n"),
	);
	const modelTitles = ["Change recipes", "Tests", "Git and release", "Gotchas", "Widgets", "Rendering", "Exports"];
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [],
				conventions: [],
				sections: modelTitles.map((title, i) => ({
					title,
					body: `- ${title} step ${i + 1} goes through \`renderWidget\` in \`src/widgets/render.ts\`.`,
				})),
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const docs = handbook.split("## Docs and prose")[1]?.split("\n## ")[0] ?? "";
	ok(docs.includes("Write new pages as Markdown under `docs/`"), handbook);
	ok(docs.includes("the corpus check in `scripts/check.js` fails otherwise"), handbook);
	strictEqual(docs.includes("Keep sentences short"), false, handbook);
	strictEqual(docs.includes("stale-anchor"), false, handbook);
	const titles = [...handbook.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
	deepStrictEqual(titles, [
		"Hard invariants",
		"Tests",
		"Gotchas",
		"Change recipes",
		"Git and release",
		"Widgets",
		"Rendering",
		"Docs and prose",
		"Verification expectations",
	]);
});

it("drops a bullet that rewords an earlier bullet of the same section", async () => {
	writeFileSync(join(cwd, "CLIO-CODER.md"), "# harbor\n\nA widget renderer.\n");
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [],
				conventions: [],
				sections: [
					{
						title: "Change recipes",
						body: [
							"- A new widget kind registers its renderer through `renderWidget` in `src/widgets/render.ts` under the widgets tests.",
							"- A new widget kind registers its renderer through `renderWidget` in `src/widgets/render.ts` with widgets tests first.",
							"- Exported names from `src/widgets/render.ts` stay stable between minor releases.",
						].join("\n"),
					},
				],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	strictEqual(handbook.match(/registers its renderer/g)?.length, 1, handbook);
	ok(handbook.includes("under the widgets tests."), handbook);
	ok(handbook.includes("stay stable between minor releases"), handbook);
});

it("returns a previous block under a kept title unless a protected rule states it word for word", async () => {
	const carried = writeCarryFixture();
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");
	const previousCorpus =
		"- Every page under `docs/` is reachable from `docs/guide.md`; the corpus check in `scripts/check.js` fails otherwise.";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			...carried.map((rule, i) => `${i + 1}. ${rule}`),
			"",
			"## Docs and prose",
			"",
			`- ${carried[1]}`,
			previousCorpus,
			"",
		].join("\n"),
	);
	// Names the corpus check for another instruction. The previous retired-html block is carried invariant 2.
	const modelDocs = "- Name each page in kebab case; the corpus check in `scripts/check.js` also reads page names.";
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [],
				conventions: [],
				sections: [{ title: "Docs and prose", body: modelDocs }],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const docs = docsRules(handbook);
	strictEqual(docs, [previousCorpus, modelDocs].join("\n"), handbook);
});

/** Rules of distinct words, so no rule restates another and only the budget decides what stays. */
function distinctFiller(): (label: string, length: number) => string {
	let next = 0;
	const word = (): string => {
		next += 1;
		let n = next;
		let text = "";
		for (; n > 0; n = Math.floor(n / 26)) text += String.fromCharCode(97 + (n % 26));
		return `qu${text}x`;
	};
	return (label, length) => {
		let text = `${label} renders through \`src/widgets/render.ts\``;
		while (text.length < length) text += ` ${word()}`;
		return `${text}.`;
	};
}

it("keeps carried invariants and sections whole when model content fills the handbook budget", async () => {
	const carried = writeCarryFixture();
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");
	const docsRule =
		"- Every page under `docs/` is reachable from `docs/guide.md`; the corpus check in `scripts/check.js` fails otherwise.";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			...carried.map((rule, i) => `${i + 1}. ${rule}`),
			"",
			"## Docs and prose",
			"",
			docsRule,
			"",
		].join("\n"),
	);
	const filler = distinctFiller();
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: Array.from({ length: 16 }, (_, i) => filler(`Widget rule ${i + 1}`, 700)),
				conventions: [],
				sections: ["Change recipes", "Tests", "Gotchas", "Widgets", "Rendering", "Exports"].map((title) => ({
					title,
					body: Array.from({ length: 10 }, (_, i) => `- ${filler(`${title} step ${i + 1}`, 370)}`).join("\n"),
				})),
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.length <= HANDBOOK_TARGETS.chars, `${handbook.length}`);
	for (const rule of carried) ok(handbook.includes(rule), handbook);
	const docs = docsRules(handbook);
	strictEqual(docs, docsRule, handbook);
});

/**
 * A rewrite whose model content fills the handbook's line budget, so a section
 * the final fit does not reserve finds no room. Returns the Docs section.
 */
async function docsUnderFullBudget(
	previousDocs: string[],
	modelDocs: string[],
	conventions: string[],
): Promise<string> {
	const carried = writeCarryFixture();
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			...carried.map((rule, i) => `${i + 1}. ${rule}`),
			"",
			"## Docs and prose",
			"",
			...previousDocs,
			"",
		].join("\n"),
	);
	const filler = distinctFiller();
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: Array.from({ length: 16 }, (_, i) => filler(`Widget rule ${i + 1}`, 700)),
				conventions,
				sections: [
					...["Change recipes", "Tests", "Gotchas", "Widgets", "Rendering", "Exports"].map((title) => ({
						title,
						body: Array.from({ length: 40 }, (_, i) => `- ${filler(`${title} step ${i + 1}`, 90)}`).join("\n"),
					})),
					{ title: "Docs and prose", body: modelDocs.join("\n") },
				],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.trimEnd().split("\n").length <= HANDBOOK_TARGETS.lines, handbook);
	return docsRules(handbook);
}

const DOCS_RULE =
	"- Every page under `docs/` is reachable from `docs/guide.md`; the corpus check in `scripts/check.js` fails otherwise.";

it("protects a previous block the model already wrote when model content fills the handbook budget", async () => {
	strictEqual(await docsUnderFullBudget([DOCS_RULE], [DOCS_RULE], []), DOCS_RULE);
});

it("returns a previous block a model rule restates, since the final fit may cut that rule", async () => {
	const names = "Name each page in kebab case; the corpus check in `scripts/check.js` reads page names.";
	const docs = await docsUnderFullBudget([DOCS_RULE, `- ${names}`], [DOCS_RULE], [names]);
	strictEqual(docs, [DOCS_RULE, `- ${names}`].join("\n"));
});

it("protects a section's carried blocks once each, but not the model's additions to it", async () => {
	const reworded =
		"- Each page under `docs/` must be reachable from `docs/guide.md`, or the corpus check in `scripts/check.js` fails.";
	const docs = await docsUnderFullBudget([DOCS_RULE, DOCS_RULE], [DOCS_RULE.toLowerCase(), reworded], []);
	strictEqual(docs, DOCS_RULE);
});

it("keeps protected invariants that alone exceed the budget and reports the overflow", () => {
	const rules = Array.from({ length: 40 }, (_, i) =>
		`Rule ${i + 1}: ${"keep every obligation whole ".repeat(25)}`.trim(),
	);
	const overflows: Array<{ chars: number; lines: number }> = [];
	const fitted = fitGeneratedHandbook(
		{
			projectName: "harbor",
			identity: "A widget renderer.",
			invariants: [...rules, "A model rule `src/widgets/render.ts` gives way."],
			conventions: [],
			sections: [],
		},
		{ invariants: rules, sections: [] },
		(size) => overflows.push(size),
	);
	deepStrictEqual(fitted.invariants, rules);
	strictEqual(overflows.length, 1);
	strictEqual(overflows[0]?.chars, serializeClioMd(fitted).length);
	ok((overflows[0]?.chars ?? 0) > HANDBOOK_TARGETS.chars);
});

it("records the spend of every bootstrap dispatch, not only the draft that survived", async () => {
	const draft = {
		projectName: "harbor",
		identity: "A widget renderer.",
		invariants: [],
		conventions: ["Code under `src/widgets/**` renders through `renderWidget()`."],
		sections: [],
	};
	let dispatches = 0;
	const dispatch = {
		dispatch: async () => {
			dispatches += 1;
			const runId = `bootstrap-spend-${dispatches}`;
			return {
				runId,
				events: (async function* () {
					yield { type: "text_delta", text: JSON.stringify(draft) };
				})(),
				finalPromise: Promise.resolve({
					runId,
					exitCode: 0,
					toolCalls: 3,
					toolStats: [],
					spend: { totalTokens: { kind: "measured", value: 1000 * dispatches } },
				}),
			};
		},
		abort: () => {},
	} as unknown as DispatchContract;
	const generate = modelBootstrapGenerate({ dispatch, onFallback: () => {} });
	let assessed = 0;
	await runBootstrap({
		cwd,
		// The first draft is sent back for repair, the repair is accepted, and one section is asked for.
		generate: (input) =>
			generate({
				...input,
				assessDraft: () => (assessed++ === 0 ? "cite the files" : null),
				missingSections: () => [{ title: "Change recipes", reason: "fixture" }],
			}),
	});
	strictEqual(dispatches, 3);
	const generation = readClioState(cwd)?.lastBootstrap;
	strictEqual(generation?.tokenCount, 6000, JSON.stringify(generation));
	strictEqual(generation?.toolCalls, 9, JSON.stringify(generation));
	strictEqual(generation?.repairRan, true, JSON.stringify(generation));
});

it("records the whole generation span when every dispatch failed, not the last receipt's", async () => {
	let clock = 0;
	const now = mock.method(performance, "now", () => clock);
	let dispatches = 0;
	const dispatch = {
		dispatch: async () => {
			dispatches += 1;
			clock += 5_500;
			const runId = `bootstrap-failed-${dispatches}`;
			return {
				runId,
				events: (async function* () {})(),
				finalPromise: Promise.resolve({
					runId,
					exitCode: 1,
					// The first refuses the schema, so the parser attempt dispatches again.
					failureMessage: dispatches === 1 ? "400 bad request: json_schema grammar failed to compile" : "the model stopped",
					startedAt: "2026-01-01T00:00:00.000Z",
					endedAt: "2026-01-01T00:00:02.000Z",
					toolCalls: 0,
					toolStats: [],
				}),
			};
		},
		abort: () => {},
	} as unknown as DispatchContract;
	try {
		await runBootstrap({ cwd, generate: modelBootstrapGenerate({ dispatch, onFallback: () => {} }) });
	} finally {
		now.mock.restore();
	}
	strictEqual(dispatches, 2);
	strictEqual(readClioState(cwd)?.lastBootstrap?.durationMs, 11_000, JSON.stringify(readClioState(cwd)?.lastBootstrap));
});

it("records the generation span when the fallback ran no dispatch", async () => {
	let clock = 0;
	const now = mock.method(performance, "now", () => clock);
	const dispatch = {
		dispatch: async () => {
			throw new Error("no dispatch expected");
		},
		abort: () => {},
	} as unknown as DispatchContract;
	try {
		await runBootstrap({
			cwd,
			generate: modelBootstrapGenerate({
				dispatch,
				resolveRoute: () => {
					clock += 11_000;
					throw new Error("no bootstrap target configured");
				},
				onFallback: () => {},
			}),
		});
	} finally {
		now.mock.restore();
	}
	const generation = readClioState(cwd)?.lastBootstrap;
	strictEqual(generation?.parserOutcome, "not-run", JSON.stringify(generation));
	strictEqual(generation?.runId, undefined, JSON.stringify(generation));
	strictEqual(generation?.durationMs, 11_000, JSON.stringify(generation));
});

it("records no tool call total when a started dispatch left no receipt", async () => {
	const settled: BootstrapRunTelemetry = {
		structuredOutputMode: "native-schema",
		runId: "settled",
		toolCalls: 3,
		promptBytes: 1,
		outputBytes: 1,
	};
	// A dispatch that started a worker but returned no receipt has no tool count.
	const unsettled: BootstrapRunTelemetry = {
		structuredOutputMode: "native-schema",
		runId: "unsettled",
		promptBytes: 1,
		outputBytes: 1,
	};
	await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({
				mode: "model",
				parserOutcome: "parsed",
				run: settled,
				runs: [unsettled, settled],
			});
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [],
				conventions: ["Code under `src/widgets/**` renders through `renderWidget()`."],
				sections: [],
			};
		},
	});
	const generation = readClioState(cwd)?.lastBootstrap;
	strictEqual(generation?.runId, "settled", JSON.stringify(generation));
	strictEqual(generation?.toolCalls, undefined, JSON.stringify(generation));
});

it("merges a handbook's restated rules, keeps the first wording and corrects a renumbered rule id", async () => {
	mkdirSync(join(cwd, "src", "widgets"), { recursive: true });
	mkdirSync(join(cwd, "tests", "boundaries"), { recursive: true });
	writeFileSync(join(cwd, "src", "widgets", "render.ts"), "export function renderWidget(): string { return ''; }\n");
	writeFileSync(join(cwd, "src", "widgets", "owner.ts"), "export const registrar = {};\n");
	writeFileSync(
		join(cwd, "tests", "boundaries", "check-owners.ts"),
		[
			"/**",
			" * 1. Every widget test file stays under the widgets suite directory.",
			" * 2. The render registrar capability of the widget owner is named only inside src/widgets/owner.ts.",
			" */",
			"export function runOwnersCheck(): string[] {",
			'\treturn ["rule1: a widget test is outside its suite", "rule2: the registrar is named outside its owner"];',
			"}",
			"",
		].join("\n"),
	);
	const kept = "Exported names from `src/widgets/render.ts` stay stable between minor releases.";
	const restated = "Exported names from `src/widgets/render.ts` must stay stable across minor releases.";
	const recipe = "- A new widget kind registers its renderer through `renderWidget` in `src/widgets/render.ts`.";
	const recipeAgain =
		"- A new widget kind registers its renderer through `renderWidget` in `src/widgets/render.ts` first.";
	const owner =
		"The render registrar capability of the widget owner is named only inside `src/widgets/owner.ts` (rule1).";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		serializeClioMd({
			projectName: "harbor",
			identity: "A widget renderer.",
			invariants: [kept, restated, owner],
			conventions: [],
			sections: [{ title: "Change recipes", body: [recipe, recipeAgain].join("\n") }],
		}),
	);
	let stdout = "";
	await runBootstrap({ cwd, applyClioMd: true, io: { stdout: (text) => (stdout += text), stderr: () => {} } });
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	strictEqual(handbook.match(/stay stable/g)?.length, 1, handbook);
	ok(handbook.includes(kept), handbook);
	strictEqual(handbook.match(/registers its renderer/g)?.length, 1, handbook);
	ok(handbook.includes(`${recipe}\n`), handbook);
	ok(handbook.includes("`src/widgets/owner.ts` (rule2)."), handbook);
	ok(stdout.includes("merged 2 restated rules"), stdout);
	ok(stdout.includes("rule id rule1 rewritten to rule2"), stdout);
});

it("merges same-section bullets that restate each other in other words, keeping the first wording", async () => {
	const docsFirst =
		"- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/**/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; the documentation-links check fails on a missing target, anchor, or cited path.";
	const docsAgain =
		"- Links in `docs/**`, `README.md` and `CONTRIBUTING.md` are checked by check-hygiene's documentation-links rule: targets must exist, heading anchors must match the slugified heading, and backticked `src/`, `tests/`, `scripts/`, `apps/` paths must resolve in the checkout.";
	const gotchaFirst =
		"- A function used only by its own file must not carry the `export` keyword: export-hygiene sweeps `src/core` and `src/tools`.";
	const gotchaAgain =
		"- Export hygiene: a function used only by the file that declares it must not carry the `export` keyword; the hygiene check sweeps `src/core` and `src/tools` and fails on dead exports.";
	const distinct = "- Retired HTML documentation must not return: no `docs/html/` directory and no links to it.";
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		serializeClioMd({
			projectName: "harbor",
			identity: "A widget renderer.",
			invariants: [],
			conventions: [],
			sections: [
				{ title: "Docs and prose", body: [docsFirst, distinct, docsAgain].join("\n") },
				{ title: "Gotchas", body: [gotchaFirst, gotchaAgain].join("\n") },
			],
		}),
	);
	let stdout = "";
	await runBootstrap({ cwd, applyClioMd: true, io: { stdout: (text) => (stdout += text), stderr: () => {} } });
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes(docsFirst) && !handbook.includes(docsAgain), handbook);
	ok(handbook.includes(gotchaFirst) && !handbook.includes(gotchaAgain), handbook);
	ok(handbook.includes(distinct), handbook);
	ok(stdout.includes("merged 2 restated rules"), stdout);
});

interface LedgerEntryShape {
	text: string;
	origin: string;
	source: { file: string; line: number };
	verdict: string;
	reason: string;
	kept: boolean;
}

function readHandbookLedger(): LedgerEntryShape[] {
	return JSON.parse(readFileSync(join(cwd, ".clio-coder", "state", "handbook-ledger.json"), "utf8")).entries;
}

it("verifies sibling handbook rules against the tree before adopting them", async () => {
	writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	writeFileSync(
		join(cwd, "CLAUDE.md"),
		[
			"# Rules",
			"",
			"- Always run `npm run test:unit` before pushing.",
			"- Always use yarn for installs.",
			"- Never import from `src/legacy/` in new code.",
			"- Never edit `src/widgets/render.ts` without updating `src/index.ts`.",
			"",
		].join("\n"),
	);
	await runBootstrap({ cwd });
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	strictEqual(handbook.includes("test:unit"), false, handbook);
	strictEqual(handbook.includes("use yarn"), false, handbook);
	strictEqual(handbook.includes("src/legacy"), false, handbook);
	ok(handbook.includes("without updating `src/index.ts`. (source: CLAUDE.md:6)"), handbook);
	const ledger = readHandbookLedger();
	const entry = (fragment: string): LedgerEntryShape | undefined =>
		ledger.find((candidate) => candidate.text.includes(fragment));
	deepStrictEqual(
		[entry("test:unit"), entry("use yarn"), entry("src/legacy/")].map((found) => [
			found?.verdict,
			found?.source.file,
			found?.source.line,
		]),
		[
			["stale", "CLAUDE.md", 3],
			["contradicted", "CLAUDE.md", 4],
			["stale", "CLAUDE.md", 5],
		],
	);
	const adopted = entry("src/widgets/render.ts");
	deepStrictEqual(
		[adopted?.verdict, adopted?.origin, adopted?.kept, adopted?.source.line],
		["verified", "adopted", true, 6],
	);
});

it("context init --verify flags a missing path and a wrong rule id, and --apply leaves a handbook that verifies", async () => {
	mkdirSync(join(cwd, "tests", "boundaries"), { recursive: true });
	writeFileSync(
		join(cwd, "tests", "boundaries", "check-owners.ts"),
		[
			"/**",
			" * 1. Every widget test file stays under the widgets suite directory.",
			" * 2. The render registrar capability of the widget owner is named only inside src/widgets/render.ts.",
			" */",
			"export function runOwnersCheck(): string[] {",
			'\treturn ["rule1: a widget test is outside its suite", "rule2: the registrar is named outside its owner"];',
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"## Rules",
			"",
			"- Exported names from `src/widgets/render.ts` stay stable between minor releases.",
			"- Never edit `src/legacy/old.ts` by hand.",
			"- Every widget test file stays under the widgets suite directory (rule7).",
			"",
		].join("\n"),
	);
	const previous = process.cwd();
	process.chdir(cwd);
	let stdout = "";
	const write = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		// The test runner's own reporter writes bytes; the command writes strings.
		if (typeof chunk === "string") stdout += chunk;
		return true;
	});
	try {
		strictEqual(await runInitCommand(["--verify", "--json"]), 1);
		const report = JSON.parse(stdout) as { rules: { verdict: string; line: number }[]; usage?: unknown };
		deepStrictEqual(
			report.rules.filter((rule) => rule.verdict === "stale").map((rule) => rule.line),
			[6, 7],
		);
		strictEqual("usage" in report, false);
		const ledger = JSON.parse(readFileSync(join(cwd, ".clio-coder", "state", "handbook-ledger.json"), "utf8"));
		ok(typeof ledger.verifiedCommit === "string", JSON.stringify(ledger));
		stdout = "";
		strictEqual(await runInitCommand(["--verify", "--apply"]), 1);
		const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
		strictEqual(handbook.includes("src/legacy"), false, handbook);
		ok(handbook.includes("suite directory (rule1)."), handbook);
		ok(stdout.includes("-- Never edit `src/legacy/old.ts` by hand."), stdout);
		stdout = "";
		strictEqual(await runInitCommand(["--verify"]), 0, stdout);
	} finally {
		write.mock.restore();
		process.chdir(previous);
	}
});

it("does not let a rule stated only in a sibling handbook ground a model line", async () => {
	writeFileSync(join(cwd, "CLAUDE.md"), "# Rules\n\n- Never edit `vendor-cache` by hand.\n");
	const sibling = "Never edit `vendor-cache` by hand.";
	const grounded = "Every widget renders through `renderWidget()` in `src/widgets/render.ts`.";
	await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [sibling, grounded],
				conventions: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes(grounded), handbook);
	strictEqual(handbook.includes("vendor-cache"), false, handbook);
	strictEqual(readHandbookLedger().find((found) => found.text.includes("vendor-cache"))?.verdict, "stale");
});

it("reports the rejected sibling rules with their source line and reason, in the summary and in --json", async () => {
	writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	writeFileSync(
		join(cwd, "CLAUDE.md"),
		[
			"# Rules",
			"",
			"- Always run `npm run test:unit` before pushing.",
			"- Always use yarn for installs.",
			"- Never import from `src/legacy/` in new code.",
			"- Never edit `src/widgets/render.ts` without updating `src/index.ts`.",
			"",
		].join("\n"),
	);
	let text = "";
	await runBootstrap({
		cwd,
		io: {
			stdout: (chunk: string) => {
				text += chunk;
			},
			stderr: () => {},
		},
	});
	const reasons = new Map(readHandbookLedger().map((found) => [`${found.source.file}:${found.source.line}`, found]));
	const rejected = [
		["dropped", "CLAUDE.md:3"],
		["contradicted", "CLAUDE.md:4"],
		["dropped", "CLAUDE.md:5"],
	];
	for (const [status, at] of rejected) {
		const line = text.split("\n").find((candidate) => candidate.includes(` ${at} `));
		ok(line?.trim().startsWith(`${status} `), text);
		ok(line?.includes(reasons.get(at ?? "")?.reason.slice(0, 40) ?? "\u0000"), text);
	}
	ok(text.includes("absorbed rules: 1 verified, 2 stale, 1 contradicted, 0 unverifiable"), text);
	ok(text.includes("absorbed handbooks: CLAUDE.md; Clio did not modify them"), text);

	rmSync(join(cwd, "CLIO-CODER.md"));
	const previous = process.cwd();
	process.chdir(cwd);
	let stdout = "";
	const write = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		if (typeof chunk === "string") stdout += chunk;
		return true;
	});
	try {
		strictEqual(await runInitCommand(["--heuristic", "--json"]), 0);
	} finally {
		write.mock.restore();
		process.chdir(previous);
	}
	const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
		absorb?: { rules: { status: string; file: string; line: number; reason: string }[]; handbooks: string[] };
	};
	deepStrictEqual(
		report.absorb?.rules.map((rule) => [rule.status, `${rule.file}:${rule.line}`, rule.reason]),
		rejected.map(([status, at]) => [status, at, reasons.get(at ?? "")?.reason]),
	);
	deepStrictEqual(report.absorb?.handbooks, ["CLAUDE.md"]);
});

it("shapes a generated handbook so a 6000-character coder compile reaches its Tests and Gotchas rules", async () => {
	const filler = distinctFiller();
	await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: Array.from({ length: 10 }, (_, i) => filler(`Invariant ${i + 1}`, 560)),
				conventions: [filler("Convention one", 120)],
				sections: ["Change recipes", "Widgets", "Gotchas", "Tests"].map((title) => ({
					title,
					body: [1, 2].map((step) => `- ${filler(`${title} rule ${step}`, 160)}`).join("\n"),
				})),
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const hard = handbook.split("## Hard invariants")[1]?.split("\n## ")[0] ?? "";
	ok(hard.trim().length <= HANDBOOK_TARGETS.invariantsTotalChars, `${hard.trim().length}`);
	const titles = [...handbook.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
	deepStrictEqual(titles.slice(0, 6), [
		"Hard invariants",
		"Tests",
		"Gotchas",
		"Conventions",
		"Change recipes",
		"Widgets",
	]);
	for (const title of ["Tests", "Gotchas", "Conventions"])
		ok(handbook.includes(`## ${title}\n\n<!-- clio: paths=none -->\n`), handbook);
	ok(!handbook.includes("## Change recipes\n\n<!--"), handbook);
	const compiled = compileHandbook(handbook, "CLIO-CODER.md");
	ok(compiled);
	const worker = selectWorkerHandbook([compiled], {
		audience: workerHandbookAudience("coder", null),
		cwd,
		workingPaths: ["README.md"],
		maxChars: 6000,
	}).text;
	ok(worker.includes("Tests rule 1") && worker.includes("Gotchas rule 1"), worker);
});
