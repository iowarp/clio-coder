import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activatedPackageRoot, pendingInstalledVersion } from "../../src/core/running-build.js";

const helper = fileURLToPath(new URL("../../scripts/native-install.cjs", import.meta.url));
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

test("malformed liveness receipts prevent collection", { skip: process.platform !== "linux" }, (t) => {
	const f = fixture(t),
		unused = f.prefix("0.5.9");
	mkdirSync(join(f.root, ".active"));
	writeFileSync(join(f.root, ".active/broken.json"), "{");
	assert.equal(f.run("prune").status, 0);
	assert.equal(existsSync(unused), true);
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
