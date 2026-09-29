#!/usr/bin/env node
// Refuses commits and pushes that carry a path .gitignore excludes. The ignore
// file alone cannot: `git add -f` stages an ignored path, and agents used it to
// commit private plans that later went public (purged in 0.5.9). check-hygiene's
// tracked-ignored rule catches the same condition in CI; this guard stops it
// before a commit or a push leaves the machine.
//
//   node scripts/git-guard.mjs install     write the pre-commit and pre-push hooks
//   node scripts/git-guard.mjs pre-commit  check the staged paths
//   node scripts/git-guard.mjs pre-push    check the commits being pushed (Git passes refs on stdin)

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MARKER = "# clio-coder git-guard";
const ZERO = /^0+$/;

function git(args, input) {
	return execFileSync("git", args, {
		encoding: "utf8",
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		maxBuffer: 256 * 1024 * 1024,
	});
}

function nulList(text) {
	return text.split("\0").filter((entry) => entry.length > 0);
}

// --no-index judges each path by the ignore rules alone, since every path here
// is already staged or committed and would otherwise count as tracked.
function ignoredPaths(paths) {
	if (paths.length === 0) return [];
	try {
		return nulList(git(["check-ignore", "--no-index", "-z", "--stdin"], `${paths.join("\0")}\0`));
	} catch (error) {
		// Exit status 1 means nothing matched; anything else is a real failure.
		if (error.status === 1) return [];
		throw error;
	}
}

function refuse(action, offenders) {
	process.stderr.write(
		`git-guard: refusing ${action}; these paths match .gitignore and must stay out of Git:\n` +
			offenders.map((line) => `  ${line}\n`).join("") +
			"Unstage them with `git rm --cached <path>` (or drop them from the commits), then retry.\n",
	);
	process.exit(1);
}

function preCommit() {
	const staged = nulList(git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]));
	const offenders = ignoredPaths(staged);
	if (offenders.length > 0) refuse("the commit", offenders);
}

function prePush(remote) {
	const lines = readFileSync(0, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	const offenders = new Set();
	for (const line of lines) {
		const [localRef, localSha] = line.split(" ");
		if (localSha === undefined || ZERO.test(localSha)) continue;
		// Only commits the remote does not have yet: anything already there
		// was checked when it was pushed, or predates this guard.
		const exclusion = remote ? [`--remotes=${remote}`] : ["--remotes"];
		const paths = nulList(
			git(["log", "--format=", "--name-only", "-z", "--diff-filter=ACMR", localSha, "--not", ...exclusion]),
		);
		for (const path of ignoredPaths([...new Set(paths)])) offenders.add(`${path} (in ${localRef})`);
	}
	if (offenders.size > 0) refuse("the push", [...offenders]);
}

function install() {
	const reported = git(["rev-parse", "--git-path", "hooks"]).trim();
	const hooksDir = isAbsolute(reported) ? reported : join(git(["rev-parse", "--show-toplevel"]).trim(), reported);
	for (const hook of ["pre-commit", "pre-push"]) {
		const target = join(hooksDir, hook);
		if (existsSync(target) && !readFileSync(target, "utf8").includes(MARKER)) {
			process.stderr.write(
				`git-guard: ${target} already exists and is not ours; add a call to scripts/git-guard.mjs ${hook} yourself\n`,
			);
			process.exitCode = 1;
			continue;
		}
		const body = [
			"#!/bin/sh",
			MARKER,
			'guard="$(git rev-parse --show-toplevel)/scripts/git-guard.mjs"',
			// A branch that predates the guard has no script; let it through.
			'[ -f "$guard" ] || exit 0',
			`exec node "$guard" ${hook} "$@"`,
			"",
		].join("\n");
		writeFileSync(target, body);
		chmodSync(target, 0o755);
		process.stdout.write(`git-guard: installed ${target}\n`);
	}
}

const [mode, remote] = process.argv.slice(2);
if (mode === "install") install();
else if (mode === "pre-commit") preCommit();
else if (mode === "pre-push") prePush(remote);
else {
	process.stderr.write("usage: node scripts/git-guard.mjs install|pre-commit|pre-push\n");
	process.exit(2);
}
