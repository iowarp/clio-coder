import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { modelBootstrapGenerate } from "../../src/cli/bootstrap-generate.js";
import { type BootstrapRunTelemetry, runBootstrap } from "../../src/domains/context/bootstrap.js";
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

it("carries a check-enforced hard invariant through a rewrite, and not one whose check is gone", async () => {
	mkdirSync(join(cwd, "scripts"));
	writeFileSync(
		join(cwd, "scripts", "check.js"),
		'function checkCasePortablePaths() {\n\tfail("case-portable-paths", "paths differ only by case and collide");\n}\n',
	);
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# harbor",
			"",
			"A widget renderer.",
			"",
			"## Hard invariants",
			"",
			"1. Do not add paths that differ only by case: they collide on case-insensitive filesystems (case-portable-paths check in `scripts/check.js`).",
			"2. Never render widgets from `src/index.ts`: the widget-entry check in `scripts/check.js` refuses it.",
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
				// The draft states the case rule only as a convention, which gives way to the carried invariant.
				invariants: [],
				conventions: ["`checkCasePortablePaths` in `scripts/check.js` fails on paths that differ only by case."],
				sections: [],
			};
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes("1. Do not add paths that differ only by case"), handbook);
	strictEqual(handbook.includes("widget-entry"), false, handbook);
	strictEqual(handbook.includes("`checkCasePortablePaths`"), false, handbook);
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
