import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	backgroundStatus,
	installBackground,
	preferBackground,
	restartBackground,
	restartBackgroundIfIdle,
	startBackground,
	startCurrentBackground,
	stopBackground,
	tryStartBackground,
	uninstallBackground,
} from "../server/launcher/background.js";
import {
	backgroundEnvironment,
	backgroundPaths,
	backgroundUnit,
	newBackgroundConfig,
	readBackgroundConfig,
	systemdArgument,
} from "../server/launcher/background-config.js";
import { desktopEntry } from "../server/launcher/desktop-entry.js";
import { launcherStatus } from "../server/launcher/install.js";
import { serverOptions } from "../server/options.js";
import { autoOpenBrowser, type controlService, serviceCommand } from "../server/process-policy.js";

const launch = {
	node: process.execPath,
	loader: fileURLToPath(import.meta.resolve("tsx")),
	entry: fileURLToPath(new URL("../server/main.ts", import.meta.url)),
};

test("background setup preserves its stable identity, starts explicitly, and removes only verified owned files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-background-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		prefix = join(root, "desktop"),
		files = backgroundPaths(directory);
	const config = await newBackgroundConfig(4317, launch, prefix, { PATH: "/usr/bin", EXAMPLE_SECRET: "never-copy" });
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return `FragmentPath=${calls.includes("enable") ? files.unitFile : ""}\nActiveState=active\nUnitFileState=enabled\nMainPID=123\n`;
	};
	const ready = async (port: number, token: string) => {
		assert.equal(port, 4317);
		assert.equal(token, config.token);
	};
	assert.equal((await backgroundStatus(directory, control)).status, "absent");
	assert.equal(await tryStartBackground(directory, config.packageRoot, control, ready), undefined);
	const installed = await installBackground(directory, config, control, ready);
	assert.equal(installed.status, "installed");
	assert.ok(!JSON.stringify(installed).includes(config.token));
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(files.config)).mode & 0o777, 0o600);
	assert.deepEqual(await readBackgroundConfig(files.config), config);
	const unit = await readFile(files.unitFile, "utf8");
	assert.equal(unit, backgroundUnit(config, directory));
	assert.ok(!unit.includes(config.token));
	assert.ok(!JSON.stringify(config).includes("never-copy"));
	assert.deepEqual(
		Object.keys(backgroundEnvironment(config)).sort(),
		[
			"PATH",
			"CLIO_CODER_PACKAGE_ROOT",
			...["CONFIG", "DATA", "STATE", "CACHE"].map((role) => `CLIO_CODER_${role}_DIR`),
		].sort(),
	);
	await installBackground(directory, { ...config, token: "z".repeat(43) }, control, ready);
	assert.equal((await readBackgroundConfig(files.config)).token, config.token);
	await assert.rejects(installBackground(directory, { ...config, port: 4318 }, control, ready), /stable port/);
	const state = await backgroundStatus(directory, control, async () => true);
	assert.equal(state.ready, true);
	assert.equal(state.desktop, "installed");
	assert.ok(!JSON.stringify(state).includes(config.token));
	assert.equal(await startBackground(directory, control, ready), `http://127.0.0.1:4317/#token=${config.token}`);
	assert.equal(
		await tryStartBackground(directory, config.packageRoot, control, ready),
		`http://127.0.0.1:4317/#token=${config.token}`,
	);
	const beforeForeign = calls.length;
	await assert.rejects(tryStartBackground(directory, root, control, ready), /another installation/);
	assert.equal(calls.length, beforeForeign);
	await stopBackground(directory, control);
	await writeFile(join(directory, "keep.txt"), "keep");
	await writeFile(files.unitFile, `${unit}# user edit\n`);
	const before = calls.length;
	await assert.rejects(uninstallBackground(directory, control), /ownership/);
	await assert.rejects(tryStartBackground(directory, config.packageRoot, control, ready), /ownership/);
	assert.equal(calls.length, before);
	await writeFile(files.unitFile, unit);
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
	assert.deepEqual(await readdir(directory), ["keep.txt"]);
	assert.equal((await launcherStatus(prefix)).status, "absent");
	assert.ok(calls.includes("disable") && calls.includes("reload") && calls.includes("stop"));
});

