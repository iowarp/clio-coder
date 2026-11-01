import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import {
	CODE_STEP_CAPTURE_MAX_BYTES,
	CODE_STEP_EXCERPT_MAX_BYTES,
	commitPointSnapshot,
	readCommitBaseline,
	runCodeStep,
	workspaceChangeSnapshot,
	writeCommitBaseline,
} from "../../src/domains/dispatch/code-step.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(script: string) {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-code-step-output-"));
	roots.push(root);
	return runCodeStep({
		stepId: "measurement",
		command: {
			id: "value",
			argv: [process.execPath, "-e", script],
			cwd: "",
			timeoutMs: 30_000,
			env: [],
			description: "Local measurement fixture",
		},
		workspaceRoot: root,
		artifactDir: join(root, "artifacts"),
	});
}

it("carries stdout beyond the report excerpt and retains stderr diagnostics in the artifact", async () => {
	const payload = `${" ".repeat(CODE_STEP_EXCERPT_MAX_BYTES)}{"value":2}\n`;
	const diagnostic = '{"energy":1}\n';
	const result = await run(
		`process.stdout.write(${JSON.stringify(payload)}); process.stderr.write(${JSON.stringify(diagnostic)});`,
	);
	strictEqual(result.record.exitCode, 0);
	strictEqual(result.stdout, payload);
	strictEqual(JSON.parse(result.stdout).value, 2);
	ok(result.stdout.length > CODE_STEP_EXCERPT_MAX_BYTES);
	const artifactPath = result.record.artifactPaths[0];
	ok(artifactPath);
	const artifact = readFileSync(artifactPath, "utf8");
	ok(artifact.includes(payload));
	ok(artifact.includes(diagnostic));
	match(result.report.outputExcerpt, /output truncated/u);
});

it("bounds stdout with the existing command capture cap", async () => {
	const producedBytes = CODE_STEP_CAPTURE_MAX_BYTES + 4096;
	const result = await run(`process.stdout.write("x".repeat(${producedBytes}));`);
	strictEqual(result.record.exitCode, 0);
	strictEqual(Buffer.byteLength(result.stdout, "utf8"), CODE_STEP_CAPTURE_MAX_BYTES);
	strictEqual(result.record.outputBytes, producedBytes);
	strictEqual(result.record.outputTruncated, true);
});

it("fails the check when a newly reported test fails outside the declared suite", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-changed-test-"));
	roots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test visible.test.cjs" } }));
	writeFileSync(join(root, "visible.test.cjs"), "require('node:test')('visible', () => {});\n");
	writeFileSync(
		join(root, "repro.test.cjs"),
		"require('node:test')('reproduction', () => { throw Error('still broken'); });\n",
	);
	const input = {
		stepId: "check",
		command: {
			id: "test",
			argv: [process.execPath, "--test", "visible.test.cjs"],
			cwd: "",
			timeoutMs: 30_000,
			env: [],
			description: "Declared suite",
		},
		workspaceRoot: root,
	};
	strictEqual((await runCodeStep(input)).report.passed, true);
	const failed = await runCodeStep({ ...input, mutatedPaths: ["repro.test.cjs"] });
	strictEqual(failed.report.passed, false);
	strictEqual(failed.report.exitCode, 1);
	strictEqual(failed.report.checks[0]?.passed, true);
	strictEqual(failed.report.checks[1]?.passed, false);
	match(failed.report.outputExcerpt, /still broken/u);
	writeFileSync(join(root, "repro.test.cjs"), "require('node:test')('reproduction', () => {});\n");
	strictEqual((await runCodeStep({ ...input, mutatedPaths: ["repro.test.cjs"] })).report.passed, true);
	writeFileSync(join(root, "repro.test.unknown"), "no runner\n");
	const fallback = await runCodeStep({ ...input, mutatedPaths: ["repro.test.unknown"] });
	strictEqual(fallback.report.passed, true);
	match(fallback.report.outputExcerpt, /no recognizable project runner.*declared check only/u);
});

