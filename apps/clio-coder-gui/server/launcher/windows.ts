import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isWsl, runWindowsPowerShell } from "../process-policy.js";
import type { LaunchPaths } from "./desktop-entry.js";
import { windowsAppScript, windowsIdentitySource } from "./windows-app.js";

/**
 * Windows entry points for a background app that lives in WSL. A Start Menu shortcut wakes WSL, starts
 * the service and opens the app window; a Startup shortcut wakes WSL at sign-in so a Windows restart
 * never leaves the installed app without its server. Ownership is recorded beside the background files
 * and only files whose recorded hash still matches are ever removed.
 */
const owner = "clio-coder-gui-windows";
const menuName = "Clio Coder.lnk";
const startupName = "Clio Coder (background).lnk";
const manifestName = "windows.json";
const iconName = "clio-coder.ico";

const foldersScript =
	"$ErrorActionPreference='Stop'; [Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Startup'); [Environment]::GetFolderPath('LocalApplicationData'); Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'";
const shortcutScript = [
	"$ErrorActionPreference='Stop'",
	"$s=New-Object -ComObject WScript.Shell",
	"$a=$s.CreateShortcut($env:CLIO_WIN_MENU_PATH)",
	"$a.TargetPath=$env:CLIO_WIN_TARGET",
	"$a.Arguments=$env:CLIO_WIN_MENU_ARGS",
	"$a.IconLocation=$env:CLIO_WIN_ICON",
	"$a.Description='Build and explore with Clio Coder'",
	"$a.WindowStyle=7",
	"$a.Save()",
	"Add-Type -Path $env:CLIO_WIN_IDENTITY_SOURCE",
	"[ClioIdentity]::SetShortcut($env:CLIO_WIN_MENU_PATH,$env:CLIO_WIN_APP_ID)",
	"$b=$s.CreateShortcut($env:CLIO_WIN_STARTUP_PATH)",
	"$b.TargetPath=$env:CLIO_WIN_TARGET",
	"$b.Arguments=$env:CLIO_WIN_STARTUP_ARGS",
	"$b.IconLocation=$env:CLIO_WIN_ICON",
	"$b.Description='Starts the Clio Coder background app when you sign in'",
	"$b.WindowStyle=7",
	"$b.Save()",
	"if ($env:CLIO_WIN_PIN_FOLDER -and (Test-Path -LiteralPath $env:CLIO_WIN_PIN_FOLDER)) { Get-ChildItem -LiteralPath $env:CLIO_WIN_PIN_FOLDER -Filter '*.lnk' | ForEach-Object { $c=$s.CreateShortcut($_.FullName); if (($c.TargetPath -match 'wslg?\\.exe$' -and $c.Arguments.StartsWith($env:CLIO_WIN_PIN_PREFIX) -and $c.Arguments.EndsWith($env:CLIO_WIN_PIN_SUFFIX)) -or ($c.TargetPath -eq $env:CLIO_WIN_TARGET -and $c.Arguments -eq $env:CLIO_WIN_OLD_ARGS)) { $c.TargetPath=$env:CLIO_WIN_TARGET; $c.Arguments=$env:CLIO_WIN_MENU_ARGS; $c.Save(); [ClioIdentity]::SetShortcut($_.FullName,$env:CLIO_WIN_APP_ID) } } }",
].join("; ");