test("background preparation is atomic and refuses foreign services, linked credentials and public state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-background-ownership-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		config = await newBackgroundConfig(4317, launch, join(root, "desktop"));
	const foreign = join(root, "foreign.service");
	await writeFile(foreign, "keep");
	await assert.rejects(
		installBackground(
			directory,
			config,
			async () => `FragmentPath=${foreign}`,
			async () => {},
		),
		/different service/,
	);
	assert.deepEqual(await readdir(directory), []);
	await writeFile(join(directory, "keep.txt"), "keep");
	await assert.rejects(
		installBackground(
			directory,
			config,
			async () => "",
			async () => {},
		),
	);
	assert.deepEqual(await readdir(directory), ["keep.txt"]);
	assert.equal(
		(await readdir(root)).some((name) => name.startsWith(".clio-coder-background-")),
		false,
	);
	await rm(join(directory, "keep.txt"));
	await chmod(directory, 0o755);
	await assert.rejects(
		installBackground(
			directory,
			config,
			async () => "",
			async () => {},
		),
		/private/,
	);
	await chmod(directory, 0o700);
	await installBackground(
		directory,
		config,
		async () => "",
		async () => {},
	);
	const files = backgroundPaths(directory);
	await chmod(files.config, 0o644);
	await assert.rejects(readBackgroundConfig(files.config), /private/);
	await chmod(files.config, 0o600);
	await link(files.config, join(root, "linked"));
	await assert.rejects(readBackgroundConfig(files.config), /private/);
	await rm(join(root, "linked"));
	await symlink(files.config, join(root, "symlink"));
	await assert.rejects(readBackgroundConfig(join(root, "symlink")));
	await uninstallBackground(directory, async () => "");
	await mkdir(join(root, "real"), { mode: 0o700 });
	await symlink(join(root, "real"), directory);
	await assert.rejects(
		installBackground(
			directory,
			config,
			async () => "",
			async () => {},
		),
		/canonical/,
	);
});

test("persistent mode cannot accidentally become transient and service control accepts only fixed Clio units", () => {
	const persistent = ["--persistent", "/private/server.json"];
	for (const extra of [
		["--port", "0"],
		["--token", "a".repeat(43)],
		["--idle-exit", "60000"],
		["--open"],
		["--fixture"],
	])
		assert.throws(() => serverOptions([...persistent, ...extra]), /cannot be combined/);
	assert.equal(serverOptions(persistent).idleMs, undefined);
	assert.equal(serverOptions([]).persistent, undefined);
	assert.throws(() => serverOptions(["--persistent", ""]));
	const { unit, unitFile } = backgroundPaths("/private/space and $variable %f");
	assert.deepEqual(serviceCommand("enable", unit, unitFile), ["--user", "enable", "--now", "--", unitFile]);
	assert.throws(() => serviceCommand("stop", "unrelated.service", "/tmp/unrelated.service"));
	assert.throws(() => systemdArgument("path\nExecStart=bad"));
	assert.equal(systemdArgument('a $var %f "quote" \\'), '"a $$var %%f \\"quote\\" \\\\"');
});

test("installed background configuration launches plain Node and preserves a branded desktop entry", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-installed-background-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = join(root, "server.js"),
		icon = join(root, "icon.png"),
		directory = join(root, "background");
	await writeFile(entry, "export {};\n");
	await writeFile(icon, "test icon");
	const config = await newBackgroundConfig(4317, { node: process.execPath, entry, icon }, join(root, "desktop"));
	assert.equal(config.launch.loader, undefined);
	assert.ok(!backgroundUnit(config, directory).includes("--import"));
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return "";
	};
	await installBackground(directory, config, control, async () => {});
	assert.deepEqual(await readBackgroundConfig(backgroundPaths(directory).config), config);
	const desktop = await launcherStatus(config.desktopPrefix);
	assert.equal(desktop.status, "installed");
	const text = await readFile(desktop.entry, "utf8");
	assert.equal(text, desktopEntry({ ...config.launch, background: directory }));
	assert.ok(text.includes(`Icon=${icon}`));
	assert.ok(!text.includes("--import"));
	const movedEntry = join(root, "moved-server.js"),
		packageAlias = join(root, "same-package-root");
	await writeFile(movedEntry, "export {};\n");
	await symlink(config.packageRoot, packageAlias);
	const current = await newBackgroundConfig(
		4317,
		{ node: process.execPath, entry: movedEntry, icon },
		config.desktopPrefix,
	);
	const moved = { ...current, packageRoot: packageAlias };
	await installBackground(directory, moved, control, async () => {}, { probe: async () => null });
	const repinned = await readBackgroundConfig(backgroundPaths(directory).config);
	assert.equal(repinned.token, config.token);
	assert.equal(repinned.launch.entry, movedEntry);
	assert.deepEqual(calls.slice(-3), ["reload", "enable", "restart"]);
	const movedDesktop = await launcherStatus(config.desktopPrefix);
	assert.equal(movedDesktop.status, "installed");
	assert.equal(await readFile(movedDesktop.entry, "utf8"), desktopEntry({ ...repinned.launch, background: directory }));
	await assert.rejects(
		installBackground(directory, { ...moved, packageRoot: root }, control, async () => {}),
		/another installation/,
	);
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
	assert.equal(serverOptions(["--open", "--no-open"]).open, "never");
});

