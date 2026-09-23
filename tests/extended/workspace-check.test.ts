import { strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { workspaceConcern } from "../../src/cli/workspace-check.js";

test("home and system scope require confirmation; project and scratch folders open directly", () => {
	const home = "/home/researcher";
	strictEqual(workspaceConcern(home, home), "home");
	for (const cwd of ["/", "/home", "/etc", "/etc/ssh", "/usr/bin", "/var/log", "/proc", "/tmp", "/System/Library"])
		strictEqual(workspaceConcern(cwd, home), "system", cwd);
	for (const cwd of [
		"/home/researcher/project",
		"/tmp/project",
		"/var/tmp/project",
		"/var/folders/ab/project",
		"/opt/project",
		"/srv/project",
		"/usr/local/src/project",
		"/etc-project",
	])
		strictEqual(workspaceConcern(cwd, home), null, cwd);
});

test("macOS names /etc, /tmp and /var by their canonical /private paths, and they keep their concern", () => {
	const home = "/Users/researcher";
	for (const cwd of [
		"/private",
		"/private/etc",
		"/private/etc/ssh",
		"/private/var/log",
		"/private/tmp",
		"/private/var/tmp",
	])
		strictEqual(workspaceConcern(cwd, home), "system", cwd);
	for (const cwd of [
		"/private/tmp/project",
		"/private/var/tmp/project",
		"/private/var/folders/ab/T/project",
		"/private/etcetera",
	])
		strictEqual(workspaceConcern(cwd, home), null, cwd);
});

test("noninteractive home startup exits before the orchestrator, including through a symlink", (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "clio-workspace-check-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const alias = path.join(root, "home-link");
	symlinkSync(homedir(), alias);
	const moduleUrl = new URL("../../src/cli/clio.ts", import.meta.url).href;
	for (const cwd of [homedir(), alias]) {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`
			const { runClioCommand } = await import(${JSON.stringify(moduleUrl)});
			process.chdir(${JSON.stringify(cwd)});
			const code = await runClioCommand({}, { bootOrchestrator: async () => { throw new Error("BOOT MUST NOT RUN"); } });
			process.exitCode = code;
		`,
			],
			{ cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CLIO_CODER_INTERACTIVE: "0" } },
		);
		strictEqual(result.status, 1, result.stderr);
		strictEqual(result.stderr.includes("This is your home folder"), true, result.stderr);
		strictEqual(result.stderr.includes("BOOT MUST NOT RUN"), false, result.stderr);
	}
});
