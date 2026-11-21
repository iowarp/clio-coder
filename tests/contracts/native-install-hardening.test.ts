import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activatedPackageRoot, pendingInstalledVersion } from "../../src/core/running-build.js";
import { describeTracking } from "../../src/domains/lifecycle/install-plan.js";

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
	const receipts = join(root, "home/state/launches");
	const receipt = (name: string, value: unknown) => {
		mkdirSync(receipts, { recursive: true });
		writeFileSync(join(receipts, name), typeof value === "string" ? value : JSON.stringify(value));
		return join(receipts, name);
	};
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
	return { root, prefix, record, save, run, receipts, receipt };
}

test("macOS process parsing stays bounded for padded commands with Unicode line separators", () => {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			'const { parseProcessList } = require(process.argv[1]); process.stdout.write(JSON.stringify(parseProcessList("darwin", "501 " + " ".repeat(100_000) + "node script\\u2028tail", 501)));',
			helper,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), ["node script\u2028tail"]);
});

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
		assert.equal(existsSync(f.receipts), false);
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
	f.receipt("live.json", { pid: process.pid, root: f.root, current: running });
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
	const dead = f.receipt("dead.json", { pid: 99999999, host: hostname(), root: f.root, current: unused });
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
	for (const gone of [duplicate, unused, oldNode, stale, dead]) assert.equal(existsSync(gone), false, gone);
	for (const kept of [f.record.current, f.record.previous, held, currentNode, launcherNode, named])
		assert.equal(existsSync(kept), true, kept);
	assert.equal(existsSync(join(f.root, ".install-lock")), false);
});

test("prune names a version it cannot read and leaves it whole, and finishes an interrupted removal", {
	skip: (process.platform !== "linux" || process.getuid?.() === 0) && "needs a non-root POSIX permission check",
}, (t) => {
	const f = fixture(t);
	const locked = f.prefix("0.5.9");
	const manifest = join(locked, suffix, "package.json");
	chmodSync(manifest, 0);
	const leftover = join(f.root, "versions/.clio-coder-pruning-0.5.7-123");
	mkdirSync(join(leftover, suffix), { recursive: true });

	const result = f.run("prune");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /could not remove .*0\.5\.9 \(EACCES\); the next update retries/);
	assert.equal(existsSync(manifest), true, "the unreadable version stays whole");
	assert.equal(existsSync(leftover), false, "a renamed entry from an interrupted prune is swept");
	assert.deepEqual(readdirSync(join(f.root, "versions")).sort(), ["0.5.9", "0.6.0", "0.6.1"]);
});