test("restart repins moved launch paths for the same installation before starting", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-background-repin-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		prefix = join(root, "desktop"),
		oldEntry = join(root, "old-server.js"),
		currentEntry = join(root, "current-server.js");
	await writeFile(oldEntry, "export {};\n");
	await writeFile(currentEntry, "export {};\n");
	const config = await newBackgroundConfig(4317, { node: process.execPath, entry: oldEntry }, prefix);
	const files = backgroundPaths(directory);
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return `FragmentPath=${calls.includes("enable") ? files.unitFile : ""}\nActiveState=active\n`;
	};
	const ready = async () => ({ clio: "0.5.7", idle: true });
	await installBackground(directory, config, control, ready);
	const result = await restartBackgroundIfIdle(directory, control, ready, ready, {
		node: process.execPath,
		entry: currentEntry,
	});
	assert.deepEqual(result, { status: "restarted", running: "0.5.7" });
	assert.deepEqual(calls.slice(-3), ["reload", "show", "restart"]);
	const repinned = await readBackgroundConfig(files.config);
	assert.equal(repinned.token, config.token);
	assert.equal(repinned.launch.entry, currentEntry);
	assert.ok((await readFile(files.unitFile, "utf8")).includes(currentEntry));
	const desktop = await launcherStatus(prefix);
	assert.equal(desktop.status, "installed");
	assert.equal(await readFile(desktop.entry, "utf8"), desktopEntry({ ...repinned.launch, background: directory }));
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
});

test("a bare launch reuses only this installation's verified background app and otherwise explains", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-background-prefer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		files = backgroundPaths(directory);
	const config = await newBackgroundConfig(4317, launch, join(root, "desktop"), { PATH: "/usr/bin" });
	const calls: string[] = [];
	let failStart = false;
	const control: typeof controlService = async (action) => {
		calls.push(action);
		if (failStart && action === "start") throw new Error("Background service start failed.");
		return `FragmentPath=${calls.includes("enable") ? files.unitFile : ""}\nActiveState=active\n`;
	};
	const ready = async () => ({ clio: "0.0.1-running" });
	assert.deepEqual(await preferBackground(directory, config.packageRoot, control, ready), { kind: "absent" });
	assert.deepEqual(calls, [], "An absent app is decided from files alone");
	await installBackground(directory, config, control, ready);
	assert.deepEqual(await preferBackground(directory, config.packageRoot, control, ready), {
		kind: "open",
		url: `http://127.0.0.1:4317/#token=${config.token}`,
		running: "0.0.1-running",
	});
	assert.equal(calls.at(-1), "start");
	// A readiness fake that reports nothing leaves the running version unknown rather than guessed.
	assert.equal(
		((await preferBackground(directory, config.packageRoot, control, async () => {})) as { running: unknown }).running,
		null,
	);
	const before = calls.length;
	const foreign = await preferBackground(directory, root, control, ready);
	assert.equal(foreign.kind, "unavailable");
	assert.match((foreign as { reason: string }).reason, /another Clio Coder installation/);
	assert.equal(calls.length, before, "Another installation's service is never touched");
	assert.deepEqual(await preferBackground(directory, config.packageRoot, control, ready, "darwin"), { kind: "absent" });
	failStart = true;
	const failed = await preferBackground(directory, config.packageRoot, control, ready);
	assert.deepEqual(failed, { kind: "unavailable", reason: "Background service start failed." });
	failStart = false;
	const restarted = await restartBackground(directory, control, ready);
	assert.equal(calls.at(-1), "restart");
	assert.equal(restarted.running, "0.0.1-running");
	const unit = await readFile(files.unitFile, "utf8");
	await writeFile(files.unitFile, `${unit}# user edit\n`);
	const tampered = calls.length;
	const refused = await preferBackground(directory, config.packageRoot, control, ready);
	assert.equal(refused.kind, "unavailable");
	assert.match((refused as { reason: string }).reason, /could not be verified/);
	assert.equal(calls.length, tampered, "Unverifiable files are left alone");
	await writeFile(files.unitFile, unit);
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
});