type Owned = { path: string; sha256: string };
type WindowsFolders = readonly [string, string, string, string?];
type Manifest = {
	v: 1;
	owner: typeof owner;
	distro: string;
	launch: string;
	files: Owned[];
	pinFolder?: string;
	target?: string;
	menuArgs?: string;
	appDirectory?: string;
	appId?: string;
	folders?: WindowsFolders;
};
export type WindowsLauncherState = "unsupported" | "absent" | "installed" | "modified";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function publish(path: string, value: string | Buffer) {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, value, { flag: "wx", mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}

async function bytes(path: string) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > 1_048_576) throw new Error("A Windows launcher file is not a small regular file.");
		return await readFile(path);
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}
/** `C:\Users\me\x` is `/mnt/c/Users/me/x` under WSL's default automount root. */
export function windowsToWsl(path: string) {
	const match = /^([A-Za-z]):\\(.*)$/.exec(path);
	if (!match) throw new Error("Windows returned a path outside a drive letter.");
	return `/mnt/${match[1]?.toLowerCase()}/${match[2]?.replace(/\\/g, "/")}`;
}
/** One argument in Windows command-line syntax, as the shortcut's Arguments field is parsed. */
export function windowsArgument(value: string) {
	if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
		throw new Error("Launcher paths cannot contain control characters.");
	if (/^[\w@%+=:,./~-]+$/.test(value)) return value;
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}
/**
 * The launcher an installer-managed install keeps on PATH. It resolves the current version on every
 * launch, where the server entry names one version and goes stale in a pinned copy at the next upgrade.
 */
export async function stableLauncher(entry: string): Promise<string | null> {
	const root = /^(.+)\/versions\/[^/]+\/lib\/node_modules\/@iowarp\/clio-coder\/dist\/gui\/server\.js$/.exec(entry)?.[1];
	if (!root) return null;
	try {
		const record = JSON.parse(await readFile(join(root, "install.json"), "utf8")) as {
			kind?: unknown;
			launcher?: unknown;
		};
		if (record.kind !== "clio-coder-installer" || typeof record.launcher !== "string" || !isAbsolute(record.launcher))
			return null;
		return (await stat(record.launcher)).isFile() ? record.launcher : null;
	} catch {
		// No readable install record: the versioned entry is the only launcher there is.
		return null;
	}
}
export function wslLaunchArguments(
	distro: string,
	user: string,
	launch: LaunchPaths,
	directory: string,
	verb: "open" | "start",
	launcher: string | null = null,
) {
	if (!/^[\w.-]{1,64}$/.test(distro) || !/^[\w.-]{1,64}$/.test(user))
		throw new Error("Unsupported WSL distribution or user name.");
	return [
		"-d",
		distro,
		"-u",
		user,
		"--cd",
		"~",
		"--",
		...(launcher
			? [launcher, "gui"]
			: [launch.node, ...(launch.loader ? ["--import", launch.loader] : []), launch.entry]),
		"background",
		verb,
		"--directory",
		directory,
	]
		.map(windowsArgument)
		.join(" ");
}
/** A Windows host captures WSL's failure, including failure to start the distribution itself. */
export function visibleWslScript(args: string) {
	const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const script = [
		"$ErrorActionPreference='Stop'",
		"try { $p=New-Object System.Diagnostics.Process; $p.StartInfo.FileName=Join-Path $env:WINDIR 'System32\\wsl.exe'",
		`$p.StartInfo.Arguments=${literal(args)}`,
		"$p.StartInfo.UseShellExecute=$false; $p.StartInfo.CreateNoWindow=$true; $p.StartInfo.RedirectStandardOutput=$true; $p.StartInfo.RedirectStandardError=$true",
		"[void]$p.Start(); $out=$p.StandardOutput.ReadToEndAsync(); $err=$p.StandardError.ReadToEndAsync()",
		"if (-not $p.WaitForExit(60000)) { $p.Kill(); throw 'WSL did not finish launching Clio Coder within 60 seconds.' }",
		"$text=$out.Result + $err.Result; if ($p.ExitCode -ne 0) { throw ('WSL exited with code ' + $p.ExitCode + ': ' + $text) }",
		"} catch { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(('Clio Coder could not open.' + [Environment]::NewLine + $_.Exception.Message + [Environment]::NewLine + 'Open your WSL terminal and run: clio-coder doctor --fix'), 'Clio Coder launch failed', 'OK', 'Error'); exit 1 }",
	].join("; ");
	return `\uFEFF${script}\n`;
}