test("prune keeps the bootstrap a native Windows launcher names in its sidecar", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "launchers"));
	const live = join(f.root, "launchers/aaa.cjs");
	const stale = join(f.root, "launchers/bbb.cjs");
	for (const file of [live, stale]) writeFileSync(file, "");
	mkdirSync(join(f.root, "bin"));
	const exe = join(f.root, "bin/clio-coder.exe");
	writeFileSync(exe, "MZ");
	writeFileSync(join(f.root, "bin/clio-coder.launch"), `node\n"${live}" launch "${f.root}"\nutf8-console\n`);
	f.save({ ...f.record, launcher: exe });
	for (const name of ["HOME", "CLIO_CODER_STATE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const) {
		const saved = process.env[name];
		process.env[name] = join(f.root, "home", name);
		t.after(() => {
			if (saved === undefined) delete process.env[name];
			else process.env[name] = saved;
		});
	}
	const result = lifecycle.prune(f.root, { dryRun: true, inventory: () => ({ complete: true, texts: [] }) });
	assert.equal(result.proof, true);
	assert.equal(result.kept.find((entry) => entry.name === "aaa.cjs")?.why, "launcher");
	assert.ok(result.removed.some((entry) => entry.name === "bbb.cjs"));
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

test("prune keeps what the GUI service names by its resolved path when the root is reached through a symlink", {
	skip: process.platform === "win32",
}, (t) => {
	const f = fixture(t);
	const gui = f.prefix("0.5.9");
	const unused = f.prefix("0.5.7");
	mkdirSync(join(f.root, "runtime", "node-v24.1.0"), { recursive: true });
	const link = `${f.root}-link`;
	symlinkSync(f.root, link);
	t.after(() => rmSync(link, { force: true }));
	f.save({
		...f.record,
		current: join(link, "versions/0.6.1"),
		previous: join(link, "versions/0.6.0"),
		node: join(link, "runtime/node"),
	});
	const state = join(f.root, "home", "state");
	mkdirSync(join(state, "gui/background"), { recursive: true });
	writeFileSync(
		join(state, "gui/background/server.json"),
		JSON.stringify({ packageRoot: join(gui, suffix), launch: { node: join(f.root, "runtime/node-v24.1.0/node") } }),
	);
	for (const [name, value] of [
		["HOME", join(f.root, "home")],
		["CLIO_CODER_STATE_DIR", state],
		["XDG_CONFIG_HOME", join(f.root, "home/config")],
		["XDG_DATA_HOME", join(f.root, "home/data")],
	] as const) {
		const saved = process.env[name];
		process.env[name] = value;
		t.after(() => {
			if (saved === undefined) delete process.env[name];
			else process.env[name] = saved;
		});
	}
	const result = lifecycle.prune(link, { inventory: () => ({ complete: true, texts: [] }) });
	assert.equal(result.proof, true);
	assert.equal(existsSync(gui), true, "the GUI's version stays");
	assert.equal(existsSync(join(f.root, "runtime/node-v24.1.0")), true, "the GUI's Node stays");
	assert.equal(existsSync(unused), false);
	assert.equal(existsSync(f.record.current), true);
});

test("activation moves a POSIX launcher to the new Node and collects the old runtime", {
	skip: process.platform === "win32",
}, (t) => {
	const f = fixture(t);
	const runtime = (name: string) => {
		mkdirSync(join(f.root, "runtime", name, "bin"), { recursive: true });
		symlinkSync(process.execPath, join(f.root, "runtime", name, "bin/node"));
		return join(f.root, "runtime", name, "bin/node");
	};
	const candidate = (version: string) => {
		const dir = f.prefix(version);
		mkdirSync(join(dir, suffix, "dist/cli"), { recursive: true });
		writeFileSync(join(dir, suffix, "dist/cli/index.js"), `console.log(${JSON.stringify(version)});`);
		return dir;
	};
	rmSync(join(f.root, "install.json"));
	const activate = (node: string, prefix: string) =>
		f.run("activate", node, "24", "linux-x64", prefix, f.record.launcher, "latest", "-", "0", "0");
	const first = runtime("node-v24.0.0-linux-x64");
	const a = activate(first, candidate("0.6.2"));
	assert.equal(a.status, 0, a.stderr);
	const second = runtime("node-v24.1.0-linux-x64");
	const b = activate(second, candidate("0.6.3"));
	assert.equal(b.status, 0, b.stderr);
	const manifest = JSON.parse(readFileSync(join(f.root, "install.json"), "utf8"));
	assert.equal(manifest.launcherNode, second);
	assert.match(readFileSync(f.record.launcher, "utf8"), new RegExp(`exec '${second}'`));
	// The first runtime is still the previous version's Node, kept for rollback.
	assert.equal(manifest.previousNode, first);
	const c = activate(second, candidate("0.6.4"));
	assert.equal(c.status, 0, c.stderr);
	assert.equal(existsSync(join(f.root, "runtime/node-v24.0.0-linux-x64")), process.platform !== "linux");
});

test("an upgrade runs the candidate's own doctor --fix, prints what it removed, and a failed repair activates nothing", {
	skip: process.platform === "win32",
}, (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "runtime/node/bin"), { recursive: true });
	const node = join(f.root, "runtime/node/bin/node");
	symlinkSync(process.execPath, node);
	const config = join(f.root, "home/config");
	mkdirSync(config, { recursive: true });
	// A fake doctor: the first --fix removes a retired key and drops a record, a later one finds nothing.
	const doctor = `const fs=require("node:fs"),p=require("node:path"),a=process.argv.slice(2),c=${JSON.stringify(config)};
if(a[0]==="--version"){console.log("candidate");process.exit(0)}
fs.appendFileSync(p.join(c,"calls"),a.join(" ")+"\\n");
const fixed=a.includes("--fix")&&!fs.existsSync(p.join(c,"done"));if(fixed)fs.writeFileSync(p.join(c,"done"),"");
const broken=fs.existsSync(p.join(c,"unfixable"));
const findings=[{ok:!broken,name:"settings.yaml",detail:broken?"x.y: unknown key":"ok"},...(fixed?[{ok:true,name:"settings.yaml retired keys",detail:"removed context.memory.observations"},{ok:true,name:"memory store",detail:"rewrote records.json (version 1) keeping 0 records and dropping 1 this build cannot read"}]:[])];
console.log(JSON.stringify({ok:!broken,fix:a.includes("--fix"),findings}));process.exit(broken?1:0);`;
	const candidate = (version: string) => {
		const dir = f.prefix(version);
		mkdirSync(join(dir, suffix, "dist/cli"), { recursive: true });
		writeFileSync(join(dir, suffix, "dist/cli/index.js"), doctor);
		return dir;
	};
	const activate = (prefix: string) =>
		f.run("activate", node, "24", "linux-x64", prefix, f.record.launcher, "latest", "-", "0", "1");
	const a = activate(candidate("0.6.2"));
	assert.equal(a.status, 0, a.stderr);
	assert.match(a.stdout, /home repair: settings\.yaml retired keys: removed context\.memory\.observations/u);
	assert.match(a.stdout, /home repair: memory store: rewrote .*dropping 1/u);
	assert.match(readFileSync(join(config, "calls"), "utf8"), /^doctor --fix --json$/mu);
	const b = activate(candidate("0.6.3"));
	assert.equal(b.status, 0, b.stderr);
	assert.match(b.stdout, /home repair: nothing to remove/u);
	writeFileSync(join(config, "unfixable"), "");
	const before = readFileSync(join(f.root, "install.json"), "utf8");
	const c = activate(candidate("0.6.4"));
	assert.notEqual(c.status, 0);
	assert.match(
		c.stderr,
		/x\.y: unknown key[\s\S]*previous installation remains active\. The new version's doctor --fix ran/u,
	);
	assert.doesNotMatch(c.stderr, /retry the installer/u);
	// Rollback keeps its target: the failed activation left the manifest it found.
	assert.equal(readFileSync(join(f.root, "install.json"), "utf8"), before);
});

