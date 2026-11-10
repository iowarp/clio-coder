#!/usr/bin/env node
// `pnpm run typecheck:compare`: runs the reference compiler (TypeScript 7
// `tsc`, behind `pnpm run typecheck:tsc`) and the default one (`tsrs --fast`,
// behind `pnpm run typecheck`) over the same project and compares their
// diagnostics as sorted sets. Release preparation runs this instead of
// `typecheck`, so the gate stays tsc's verdict and any divergence in the port
// fails the candidate rather than hiding a type error. See "Typechecking" in
// CONTRIBUTING.md for what to do when they differ.
//
//   node scripts/typecheck-compare.mjs [--project tsconfig.tests.json] [--default-mode]
//
// Exit 0: tsc passes and tsrs agrees. Exit 1: tsc reports errors, the
// diagnostics differ, or tsrs crashed. Where tsrs is unavailable on this
// platform it says so and the verdict is tsc's alone. Only pass versus fail of
// the exit code is compared: on errors tsc exits 1 and tsrs exits 2.
// TSRS_BIN names another tsrs binary (for example a local build).
import { spawnSync } from "node:child_process";
import { resolveTsc, resolveTsrs, root, tsrsVerdict } from "./typecheck.mjs";

const args = process.argv.slice(2);
const flagValue = (name) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const project = flagValue("--project") ?? "tsconfig.tests.json";
const fast = !args.includes("--default-mode");
const common = ["-p", project, "--noEmit", "--incremental", "false", "--pretty", "false"];

function run(label, command, commandArgs) {
	const started = performance.now();
	const result = spawnSync(command, [...commandArgs, ...common], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	const seconds = (performance.now() - started) / 1000;
	// Both compilers print `file(line,col): error TSnnnn: message`; continuation lines are indented.
	const diagnostics = `${result.stdout}\n${result.stderr}`
		.split(/\r?\n/u)
		.filter((line) => /\berror TS\d+:/u.test(line))
		.sort();
	return { label, seconds, result, status: result.status, diagnostics };
}

const reference = run("tsc", process.execPath, [resolveTsc()]);
if (reference.result.error) throw new Error(`tsc failed to start: ${reference.result.error.message}`);
const report = (entry) =>
	process.stdout.write(
		`${entry.label.padEnd(12)} ${entry.seconds.toFixed(2)} s  exit ${entry.status}  ${entry.diagnostics.length} diagnostics\n`,
	);
report(reference);
const referencePassed = reference.status === 0;
if (!referencePassed) process.stdout.write(`${reference.result.stdout}${reference.result.stderr}`);

const tsrs = await resolveTsrs();
if (!tsrs.path) {
	process.stdout.write(`\ntsrs is unavailable (${tsrs.reason}); the verdict is tsc's alone.\n`);
	process.exit(referencePassed ? 0 : 1);
}
const candidate = run(fast ? "tsrs --fast" : "tsrs", tsrs.path, fast ? ["--fast"] : []);
report(candidate);
if (!tsrsVerdict(candidate.result)) {
	process.stdout.write(
		`\ntsrs crashed (${candidate.result.error?.message ?? candidate.result.signal ?? `exit ${candidate.status}`}).\n${candidate.result.stderr ?? ""}`,
	);
	process.exit(1);
}

const referenceSet = new Set(reference.diagnostics);
const candidateSet = new Set(candidate.diagnostics);
const onlyReference = reference.diagnostics.filter((line) => !candidateSet.has(line));
const onlyCandidate = candidate.diagnostics.filter((line) => !referenceSet.has(line));

if (onlyReference.length > 0 || onlyCandidate.length > 0 || referencePassed !== (candidate.status === 0)) {
	process.stdout.write(
		`\nDiagnostics differ (tsc exit ${reference.status}, ${candidate.label} exit ${candidate.status}). tsc is authoritative; see "Typechecking" in CONTRIBUTING.md.\n`,
	);
	for (const line of onlyReference) process.stdout.write(`  only tsc:  ${line}\n`);
	for (const line of onlyCandidate) process.stdout.write(`  only tsrs: ${line}\n`);
	process.exit(1);
}
process.stdout.write(
	`\nSame diagnostics; ${candidate.label} is ${(reference.seconds / candidate.seconds).toFixed(1)}x faster.\n`,
);
process.exit(referencePassed ? 0 : 1);
