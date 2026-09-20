import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { desktopEntry, type LaunchPaths, launcherId, launcherUnsupported } from "./desktop-entry.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const names = { entry: `${launcherId}.desktop`, manifest: `${launcherId}.desktop.owner.json` };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function contents(path: string) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.nlink !== 1 || info.size > 16_384 || (process.getuid && info.uid !== process.getuid()))
			throw new Error("Launcher file is not a small regular file owned by this user.");
		return await readFile(path, "utf8");
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

export async function launcherFiles(prefix: string, platform: NodeJS.Platform = process.platform) {
	if (platform !== "linux") throw new Error(launcherUnsupported);
	if (!isAbsolute(prefix)) throw new Error("--prefix must be an absolute XDG data directory.");
	const directory = join(prefix, "applications");
	try {
		if (!(await lstat(directory)).isDirectory())
			throw new Error("Launcher applications path must be a directory, not a symlink.");
	} catch (error) {
		if (!missing(error)) throw error;
	}
	return { directory, entry: join(directory, names.entry), manifest: join(directory, names.manifest) };
}
export async function launcherStatus(prefix: string, platform: NodeJS.Platform = process.platform) {
	const files = await launcherFiles(prefix, platform);
	const entry = await contents(files.entry),
		manifest = await contents(files.manifest);
	if (entry === null && manifest === null) return { status: "absent" as const, ...files };
	let owned = false,
		available = false;
	try {
		const value = JSON.parse(manifest ?? "null");
		owned =
			entry !== null &&
			value?.version === 1 &&
			value?.owner === launcherId &&
			value?.sha256 === hash(entry) &&
			desktopEntry(value.launch) === entry;
		if (owned) {
			await access(value.launch.node, constants.X_OK);
			for (const path of [
				value.launch.node,
				value.launch.entry,
				...(value.launch.loader ? [value.launch.loader] : []),
				...(value.launch.icon ? [value.launch.icon] : []),
			]) {
				await access(path, constants.R_OK);
				if (!(await stat(path)).isFile()) throw new Error("Launcher target is not a file.");
			}
			available = true;
		}
	} catch {
		/* A malformed manifest never grants ownership. */
	}
	return {
		status: owned ? (available ? ("installed" as const) : ("unavailable" as const)) : ("conflict" as const),
		...files,
	};
}
export async function installLauncher(prefix: string, paths: LaunchPaths) {
	const launch = {
		node: await realpath(paths.node),
		...(paths.loader ? { loader: await realpath(paths.loader) } : {}),
		...(paths.icon ? { icon: await realpath(paths.icon) } : {}),
		entry: await realpath(paths.entry),
		...(paths.background ? { background: await realpath(paths.background) } : {}),
	};
	const entry = desktopEntry(launch);
	const state = await launcherStatus(prefix);
	if (state.status === "installed" && (await contents(state.entry)) === entry) return state;
	if (state.status !== "absent")
		throw new Error(
			"Launcher files already exist or differ. Inspect status and uninstall the owned entry before installing again.",
		);
	await mkdir(state.directory, { recursive: true });
	await launcherFiles(prefix);
	await writeFile(state.entry, entry, { flag: "wx", mode: 0o644 });
	try {
		await writeFile(
			state.manifest,
			`${JSON.stringify({ version: 1, owner: launcherId, sha256: hash(entry), launch })}\n`,
			{
				flag: "wx",
				mode: 0o600,
			},
		);
	} catch (error) {
		if ((await contents(state.entry)) === entry) await unlink(state.entry);
		throw error;
	}
	return launcherStatus(prefix);
}
export async function uninstallLauncher(prefix: string) {
	const state = await launcherStatus(prefix);
	if (state.status === "conflict") throw new Error("Launcher ownership could not be verified; no files were removed.");
	if (state.status === "installed" || state.status === "unavailable") {
		await unlink(state.entry);
		await unlink(state.manifest);
	}
	return launcherStatus(prefix);
}

export async function launcher(args: string[], paths: LaunchPaths) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prefix: { type: "string" } } });
	const command = positionals[0];
	if (positionals.length !== 1 || !["install", "status", "uninstall"].includes(command ?? ""))
		throw new Error("Usage: launcher install|status|uninstall [--prefix <absolute XDG data directory>]");
	const prefix =
		values.prefix ??
		(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
			? process.env.XDG_DATA_HOME
			: join(homedir(), ".local/share"));
	const result =
		command === "install"
			? await installLauncher(prefix, paths)
			: command === "uninstall"
				? await uninstallLauncher(prefix)
				: await launcherStatus(prefix);
	console.log(JSON.stringify(result, null, 2));
	if (result.status === "conflict" || result.status === "unavailable") process.exitCode = 1;
}