it("commits neither a file that only stopped being ignored nor a rewrite behind a staged deletion", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-commit-ignored-"));
	roots.push(root);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.name", "Contract");
	git("config", "user.email", "contract@example.invalid");
	writeFileSync(join(root, ".gitignore"), ".env\n");
	writeFileSync(join(root, "tracked.env"), "OLD=canary\n");
	git("add", ".");
	git("commit", "-qm", "base");
	writeFileSync(join(root, ".env"), "PRE_EXISTING_SECRET=canary\n");
	const artifactDir = join(root, ".git", "code-step");
	const before = commitPointSnapshot(root);
	if (before === null) throw new Error("the fixture is a git workspace");
	writeCommitBaseline(artifactDir, before);
	writeFileSync(join(root, ".gitignore"), "tracked.env\n");
	git("rm", "-q", "--cached", "tracked.env");
	writeFileSync(join(root, "tracked.env"), "NEW_SECRET=canary\n");
	writeFileSync(join(root, "work.c"), "edited\n");
	const outcome = await runCodeStep({
		command: {
			id: "commit",
			argv: ["git", "commit", "-m", "{{commitMessage}}"],
			cwd: "",
			timeoutMs: 10_000,
			env: [],
			description: "Local commit fixture",
		},
		stepId: "commit-code",
		workspaceRoot: root,
		artifactDir,
		substitutions: { commitMessage: "record the work" },
		requireWorkspaceChanges: true,
		stage: { baseline: readCommitBaseline(artifactDir), artifacts: [] },
	});
	strictEqual(outcome.report.passed, true, outcome.report.checks[0]?.evidence);
	strictEqual(git("show", "--name-status", "--format=", "HEAD"), "M\t.gitignore\nD\ttracked.env\nA\twork.c\n");
	strictEqual(git("status", "--porcelain"), "?? .env\n");
	match(outcome.report.checks[0]?.evidence ?? "", /1 other change\(s\) left out of this commit: \.env/);
});

it("stages everything since the last commit point, including an ignored required artifact", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-commit-stage-"));
	roots.push(root);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.name", "Contract");
	git("config", "user.email", "contract@example.invalid");
	writeFileSync(join(root, ".gitignore"), ".clio-coder/\n");
	for (const name of ["calc.c", "gone.c", "repaired.c"]) writeFileSync(join(root, name), "base\n");
	git("add", ".");
	git("commit", "-qm", "base");
	writeFileSync(join(root, "operator-scratch.txt"), "not this run's\n");
	writeFileSync(join(root, ".env"), "PRE_EXISTING_SECRET=canary\n");
	const artifactDir = join(root, ".git", "code-step");
	const before = workspaceChangeSnapshot(root);
	if (before === null) throw new Error("the fixture is a git workspace");
	writeCommitBaseline(artifactDir, before);
	// A worker ignoring a file that was already untracked must not read as producing it.
	writeFileSync(join(root, ".gitignore"), ".clio-coder/\n.env\n");
	mkdirSync(join(root, ".clio-coder", "artifacts"), { recursive: true });
	writeFileSync(join(root, ".clio-coder", "artifacts", "PLAN.md"), "plan\n");
	writeFileSync(join(root, "calc.c"), "edited\n");
	writeFileSync(join(root, "repaired.c"), "edited by a repair in an earlier process\n");
	writeFileSync(join(root, "new file.c"), "new\n");
	// Staged, as a crash between staging and committing leaves it.
	git("rm", "-q", "gone.c");
	const outcome = await runCodeStep({
		command: {
			id: "commit",
			argv: ["git", "commit", "-m", "{{commitMessage}}"],
			cwd: "",
			timeoutMs: 10_000,
			env: [],
			description: "Local commit fixture",
		},
		stepId: "commit-code",
		workspaceRoot: root,
		artifactDir,
		substitutions: { commitMessage: "record the work" },
		requireWorkspaceChanges: true,
		stage: { baseline: readCommitBaseline(artifactDir), artifacts: [".clio-coder/artifacts/PLAN.md"] },
	});
	strictEqual(outcome.report.passed, true, outcome.report.checks[0]?.evidence);
	strictEqual(
		git("show", "--name-status", "--format=", "HEAD"),
		"A\t.clio-coder/artifacts/PLAN.md\nM\t.gitignore\nM\tcalc.c\nD\tgone.c\nA\tnew file.c\nM\trepaired.c\n",
	);
	strictEqual(git("status", "--porcelain"), "?? operator-scratch.txt\n");
	match(outcome.report.checks[0]?.evidence ?? "", /1 other change\(s\) left out of this commit: operator-scratch\.txt/);
});
