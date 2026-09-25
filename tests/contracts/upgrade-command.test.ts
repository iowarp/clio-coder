import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readClioVersion } from "../../src/core/package-root.js";
import {
	inspectInstallation,
	installationCommand,
	npmInstallArgs,
} from "../../src/domains/lifecycle/install-method.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const ARGV_MODULE = new URL("../../src/cli/argv.ts", import.meta.url).href;
const TSX_IMPORT = `--import=${import.meta.resolve("tsx")}`;

function installedFixture() {
	const home = makeScratchHome("clio-upgrade-command-");
	const prefix = join(home.dir, "custom prefix");
	const root = join(prefix, "lib/node_modules/@iowarp/clio-coder");
	const entry = join(root, "dist/cli/index.js");
	const bin = join(home.dir, "bin");
	const log = join(home.dir, "calls.jsonl");
	mkdirSync(dirname(entry), { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.4","type":"module"}');
	// The relaunch is judged by the real startup parser, not by the fixture: a
	// fake that accepted any argv is how a refused `--continue` relaunch stayed
	// green. The post-install and doctor children are recognized by their verb.
	writeFileSync(
		entry,
		[
			"import fs from 'node:fs';",
			"const args = process.argv.slice(2);",
			"fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ entry: process.argv[1], args })+'\\n');",
			"if (args[0] === 'upgrade' || args[0] === 'doctor') process.exitCode = Number(process.env.POST_CODE || 0);",
			"else {",
			`  const { extractGlobalFlags } = await import(${JSON.stringify(ARGV_MODULE)});`,
			"  const parsed = extractGlobalFlags(args);",
			"  if (parsed.error) { process.stderr.write('relaunch refused: ' + parsed.error + '\\n'); process.exitCode = 2; }",
			"  else process.exitCode = Number(process.env.RESTART_CODE || 0);",
			"}",
		].join("\n"),
	);
	writeFileSync(
		join(bin, "npm"),
		`#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: 'npm', args: process.argv.slice(2) })+'\\n');`,
		{ mode: 0o755 },
	);
	writeFileSync(join(bin, "clio-coder"), "#!/bin/sh\necho WRONG_LAUNCHER >&2\nexit 91\n", { mode: 0o755 });
	function run(args: string[], extra = "", env: NodeJS.ProcessEnv = {}) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				"--input-type=module",
				"-e",
				`
			import { runUpgradeCommand } from ${JSON.stringify(new URL("../../src/cli/upgrade.ts", import.meta.url).href)};
			import { inspectInstallation } from ${JSON.stringify(new URL("../../src/domains/lifecycle/install-method.ts", import.meta.url).href)};
			process.exitCode = await runUpgradeCommand(${JSON.stringify(args)}, {
				inspectInstallation: () => inspectInstallation(${JSON.stringify(entry)}),
				lookUpAvailableVersion: async () => ({ asked: true, version: '99.0.0' }),
				runPending: async () => ({ applied: [], allApplied: [], available: [] }),
				${extra}
			});`,
			],
			{
				env: {
					...process.env,
					...home.env,
					PATH: `${bin}:${process.env.PATH}`,
					CALL_LOG: log,
					// The installed-entry fixture imports the TypeScript argv parser.
					NODE_OPTIONS: [process.env.NODE_OPTIONS, TSX_IMPORT].filter(Boolean).join(" "),
					...env,
				},
				encoding: "utf8",
				timeout: 20_000,
			},
		);
	}
	const calls = () =>
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { home, prefix, root, entry, run, calls };
}

test("npm layout preserves a custom prefix through launcher symlinks and shell quoting", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const link = join(f.home.dir, "launcher");
	symlinkSync(f.entry, link);
	const found = inspectInstallation(link);
	assert.equal(found.kind, "npm");
	assert.equal(found.prefix, f.prefix);
	assert.deepEqual(npmInstallArgs(found, "latest"), [
		"install",
		"-g",
		"--prefix",
		f.prefix,
		"@iowarp/clio-coder@latest",
	]);
	assert.match(installationCommand(found, "uninstall"), /npm uninstall -g --prefix '.*custom prefix'/);
	assert.throws(() => npmInstallArgs({ ...found, kind: "pnpm" }, "latest"), /original package manager/);
});

