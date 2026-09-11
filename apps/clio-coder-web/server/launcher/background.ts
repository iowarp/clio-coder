import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveClioDirs } from "../clio/http-shims.js";
import { localServerReady, waitForLocalServer } from "../local-server.js";
import { controlService, openBrowser } from "../process-policy.js";
import {
	type BackgroundConfig,
	backgroundPaths,
	backgroundUnit,
	newBackgroundConfig,
	readBackgroundConfig,
} from "./background-config.js";
import { desktopEntry, type LaunchPaths } from "./desktop-entry.js";
import { contents, installLauncher, launcherStatus, uninstallLauncher } from "./install.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Control = typeof controlService;
type Files = ReturnType<typeof backgroundPaths>;

async function owned(directory: string) {
	const files = backgroundPaths(directory);
	const manifest = await contents(files.manifest),
		configText = await contents(files.config),
		unit = await contents(files.unitFile);
	if (manifest === null && configText === null && unit === null) return { status: "absent" as const, files };
	try {
		const owner = JSON.parse(manifest ?? "null");
		if (
			owner?.v !== 1 ||
			owner?.owner !== "clio-coder-web-background" ||
			!configText ||
			!unit ||
			owner.config !== hash(configText) ||
			owner.unit !== hash(unit)
		)
			throw new Error("Ownership mismatch");
		const config = await readBackgroundConfig(files.config);
		if (unit !== backgroundUnit(config, directory)) throw new Error("Unit does not match configuration");
		return { status: "installed" as const, files, config };
	} catch {
		throw new Error(
			"Background files are incomplete, modified or not private; ownership could not be verified. No files were changed.",
		);
	}
}
async function serviceState(files: Files, control: Control) {
	const text = await control("show", files.unit, files.unitFile);
	const values = Object.fromEntries(
		text
			.trim()
			.split("\n")
			.map((line) => {
				const index = line.indexOf("=");
				return [line.slice(0, index), line.slice(index + 1)];
			}),
	);
	if (values.FragmentPath && (await realpath(values.FragmentPath).catch(() => "")) !== files.unitFile)
		throw new Error("A different service uses this name; it will not be changed.");
	return values;
}
async function desktopOwned(config: BackgroundConfig, directory: string) {
	const state = await launcherStatus(config.desktopPrefix);
	if (state.status === "absent") return false;
	if (
		state.status === "conflict" ||
		(await contents(state.entry)) !== desktopEntry({ ...config.launch, background: directory })
	)
		throw new Error(
			"The desktop entry belongs to another launch mode or was changed; it will not be replaced or removed.",
		);
	return true;
}
export async function installBackground(
	directory: string,
	proposed: BackgroundConfig,
	control: Control = controlService,
	ready = waitForLocalServer,
) {
	if (process.platform !== "linux")
		throw new Error("Background setup currently requires Linux with a systemd user session.");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (
		!info.isDirectory() ||
		(await realpath(directory)) !== directory ||
		(info.mode & 0o077) !== 0 ||
		(process.getuid && info.uid !== process.getuid())
	)
		throw new Error("Background directory must be a private, canonical directory owned by this user.");
	const state = await owned(directory),
		files = state.files;
	await serviceState(files, control);
	const config = state.status === "installed" ? state.config : proposed;
	if (state.status === "installed" && (config.port !== proposed.port || config.desktopPrefix !== proposed.desktopPrefix))
		throw new Error(
			"Background setup already has a stable port and desktop location. Uninstall it before changing them.",
		);
	if (
		state.status === "installed" &&
		(config.packageRoot !== proposed.packageRoot ||
			config.launch.node !== proposed.launch.node ||
			config.launch.entry !== proposed.launch.entry ||
			config.launch.loader !== proposed.launch.loader)
	)
		throw new Error(
			"Background setup belongs to another installation. Run web background uninstall before installing this one.",
		);
	const desktop = await launcherStatus(config.desktopPrefix);
	if (desktop.status !== "absent") await desktopOwned(config, directory);
	if (state.status === "absent") {
		const configText = `${JSON.stringify(config, null, 2)}\n`,
			unit = backgroundUnit(config, directory);
		const staging = await mkdtemp(join(dirname(directory), ".clio-coder-background-"));
		try {
			await writeFile(join(staging, "server.json"), configText, { flag: "wx", mode: 0o600 });
			await readBackgroundConfig(join(staging, "server.json"));
			await writeFile(join(staging, files.unit), unit, { flag: "wx", mode: 0o600 });
			await writeFile(
				join(staging, "owner.json"),
				`${JSON.stringify({ v: 1, owner: "clio-coder-web-background", config: hash(configText), unit: hash(unit) })}\n`,
				{ flag: "wx", mode: 0o600 },
			);
			// Rename publishes all three files together and refuses a nonempty competing directory.
			await rename(staging, directory);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
	await control("enable", files.unit, files.unitFile);
	await ready(config.port, config.token);
	await installLauncher(config.desktopPrefix, { ...config.launch, background: directory });
	return { status: "installed", unit: files.unit, origin: `http://127.0.0.1:${config.port}`, directory };
}
export async function backgroundStatus(directory: string, control: Control = controlService, ready = localServerReady) {
	const state = await owned(directory);
	if (state.status === "absent") return { status: "absent", directory };
	const service = await serviceState(state.files, control);
	return {
		status: "installed",
		directory,
		unit: state.files.unit,
		port: state.config.port,
		origin: `http://127.0.0.1:${state.config.port}`,
		active: service.ActiveState ?? "unknown",
		enabled: service.UnitFileState ?? "unknown",
		pid: Number(service.MainPID) || null,
		ready: await ready(state.config.port, state.config.token),
		desktop: (await desktopOwned(state.config, directory)) ? "installed" : "absent",
	};
}
export async function startBackground(
	directory: string,
	control: Control = controlService,
	ready = waitForLocalServer,
) {
	const state = await owned(directory);
	if (state.status !== "installed")
		throw new Error("Background service is not installed. Run background install first.");
	await serviceState(state.files, control);
	await control("start", state.files.unit, state.files.unitFile);
	await ready(state.config.port, state.config.token);
	return `http://127.0.0.1:${state.config.port}/#token=${state.config.token}`;
}
export async function stopBackground(directory: string, control: Control = controlService) {
	const state = await owned(directory);
	if (state.status === "absent") return;
	await serviceState(state.files, control);
	await control("stop", state.files.unit, state.files.unitFile);
}
export async function uninstallBackground(directory: string, control: Control = controlService) {
	const state = await owned(directory);
	if (state.status === "absent") return { status: "absent", directory };
	await serviceState(state.files, control);
	const desktop = await desktopOwned(state.config, directory);
	await control("disable", state.files.unit, state.files.unitFile);
	if (desktop) await uninstallLauncher(state.config.desktopPrefix);
	for (const file of [state.files.manifest, state.files.unitFile, state.files.config]) await unlink(file);
	await control("reload", state.files.unit, state.files.unitFile);
	await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOTEMPTY") throw error;
	});
	return { status: "absent", directory };
}

