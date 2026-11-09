import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activatedPackageRoot, pendingInstalledVersion } from "../../src/core/running-build.js";

const helper = fileURLToPath(new URL("../../scripts/native-install.cjs", import.meta.url));
const lifecycle = createRequire(import.meta.url)(helper) as {
	prune(
		root: string,
		options?: { dryRun?: boolean; inventory?: () => { complete: boolean; reason?: string; texts: string[] } },
	): { proof: boolean; removed: { name: string }[]; kept: { name: string; why: string }[] };
	parseProcessList(platform: string, text: string, uid?: number): string[];
};
const suffix = "lib/node_modules/@iowarp/clio-coder";
function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "clio-install-hardening-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const prefix = (version: string) => {
		const dir = join(root, "versions", version);
		mkdirSync(join(dir, suffix), { recursive: true });
		writeFileSync(join(dir, suffix, "package.json"), JSON.stringify({ name: "@iowarp/clio-coder", version }));
		utimesSync(dir, 1, 1);
		return dir;
	};
	const current = prefix("0.6.1"),
		previous = prefix("0.6.0");
	const record = {
		schema: 2,
		kind: "clio-coder-installer",
		current,
		previous,
		node: join(root, "runtime/node"),
		launcher: join(root, "bin/clio-coder"),
	};
	const save = (value: unknown) => writeFileSync(join(root, "install.json"), JSON.stringify(value));
	save(record);
	const run = (action: string, ...args: string[]) =>
		spawnSync(process.execPath, [helper, action, root, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: join(root, "home"),
				CLIO_CODER_HOME: join(root, "home"),
				CLIO_CODER_STATE_DIR: join(root, "home/state"),
				XDG_CONFIG_HOME: join(root, "home/config"),
				XDG_DATA_HOME: join(root, "home/data"),
			},
		});
	return { root, prefix, record, save, run };
}

test("truncated and malformed install records give actionable errors without partial launch state", (t) => {
	const f = fixture(t);
	for (const value of [
		null,
		{},
		{ ...f.record, node: undefined },
		{ ...f.record, current: undefined },
		{ ...f.record, launcher: undefined },
	]) {
		f.save(value);
		const result = f.run("launch");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Incomplete installer manifest/);
		assert.equal(existsSync(join(f.root, ".active")), false);
	}
	writeFileSync(join(f.root, "install.json"), "{");
	assert.match(f.run("launch").stderr, /Invalid installer manifest JSON/);
});

test("retention preserves current, rollback and live receipts while collecting old and refused versions", {
	skip: process.platform !== "linux",
}, (t) => {
	const f = fixture(t);
	const unused = f.prefix("0.5.9"),
		running = f.prefix("0.5.8"),
		refused = f.prefix("0.6.2-rc.1");
	writeFileSync(join(refused, ".clio-coder-refused-candidate"), "");
	mkdirSync(join(f.root, ".active"));
	writeFileSync(join(f.root, ".active/live.json"), JSON.stringify({ pid: process.pid, current: running }));
	const result = f.run("prune");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(f.record.current), true);
	assert.equal(existsSync(f.record.previous), true);
	assert.equal(existsSync(running), true);
	assert.equal(existsSync(unused), false, result.stdout + result.stderr);
	assert.equal(existsSync(refused), false);
});

test("a proven keep set removes every unused version, runtime and helper at once, whatever its age", {
	skip: process.platform !== "linux",
}, async (t) => {
	const f = fixture(t);
	const fresh = (dir: string) => {
		utimesSync(dir, new Date(), new Date());
		return dir;
	};
	const duplicate = fresh(f.prefix("0.6.1-20261009000000-42"));
	const unused = fresh(f.prefix("0.5.9"));
	const held = fresh(f.prefix("0.5.8"));
	const runtime = (name: string) => {
		mkdirSync(join(f.root, "runtime", name, "bin"), { recursive: true });
		return join(f.root, "runtime", name);
	};
	const currentNode = runtime("node-v24.2.0-linux-x64");
	const launcherNode = runtime("node-v24.0.0-linux-x64");
	const oldNode = runtime("node-v24.1.0-linux-x64");
	mkdirSync(join(f.root, "launchers"));
	const named = join(f.root, "launchers/aaa.cjs");
	const stale = join(f.root, "launchers/bbb.cjs");
	for (const file of [named, stale]) writeFileSync(file, "");
	mkdirSync(join(f.root, "bin"));
	writeFileSync(f.record.launcher, `#!/bin/sh\nexec '${launcherNode}/bin/node' '${named}' launch '${f.root}' "$@"\n`);
	f.save({ ...f.record, node: join(currentNode, "bin/node") });
	mkdirSync(join(f.root, ".active"));
	writeFileSync(join(f.root, ".active/dead.json"), JSON.stringify({ pid: 99999999, host: hostname(), current: unused }));
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", join(held, suffix)], { stdio: "ignore" });
	t.after(() => holder.kill());
	await new Promise((resolve) => setTimeout(resolve, 200));

	const preview = f.run("prune", "--dry-run", "--json");
	assert.equal(preview.status, 0, preview.stderr);
	const plan = JSON.parse(preview.stdout);
	assert.equal(plan.proof, true, plan.reason);
	assert.deepEqual(plan.removed.map((entry: { name: string }) => entry.name).sort(), [
		"0.5.9",
		"0.6.1-20261009000000-42",
		"bbb.cjs",
		"node-v24.1.0-linux-x64",
	]);
	assert.equal(existsSync(unused), true, "a dry run removes nothing");

	const result = f.run("prune");
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/removed 2 unused versions, 1 runtime, 1 launcher helper \(.+\); kept .*0\.6\.1 \(current\)/,
	);
	for (const gone of [duplicate, unused, oldNode, stale, join(f.root, ".active/dead.json")])
		assert.equal(existsSync(gone), false, gone);
	for (const kept of [f.record.current, f.record.previous, held, currentNode, launcherNode, named])
		assert.equal(existsSync(kept), true, kept);
	assert.equal(existsSync(join(f.root, ".install-lock")), false);
});