test("launch options: bare reuses and opens on a desktop; any listener flag keeps a private server", () => {
	assert.deepEqual((({ open, reuse }) => ({ open, reuse }))(serverOptions([])), { open: "auto", reuse: "preferred" });
	assert.equal(serverOptions(["--path", "/docs"]).reuse, "preferred");
	for (const flags of [
		["--foreground"],
		["--port", "0"],
		["--idle-exit", "60000"],
		["--log-file", "/tmp/x"],
		["--fixture"],
	])
		assert.equal(serverOptions(flags).reuse, "never", flags.join(" "));
	assert.equal(serverOptions(["--reuse-background"]).reuse, "required");
	assert.throws(() => serverOptions(["--reuse-background", "--foreground"]), /opposite/);
	assert.equal(serverOptions(["--open"]).open, "always");
	assert.equal(serverOptions(["--no-open"]).open, "never");
	assert.equal(serverOptions(["--persistent", "/tmp/server.json"]).open, "never");
	assert.equal(autoOpenBrowser({ DISPLAY: ":0" }, "linux", false), false, "A pipe or a test never opens a browser");
	assert.equal(autoOpenBrowser({ DISPLAY: ":0" }, "linux", true), true);
	assert.equal(autoOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux", true), true);
	assert.equal(autoOpenBrowser({ WSL_DISTRO_NAME: "Ubuntu" }, "linux", true), true);
	assert.equal(
		autoOpenBrowser({ SSH_TTY: "/dev/pts/1" }, "linux", true),
		false,
		"SSH without a display prints the link",
	);
	assert.equal(autoOpenBrowser({}, "darwin", true), true);
	assert.equal(autoOpenBrowser({}, "win32", true), false, "Windows prints the link until its opener is verified");
});

test("a bare launch restarts this installation's idle background app when it runs an older version, and only then", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-background-version-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		files = backgroundPaths(directory);
	const config = await newBackgroundConfig(4318, launch, join(root, "desktop"), { PATH: "/usr/bin" });
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return `FragmentPath=${calls.includes("enable") ? files.unitFile : ""}\nActiveState=active\n`;
	};
	// The running app answers with its version and whether anything is open in it; a restart loads the new one.
	let running = "0.5.6";
	let idle: boolean | undefined = true;
	const ready = async () => ({ clio: running, ...(idle === undefined ? {} : { idle }) });
	await installBackground(directory, config, control, ready);
	const restartTo =
		(version: string): typeof controlService =>
		async (action, unit, unitFile) => {
			if (action === "restart") running = version;
			return control(action, unit, unitFile);
		};
	const upgraded = await preferBackground(directory, config.packageRoot, restartTo("0.5.7"), ready, "linux", "0.5.7");
	assert.deepEqual(upgraded, {
		kind: "open",
		url: `http://127.0.0.1:4318/#token=${config.token}`,
		running: "0.5.7",
		restartedFrom: "0.5.6",
	});
	assert.deepEqual(calls.slice(-2), ["show", "restart"]);
	// Something is open in it: the operator's work outlives the version check, and the caller says so.
	running = "0.5.6";
	idle = false;
	const busy = await preferBackground(directory, config.packageRoot, restartTo("0.5.7"), ready, "linux", "0.5.7");
	assert.deepEqual(busy, { kind: "open", url: `http://127.0.0.1:4318/#token=${config.token}`, running: "0.5.6" });
	assert.notEqual(calls.at(-1), "restart");
	// An older app that does not report idleness is treated as in use.
	idle = undefined;
	const unknown = await preferBackground(directory, config.packageRoot, restartTo("0.5.7"), ready, "linux", "0.5.7");
	assert.equal((unknown as { running: string }).running, "0.5.6");
	assert.notEqual(calls.at(-1), "restart");
	// The same version is never restarted.
	idle = true;
	running = "0.5.7";
	const same = await preferBackground(directory, config.packageRoot, restartTo("0.5.8"), ready, "linux", "0.5.7");
	assert.deepEqual(same, { kind: "open", url: `http://127.0.0.1:4318/#token=${config.token}`, running: "0.5.7" });
	assert.notEqual(calls.at(-1), "restart");
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
});

