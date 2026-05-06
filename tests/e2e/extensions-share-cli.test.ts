import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

let scratch: ReturnType<typeof makeScratchHome>;

function writeExtension(root: string): void {
	mkdirSync(join(root, "prompts"), { recursive: true });
	writeFileSync(
		join(root, "clio-extension.yaml"),
		[
			"manifestVersion: 1",
			"id: lab-pack",
			"name: Lab Pack",
			"version: 1.0.0",
			"description: Lab extension",
			"resources:",
			"  prompts: prompts",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(root, "prompts", "lab.md"), "---\ndescription: Lab prompt\n---\nLab $1\n", "utf8");
}

describe("extensions and share cli", { concurrency: false }, () => {
	beforeEach(async () => {
		scratch = makeScratchHome();
		await runCli(["doctor", "--fix"], { env: scratch.env });
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("installs, lists, disables, enables, and removes an extension package", async () => {
		const source = join(scratch.dir, "lab-pack");
		writeExtension(source);

		const install = await runCli(["extensions", "install", source], { env: scratch.env });
		strictEqual(install.code, 0, install.stderr);
		match(install.stdout, /installed lab-pack/);

		const list = await runCli(["extensions", "list", "--all"], { env: scratch.env });
		strictEqual(list.code, 0, list.stderr);
		match(list.stdout, /lab-pack/);
		match(list.stdout, /active/);

		const disable = await runCli(["extensions", "disable", "lab-pack"], { env: scratch.env });
		strictEqual(disable.code, 0, disable.stderr);
		const disabledList = await runCli(["extensions", "list", "--all"], { env: scratch.env });
		match(disabledList.stdout, /disabled/);

		const enable = await runCli(["extensions", "enable", "lab-pack"], { env: scratch.env });
		strictEqual(enable.code, 0, enable.stderr);
		const remove = await runCli(["extensions", "remove", "lab-pack"], { env: scratch.env });
		strictEqual(remove.code, 0, remove.stderr);
		const empty = await runCli(["extensions", "list"], { env: scratch.env });
		match(empty.stdout, /extensions: none/);
	});

	it("exports, dry-runs import conflicts, and imports a share archive", async () => {
		const source = join(scratch.dir, "project-a");
		const dest = join(scratch.dir, "project-b");
		mkdirSync(join(source, ".clio", "prompts"), { recursive: true });
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(source, "CLIO.md"), "# Source\n", "utf8");
		writeFileSync(join(source, ".clio", "prompts", "lab.md"), "---\ndescription: Lab\n---\nLab\n", "utf8");
		const archive = join(scratch.dir, "bundle.clio-share.json");

		const exported = await runCli(["share", "export", "--out", archive], { env: scratch.env, cwd: source });
		strictEqual(exported.code, 0, exported.stderr);
		ok(existsSync(archive));

		writeFileSync(join(dest, "CLIO.md"), "different\n", "utf8");
		const dryRun = await runCli(["share", "import", archive, "--dry-run"], { env: scratch.env, cwd: dest });
		strictEqual(dryRun.code, 1);
		match(dryRun.stderr, /destination already exists/);

		const forced = await runCli(["share", "import", archive, "--force"], { env: scratch.env, cwd: dest });
		strictEqual(forced.code, 0, forced.stderr);
		ok(existsSync(join(dest, ".clio", "prompts", "lab.md")));
	});
});
