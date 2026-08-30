/**
 * The install/upgrade/status/uninstall lifecycle against an isolated prefix
 * and a stand-in binary. Nothing here compiles or touches the real home.
 */

import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import {
	DESKTOP_ENTRY_NAME,
	desktopEntry,
	ICON_NAME,
	install,
	type InstallManifest,
	type LifecycleContext,
	LifecycleError,
	readManifest,
	resolveLayout,
	runLifecycle,
	status,
	uninstall,
} from "../scripts/gui-lifecycle.ts";
import { APP_VERSION, CLI_NAME } from "../main.ts";

async function scratch(): Promise<string> {
	return await Deno.makeTempDir({ prefix: "clio-coder-gui-lifecycle-" });
}

function context(home: string, extra: Record<string, string> = {}): LifecycleContext & { lines: string[] } {
	const lines: string[] = [];
	const values: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin", ...extra };
	return { env: (name) => values[name], log: (line) => lines.push(line), lines };
}

async function listTree(root: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(directory: string, prefix: string): Promise<void> {
		for await (const entry of Deno.readDir(directory)) {
			const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			found.push(entry.isDirectory ? `${relativePath}/` : relativePath);
			if (entry.isDirectory) await walk(join(directory, entry.name), relativePath);
		}
	}
	await walk(root, "");
	return found.sort();
}

async function dummyBinary(root: string, content: string): Promise<string> {
	const path = join(root, "build", CLI_NAME);
	await Deno.mkdir(join(root, "build"), { recursive: true });
	await Deno.writeTextFile(path, content);
	return path;
}

Deno.test("the layout follows XDG defaults without a prefix and stays inside the prefix with one", () => {
	const env = (name: string) => ({ HOME: "/home/researcher", XDG_DATA_HOME: "/home/researcher/data" })[name];
	const xdg = resolveLayout({}, env);
	equal(xdg.bin, "/home/researcher/.local/bin");
	equal(xdg.applications, "/home/researcher/data/applications");
	equal(xdg.data, "/home/researcher/data/clio-coder-gui");
	equal(xdg.manifest, "/home/researcher/data/clio-coder-gui/install.json");
	equal(xdg.stateDir, "/home/researcher/.local/state/clio-workbench");

	const prefixed = resolveLayout({ prefix: "/opt/clio" }, env);
	equal(prefixed.bin, "/opt/clio/bin");
	equal(prefixed.applications, "/opt/clio/share/applications");
	equal(prefixed.data, "/opt/clio/share/clio-coder-gui");
	equal(prefixed.stateDir, "/home/researcher/.local/state/clio-workbench");

	const explicitState = resolveLayout(
		{},
		(name) => ({ HOME: "/home/researcher", CLIO_WORKBENCH_STATE_DIR: "/srv/state" })[name],
	);
	equal(explicitState.stateDir, "/srv/state");
});

Deno.test("the installer refuses the home directory, the filesystem root, and relative paths as a prefix", () => {
	const env = (name: string) => ({ HOME: "/home/researcher" })[name];
	for (const prefix of ["/home/researcher", "/", "relative/dir"]) {
		let failed = false;
		try {
			resolveLayout({ prefix }, env);
		} catch (error) {
			failed = error instanceof LifecycleError;
		}
		ok(failed, `${prefix} must be refused`);
	}
});

Deno.test("the desktop entry launches the binary with --open and quotes its path", () => {
	const entry = desktopEntry("/opt/my apps/bin/clio-coder-gui", "/opt/icons/clio-coder-gui.png");
	ok(entry.startsWith("[Desktop Entry]\n"));
	ok(entry.includes('Exec="/opt/my apps/bin/clio-coder-gui" --open\n'));
	ok(entry.includes("Icon=/opt/icons/clio-coder-gui.png\n"));
	ok(entry.includes("Name=Clio Coder\n"));
	ok(entry.includes("Terminal=true\n"));
});

