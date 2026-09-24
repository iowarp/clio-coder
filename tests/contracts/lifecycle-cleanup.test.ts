import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive, processBirthToken } from "../../src/core/process-identity.js";
import { makeScratchHome } from "../harness/scratch-env.js";

function fixture() {
	const home = makeScratchHome("clio-lifecycle-cleanup-");
	const state = join(home.dir, "state");
	const registry = join(state, "gui/docs-server.json");
	const history = join(state, "session-fixture.json");
	const root = join(home.dir, "terminal-only-package");
	mkdirSync(join(state, "gui"), { recursive: true });
	mkdirSync(root);
	writeFileSync(join(root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.4"}');
	writeFileSync(history, "history must survive previews and failures");
	function run(command: "reset" | "uninstall", args: string[]) {
		const functionName = command === "reset" ? "runResetCommand" : "runUninstallCommand";
		return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
			execFile(
				process.execPath,
				[
					"--import",
					import.meta.resolve("tsx"),
					"--input-type=module",
					"-e",
					`
			import { ${functionName} } from ${JSON.stringify(new URL(`../../src/cli/${command}.ts`, import.meta.url).href)};
			process.exitCode = await ${functionName}(${JSON.stringify(args)});`,
				],
				{
					env: {
						...process.env,
						...home.env,
						CLIO_CODER_PACKAGE_ROOT: root,
						HOME: home.dir,
						XDG_DATA_HOME: join(home.dir, "desktop"),
					},
					encoding: "utf8",
					timeout: 20_000,
				},
				(error, stdout, stderr) =>
					resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
			),
		);
	}
	return { home, state, registry, history, root, run };
}

for (const command of ["reset", "uninstall"] as const) {
	test(`${command} leaves a docs server alive on preview and stops it before removing state`, {
		skip: process.platform !== "linux",
	}, async (t) => {
		const f = fixture();
		t.after(f.home.cleanup);
		const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		await once(server, "spawn");
		const pid = server.pid;
		assert.ok(pid);
		t.after(() => {
			if (processAlive(pid)) server.kill("SIGKILL");
		});
		writeFileSync(
			f.registry,
			JSON.stringify({ v: 1, pid, birth: processBirthToken(pid), port: 1234, token: "t".repeat(43), packageRoot: f.root }),
		);
		const preview = await f.run(command, ["--dry-run", "--json"]);
		assert.equal(preview.status, 0, preview.stderr + preview.stdout);
		assert.ok(processAlive(pid));
		assert.ok(existsSync(f.history));
		const real = await f.run(command, ["--force", "--json"]);
		assert.equal(real.status, 0, real.stderr + real.stdout);
		assert.equal(processAlive(pid), false);
		assert.equal(existsSync(f.history), false);
		assert.equal(existsSync(f.registry), false);
	});

	test(`${command} preserves every root and the record when docs process ownership is unverified`, async (t) => {
		const f = fixture();
		t.after(f.home.cleanup);
		const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		await once(server, "spawn");
		const pid = server.pid;
		assert.ok(pid);
		t.after(() => {
			server.kill("SIGKILL");
		});
		const record = JSON.stringify({
			v: 1,
			pid,
			birth: "wrong-birth-token",
			port: 9,
			token: "t".repeat(43),
			packageRoot: f.root,
		});
		writeFileSync(f.registry, record);
		const result = await f.run(command, ["--force", "--json"]);
		assert.equal(result.status, 1, result.stderr + result.stdout);
		assert.ok(processAlive(pid));
		assert.equal(readFileSync(f.registry, "utf8"), record);
		assert.ok(existsSync(f.history));
		assert.match(result.stdout, /state was preserved/);
	});
}

test("reset refuses to orphan a background service when its ownership cannot be checked", async (t) => {
	const f = fixture();
	t.after(f.home.cleanup);
	const directory = join(f.state, "gui/background");
	mkdirSync(directory);
	writeFileSync(join(directory, "owner.json"), "{}");
	const preview = await f.run("reset", ["--all", "--dry-run", "--json"]);
	assert.equal(preview.status, 0, preview.stderr + preview.stdout);
	assert.ok(existsSync(f.history));
	const result = await f.run("reset", ["--all", "--force", "--json"]);
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.ok(existsSync(f.history));
	assert.ok(existsSync(join(directory, "owner.json")));
});