test("pnpm project stores stay local while its recognized global layout uses pnpm guidance", (t) => {
	const home = makeScratchHome("clio-pnpm-layout-");
	t.after(home.cleanup);
	for (const [layout, kind] of [
		["project/node_modules/.pnpm/pkg/node_modules/@iowarp/clio-coder", "local"],
		["pnpm/global/5/.pnpm/pkg/node_modules/@iowarp/clio-coder", "pnpm"],
	] as const) {
		const root = join(home.dir, layout);
		const entry = join(root, "dist/cli/index.js");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "// fixture");
		writeFileSync(join(root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.4"}');
		assert.equal(inspectInstallation(entry).kind, kind);
	}
});

test("upgrade updates the same prefix and runs checks with the exact installed entry despite PATH shadowing", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(["--json"]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(JSON.parse(result.stdout).status, "success");
	assert.deepEqual(f.calls(), [
		{ command: "npm", args: ["install", "-g", "--prefix", f.prefix, "@iowarp/clio-coder@latest"] },
		{ entry: f.entry, args: ["upgrade", "--post-install", "--channel=latest"] },
	]);
});

test("restart follows successful checks, relaunches with argv the real parser accepts, and propagates the new CLI's exit status", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(["--restart"], "isInteractive: () => true,", { RESTART_CODE: "7" });
	assert.equal(result.status, 7, result.stderr + result.stdout);
	assert.doesNotMatch(result.stderr, /relaunch refused/);
	assert.deepEqual(
		f.calls().map((row) => row.args),
		[
			["install", "-g", "--prefix", f.prefix, "@iowarp/clio-coder@latest"],
			["upgrade", "--post-install", "--channel=latest"],
			[],
		],
	);
});

test("every resume hint names /resume, never the refused --continue flag", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const automated = f.run(["--restart"], "isInteractive: () => false,");
	assert.equal(automated.status, 2);
	assert.match(automated.stderr, /\/resume/);
	const relaunchFailed = f.run(
		["--restart"],
		"isInteractive: () => true, runRestart: async () => { throw new Error('spawn failed'); },",
	);
	assert.equal(relaunchFailed.status, 1);
	assert.match(relaunchFailed.stderr, /\/resume/);
	const manual = f.run(
		[],
		`inspectInstallation: () => ({ ...inspectInstallation(${JSON.stringify(f.entry)}), kind: 'pnpm' }),`,
	);
	assert.match(manual.stdout, /\/resume/);
	const preview = f.run(["--dry-run", "--restart"]);
	assert.match(preview.stdout, /\/resume/);
	for (const output of [automated, relaunchFailed, manual, preview]) {
		assert.doesNotMatch(output.stdout + output.stderr, /--continue/);
	}
});

test("failed checks never relaunch and recovery points to migrations", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(["--restart"], "isInteractive: () => true,", { POST_CODE: "1" });
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.equal(f.calls().length, 2);
	assert.match(result.stdout, /upgrade --post-install/);
});

test("post-install runs repairs even with current metadata and no pending migrations", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const state = join(f.home.dir, "state");
	mkdirSync(state);
	writeFileSync(join(state, "install.json"), JSON.stringify({ version: readClioVersion() }));
	const result = f.run(["--post-install", "--skip-migrations", "--json"]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.deepEqual(f.calls(), [{ entry: f.entry, args: ["doctor", "--fix"] }]);
});

test("restart rejects automation and conflicting flags before changing the installation", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	for (const args of [["--restart"], ["--restart", "--json"], ["--restart", "--post-install"]]) {
		const result = f.run(args, "isInteractive: () => false,");
		assert.equal(result.status, 2, result.stdout + result.stderr);
	}
	assert.throws(f.calls, /ENOENT/);
});

test("manual package managers get instructions without replacement and dry runs never restart", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(
		["--json"],
		`inspectInstallation: () => ({ ...inspectInstallation(${JSON.stringify(f.entry)}), kind: 'pnpm' }),`,
	);
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.match(result.stdout, /pnpm add -g/);
	const preview = f.run(["--dry-run", "--restart"]);
	assert.equal(preview.status, 0, preview.stderr + preview.stdout);
	assert.match(preview.stdout, /Would relaunch/);
	assert.throws(f.calls, /ENOENT/);
});

test("an older dist-tag never downgrades the installed package", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(["--json"], "lookUpAvailableVersion: async () => ({ asked: true, version: '0.0.1' }),");
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.deepEqual(f.calls(), [{ entry: f.entry, args: ["doctor", "--fix"] }]);
	assert.match(result.stdout, /keeping it/);
});