export async function background(args: string[], launch: LaunchPaths) {
	if (process.platform !== "linux")
		throw new Error("Background setup currently requires Linux with a systemd user session.");
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			directory: { type: "string" },
			prefix: { type: "string" },
			port: { type: "string" },
			open: { type: "boolean" },
		},
	});
	const command = positionals[0];
	if (positionals.length !== 1 || !["install", "status", "start", "open", "stop", "uninstall"].includes(command ?? ""))
		throw new Error(
			"Usage: background install|status|start|open|stop|uninstall [--directory <absolute private directory>] [install: --port <port> --prefix <XDG data directory> --open]",
		);
	if (command !== "install" && (values.prefix !== undefined || values.port !== undefined || values.open !== undefined))
		throw new Error("--port, --prefix and --open apply to background install only.");
	const directory = values.directory ?? join(resolveClioDirs().state, "web/background");
	if (!isAbsolute(directory) || resolve(directory) !== directory)
		throw new Error("--directory must be an absolute normalized path.");
	if (command === "status") {
		console.log(JSON.stringify(await backgroundStatus(directory), null, 2));
		return;
	}
	if (command === "uninstall") {
		console.log(JSON.stringify(await uninstallBackground(directory), null, 2));
		return;
	}
	if (command === "stop") {
		await stopBackground(directory);
		console.log("Clio background service stopped. It remains enabled for the next login.");
		return;
	}
	if (command === "install") {
		const port = Number(values.port ?? "4317");
		if (!/^\d+$/.test(values.port ?? "4317") || !Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("--port must be an integer from 1 to 65535.");
		const prefix =
			values.prefix ??
			(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
				? process.env.XDG_DATA_HOME
				: join(homedir(), ".local/share"));
		const config = await newBackgroundConfig(port, launch, prefix);
		console.log(JSON.stringify(await installBackground(directory, config), null, 2));
		console.log(
			"Background sessions use Clio's saved credentials. If a target key exists only in your terminal environment, save it with clio-coder auth login <target> before starting a conversation.",
		);
		if (!values.open) return;
	}
	const url = await startBackground(directory);
	if (command === "start") console.log(`Clio background service is ready at ${new URL(url).origin}.`);
	else await openBrowser(url);
}
