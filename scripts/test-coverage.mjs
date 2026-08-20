#!/usr/bin/env node
/**
 * Test coverage runner. Runs the test suite under Node's experimental
 * coverage reporter with temporary V8 coverage dumps and scratch roots
 * directed to a disk-backed temporary directory (defaults to /var/tmp,
 * overrideable via the CLIO_CODER_COVERAGE_TMP environment variable).
 *
 * This avoids filling the tmpfs mount (4.0 GB) with uncompressed V8
 * coverage JSON dumps across 364+ test files, preventing ENOSPC errors
 * and ensuring Node's built-in coverage aggregator successfully outputs
 * the coverage summary table.
 *
 * Single temporary root under <base>/clio-coverage-<pid> with V8 dumps in
 * <root>/v8-coverage, cleaned up in one step on exit (including SIGINT,
 * SIGTERM, SIGHUP, SIGPIPE, and normal exit).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_BASE = process.env.CLIO_CODER_COVERAGE_TMP || "/var/tmp";
const TEST_TMP = join(TMP_BASE, `clio-coverage-${process.pid}`);
const V8_COVERAGE_DIR = join(TEST_TMP, "v8-coverage");

mkdirSync(V8_COVERAGE_DIR, { recursive: true });

const env = {
	...process.env,
	TMPDIR: TEST_TMP,
	NODE_V8_COVERAGE: V8_COVERAGE_DIR,
	CLIO_CODER_TEST_TMP_ROOT: TEST_TMP,
};

const passedArgs = process.argv.slice(2);
const defaultArgs = [
	"--import",
	"tsx",
	"--import",
	"./tests/harness/tmp-root.ts",
	"--test",
	"--experimental-test-coverage",
	"--test-coverage-include=src/**/*.ts",
	"--test-coverage-exclude=src/**/*.d.ts",
	"tests/contracts/**/*.test.ts",
	"tests/smoke/**/*.test.ts",
];

const runnerArgs =
	passedArgs.length > 0
		? ["--import", "tsx", "--import", "./tests/harness/tmp-root.ts", "--test", ...passedArgs]
		: defaultArgs;

const child = spawn(process.execPath, runnerArgs, {
	cwd: REPO_ROOT,
	env,
	stdio: "inherit",
});

let cleaned = false;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	try {
		if (existsSync(TEST_TMP)) {
			rmSync(TEST_TMP, { recursive: true, force: true });
		}
	} catch {
		// Best effort cleanup
	}
}

process.on("exit", cleanup);

child.on("close", (code) => {
	cleanup();
	process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) {
	process.on(signal, () => {
		try {
			child.kill(signal);
		} catch {
			// Best effort child termination
		}
		cleanup();
		process.exit(1);
	});
}