test("restart --if-idle restarts only an idle background app and says why it left a busy one", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-background-if-idle-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		files = backgroundPaths(directory);
	const config = await newBackgroundConfig(4319, launch, join(root, "desktop"), { PATH: "/usr/bin" });
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return `FragmentPath=${calls.includes("enable") ? files.unitFile : ""}\nActiveState=active\n`;
	};
	let idle: boolean | undefined = false;
	const ready = async () => ({ clio: "0.5.6", ...(idle === undefined ? {} : { idle }) });
	const probe = async () => ({ clio: "0.5.6", ...(idle === undefined ? {} : { idle }) });
	assert.deepEqual(await restartBackgroundIfIdle(directory, control, ready, probe), { status: "absent" });
	await installBackground(directory, config, control, ready);
	assert.deepEqual(await restartBackgroundIfIdle(directory, control, ready, probe), {
		status: "left",
		reason: "busy",
		running: "0.5.6",
	});
	assert.notEqual(calls.at(-1), "restart");
	idle = undefined;
	assert.deepEqual(await restartBackgroundIfIdle(directory, control, ready, probe), {
		status: "left",
		reason: "unknown",
		running: "0.5.6",
	});
	idle = true;
	assert.deepEqual(await restartBackgroundIfIdle(directory, control, ready, probe), {
		status: "restarted",
		running: "0.5.6",
	});
	assert.equal(calls.at(-1), "restart");
	// A stopped app has nothing open in it; restarting would start it, so it is left stopped.
	assert.deepEqual(await restartBackgroundIfIdle(directory, control, ready, async () => null), {
		status: "left",
		reason: "stopped",
		running: null,
	});
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
});

test("explicit handover preserves a verified service identity and refuses active work", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-handover-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background");
	const oldRoot = join(root, "old-checkout");
	const newRoot = join(root, "release");
	await mkdir(oldRoot);
	await mkdir(newRoot);
	await writeFile(join(newRoot, "server.js"), "export {};\n");
	const config = { ...(await newBackgroundConfig(4343, launch, join(root, "desktop"))), packageRoot: oldRoot };
	const files = backgroundPaths(directory);
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return `FragmentPath=${calls.includes("enable") ? files.unitFile : ""}\nActiveState=active`;
	};
	const ready = async () => ({ clio: "0.6.0", idle: true, port: 7373 });
	await installBackground(directory, config, control, ready);
	const proposed = { ...config, packageRoot: newRoot, launch: { ...launch, entry: join(newRoot, "server.js") } };
	await assert.rejects(installBackground(directory, proposed, control, ready), /--handover/);
	await assert.rejects(
		installBackground(directory, proposed, control, ready, {
			handover: true,
			probe: async () => ({ clio: "0.6.0", idle: false }),
		}),
		/active work/,
	);
	assert.equal((await readBackgroundConfig(files.config)).packageRoot, oldRoot);
	const changed = await installBackground(directory, proposed, control, ready, { handover: true, probe: ready });
	assert.equal(changed.origin, "http://127.0.0.1:7373");
	const saved = await readBackgroundConfig(files.config);
	assert.equal(saved.packageRoot, newRoot);
	assert.equal(saved.token, config.token);
	assert.equal(saved.port, 4343);
	assert.ok(calls.includes("restart"));
	assert.ok((await readFile(files.unitFile, "utf8")).includes(newRoot));
	await uninstallBackground(directory, control);
	assert.equal((await launcherStatus(config.desktopPrefix)).status, "absent");
});

test("opening after activation repins the service and restarts only idle work, including same-version rebuilds", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-open-current-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "background"),
		files = backgroundPaths(directory);
	const config = await newBackgroundConfig(4317, launch, join(root, "desktop"));
	const calls: string[] = [];
	const control: typeof controlService = async (action) => {
		calls.push(action);
		return `FragmentPath=${(await stat(files.unitFile).catch(() => null)) ? files.unitFile : ""}\nActiveState=active\n`;
	};
	await installBackground(directory, config, control, async () => {});
	const newEntry = join(root, "new-server.ts");
	await writeFile(newEntry, "export {};\n");
	let idle = false;
	let running = "0.6.0";
	const ready = async () => ({ clio: running, idle });
	calls.length = 0;
	await startCurrentBackground(directory, { ...launch, entry: newEntry }, control, ready);
	assert.equal((await readBackgroundConfig(files.config)).launch.entry, launch.entry);
	assert.ok(!calls.includes("restart"), "busy app keeps its executable until idle");
	idle = true;
	running = (await import("../server/clio/http-shims.js")).getVersionInfo().clio;
	calls.length = 0;
	await startCurrentBackground(directory, { ...launch, entry: newEntry }, control, ready);
	assert.equal((await readBackgroundConfig(files.config)).launch.entry, newEntry);
	assert.ok(calls.includes("restart"), "same-version rebuild is selected once idle");
	calls.length = 0;
	await startCurrentBackground(directory, launch, control, ready);
	assert.equal((await readBackgroundConfig(files.config)).launch.entry, launch.entry);
	assert.ok(calls.includes("restart"), "rollback opening selects the restored executable once idle");
});
