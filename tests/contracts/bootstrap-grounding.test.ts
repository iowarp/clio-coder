import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it, mock } from "node:test";
import { modelBootstrapGenerate } from "../../src/cli/bootstrap-generate.js";
import { type BootstrapRunTelemetry, runBootstrap } from "../../src/domains/context/bootstrap.js";
import { HANDBOOK_TARGETS, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { fitGeneratedHandbook } from "../../src/domains/context/handbook-budget.js";
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

it("keeps model rules that cite real files, strings, globs and symbols, and drops invented ones", async () => {
	const result = await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [
					"Keep the `ci (22)` job name in `.github/workflows/ci.yml`; branch protection keys on it.",
					"Never ship `src/missing-module.ts`; it holds credentials.",
				],
				conventions: [
					"Follow `CONTRIBUTING.md` before review.",
					"Code under `src/widgets/**` renders through `renderWidget()`.",
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
});

it("keeps a reviewer requirement its cited policy states, and marks one its cited file does not state", async () => {
	writeFileSync(join(cwd, ".github", "workflows", "release.yml"), "jobs:\n  publish:\n    environment: release\n");
	writeFileSync(
		join(cwd, ".github", "branch-protection.json"),
		JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 } }),
	);
	await runBootstrap({
		cwd,
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
						].join("\n"),
					},
				],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(
		handbook.includes(
			"- The `release` environment in `.github/workflows/release.yml` requires the owner as reviewer (unverified: `.github/workflows/release.yml` states no review policy). Keep the `ci (22)` job name in `.github/workflows/ci.yml`.",
		),
		handbook,
	);
	ok(handbook.includes("- `.github/branch-protection.json` requires a reviewer before merging.\n"), handbook);
	ok(handbook.includes("- Follow `CONTRIBUTING.md` before review."), handbook);
});

it("cuts a model line's claim that CI runs a check, but keeps a carried invariant verbatim", async () => {
	const carried = "Never commit a path `.gitignore` excludes: the tracked-ignored check in `scripts/check.js` fails CI.";
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
				invariants: ["Export every widget from `src/index.ts`; `npm run check` is enforced in CI."],
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
	ok(handbook.includes(`1. ${carried}`), handbook);
	ok(handbook.includes("2. Export every widget from `src/index.ts`; `npm run check` is enforced.\n"), handbook);
	ok(handbook.includes("rerun `npm run check`. It fails on drift."), handbook);
	strictEqual(/(?:fails|enforced)(?: on| in)? CI/.test(handbook.replace(carried, "")), false, handbook);
});

it("marks a module a rule calls preloaded when no package script preloads it", async () => {
	mkdirSync(join(cwd, "tests", "harness"), { recursive: true });
	mkdirSync(join(cwd, "scripts"));
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({
			name: "harbor",
			type: "module",
			scripts: { "test:file": "node --import tsx --import ./tests/harness/tmp-root.ts --test" },
		}),
	);
	writeFileSync(join(cwd, "tests", "harness", "tmp-root.ts"), "export const root = process.env.TMPDIR;\n");
	writeFileSync(join(cwd, "tests", "harness", "scratch-env.ts"), "export function isolateEnv(): void {}\n");
	writeFileSync(
		join(cwd, "scripts", "run-tests.mjs"),
		'spawn(process.execPath, ["--import", "./tests/harness/tmp-root.ts", "--test"]);\n',
	);
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
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [claim],
				conventions: [launcher, workspace],
				sections: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(
		handbook.includes(
			`${claim.slice(0, -1)} (unverified: \`tests/harness/scratch-env.ts\` is not preloaded by a package script).`,
		),
		handbook,
	);
	ok(handbook.includes(launcher), handbook);
	ok(handbook.includes(`${workspace}\n`), handbook);
});

it("carries every previous hard invariant verbatim while its citations still exist", async () => {
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
		[...kept, "Widgets render only through `renderWidget` in `src/widgets/render.ts`."],
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

it("removes a model rule only when it restates a carried invariant, not when it shares its check", async () => {
	const carried = writeCarryFixture();
	const approval = "Get maintainer approval before disabling the case-portable-paths check in `scripts/check.js`.";
	const recipe =
		"Renaming `src/widgets/render.ts`: update the export in `src/index.ts` in the same commit; the case-portable-paths check in `scripts/check.js` refuses a case-only rename.";
	await runBootstrap({
		cwd,
		rewriteClioMd: true,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return {
				projectName: "harbor",
				identity: "A widget renderer.",
				invariants: [
					// The carried rule in nearly its own words gives way to it.
					"Never join a gitignored directory name into a literal string: the gitignored-literal check in `scripts/check.js` refuses it.",
					// The same script and file as a carried rule, with an obligation of its own.
					"The `prepublishOnly` script in `package.json` throws, so publication runs only from the release job.",
					approval,
					"Keep each widget's tests beside it under `src/widgets/`; the case-portable-paths check in `scripts/check.js` also runs on test file names.",
				],
				conventions: [
					"`renderWidget` returns a string and never touches the DOM; a case-only rename of its file fails the case-portable-paths check in `scripts/check.js`.",
				],
				sections: [{ title: "Change recipes", body: `- ${recipe}` }],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	for (const rule of carried) ok(handbook.includes(rule), handbook);
	strictEqual(handbook.includes("into a literal string"), false, handbook);
	ok(handbook.includes("publication runs only from the release job"), handbook);
	ok(handbook.includes(approval), handbook);
	ok(handbook.includes("Keep each widget's tests beside it under `src/widgets/`"), handbook);
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
	const docs = handbook.split("## Docs and prose")[1]?.split("\n## ")[0]?.trim() ?? "";
	strictEqual(docs, [modelDocs, previousDocs].join("\n"), handbook);
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
	strictEqual(rules.length, 20, handbook);
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
		...modelTitles.slice(0, 6),
		"Docs and prose",
		"Verification expectations",
	]);
});

it("returns a previous block under a kept title unless the handbook restates it", async () => {
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
			"- Pages are Markdown under `docs/`, never HTML; the retired-html check in `scripts/check.js` refuses an HTML tree.",
			previousCorpus,
			"",
		].join("\n"),
	);
	// Names the corpus check for another instruction. The previous retired-html block restates carried invariant 2.
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
	const docs = handbook.split("## Docs and prose")[1]?.split("\n## ")[0]?.trim() ?? "";
	strictEqual(docs, [modelDocs, previousCorpus].join("\n"), handbook);
});

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
	// Distinct words per rule, so no rule restates another and only the budget decides what stays.
	let next = 0;
	const word = (): string => {
		next += 1;
		let n = next;
		let text = "";
		for (; n > 0; n = Math.floor(n / 26)) text += String.fromCharCode(97 + (n % 26));
		return `qu${text}x`;
	};
	const filler = (label: string, length: number): string => {
		let text = `${label} renders through \`src/widgets/render.ts\``;
		while (text.length < length) text += ` ${word()}`;
		return `${text}.`;
	};
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
	const docs = handbook.split("## Docs and prose")[1]?.split("\n## ")[0]?.trim() ?? "";
	strictEqual(docs, docsRule, handbook);
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
		{ invariants: rules, sectionTitles: [] },
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