export function visibleWslArguments(scriptPath: string) {
	const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsArgument(scriptPath)}`;
	if (args.length >= 1024) throw new Error("Windows shortcut arguments exceed the shell's 1023-character limit.");
	return args;
}

/** A PNG wrapped as a Windows icon; the format has carried PNG frames since Vista. */
export function icoFromPng(png: Buffer) {
	if (png.length < 24 || png.toString("latin1", 1, 4) !== "PNG") throw new Error("The app icon is not a PNG.");
	const width = png.readUInt32BE(16),
		height = png.readUInt32BE(20);
	if (width < 1 || width > 256 || height < 1 || height > 256)
		throw new Error("The app icon must be at most 256 pixels.");
	const header = Buffer.alloc(22);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(1, 4);
	header.writeUInt8(width === 256 ? 0 : width, 6);
	header.writeUInt8(height === 256 ? 0 : height, 7);
	header.writeUInt16LE(1, 10);
	header.writeUInt16LE(32, 12);
	header.writeUInt32LE(png.length, 14);
	header.writeUInt32LE(22, 18);
	return Buffer.concat([header, png]);
}

async function readManifest(directory: string): Promise<Manifest | null> {
	const text = await bytes(join(directory, manifestName));
	if (text === null) return null;
	try {
		const value = JSON.parse(text.toString("utf8"));
		if (
			value?.v === 1 &&
			value.owner === owner &&
			typeof value.distro === "string" &&
			typeof value.launch === "string" &&
			Array.isArray(value.files) &&
			value.files.every((file: Owned) => typeof file?.path === "string" && typeof file.sha256 === "string")
		)
			return value;
	} catch {
		/* A malformed record never grants ownership. */
	}
	throw new Error("Windows launcher record is invalid; no Windows files were changed.");
}
async function inspect(files: Owned[]) {
	let changed = false,
		missingAny = false;
	for (const file of files) {
		const current = await bytes(file.path);
		if (current === null) missingAny = true;
		else if (sha(current) !== file.sha256) changed = true;
	}
	return { changed, missing: missingAny };
}

export async function windowsLauncherStatus(directory: string): Promise<WindowsLauncherState> {
	const manifest = await readManifest(directory);
	if (manifest === null) return isWsl() ? "absent" : "unsupported";
	const { changed, missing: gone } = await inspect(manifest.files);
	return changed || gone ? "modified" : "installed";
}

export async function installWindowsLauncher(directory: string, launch: LaunchPaths, folders?: WindowsFolders) {
	if (!isWsl()) return { status: "unsupported" as const };
	const distro = process.env.WSL_DISTRO_NAME ?? "",
		user = userInfo().username;
	const launcher = await stableLauncher(launch.entry);
	const rawMenuArgs = wslLaunchArguments(distro, user, launch, directory, "open", launcher),
		rawStartupArgs = wslLaunchArguments(distro, user, launch, directory, "start", launcher);
	const existing = await readManifest(directory);
	if (existing) {
		const { changed } = await inspect(existing.files);
		if (changed)
			throw new Error(
				"Windows launcher files were changed; they will not be replaced. Remove them or restore them first.",
			);
	}
	const [programs, startup, local, pinFolder] =
		folders ?? existing?.folders ?? (await runWindowsPowerShell(foldersScript)).trim().split("\n");
	if (!programs || !startup || !local) throw new Error("Windows did not report its shortcut folders.");
	const windowsDirectory = `${local}\\clio-coder\\gui\\${sha(`${distro}\n${user}\n${directory}`).slice(0, 16)}`;
	const relaunch = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoP -W Hidden -EP Bypass -File "${windowsDirectory}\\open.ps1"`;
	if (relaunch.length >= 260)
		throw new Error(
			"The Windows app path is too long for the shell relaunch command; use a shorter Windows profile path.",
		);
	const menuArgs = visibleWslArguments(`${windowsDirectory}\\open.ps1`),
		startupArgs = visibleWslArguments(`${windowsDirectory}\\start.ps1`);
	const target = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
	const launchKey = sha(`${target}\n${menuArgs}\n${startupArgs}`);
	const menu = join(windowsToWsl(programs), menuName),
		boot = join(windowsToWsl(startup), startupName);
	await mkdir(dirname(menu), { recursive: true });
	await mkdir(dirname(boot), { recursive: true });
	if (!existing)
		for (const path of [menu, boot])
			if ((await bytes(path)) !== null)
				throw new Error(
					`A shortcut named ${path.split("/").pop()} already exists and is not Clio Coder's; it was left alone.`,
				);
	if (!launch.icon) throw new Error("The app icon path is required for the Windows launcher.");
	const icon = join(windowsToWsl(windowsDirectory), iconName);
	await mkdir(dirname(icon), { recursive: true });
	await publish(icon, icoFromPng(await readFile(launch.icon)));
	const openScript = join(dirname(icon), "open.ps1"),
		startScript = join(dirname(icon), "start.ps1");
	await publish(openScript, visibleWslScript(rawMenuArgs));
	await publish(startScript, visibleWslScript(rawStartupArgs));
	const identitySource = join(dirname(icon), "identity.cs"),
		appScript = join(dirname(icon), "app.ps1"),
		identityFile = join(dirname(icon), "app-id");
	const appId = `io.iowarp.ClioCoder.${sha(`${distro}\n${user}\n${directory}`).slice(0, 16)}`;
	await publish(identitySource, windowsIdentitySource);
	await publish(appScript, `\uFEFF${windowsAppScript}`);
	await publish(identityFile, appId);
	await runWindowsPowerShell(shortcutScript, {
		CLIO_WIN_MENU_PATH: `${programs}\\${menuName}`,
		CLIO_WIN_STARTUP_PATH: `${startup}\\${startupName}`,
		CLIO_WIN_TARGET: target,
		CLIO_WIN_IDENTITY_SOURCE: `${windowsDirectory}\\identity.cs`,
		CLIO_WIN_APP_ID: appId,
		CLIO_WIN_PIN_FOLDER: pinFolder ?? "",
		CLIO_WIN_OLD_ARGS: existing?.menuArgs ?? "",
		CLIO_WIN_PIN_PREFIX: `-d ${windowsArgument(distro)} -u ${windowsArgument(user)} --cd ~ -- `,
		CLIO_WIN_MENU_ARGS: menuArgs,
		CLIO_WIN_STARTUP_ARGS: startupArgs,
		CLIO_WIN_PIN_SUFFIX: `background open --directory ${windowsArgument(directory)}`,
		CLIO_WIN_ICON: `${windowsDirectory}\\${iconName},0`,
	});
	const files: Owned[] = [];
	for (const path of [menu, boot, icon, openScript, startScript, identitySource, appScript, identityFile]) {
		const written = await bytes(path);
		if (written === null) throw new Error("Windows did not create the launcher shortcut.");
		files.push({ path, sha256: sha(written) });
	}
	for (const old of existing?.files ?? []) {
		if (!files.some((file) => file.path === old.path))
			await unlink(old.path).catch((error) => {
				if (!missing(error)) throw error;
			});
	}
	const record: Manifest = {
		v: 1,
		owner,
		distro,
		launch: launchKey,
		files,
		pinFolder: pinFolder ?? "",
		target,
		menuArgs,
		appDirectory: windowsDirectory,
		appId,
		folders: [programs, startup, local, pinFolder ?? ""],
	};
	await publish(join(directory, manifestName), `${JSON.stringify(record, null, 2)}\n`);
	return { status: "installed" as const, files: files.map((file) => file.path) };
}

