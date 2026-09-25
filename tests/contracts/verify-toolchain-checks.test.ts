import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { discoverToolchainChecks } from "../../src/tools/verify/toolchain-checks.js";

const roots: string[] = [];
const originalCwd = process.cwd();

function workspace(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-verify-toolchain-")));
	roots.push(root);
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(join(root, relative, ".."), { recursive: true });
		writeFileSync(join(root, relative), text, "utf8");
	}
	return root;
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commandOf(root: string, id: string): string[] | undefined {
	return discoverToolchainChecks(root).find((check) => check.id === id)?.command;
}

function textOf(result: Awaited<ReturnType<typeof verifyTool.run>>): string {
	return result.kind === "ok" ? result.output : result.message;
}

/** What a headless run does with a verify call: the net decision, then the autonomy mapping. */
function admission(root: string, args: Record<string, unknown>, level: "yolo" | "default"): string {
	const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({ tool: "verify", args });
	if (decision.kind !== "allow") return decision.kind;
	return mapAutonomy(level, decision.actionClass, { executeRecognized: decision.execRecognition !== "unrecognized" });
}

const PYPROJECT = '[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = ["pydantic>=2"]\n';

describe("verify in repositories without package.json", () => {
	it("derives a uv-launched unittest check from pyproject.toml, uv.lock and a tests directory", () => {
		const root = workspace({ "pyproject.toml": PYPROJECT, "uv.lock": "version = 1\n", "tests/test_a.py": "" });
		deepStrictEqual(commandOf(root, "python-unittest"), [
			"uv",
			"run",
			"python",
			"-m",
			"unittest",
			"discover",
			"-s",
			"tests",
		]);
		strictEqual(commandOf(root, "python-pytest"), undefined);
	});

	it("follows pytest when the project declares it as a dependency", () => {
		const root = workspace({
			"pyproject.toml": `${PYPROJECT}\n[dependency-groups]\ndev = ["pytest>=8"]\n`,
			"uv.lock": "version = 1\n",
			"tests/test_a.py": "",
		});
		deepStrictEqual(commandOf(root, "python-pytest"), ["uv", "run", "python", "-m", "pytest"]);
		strictEqual(commandOf(root, "python-unittest"), undefined);
	});

	it("lists Makefile verification targets and the scripts CI runs, and skips setup steps", () => {
		const root = workspace({
			Makefile: "install:\n\tpip install .\ntest:\n\t@echo make-test-ran\nlint:\n\t@echo lint\n",
			".github/workflows/gate.yml":
				"on: push\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: uv sync\n      - name: Gate\n        run: sh scripts/gate.sh\n",
			"scripts/gate.sh": "echo gate-ran\n",
		});
		deepStrictEqual(commandOf(root, "make-test"), ["make", "test"]);
		deepStrictEqual(commandOf(root, "make-lint"), ["make", "lint"]);
		strictEqual(commandOf(root, "make-install"), undefined);
		deepStrictEqual(commandOf(root, "ci-gate"), ["sh", "scripts/gate.sh"]);
		ok(!discoverToolchainChecks(root).some((check) => check.command[0] === "uv"));
	});

	it("runs a derived check through verify and resolves a family word when one check owns it", async () => {
		const root = workspace({
			".github/workflows/gate.yml": "jobs:\n  gate:\n    steps:\n      - run: sh scripts/gate.sh\n",
			"scripts/gate.sh": "echo gate-ran\n",
		});
		process.chdir(root);
		const listed = await verifyTool.run({});
		strictEqual(listed.kind, "ok");
		match(textOf(listed), /ci-gate/);
		const ran = await verifyTool.run({ check: "ci-gate" });
		strictEqual(ran.kind, "ok", textOf(ran));
		match(textOf(ran), /gate-ran/);
		strictEqual(ran.details?.check, "ci-gate");
		const alias = await verifyTool.run({ check: "ci" });
		strictEqual(alias.kind, "ok", textOf(alias));
		match(textOf(alias), /gate-ran/);
	});

	it("never runs an undeclared check string", async () => {
		const root = workspace({ "pyproject.toml": PYPROJECT, "tests/test_a.py": "" });
		process.chdir(root);
		const marker = join(root, "ran");
		const refused = await verifyTool.run({ check: `touch ${marker}` });
		strictEqual(refused.kind, "error");
		match(textOf(refused), /python-unittest/);
		strictEqual(existsSync(marker), false);
	});

	it("names what it looked for when nothing is declared and points at bash", async () => {
		const root = workspace({ "README.md": "# demo\n" });
		process.chdir(root);
		const result = await verifyTool.run({ check: "test" });
		strictEqual(result.kind, "error");
		doesNotMatch(textOf(result), /package\.json not found/);
		match(textOf(result), /pyproject\.toml/);
		match(textOf(result), /Makefile/);
		match(textOf(result), /bash/);
	});
});

