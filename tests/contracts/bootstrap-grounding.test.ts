import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { runBootstrap } from "../../src/domains/context/bootstrap.js";
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
