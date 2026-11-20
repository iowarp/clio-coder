import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	type PathLike,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, mock } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { mainSandboxPolicy } from "../../src/core/sandbox/main-session.js";
import { parseCodeReport } from "../../src/domains/agents/result-contract.js";
import {
	CODE_STEP_CAPTURE_MAX_BYTES,
	CODE_STEP_EXCERPT_MAX_BYTES,
	commitPointSnapshot,
	readCommitBaseline,
	runCodeStep,
	workspaceChangeSnapshot,
	writeCommitBaseline,
} from "../../src/domains/dispatch/code-step.js";
import {
	changedCheckoutPaths,
	RACY_DIGEST_MAX_FILES,
	snapshotCheckoutSince,
	takeCheckoutBaseline,
} from "../../src/tools/checkout-changes.js";
import { resolveTestFileChecks } from "../../src/tools/verify/test-files.js";

const roots: string[] = [];

afterEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkoutFixture(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"]);
	return root;
}

/**
 * Reports `ctimeNs` for the named files as a filesystem whose change clock did not move between two writes, and
 * records the names of files read whole from then on.
 */
function pinChangeTime(root: string, ctimeNs: bigint, names: readonly string[]): string[] {
	const pinned = new Set(names.map((name) => join(root, name)));
	const reads: string[] = [];
	const { lstat, readFile } = fsPromises;
	mock.method(fsPromises, "lstat", (async (path: PathLike, options?: { bigint?: boolean }) => {
		const stat = await lstat(path, { bigint: options?.bigint === true });
		if (pinned.has(String(path))) Object.assign(stat, { ctimeNs });
		return stat;
	}) as typeof lstat);
	mock.method(fsPromises, "readFile", (async (path: PathLike) => {
		reads.push(String(path).slice(root.length + 1));
		return readFile(path);
	}) as typeof readFile);
	syncBuiltinESMExports();
	return reads;
}

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

it("a successful leader cannot leave its background child running", {
	skip: process.platform === "win32",
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-code-step-descendant-"));
	roots.push(root);
	const ready = join(root, "ready");
	const stopped = join(root, "stopped");
	const background = `
		const fs = require('node:fs');
		process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); });
		fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
		setInterval(() => {}, 1000);
	`;
	const script = `
		const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(background)}], {stdio:'ignore'});
		child.unref();
		const timer = setInterval(() => {
			if (!require('node:fs').existsSync(${JSON.stringify(ready)})) return;
			clearInterval(timer);
			process.stdout.write(String(child.pid), () => process.exit(0));
		}, 10);
	`;
	let pid: number | undefined;
	try {
		const result = await runCodeStep({
			stepId: "descendant",
			command: {
				id: "check",
				argv: [process.execPath, "-e", script],
				cwd: "",
				timeoutMs: 10_000,
				env: [],
				description: "Owned child",
			},
			workspaceRoot: root,
		});
		pid = Number(result.stdout);
		ok(existsSync(stopped), "the descendant must receive cleanup before the code-step settles");
	} finally {
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
});

it("a sandboxed command that times out gets SIGTERM before it is killed", {
	skip: !sandboxAvailability().available,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-code-step-sandbox-term-"));
	roots.push(root);
	const handler = `
		process.on('SIGTERM', () => { require('node:fs').writeFileSync('term-marker', '1'); process.exit(0); });
		setInterval(() => {}, 1000);
	`;
	const result = await runCodeStep({
		stepId: "measurement",
		command: {
			id: "graceful",
			argv: [process.execPath, "-e", handler],
			cwd: "",
			timeoutMs: 2_000,
			env: [],
			description: "Sandboxed SIGTERM fixture",
		},
		workspaceRoot: root,
		shellSandbox: mainSandboxPolicy({ workspace: root, scratchRoots: [] }),
	});
	strictEqual(result.record.timedOut, true);
	ok(existsSync(join(root, "term-marker")), "the sandboxed command never saw SIGTERM");
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

it("targets a changed jest or vitest file so an empty selection fails, whatever the script's --passWithNoTests", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-changed-test-js-"));
	roots.push(root);
	mkdirSync(join(root, "integration"));
	writeFileSync(join(root, "integration", "api.test.js"), "test('api', () => {});\n");
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "jest --passWithNoTests" } }));
	deepStrictEqual(resolveTestFileChecks(root, ["integration/api.test.js"]).checks[0]?.argv, [
		"npm",
		"run",
		"test",
		"--",
		"--runTestsByPath",
		"--passWithNoTests=false",
		"./integration/api.test.js",
	]);
	// Vitest refuses the flag twice, so its script runs directly without its own --passWithNoTests.
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	const vitest = join(root, "node_modules", ".bin", "vitest");
	writeFileSync(vitest, "#!/bin/sh\n");
	chmodSync(vitest, 0o755);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run --passWithNoTests" } }));
	deepStrictEqual(resolveTestFileChecks(root, ["integration/api.test.js"]).checks[0]?.argv, [
		vitest,
		"run",
		"--passWithNoTests=false",
		"./integration/api.test.js",
	]);
});