describe("verify admission under headless autonomy", () => {
	it("admits a derived check at yolo exactly as bash admits its command", () => {
		const root = workspace({ "pyproject.toml": PYPROJECT, "uv.lock": "version = 1\n", "tests/test_a.py": "" });
		strictEqual(admission(root, { check: "python-unittest" }, "yolo"), "allow");
		strictEqual(
			admission(root, { check: "python-unittest" }, "yolo"),
			(() => {
				const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({
					tool: "bash",
					args: { command: "uv run python -m unittest discover -s tests" },
				});
				return decision.kind === "allow"
					? mapAutonomy("yolo", decision.actionClass, {
							executeRecognized: decision.execRecognition !== "unrecognized",
						})
					: decision.kind;
			})(),
		);
		strictEqual(admission(root, { check: "python-unittest" }, "default"), "ask");
	});

	it("runs a package typecheck or lint at yolo and asks at default", () => {
		const root = workspace({
			"package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "biome check ." } }),
		});
		for (const check of ["typecheck", "lint"]) {
			strictEqual(admission(root, { check }, "yolo"), "allow", check);
			strictEqual(admission(root, { check }, "default"), "ask", check);
		}
	});

	it("does not turn a listing or an undeclared id into a permission ask", () => {
		const root = workspace({ "pyproject.toml": PYPROJECT, "tests/test_a.py": "" });
		strictEqual(admission(root, { check: "" }, "yolo"), "allow");
		strictEqual(admission(root, {}, "default"), "allow");
		strictEqual(admission(root, { check: "pytest tests/test_a.py" }, "yolo"), "allow");
	});

	it("scans model-supplied arguments with the resolved command", () => {
		const root = workspace({ "pyproject.toml": PYPROJECT, "tests/test_a.py": "" });
		const engine = createSafetyPolicyEngine({ cwd: root });
		const hidden = engine.evaluate({ tool: "verify", args: { check: "python-unittest", args: ["$(touch x)"] } });
		strictEqual(hidden.kind, "ask");
		strictEqual(hidden.reasonCode, "verify-unrecognized-argv");
		strictEqual(
			engine.evaluate({ tool: "verify", args: { check: "python-unittest", args: '["$(touch x)"]' } }).kind,
			"ask",
			"the JSON-string argument shape accepted by verify has the same safety decision",
		);
		strictEqual(admission(root, { check: "python-unittest", args: ["tests.test_a"] }, "yolo"), "allow");
		const destructive = engine.evaluate({
			tool: "verify",
			args: { check: "python-unittest", args: ["&&", "rm", "-rf", "/"] },
		});
		strictEqual(destructive.kind, "block");
	});

	it("scans package-script arguments after the declared script name", () => {
		const root = workspace({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
		strictEqual(admission(root, { check: "test", args: ["safe.test.js"] }, "yolo"), "allow");
		const hidden = createSafetyPolicyEngine({ cwd: root }).evaluate({
			tool: "verify",
			args: { check: "test", args: ["$(touch x)"] },
		});
		strictEqual(hidden.kind, "ask");
		strictEqual(hidden.reasonCode, "verify-unrecognized-argv");
	});

	it("uses a catalog check's execution cwd for relative secret reads", () => {
		const root = workspace({
			".env": "SECRET=value\n",
			"nested/keep": "",
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 1,
				checks: [
					{
						id: "read-env",
						description: "Read env",
						command: ["cat", "../.env"],
						cwd: "nested",
						timeoutMs: 30000,
						tags: [],
					},
				],
			}),
		});
		const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({ tool: "verify", args: { check: "read-env" } });
		strictEqual(decision.cwd, join(root, "nested"));
		strictEqual(decision.kind, "block");
		strictEqual(decision.reasonCode, "secret_path_bash");
	});

	it("ignores a model cwd that the derived runner does not execute in", () => {
		const root = workspace({
			"pyproject.toml": PYPROJECT,
			"tests/test_a.py": "",
			".env": "SECRET=value\n",
			"other/keep": "",
		});
		const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({
			tool: "verify",
			args: { check: "python-unittest", args: [".env"], cwd: "other" },
		});
		strictEqual(decision.cwd, root);
		strictEqual(decision.kind, "block");
		strictEqual(decision.reasonCode, "secret_path_bash");
	});
});
