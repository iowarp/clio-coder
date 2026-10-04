import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	installWindowsLauncher,
	uninstallWindowsLauncher,
	visibleWslArguments,
	visibleWslScript,
	windowsArgument,
	windowsLauncherStatus,
	windowsToWsl,
	wslLaunchArguments,
} from "../server/launcher/windows.js";
import { isWsl, runWindowsPowerShell } from "../server/process-policy.js";

test("Windows launch wrapper retains literal WSL arguments and reports exit failures with a timeout", () => {
	const raw = wslLaunchArguments(
		"Ubuntu-24.04",
		"user",
		{ node: "/node", entry: "/old/server.js" },
		"/home/user/a 'quoted' directory",
		"open",
		"/home/user/bin/clio-coder",
	);
	const script = visibleWslScript(raw);
	assert.match(script, /WaitForExit\(60000\)/);
	assert.match(script, /MessageBox\]::Show/);
	assert.match(script, /ExitCode -ne 0/);
	assert.ok(script.includes(raw.replaceAll("'", "''")));
	assert.ok(!script.includes("/old/server.js"));
});

test("real Windows temporary shortcuts migrate renamed owned pins, preserve other distros and uninstall", {
	skip: !isWsl() || process.env.CLIO_CODER_TEST_WINDOWS_TEMP !== "1",
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "clio-win-shortcuts-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const win = (
		await runWindowsPowerShell(
			"$ErrorActionPreference='Stop'; $p=Join-Path ([IO.Path]::GetTempPath()) ('clio-install-hardening-' + [guid]::NewGuid()); [void](New-Item -ItemType Directory -Path $p); [Console]::Write($p)",
		)
	).trim();
	t.after(() =>
		runWindowsPowerShell("Remove-Item -LiteralPath $env:CLIO_WIN_TEST_ROOT -Recurse -Force", {
			CLIO_WIN_TEST_ROOT: win,
		}).then(() => {}),
	);
	const folders = [`${win}\\Programs`, `${win}\\Startup`, `${win}\\Local`, `${win}\\TaskBar`] as const;
	await runWindowsPowerShell(
		"$ErrorActionPreference='Stop'; [void](New-Item -ItemType Directory -Path $env:CLIO_WIN_TEST_PIN)",
		{ CLIO_WIN_TEST_PIN: folders[3] },
	);
	const launch = {
		node: process.execPath,
		entry: join(directory, "server.js"),
		icon: fileURLToPath(new URL("../client/public/icon-192.png", import.meta.url)),
	};
	await writeFile(launch.entry, "");
	const raw = wslLaunchArguments(process.env.WSL_DISTRO_NAME ?? "", userInfo().username, launch, directory, "open");
	await runWindowsPowerShell(
		"$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; $a=$s.CreateShortcut($env:CLIO_WIN_TEST_PIN + '\\Renamed Clio.lnk'); $a.TargetPath='C:\\Windows\\System32\\wsl.exe'; $a.Arguments=$env:CLIO_WIN_TEST_ARGS; $a.Save(); $b=$s.CreateShortcut($env:CLIO_WIN_TEST_PIN + '\\Foreign.lnk'); $b.TargetPath=$a.TargetPath; $b.Arguments=$env:CLIO_WIN_TEST_ARGS.Replace('-d ', '-d Other'); $b.Save()",
		{ CLIO_WIN_TEST_PIN: folders[3], CLIO_WIN_TEST_ARGS: raw },
	);
	const foreign = await readFile(join(windowsToWsl(folders[3]), "Foreign.lnk"));
	await installWindowsLauncher(directory, launch, folders);
	assert.equal(await windowsLauncherStatus(directory), "installed");
	const pin = (
		await runWindowsPowerShell(
			"$s=New-Object -ComObject WScript.Shell; $a=$s.CreateShortcut($env:CLIO_WIN_TEST_PATH); [Console]::Write($a.Arguments)",
			{ CLIO_WIN_TEST_PATH: `${folders[3]}\\Renamed Clio.lnk` },
		)
	).trim();
	const manifest = JSON.parse(await readFile(join(directory, "windows.json"), "utf8"));
	assert.equal(pin, manifest.menuArgs);
	assert.ok(pin.length < 1024);
	assert.match(pin, /-File /);
	assert.deepEqual(await readFile(join(windowsToWsl(folders[3]), "Foreign.lnk")), foreign);
	// Reconciliation (including upgrade) must retain the recorded folders.
	await installWindowsLauncher(directory, launch);
	await uninstallWindowsLauncher(directory);
	assert.equal(await windowsLauncherStatus(directory), "absent");
	await assert.rejects(readFile(join(windowsToWsl(folders[3]), "Renamed Clio.lnk")), { code: "ENOENT" });
	assert.deepEqual(await readFile(join(windowsToWsl(folders[3]), "Foreign.lnk")), foreign);
	// Exercise the same generated host script without displaying any dialog or opening a browser.
	const goodArgs = wslLaunchArguments(
		process.env.WSL_DISTRO_NAME ?? "",
		userInfo().username,
		{ node: "/bin/true", entry: "unused" },
		directory,
		"start",
	);
	const script = visibleWslScript(goodArgs);
	assert.equal(await runWindowsPowerShell(script), "");
	assert.ok(windowsArgument("space path").startsWith('"'));
	assert.throws(() => visibleWslArguments("x".repeat(1024)), /limit/);
});