/** The managed profile hosts the installed PWA; the shortcut still starts and verifies its local server. */
export async function openManagedWindowsApp(url: string, directory: string): Promise<boolean> {
	if (!isWsl()) return false;
	const manifest = await readManifest(directory);
	if (!manifest?.appDirectory || !manifest.appId) return false;
	if ((await inspect(manifest.files)).changed)
		throw new Error("Windows launcher files were changed; run clio-coder doctor --fix.");
	await runWindowsPowerShell("$ErrorActionPreference='Stop'; & $env:CLIO_WIN_APP_SCRIPT", {
		CLIO_WIN_APP_SCRIPT: `${manifest.appDirectory}\\app.ps1`,
		CLIO_WIN_URL: url,
	});
	return true;
}

/** Removes only what this installation recorded, and only while the recorded bytes are still there. */
export async function uninstallWindowsLauncher(directory: string) {
	const manifest = await readManifest(directory);
	if (manifest === null) return "absent" as const;
	if ((await inspect(manifest.files)).changed)
		throw new Error("Windows launcher files were changed; they will not be removed.");
	if (manifest.pinFolder && manifest.target && manifest.menuArgs) {
		await runWindowsPowerShell(
			"$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; if (Test-Path -LiteralPath $env:CLIO_WIN_PIN_FOLDER) { Get-ChildItem -LiteralPath $env:CLIO_WIN_PIN_FOLDER -Filter '*.lnk' | ForEach-Object { $c=$s.CreateShortcut($_.FullName); if ($c.TargetPath -eq $env:CLIO_WIN_TARGET -and $c.Arguments -eq $env:CLIO_WIN_MENU_ARGS) { Remove-Item -LiteralPath $_.FullName -Force } } }",
			{
				CLIO_WIN_PIN_FOLDER: manifest.pinFolder,
				CLIO_WIN_TARGET: manifest.target,
				CLIO_WIN_MENU_ARGS: manifest.menuArgs,
			},
		);
	}
	if (manifest.appDirectory && manifest.appId) {
		const base = windowsToWsl(manifest.appDirectory);
		const identity = join(base, "app-id");
		if (
			!manifest.files.some((file) => file.path === identity) ||
			(await readFile(identity, "utf8")).trim() !== manifest.appId
		)
			throw new Error("Windows desktop profile ownership could not be verified.");
		// Close only browser processes using the profile this launcher created; personal profiles are untouched.
		await runWindowsPowerShell(
			"$ErrorActionPreference='Stop'; Add-Type -Path $env:CLIO_WIN_IDENTITY_SOURCE; Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','msedge.exe') -and [ClioIdentity]::UsesProfile($_.CommandLine,$env:CLIO_WIN_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
			{
				CLIO_WIN_PROFILE: `${manifest.appDirectory}\\browser`,
				CLIO_WIN_IDENTITY_SOURCE: `${manifest.appDirectory}\\identity.cs`,
			},
		);
		await rm(join(base, "browser"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		await rm(join(base, "last-link"), { force: true });
		await rm(join(base, "last-window-mode"), { force: true });
	}
	for (const file of manifest.files)
		await unlink(file.path).catch((error: NodeJS.ErrnoException) => {
			if (!missing(error)) throw error;
		});
	await unlink(join(directory, manifestName));
	if (manifest.appDirectory) {
		const base = windowsToWsl(manifest.appDirectory);
		for (const folder of [base, dirname(base), dirname(dirname(base))]) {
			await rmdir(folder).catch((error: NodeJS.ErrnoException) => {
				if (!missing(error) && error.code !== "ENOTEMPTY") throw error;
			});
		}
	}
	return "absent" as const;
}

/** Checked before an uninstall changes anything, so a modified shortcut stops the whole removal. */
export async function assertWindowsLauncherRemovable(directory: string) {
	const manifest = await readManifest(directory);
	if (manifest && (await inspect(manifest.files)).changed)
		throw new Error("Windows launcher files were changed; they will not be removed.");
}