test("a pin records where it came from and keeps its first date across reinstalls of the same pin", {
	skip: process.platform === "win32",
}, (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "runtime/node-v24.0.0-linux-x64/bin"), { recursive: true });
	const node = join(f.root, "runtime/node-v24.0.0-linux-x64/bin/node");
	symlinkSync(process.execPath, node);
	rmSync(join(f.root, "install.json"));
	const activate = (version: string, pin: string, source: string) => {
		const dir = f.prefix(version);
		mkdirSync(join(dir, suffix, "dist/cli"), { recursive: true });
		writeFileSync(join(dir, suffix, "dist/cli/index.js"), `console.log(${JSON.stringify(version)});`);
		const result = f.run("activate", node, "24", "linux-x64", dir, f.record.launcher, "latest", pin, "0", "0", source);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(readFileSync(join(f.root, "install.json"), "utf8"));
	};
	const first = activate("0.6.2", "0.6.2", "package-file");
	assert.equal(first.pinSource, "package-file");
	const again = activate("0.6.2-again", "0.6.2", "version-flag");
	assert.deepEqual([again.pinSource, again.pinnedAt], [first.pinSource, first.pinnedAt]);
	const released = activate("0.6.3", "-", "version-flag");
	assert.deepEqual([released.versionPin, released.pinSource, released.pinnedAt], ["", "", ""]);
	assert.equal(f.run("rollback").status, 0);
	const rolled = JSON.parse(readFileSync(join(f.root, "install.json"), "utf8"));
	assert.equal(rolled.pinSource, "");
});

test("one tracking phrase names a pin, its origin and how to release it, or what the install follows", () => {
	const installer = {
		root: "/i",
		node: "/i/runtime/n/bin/node",
		nodeVersion: "24",
		nodeBuild: "linux-x64",
		current: "/i/versions/0.6.2",
		previous: null,
		launcher: "/b/clio-coder",
		channel: "latest",
	};
	const base = { kind: "installer" as const, root: "/r", entry: "/r/e", prefix: "/i/versions/0.6.2" };
	assert.equal(
		describeTracking(
			{ ...base, installer: { ...installer, versionPin: "0.6.2", installedAt: "2026-10-09T01:02:03Z" } },
			{ windows: false },
		),
		"pinned to 0.6.2 since 2026-10-09 (install.sh --version 0.6.2); release with clio-coder upgrade --channel latest",
	);
	assert.match(
		describeTracking({ ...base, installer: { ...installer, versionPin: "0.6.1", pinSource: "rollback" } }),
		/^pinned to 0\.6\.1 \(upgrade --rollback\)/,
	);
	assert.equal(
		describeTracking({ ...base, installer }, { autoUpdate: { enabled: false, blocker: "setting" } }),
		"follows latest; background updates off (setting)",
	);
	assert.equal(
		describeTracking({ kind: "npm", root: "/r", entry: "/r/e", prefix: "/p" }),
		"npm global; follows latest through npm",
	);
});

test("malformed liveness receipts withdraw the proof", { skip: process.platform !== "linux" }, (t) => {
	const f = fixture(t),
		unused = f.prefix("0.5.9");
	f.receipt("broken.json", "{");
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
	assert.equal(existsSync(join(f.root, ".active")), false, "receipts never land in the install root");
	// A contained shell mounts the state root read-only; the launch still runs without a receipt.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		mkdirSync(f.receipts, { recursive: true });
		chmodSync(f.receipts, 0o555);
		try {
			const readOnly = f.run("launch", "--version");
			assert.equal(readOnly.status, 0, readOnly.stderr);
			assert.equal(readOnly.stdout.trim(), active);
			assert.deepEqual(readdirSync(f.receipts), []);
		} finally {
			chmodSync(f.receipts, 0o755);
		}
	}
});