test("managed Windows app uses its owned profile and shell identity and uninstall removes that profile", {
	skip: !isWsl() || process.env.CLIO_CODER_TEST_WINDOWS_DESKTOP !== "1",
}, async (t) => {
	const { openManagedWindowsApp } = await import("../server/launcher/windows.js");
	const directory = await mkdtemp(join(tmpdir(), "clio-win-desktop-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const win = (
		await runWindowsPowerShell(
			"$p=Join-Path ([IO.Path]::GetTempPath()) ('clio-install-hardening-desktop-' + [guid]::NewGuid()); [void](New-Item -ItemType Directory -Path $p); [Console]::Write($p)",
		)
	).trim();
	t.after(() =>
		runWindowsPowerShell(
			"Remove-Item -LiteralPath $env:CLIO_WIN_TEST_ROOT -Recurse -Force -ErrorAction SilentlyContinue",
			{ CLIO_WIN_TEST_ROOT: win },
		).then(() => {}),
	);
	const launch = {
		node: process.execPath,
		entry: join(directory, "server.js"),
		icon: fileURLToPath(new URL("../client/public/icon-192.png", import.meta.url)),
	};
	await writeFile(launch.entry, "");
	const folders = [`${win}\\Programs`, `${win}\\Startup`, `${win}\\Local`, `${win}\\TaskBar`] as const;
	await installWindowsLauncher(directory, launch, folders);
	t.after(() => uninstallWindowsLauncher(directory).then(() => {}));
	const manifest = JSON.parse(await readFile(join(directory, "windows.json"), "utf8"));
	assert.equal(
		await openManagedWindowsApp(
			"http://127.0.0.1:43981/#token=clio_install_hardening_isolated_desktop_token_00001",
			directory,
		),
		true,
	);
	// Two simultaneous relaunches must serialize, focus the existing window and preserve its identity.
	await Promise.all(
		[0, 1].map(() =>
			openManagedWindowsApp(
				"http://127.0.0.1:43981/#token=clio_install_hardening_isolated_desktop_token_00001",
				directory,
			),
		),
	);
	const result = await runWindowsPowerShell(
		"$ErrorActionPreference='Stop'; Add-Type -Path $env:CLIO_WIN_IDENTITY_SOURCE; $ids=@(); Get-CimInstance Win32_Process -Filter \"name='chrome.exe' OR name='msedge.exe'\" | Where-Object { [ClioIdentity]::UsesProfile($_.CommandLine,$env:CLIO_WIN_PROFILE) } | ForEach-Object { foreach($w in [ClioIdentity]::Windows($_.ProcessId)) { $ids += [ClioIdentity]::WindowId($w) } }; ConvertTo-Json -Compress -InputObject $ids",
		{
			CLIO_WIN_IDENTITY_SOURCE: `${manifest.appDirectory}\\identity.cs`,
			CLIO_WIN_PROFILE: `${manifest.appDirectory}\\browser`,
		},
	);
	assert.deepEqual(JSON.parse(result), [manifest.appId], "repeated launches must keep exactly one app window");
	await uninstallWindowsLauncher(directory);
	await assert.rejects(readFile(join(windowsToWsl(manifest.appDirectory), "app-id")), { code: "ENOENT" });
	const { stat } = await import("node:fs/promises");
	await assert.rejects(stat(join(windowsToWsl(manifest.appDirectory), "browser")), { code: "ENOENT" });
});
