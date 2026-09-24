import { ok } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
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

it("writes the commands CI runs, the derived test runner and the bash fallback into the verification section", async () => {
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
	ok(section.includes("`scripts/gate.sh`"), section);
	ok(!section.includes("`uv sync`"), section);
	ok(section.includes("`uv run python -m unittest discover -s tests`"), section);
	ok(/bash/.test(section), section);
});

it("asks the bootstrap model where a regression test must live so CI runs it", () => {
	ok(/regression test/i.test(BOOTSTRAP_PROMPT));
	ok(/test directories? CI (?:actually )?runs/i.test(BOOTSTRAP_PROMPT), "prompt must ask which test paths CI executes");
});

it("clamps an overlong model rule at a sentence end instead of mid-word", () => {
	const sentence = "Rule6 in `tests/boundaries/check-boundaries.ts` routes every entry through `STAGE0_SEAMS`. ";
	const long = sentence.repeat(Math.ceil((HANDBOOK_TARGETS.invariantChars * 1.5) / sentence.length));
	const output = parseBootstrapModelOutput(
		JSON.stringify({ projectName: "harbor", identity: "A harbor.", conventions: [], invariants: [long], sections: [] }),
	);
	const clamped = output.invariants?.[0] ?? "";
	ok(clamped.length <= HANDBOOK_TARGETS.invariantChars, `${clamped.length}`);
	ok(clamped.endsWith("`STAGE0_SEAMS`."), clamped.slice(-40));
});