Deno.test("install, status, upgrade, and uninstall touch only the three recorded files", async () => {
	const root = await scratch();
	try {
		const home = join(root, "home");
		const prefix = join(root, "prefix");
		const stateDir = join(root, "state");
		await Deno.mkdir(join(stateDir, "projects"), { recursive: true });
		await Deno.writeTextFile(join(stateDir, "projects", "recent.json"), "[]");
		const firstBinary = await dummyBinary(root, "#!/bin/sh\necho first\n");
		const ctx = context(home);

		const manifest = await install({ prefix, binary: firstBinary, stateDir, skipBuild: true }, ctx);
		equal(manifest.version, APP_VERSION);
		equal(manifest.stateDir, stateDir);
		deepEqual(manifest.files.map((file) => file.role), ["binary", "icon", "desktop-entry"]);
		deepEqual(await listTree(prefix), [
			"bin/",
			`bin/${CLI_NAME}`,
			"share/",
			"share/applications/",
			`share/applications/${DESKTOP_ENTRY_NAME}`,
			"share/clio-coder-gui/",
			`share/clio-coder-gui/${ICON_NAME}`,
			"share/clio-coder-gui/install.json",
		]);
		equal(await Deno.readTextFile(join(prefix, "bin", CLI_NAME)), "#!/bin/sh\necho first\n");
		equal((await Deno.stat(join(prefix, "bin", CLI_NAME))).mode! & 0o111, 0o111, "the binary is executable");
		const entry = await Deno.readTextFile(join(prefix, "share", "applications", DESKTOP_ENTRY_NAME));
		ok(entry.includes(`Exec="${join(prefix, "bin", CLI_NAME)}" --open`));
		ok(entry.includes(`Icon=${join(prefix, "share", "clio-coder-gui", ICON_NAME)}`));
		const iconBytes = await Deno.readFile(join(prefix, "share", "clio-coder-gui", ICON_NAME));
		deepEqual([...iconBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the icon is a PNG");
		ok(ctx.lines.some((line) => line.includes("is not on PATH")));

		const healthy = await status({ prefix, stateDir }, ctx);
		equal(healthy.installed, true);
		equal(healthy.version, APP_VERSION);
		deepEqual(healthy.files.map((file) => file.state), ["ok", "ok", "ok"]);
		equal(healthy.stateDirPresent, true);
		equal(healthy.binOnPath, false);

		// A modified file is reported, never silently accepted.
		await Deno.writeTextFile(join(prefix, "bin", CLI_NAME), "tampered");
		const tampered = await status({ prefix, stateDir }, ctx);
		deepEqual(tampered.files.map((file) => file.state), ["modified", "ok", "ok"]);

		// Upgrade replaces the binary in place and rewrites the manifest.
		const secondBinary = await dummyBinary(root, "#!/bin/sh\necho second\n");
		const upgraded = await install({ prefix, binary: secondBinary, stateDir, skipBuild: true }, ctx);
		equal(await Deno.readTextFile(join(prefix, "bin", CLI_NAME)), "#!/bin/sh\necho second\n");
		equal(upgraded.files.length, 3);
		ok(upgraded.files[0]!.sha256 !== manifest.files[0]!.sha256);
		deepEqual(upgraded.createdDirectories, manifest.createdDirectories);
		deepEqual((await status({ prefix, stateDir }, ctx)).files.map((file) => file.state), ["ok", "ok", "ok"]);
		ok(ctx.lines.some((line) => line.includes("Upgrading")));
		ok(!(await listTree(prefix)).some((path) => path.endsWith(".tmp")), "no temp files are left behind");

		// Uninstall removes exactly those files and the directories it created, and keeps the state.
		equal(await uninstall({ prefix, stateDir, purgeState: false }, ctx), true);
		equal(await Deno.stat(prefix).then(() => true, () => false), false, "the created prefix is gone");
		deepEqual(await listTree(stateDir), ["projects/", "projects/recent.json"]);
		ok(ctx.lines.some((line) => line.includes("Kept state directory")));

		// A second uninstall is a no-op that says so.
		equal(await uninstall({ prefix, stateDir, purgeState: false }, ctx), false);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("uninstall keeps pre-existing directories and only purges state when asked", async () => {
	const root = await scratch();
	try {
		const home = join(root, "home");
		const prefix = join(root, "prefix");
		const stateDir = join(root, "state");
		await Deno.mkdir(join(prefix, "bin"), { recursive: true });
		await Deno.writeTextFile(join(prefix, "bin", "other-tool"), "keep me");
		await Deno.mkdir(stateDir, { recursive: true });
		await Deno.writeTextFile(join(stateDir, "workbench.json"), "{}");
		const binary = await dummyBinary(root, "binary");
		const ctx = context(home);
		await install({ prefix, binary, stateDir, skipBuild: true }, ctx);
		await uninstall({ prefix, stateDir, purgeState: true }, ctx);
		deepEqual(await listTree(prefix), ["bin/", "bin/other-tool"]);
		equal(await Deno.stat(stateDir).then(() => true, () => false), false, "the state directory was purged");
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("uninstall leaves alone anything the manifest lists outside the recorded roots or that changed shape", async () => {
	const root = await scratch();
	try {
		const home = join(root, "home");
		const prefix = join(root, "prefix");
		const stateDir = join(root, "state");
		const outside = join(root, "precious.txt");
		await Deno.writeTextFile(outside, "not yours");
		const binary = await dummyBinary(root, "binary");
		const ctx = context(home);
		const manifest = await install({ prefix, binary, stateDir, skipBuild: true }, ctx);

		// Replace the icon with a directory and add an outside path to the manifest.
		const iconPath = manifest.files.find((file) => file.role === "icon")!.path;
		await Deno.remove(iconPath);
		await Deno.mkdir(iconPath);
		const hostile: InstallManifest = {
			...manifest,
			files: [...manifest.files, { path: outside, role: "icon", sha256: "0", bytes: 0 }],
		};
		const manifestPath = join(prefix, "share", "clio-coder-gui", "install.json");
		await Deno.writeTextFile(manifestPath, JSON.stringify(hostile));

		await uninstall({ prefix, stateDir, purgeState: false }, ctx);
		equal(await Deno.readTextFile(outside), "not yours");
		ok((await Deno.stat(iconPath)).isDirectory, "a directory where the icon was is never removed");
		ok(ctx.lines.some((line) => line.includes("outside the recorded installation directories")));
		ok(ctx.lines.some((line) => line.includes("not a regular file any more")));
		equal(await readManifest(manifestPath), null);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a corrupt manifest is refused rather than guessed at", async () => {
	const root = await scratch();
	try {
		const prefix = join(root, "prefix");
		const manifestPath = join(prefix, "share", "clio-coder-gui", "install.json");
		await Deno.mkdir(join(prefix, "share", "clio-coder-gui"), { recursive: true });
		await Deno.writeTextFile(manifestPath, "{not json");
		await rejects(() => readManifest(manifestPath), LifecycleError);
		await Deno.writeTextFile(manifestPath, JSON.stringify({ schema: 99, files: [] }));
		await rejects(() => readManifest(manifestPath), LifecycleError);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("the command line maps to the same operations and reports usage for anything else", async () => {
	const root = await scratch();
	try {
		const home = join(root, "home");
		const prefix = join(root, "prefix");
		const stateDir = join(root, "state");
		const binary = await dummyBinary(root, "binary");
		const ctx = context(home);
		equal(await runLifecycle(["status", `--prefix=${prefix}`, `--state-dir=${stateDir}`], ctx), 1);
		equal(
			await runLifecycle(
				["install", `--prefix=${prefix}`, `--binary=${binary}`, `--state-dir=${stateDir}`, "--skip-build"],
				ctx,
			),
			0,
		);
		equal(await runLifecycle(["status", `--prefix=${prefix}`, `--state-dir=${stateDir}`], ctx), 0);
		equal(await runLifecycle(["uninstall", `--prefix=${prefix}`, `--state-dir=${stateDir}`], ctx), 0);
		equal(await runLifecycle([], ctx), 0);
		equal(await runLifecycle(["dance"], ctx), 2);
		await rejects(() => runLifecycle(["install", "--bogus"], ctx), LifecycleError);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
