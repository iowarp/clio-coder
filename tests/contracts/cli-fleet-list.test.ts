/**
 * What `clio fleet list` says about the shipped fleets in a repo that has not
 * declared a command registry.
 *
 * Two of the three builtins bind code steps, so a fresh checkout read
 * `build-test  builtin  invalid` beside an error that named
 * `.clio/fleets/commands.yaml` and no way to produce it. Nothing about those
 * contracts is wrong: the repo has not said what `test` and `commit` mean in
 * it. They stay unrunnable, and the word for that is not `invalid`.
 */
import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REGISTRY = [
	"version: 1",
	"commands:",
	"  test:",
	'    argv: ["true"]',
	"  commit:",
	'    argv: ["true"]',
	"",
].join("\n");

describe("contracts/cli-fleet-list", () => {
	const scratch = makeScratchHome("clio-fleet-list-");
	let repo = "";

	before(() => {
		repo = mkdtempSync(join(tmpdir(), "clio-fleet-repo-"));
	});
	after(() => {
		rmSync(repo, { recursive: true, force: true });
		scratch.cleanup();
	});

	function writeRegistry(yaml: string): void {
		mkdirSync(join(repo, ".clio", "fleets"), { recursive: true });
		writeFileSync(join(repo, ".clio", "fleets", "commands.yaml"), yaml);
	}

	it("calls a builtin that only needs the repo's command registry `setup`, with the ids and the remedy", async () => {
		const result = await runCli(["fleet", "list"], { env: scratch.env, cwd: repo });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /^build-test {2}builtin {2}setup {4}needs \.clio\/fleets\/commands\.yaml declaring test$/m);
		match(result.stdout, /^sdlc {2}builtin {2}setup {4}needs \.clio\/fleets\/commands\.yaml declaring commit, test$/m);
		match(result.stdout, /declare each id there under `commands:` with an `argv` list/);
		match(result.stdout, /`clio docs fleet_dispatch` has the schema/);
		// A fleet with no code steps was never affected and still reads valid.
		match(result.stdout, /^build-review {2}builtin {2}valid {4}coder\[workspace\]/m);
		// The word that used to be there is gone from this state.
		strictEqual(/^build-test {2}builtin {2}invalid/m.test(result.stdout), false, result.stdout);
	});

	it("names the same remedy when the fleet is run rather than listed", async () => {
		const result = await runCli(["fleet", "run", "build-test"], { env: scratch.env, cwd: repo });
		strictEqual(result.code, 2, `stdout=${result.stdout}`);
		match(result.stderr, /code steps require a command registry at \.clio\/fleets\/commands\.yaml declaring test/);
		match(result.stderr, /`clio docs fleet_dispatch` has the schema/);
	});

	it("reads valid once the repo declares the commands", async () => {
		writeRegistry(REGISTRY);
		const result = await runCli(["fleet", "list"], { env: scratch.env, cwd: repo });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		for (const name of ["build-review", "build-test", "sdlc"]) {
			match(result.stdout, new RegExp(`^${name} {2}builtin {2}valid`, "m"));
		}
		strictEqual(/setup/.test(result.stdout), false, result.stdout);
	});

	it("keeps a registry that exists and binds the wrong ids `invalid`", async () => {
		writeRegistry(["version: 1", "commands:", "  lint:", '    argv: ["true"]', ""].join("\n"));
		const result = await runCli(["fleet", "list"], { env: scratch.env, cwd: repo });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /^build-test {2}builtin {2}invalid {2}.*names unknown command 'test'/m);
		// Telling a repo to write the file it already wrote is the wrong remedy.
		strictEqual(/setup/.test(result.stdout), false, result.stdout);
	});
});
