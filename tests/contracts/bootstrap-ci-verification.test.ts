import { deepEqual, ok } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { ciRunCommands } from "../../src/core/ci-commands.js";
import { runBootstrap } from "../../src/domains/context/bootstrap.js";
import { BOOTSTRAP_PROMPT, parseBootstrapModelOutput } from "../../src/domains/context/bootstrap-prompt.js";
import { HANDBOOK_TARGETS } from "../../src/domains/context/clio-md.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// A generated handbook for a uv/unittest repository had no verification section:
// the generator named a runner only for tox and pytest configurations, so the
// gate script CI runs (`scripts/gate.sh`) never reached the agent, and agents
// recorded "could not run tests" instead of running it through bash.
let isolated: IsolatedClioEnv;
let cwd: string;
const write = (path: string, text: string): void => {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), text);
};

beforeEach(async () => {
	isolated = await isolateClioEnv("clio-coder-bootstrap-ci-verification-");
	cwd = join(isolated.dir, "repo");
	write("pyproject.toml", '[project]\nname = "harbor"\nversion = "0.1.0"\n');
	write("uv.lock", "version = 1\n");
	write("tests/test_harbor.py", "import unittest\n");
	write("src/harbor/__init__.py", "");
	write(
		".github/workflows/gate.yml",
		[
			"jobs:",
			"  gate:",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"      - name: Install dependencies",
			"        run: uv sync",
			"      - name: Gate",
			"        run: scripts/gate.sh",
			"",
		].join("\n"),
	);
	write("scripts/gate.sh", "#!/bin/sh\nuv run python -m unittest discover -s tests\nuv run ruff check src\n");
});

afterEach(() => isolated.restore());

it("writes the commands each workflow runs, the derived test runner and the bash fallback into the verification section", async () => {
	await runBootstrap({
		cwd,
		generate: async (input) => {
			input.reportGeneration?.({ mode: "model", parserOutcome: "parsed" });
			return { projectName: "harbor", identity: "A harbor.", invariants: [], conventions: [], sections: [] };
		},
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const section = handbook.slice(handbook.indexOf("## Verification"));
	ok(handbook.includes("## Verification"), handbook);
	ok(section.includes("`.github/workflows/gate.yml` runs `scripts/gate.sh`."), section);
	ok(!/\bCI\b/.test(section), section);
	ok(!section.includes("`uv sync`"), section);
	ok(section.includes("`uv run python -m unittest discover -s tests`"), section);
	ok(/bash/.test(section), section);
});

// The prompt asked the model to trace which tests CI runs, and grounding then deleted every sentence naming CI.
it("asks the bootstrap model where a regression test must live without asking it to trace CI", () => {
	ok(/regression test must live for that script to run it/i.test(BOOTSTRAP_PROMPT));
	ok(
		!/test directories CI|CI-reached|CI command actually reaches/i.test(BOOTSTRAP_PROMPT),
		"prompt must not ask which test paths CI executes",
	);
});

// A tag-triggered publish was listed as "CI runs `npm publish --provenance`. These are CI checks".
it("names each workflow's steps with their triggers and leaves out a tag- or release-only workflow", async () => {
	write(".github/workflows/gate.yml", "");
	write(
		".github/workflows/release.yml",
		"on: { push: { tags: ['v*'] } }\njobs:\n  publish:\n    steps:\n      - run: npm publish --provenance\n",
	);
	write(
		".github/workflows/pages.yml",
		[
			"on:",
			"  release:",
			"    types: [published]",
			"  workflow_dispatch:",
			"jobs:",
			"  pages:",
			"    steps:",
			"      - run: scripts/deploy-pages.sh",
			"",
		].join("\n"),
	);
	write(
		".github/workflows/ci.yml",
		[
			"on:",
			"  push:",
			"    branches: [main]",
			"    tags: ['v*']",
			"  pull_request:",
			"jobs:",
			"  test:",
			"    steps:",
			"      - run: scripts/gate.sh",
			"",
		].join("\n"),
	);
	await runBootstrap({
		cwd,
		generate: async () => ({
			projectName: "harbor",
			identity: "A harbor.",
			invariants: [],
			conventions: [],
			sections: [],
		}),
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	const section = handbook.slice(handbook.indexOf("## Verification"));
	ok(section.includes("`.github/workflows/ci.yml` runs `scripts/gate.sh` on `push`, `pull_request`."), section);
	ok(!section.includes("npm publish"), section);
	ok(!section.includes("deploy-pages"), section);
	ok(!/\bCI\b/.test(section), section);
});

it("omits an oversized rule whole rather than losing its final exception", () => {
	const rule =
		"Preserve `src/owner.ts`. " +
		"The rationale requires space. ".repeat(HANDBOOK_TARGETS.invariantChars) +
		" Except generated fixtures may be replaced.";
	const complete = "Use `src/owner.ts` for owned writes.";
	const output = parseBootstrapModelOutput(
		JSON.stringify({
			projectName: "harbor",
			identity: "A harbor.",
			conventions: [],
			invariants: [rule, complete],
			sections: [],
		}),
	);
	ok(output.invariants.length === 1);
	ok(output.invariants[0] === complete);
});

it("preserves the exact default test selection without claiming optional suites run in CI", async () => {
	const ordinary = "node --test tests/contracts/*.test.ts tests/smoke/boot.test.ts";
	write(
		"package.json",
		JSON.stringify({ name: "fixture", scripts: { test: ordinary, "test:full": "node --test tests/**/*.test.ts" } }),
	);
	await runBootstrap({
		cwd,
		generate: async () => ({
			projectName: "fixture",
			identity: "Fixture.",
			invariants: [],
			conventions: [],
			sections: [],
		}),
	});
	const handbook = readFileSync(join(cwd, "CLIO-CODER.md"), "utf8");
	ok(handbook.includes(`Exact package.json#scripts.test: \`${ordinary}\``));
	ok(!handbook.includes("node --test tests/**/*.test.ts"));
});

// Clio's own workflow listed `fi` and `shell: bash` as CI gates.
it("reads a multi-line run script as commands and a run mapping as none", () => {
	const yaml = [
		"defaults:",
		"  run:",
		"    shell: bash",
		"steps:",
		"  - run: |",
		"      if pnpm run lint; then",
		"        pnpm run build \\",
		"          --prod",
		"      fi",
		"",
	].join("\n");
	deepEqual(ciRunCommands(yaml), ["pnpm run lint", "pnpm run build --prod"]);
});
