import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { isWsl, runWindowsPowerShell } from "../process-policy.js";
import type { LaunchPaths } from "./desktop-entry.js";

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
	"$ErrorActionPreference='Stop'; [Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Startup'); [Environment]::GetFolderPath('LocalApplicationData')";
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
	"$b=$s.CreateShortcut($env:CLIO_WIN_STARTUP_PATH)",
	"$b.TargetPath=$env:CLIO_WIN_TARGET",
	"$b.Arguments=$env:CLIO_WIN_STARTUP_ARGS",
	"$b.IconLocation=$env:CLIO_WIN_ICON",
	"$b.Description='Starts the Clio Coder background app when you sign in'",
	"$b.WindowStyle=7",
	"$b.Save()",
].join("; ");

type Owned = { path: string; sha256: string };
type Manifest = { v: 1; owner: typeof owner; distro: string; launch: string; files: Owned[] };
export type WindowsLauncherState = "unsupported" | "absent" | "installed" | "modified";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

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
export function wslLaunchArguments(
	distro: string,
	user: string,
	launch: LaunchPaths,
	directory: string,
	verb: "open" | "start",
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
		launch.node,
		...(launch.loader ? ["--import", launch.loader] : []),
		launch.entry,
		"background",
		verb,
		"--directory",
		directory,
	]
		.map(windowsArgument)
		.join(" ");
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

export async function installWindowsLauncher(directory: string, launch: LaunchPaths) {
	if (!isWsl()) return { status: "unsupported" as const };
	const distro = process.env.WSL_DISTRO_NAME ?? "",
		user = userInfo().username;
	const menuArgs = wslLaunchArguments(distro, user, launch, directory, "open"),
		startupArgs = wslLaunchArguments(distro, user, launch, directory, "start");
	const launchKey = sha(`${menuArgs}\n${startupArgs}`);
	const existing = await readManifest(directory);
	if (existing) {
		const { changed, missing: gone } = await inspect(existing.files);
		if (changed)
			throw new Error(
				"Windows launcher files were changed; they will not be replaced. Remove them or restore them first.",
			);
		if (!gone && existing.launch === launchKey)
			return { status: "installed" as const, files: existing.files.map((file) => file.path) };
	}
	const [programs, startup, local] = (await runWindowsPowerShell(foldersScript)).trim().split("\n");
	if (!programs || !startup || !local) throw new Error("Windows did not report its shortcut folders.");
	const menu = join(windowsToWsl(programs), menuName),
		boot = join(windowsToWsl(startup), startupName);
	if (!existing)
		for (const path of [menu, boot])
			if ((await bytes(path)) !== null)
				throw new Error(
					`A shortcut named ${path.split("/").pop()} already exists and is not Clio Coder's; it was left alone.`,
				);
	if (!launch.icon) throw new Error("The app icon path is required for the Windows launcher.");
	const icon = join(windowsToWsl(local), "clio-coder", "gui", iconName);
	await mkdir(dirname(icon), { recursive: true });
	await writeFile(icon, icoFromPng(await readFile(launch.icon)));
	// Presence only: the launcher binary is megabytes, far past what `bytes` reads for files this module owns.
	const wslg = await stat("/mnt/c/Program Files/WSL/wslg.exe").then(
		(info) => info.isFile(),
		() => false,
	);
	await runWindowsPowerShell(shortcutScript, {
		CLIO_WIN_MENU_PATH: `${programs}\\${menuName}`,
		CLIO_WIN_STARTUP_PATH: `${startup}\\${startupName}`,
		CLIO_WIN_TARGET: wslg ? "C:\\Program Files\\WSL\\wslg.exe" : "C:\\Windows\\System32\\wsl.exe",
		CLIO_WIN_MENU_ARGS: menuArgs,
		CLIO_WIN_STARTUP_ARGS: startupArgs,
		CLIO_WIN_ICON: `${local}\\clio-coder\\gui\\${iconName},0`,
	});
	const files: Owned[] = [];
	for (const path of [menu, boot, icon]) {
		const written = await bytes(path);
		if (written === null) throw new Error("Windows did not create the launcher shortcut.");
		files.push({ path, sha256: sha(written) });
	}
	const record: Manifest = { v: 1, owner, distro, launch: launchKey, files };
	await writeFile(join(directory, manifestName), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	return { status: "installed" as const, files: files.map((file) => file.path) };
}

/** Removes only what this installation recorded, and only while the recorded bytes are still there. */
export async function uninstallWindowsLauncher(directory: string) {
	const manifest = await readManifest(directory);
	if (manifest === null) return "absent" as const;
	if ((await inspect(manifest.files)).changed)
		throw new Error("Windows launcher files were changed; they will not be removed.");
	for (const file of manifest.files)
		await unlink(file.path).catch((error: NodeJS.ErrnoException) => {
			if (!missing(error)) throw error;
		});
	await unlink(join(directory, manifestName));
	return "absent" as const;
}

/** Checked before an uninstall changes anything, so a modified shortcut stops the whole removal. */
export async function assertWindowsLauncherRemovable(directory: string) {
	const manifest = await readManifest(directory);
	if (manifest && (await inspect(manifest.files)).changed)
		throw new Error("Windows launcher files were changed; they will not be removed.");
}