it("fails the check without a repair when a changed test's known runner needs provisioning", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-changed-test-uv-"));
	roots.push(root);
	writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "api"\n\n[tool.pytest.ini_options]\n');
	writeFileSync(join(root, "uv.lock"), "version = 1\n");
	mkdirSync(join(root, "tests"));
	writeFileSync(join(root, "tests", "test_api.py"), "def test_api():\n    assert True\n");
	const outcome = await runCodeStep({
		stepId: "check",
		command: {
			id: "lint",
			argv: [process.execPath, "-e", ""],
			cwd: "",
			timeoutMs: 30_000,
			env: [],
			description: "Declared lint",
		},
		workspaceRoot: root,
		mutatedPaths: ["tests/test_api.py"],
	});
	strictEqual(outcome.report.passed, false);
	strictEqual(outcome.report.checks[0]?.passed, true);
	strictEqual(outcome.report.checks[1]?.name, "changed tests (python-pytest)");
	match(outcome.report.checks[1]?.evidence ?? "", /tests\/test_api\.py was not run.*\.venv is missing.*uv sync/u);
	strictEqual(outcome.unrepairable, true);
	// The sealed report validates with the check's execution state.
	strictEqual(parseCodeReport(outcome.output)?.checks[1]?.ran, false);
	strictEqual(parseCodeReport(outcome.output)?.checks[0]?.ran, true);
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

it("a run's checkout delta reads only files whose stat moved or that sat in the tick window, and concurrent spawns share one baseline", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-checkout-delta-"));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"]);
	const large = Buffer.alloc(1024 * 1024 + 1, 7);
	for (const name of ["same-size.txt", "touched.txt"]) writeFileSync(join(root, name), "aaaa\n");
	for (const name of ["large-kept.bin", "large-rewritten.bin"]) writeFileSync(join(root, name), large);
	const shared = [takeCheckoutBaseline(root), takeCheckoutBaseline(root), takeCheckoutBaseline(root)];
	const [before, ...peers] = await Promise.all(shared);
	if (!before) throw new Error("the fixture is a git workspace");
	for (const peer of peers) strictEqual(peer, before);
	notStrictEqual(await takeCheckoutBaseline(root), before);
	const later = new Date(Date.now() + 60_000);
	// Same size, new bytes: read again because its stat moved.
	writeFileSync(join(root, "same-size.txt"), "bbbb\n");
	// Same bytes rewritten: read again and found unchanged.
	writeFileSync(join(root, "touched.txt"), "aaaa\n");
	// Same bytes over 1 MiB: never read, so its stat tuple is the identity and it counts as changed.
	writeFileSync(join(root, "large-rewritten.bin"), large);
	for (const name of ["same-size.txt", "touched.txt", "large-rewritten.bin"]) utimesSync(join(root, name), later, later);
	const after = await snapshotCheckoutSince(before, root);
	if (!after) throw new Error("the fixture is a git workspace");
	deepStrictEqual(changedCheckoutPaths(before, after), ["large-rewritten.bin", "same-size.txt"]);
});

it("a same-size rewrite inside one timestamp tick of the baseline is reported although its stat held", async () => {
	const root = checkoutFixture("clio-coder-checkout-tick-");
	const file = join(root, "same-tick.txt");
	writeFileSync(file, "aaaa\n");
	// A tick that has not ended when the baseline reads the file: a later write in it keeps every timestamp.
	const tick = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
	utimesSync(file, tick, tick);
	pinChangeTime(root, BigInt(tick.getTime()) * 1_000_000n, ["same-tick.txt"]);
	const before = await takeCheckoutBaseline(root);
	if (!before) throw new Error("the fixture is a git workspace");
	writeFileSync(file, "bbbb\n");
	utimesSync(file, tick, tick);
	const after = await snapshotCheckoutSince(before, root);
	if (!after) throw new Error("the fixture is a git workspace");
	deepStrictEqual(changedCheckoutPaths(before, after), ["same-tick.txt"]);
});

it("a dirty file whose timestamps predate the tick window keeps the cheap stat check and is not read again", async () => {
	const root = checkoutFixture("clio-coder-checkout-settled-");
	const settled = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);
	const tick = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
	for (const [name, time] of [
		["settled.txt", settled],
		["in-tick.txt", tick],
	] as const) {
		writeFileSync(join(root, name), "aaaa\n");
		utimesSync(join(root, name), time, time);
	}
	const reads = pinChangeTime(root, BigInt(settled.getTime()) * 1_000_000n, ["settled.txt"]);
	const before = await takeCheckoutBaseline(root);
	if (!before) throw new Error("the fixture is a git workspace");
	reads.length = 0;
	const after = await snapshotCheckoutSince(before, root);
	if (!after) throw new Error("the fixture is a git workspace");
	deepStrictEqual(reads, ["in-tick.txt"]);
	deepStrictEqual(changedCheckoutPaths(before, after), []);
});

it("content checks of files inside the tick window stop at the cap and report the rest as possibly changed", async () => {
	const root = checkoutFixture("clio-coder-checkout-cap-");
	const tick = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
	const names = Array.from({ length: RACY_DIGEST_MAX_FILES + 2 }, (_, index) => `in-tick-${index}.txt`);
	for (const name of names) {
		writeFileSync(join(root, name), "aaaa\n");
		utimesSync(join(root, name), tick, tick);
	}
	const reads = pinChangeTime(root, BigInt(tick.getTime()) * 1_000_000n, names);
	const before = await takeCheckoutBaseline(root);
	if (!before) throw new Error("the fixture is a git workspace");
	reads.length = 0;
	const after = await snapshotCheckoutSince(before, root);
	if (!after) throw new Error("the fixture is a git workspace");
	strictEqual(reads.length, RACY_DIGEST_MAX_FILES);
	const reported = changedCheckoutPaths(before, after);
	strictEqual(reported.length, 2);
	for (const name of reported) ok(!reads.includes(name), `${name} was read yet reported`);
});
