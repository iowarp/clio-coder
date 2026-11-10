#!/usr/bin/env node
// Cross-check between the default typechecker (`tsrs --fast`, the Rust port of
// TypeScript 7, behind `pnpm run typecheck`) and the reference compiler
// (TypeScript 7 `tsc`, behind `pnpm run typecheck:tsc`). It runs both over the
// same project, compares the diagnostics as sorted sets, and prints wall time
// for each, so a divergence in the port shows up as a failing check rather than
// as a missed type error.
//
//   node scripts/typecheck-compare.mjs [--project tsconfig.tests.json] [--default-mode]
//
// Exit 0: same diagnostics. Exit 1: they differ, or either compiler failed to
// run. Only pass versus fail of the exit code is compared: on errors `tsc`
// exits 1 and `tsrs` exits 2. TSRS_BIN names another tsrs binary (for example a local build).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flagValue = (name) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const project = flagValue("--project") ?? "tsconfig.tests.json";
const fast = !args.includes("--default-mode");
const windows = process.platform === "win32";

const bin = (name) => join(root, "node_modules", ".bin", windows ? `${name}.cmd` : name);
const tsc = bin("tsc");
const tsrs = process.env.TSRS_BIN ?? bin("tsrs");
for (const [label, path] of [
	["tsc", tsc],
	["tsrs", tsrs],
]) {
	if (!existsSync(path)) {
		process.stderr.write(`${label} not found at ${path}; run pnpm install.\n`);
		process.exit(1);
	}
}

const common = ["-p", project, "--noEmit", "--incremental", "false", "--pretty", "false"];

function run(label, path, extra = []) {
	const started = performance.now();
	const result = spawnSync(path, [...common, ...extra], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		shell: windows,
	});
	const seconds = (performance.now() - started) / 1000;
	if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
	// Both compilers print `file(line,col): error TSnnnn: message`; continuation lines are indented.
	const diagnostics = `${result.stdout}\n${result.stderr}`
		.split(/\r?\n/u)
		.filter((line) => /\berror TS\d+:/u.test(line))
		.sort();
	return { label, seconds, status: result.status, diagnostics };
}

const reference = run("tsc", tsc);
const candidate = run(fast ? "tsrs --fast" : "tsrs", tsrs, fast ? ["--fast"] : []);

for (const result of [reference, candidate])
	process.stdout.write(
		`${result.label.padEnd(12)} ${result.seconds.toFixed(2)} s  exit ${result.status}  ${result.diagnostics.length} diagnostics\n`,
	);

const referenceSet = new Set(reference.diagnostics);
const candidateSet = new Set(candidate.diagnostics);
const onlyReference = reference.diagnostics.filter((line) => !candidateSet.has(line));
const onlyCandidate = candidate.diagnostics.filter((line) => !referenceSet.has(line));

if (onlyReference.length > 0 || onlyCandidate.length > 0 || (reference.status === 0) !== (candidate.status === 0)) {
	process.stdout.write(
		`\nDiagnostics differ (tsc exit ${reference.status}, ${candidate.label} exit ${candidate.status}).\n`,
	);
	for (const line of onlyReference) process.stdout.write(`  only tsc:  ${line}\n`);
	for (const line of onlyCandidate) process.stdout.write(`  only tsrs: ${line}\n`);
	process.exit(1);
}
process.stdout.write(
	`\nSame diagnostics; ${candidate.label} is ${(reference.seconds / candidate.seconds).toFixed(1)}x faster.\n`,
);