test("without a complete process inventory, prune keeps the last week and the newest three", (t) => {
	const f = fixture(t);
	const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
	const aged = (version: string, age: number) => {
		const dir = f.prefix(version);
		utimesSync(dir, days(age), days(age));
		return dir;
	};
	const recent = aged("0.6.3", 2);
	const newest = [aged("0.5.3", 10), aged("0.5.2", 11)];
	const old = [aged("0.5.1", 20), aged("0.5.0", 30)];
	for (const name of ["HOME", "CLIO_CODER_STATE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const) {
		const saved = process.env[name];
		process.env[name] = join(f.root, "home", name);
		t.after(() => {
			if (saved === undefined) delete process.env[name];
			else process.env[name] = saved;
		});
	}
	const result = lifecycle.prune(f.root, { inventory: () => ({ complete: false, reason: "no /proc", texts: [] }) });
	assert.equal(result.proof, false);
	for (const dir of [recent, ...newest, f.record.current, f.record.previous]) assert.equal(existsSync(dir), true, dir);
	for (const dir of old) assert.equal(existsSync(dir), false, dir);
	assert.equal(result.kept.find((entry) => entry.name === "0.6.3")?.why, "recent");
});

test("malformed liveness receipts withdraw the proof", { skip: process.platform !== "linux" }, (t) => {
	const f = fixture(t),
		unused = f.prefix("0.5.9");
	mkdirSync(join(f.root, ".active"));
	writeFileSync(join(f.root, ".active/broken.json"), "{");
	const result = f.run("prune", "--json");
	assert.equal(result.status, 0, result.stderr);
	assert.match(JSON.parse(result.stdout).reason, /unreadable launch receipt/);
	assert.equal(existsSync(unused), true);
});

test("macOS and Windows process listings feed the same keep set", () => {
	assert.deepEqual(
		lifecycle.parseProcessList("darwin", "  501 /opt/node /Users/a/clio/versions/0.6.1/x.js\n    0 /sbin/launchd\n", 501),
		["/opt/node /Users/a/clio/versions/0.6.1/x.js"],
	);
	assert.deepEqual(lifecycle.parseProcessList("win32", "\r\n C:\\clio\\node.exe C:\\clio\\versions\\0.6.1\\x.js\r\n"), [
		"C:\\clio\\node.exe C:\\clio\\versions\\0.6.1\\x.js",
	]);
});

test("running package notices activation and rollback even when its old files are intact", (t) => {
	const f = fixture(t),
		oldRoot = join(f.record.previous, suffix),
		activeRoot = join(f.record.current, suffix);
	assert.equal(activatedPackageRoot(oldRoot), activeRoot);
	assert.equal(pendingInstalledVersion(oldRoot), "0.6.1");
	assert.equal(pendingInstalledVersion(activeRoot), null);
	f.save({ ...f.record, current: f.record.previous, previous: f.record.current });
	assert.equal(pendingInstalledVersion(activeRoot), "0.6.0");
	assert.equal(pendingInstalledVersion(oldRoot), null);
	assert.equal(JSON.parse(readFileSync(join(oldRoot, "package.json"), "utf8")).version, "0.6.0");
});

test("rollback keeps the capable desktop manager and cleanup while launching the activated server", (t) => {
	const f = fixture(t);
	const manager = f.record.current;
	const active = f.record.previous;
	for (const prefix of [active, manager]) {
		mkdirSync(join(prefix, suffix, "dist/cli"), { recursive: true });
		writeFileSync(join(prefix, suffix, "dist/cli/index.js"), `console.log(${JSON.stringify(prefix)});`);
	}
	mkdirSync(join(manager, suffix, "dist/gui"), { recursive: true });
	writeFileSync(
		join(manager, suffix, "dist/gui/server.js"),
		"console.log(JSON.stringify({args:process.argv.slice(2),root:process.env.CLIO_CODER_PACKAGE_ROOT}));",
	);
	mkdirSync(join(f.root, "runtime"));
	copyFileSync(process.execPath, f.record.node);
	mkdirSync(join(f.root, "bin"));
	writeFileSync(f.record.launcher, "owned launcher");
	f.save({ ...f.record, current: active, previous: manager, desktopManager: manager });
	const result = f.run("launch", "gui", "background", "open", "--directory", join(f.root, "desktop"));
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		args: ["managed-background", "open", "--directory", join(f.root, "desktop")],
		root: join(active, suffix),
	});
	const bare = f.run("launch", "gui");
	assert.equal(bare.status, 0, bare.stderr);
	assert.deepEqual(JSON.parse(bare.stdout), { args: [], root: join(active, suffix) });
	const cleanup = f.run("launch", "uninstall", "--dry-run");
	assert.equal(cleanup.status, 0, cleanup.stderr);
	assert.equal(cleanup.stdout.trim(), manager);
	assert.equal(f.run("launch", "--version").stdout.trim(), active);
});
