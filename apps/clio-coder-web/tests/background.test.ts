import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	backgroundStatus,
	installBackground,
	startBackground,
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
import { type controlService, serviceCommand } from "../server/process-policy.js";

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
	const control = async () => "";
	await installBackground(directory, config, control, async () => {});
	assert.deepEqual(await readBackgroundConfig(backgroundPaths(directory).config), config);
	const desktop = await launcherStatus(config.desktopPrefix);
	assert.equal(desktop.status, "installed");
	const text = await readFile(desktop.entry, "utf8");
	assert.equal(text, desktopEntry({ ...config.launch, background: directory }));
	assert.ok(text.includes(`Icon=${icon}`));
	assert.ok(!text.includes("--import"));
	await assert.rejects(
		installBackground(directory, { ...config, packageRoot: root }, control, async () => {}),
		/another installation/,
	);
	assert.equal((await uninstallBackground(directory, control)).status, "absent");
	assert.equal(serverOptions(["--open", "--no-open"]).open, false);
});
