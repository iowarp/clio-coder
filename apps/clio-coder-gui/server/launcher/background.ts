import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveClioDirs } from "../clio/http-shims.js";
import { findLocalServer, type LocalServerMeta, waitForLocalServer } from "../local-server.js";
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
import { DEFAULT_GUI_PORT } from "./ports.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Control = typeof controlService;
type Files = ReturnType<typeof backgroundPaths>;
/** Resolves once the app answers; a fake in tests may resolve without its report. */
type Ready = (port: number, token: string) => Promise<LocalServerMeta | unknown>;
const serverReport = (meta: unknown) => ({
	running:
		meta && typeof meta === "object" && typeof (meta as LocalServerMeta).clio === "string"
			? (meta as LocalServerMeta).clio
			: null,
	idle:
		meta && typeof meta === "object" && typeof (meta as LocalServerMeta).idle === "boolean"
			? (meta as LocalServerMeta).idle
			: undefined,
	port:
		meta && typeof meta === "object" && Number.isInteger((meta as LocalServerMeta).port)
			? (meta as LocalServerMeta).port
			: undefined,
});
const sameLaunch = (left: BackgroundConfig["launch"], right: BackgroundConfig["launch"]) =>
	left.node === right.node && left.loader === right.loader && left.entry === right.entry && left.icon === right.icon;
async function sameInstallation(left: string, right: string) {
	return Promise.all([realpath(left), realpath(right)]).then(
		([installed, current]) => installed === current,
		() => false,
	);
}
async function publishOwned(directory: string, config: BackgroundConfig, files: Files, replace: boolean) {
	const configText = `${JSON.stringify(config, null, 2)}\n`,
		unit = backgroundUnit(config, directory);
	const staging = await mkdtemp(join(dirname(directory), ".clio-coder-background-"));
	try {
		await writeFile(join(staging, "server.json"), configText, { flag: "wx", mode: 0o600 });
		await readBackgroundConfig(join(staging, "server.json"));
		await writeFile(join(staging, files.unit), unit, { flag: "wx", mode: 0o600 });
		await writeFile(
			join(staging, "owner.json"),
			`${JSON.stringify({ v: 1, owner: "clio-coder-gui-background", config: hash(configText), unit: hash(unit) })}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		if (replace) {
			// The manifest moves last: ownership never blesses a mixture of the old and new launch files.
			await rename(join(staging, "server.json"), files.config);
			await rename(join(staging, files.unit), files.unitFile);
			await rename(join(staging, "owner.json"), files.manifest);
		} else {
			// Rename publishes all three files together and refuses a nonempty competing directory.
			await rename(staging, directory);
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

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
			owner?.owner !== "clio-coder-gui-background" ||
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
	ready: Ready = waitForLocalServer,
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
	let config = proposed;
	let launchMoved = false;
	if (state.status === "installed") {
		if (state.config.port !== proposed.port || state.config.desktopPrefix !== proposed.desktopPrefix)
			throw new Error(
				"Background setup already has a stable port and desktop location. Uninstall it before changing them.",
			);
		if (!(await sameInstallation(state.config.packageRoot, proposed.packageRoot)))
			throw new Error(
				"Background setup belongs to another installation. Run gui background uninstall before installing this one.",
			);
		launchMoved = !sameLaunch(state.config.launch, proposed.launch);
		config = launchMoved ? { ...state.config, packageRoot: proposed.packageRoot, launch: proposed.launch } : state.config;
	}
	const desktopConfig = state.status === "installed" ? state.config : config;
	const desktop = await launcherStatus(config.desktopPrefix);
	const hasDesktop = desktop.status === "absent" ? false : await desktopOwned(desktopConfig, directory);
	if (launchMoved && hasDesktop) await uninstallLauncher(config.desktopPrefix);
	if (state.status === "absent") await publishOwned(directory, config, files, false);
	else if (launchMoved) {
		await publishOwned(directory, config, files, true);
		await control("reload", files.unit, files.unitFile);
	}
	await control("enable", files.unit, files.unitFile);
	await ready(config.port, config.token);
	await installLauncher(config.desktopPrefix, { ...config.launch, background: directory });
	return { status: "installed", unit: files.unit, origin: `http://127.0.0.1:${config.port}`, directory };
}
export async function backgroundStatus(
	directory: string,
	control: Control = controlService,
	ready: (port: number, token: string) => Promise<LocalServerMeta | boolean | null> = findLocalServer,
) {
	const state = await owned(directory);
	if (state.status === "absent") return { status: "absent", directory };
	const service = await serviceState(state.files, control);
	const found = await ready(state.config.port, state.config.token);
	// The app may be listening on its documented fallback port; the address a person should use is the live one.
	const port = serverReport(found).port ?? state.config.port;
	return {
		status: "installed",
		directory,
		unit: state.files.unit,
		port,
		configuredPort: state.config.port,
		origin: `http://127.0.0.1:${port}`,
		active: service.ActiveState ?? "unknown",
		enabled: service.UnitFileState ?? "unknown",
		pid: Number(service.MainPID) || null,
		ready: !!found,
		desktop: (await desktopOwned(state.config, directory)) ? "installed" : "absent",
	};
}
type Installed = Extract<Awaited<ReturnType<typeof owned>>, { status: "installed" }>;
async function pinCurrentLaunch(
	state: Installed,
	directory: string,
	launch: LaunchPaths,
	control: Control,
): Promise<Installed> {
	const proposed = await newBackgroundConfig(state.config.port, launch, state.config.desktopPrefix);
	if (!(await sameInstallation(state.config.packageRoot, proposed.packageRoot)))
		throw new Error("Background setup belongs to another installation and its launch paths were left unchanged.");
	if (sameLaunch(state.config.launch, proposed.launch)) return state;
	await serviceState(state.files, control);
	const hasDesktop = await desktopOwned(state.config, directory);
	if (hasDesktop) await uninstallLauncher(state.config.desktopPrefix);
	const config = { ...state.config, packageRoot: proposed.packageRoot, launch: proposed.launch };
	await publishOwned(directory, config, state.files, true);
	await control("reload", state.files.unit, state.files.unitFile);
	await installLauncher(config.desktopPrefix, { ...config.launch, background: directory });
	return { ...state, config };
}
async function startOwned(state: Installed, control: Control, ready: Ready, action: "start" | "restart" = "start") {
	await serviceState(state.files, control);
	await control(action, state.files.unit, state.files.unitFile);
	const report = serverReport(await ready(state.config.port, state.config.token));
	return {
		url: `http://127.0.0.1:${report.port ?? state.config.port}/#token=${state.config.token}`,
		...report,
	};
}
const publicStart = ({ url, running }: Awaited<ReturnType<typeof startOwned>>) => ({ url, running });
export async function startBackground(
	directory: string,
	control: Control = controlService,
	ready: Ready = waitForLocalServer,
) {
	const state = await owned(directory);
	if (state.status !== "installed")
		throw new Error("Background service is not installed. Run background install first.");
	return (await startOwned(state, control, ready)).url;
}
export async function restartBackground(
	directory: string,
	control: Control = controlService,
	ready: Ready = waitForLocalServer,
	launch?: LaunchPaths,
) {
	let state = await owned(directory);
	if (state.status !== "installed")
		throw new Error("Background service is not installed. Run background install first.");
	if (launch) state = await pinCurrentLaunch(state, directory, launch, control);
	return publicStart(await startOwned(state, control, ready, "restart"));
}

export type BackgroundPreference =
	| { kind: "open"; url: string; running: string | null; restartedFrom?: string }
	| { kind: "absent" }
	| { kind: "unavailable"; reason: string };

/**
 * A bare launch reuses this installation's own background app. It never fails over it: files it
 * cannot verify, another installation's service, or a service manager that will not start it each
 * become a reason the caller prints before starting a private server, and nothing is changed.
 */
export async function preferBackground(
	directory: string,
	packageRoot: string,
	control: Control = controlService,
	ready: Ready = waitForLocalServer,
	platform: NodeJS.Platform = process.platform,
	version?: string,
): Promise<BackgroundPreference> {
	if (platform !== "linux") return { kind: "absent" };
	let state: Awaited<ReturnType<typeof owned>>;
	try {
		state = await owned(directory);
	} catch {
		return {
			kind: "unavailable",
			reason:
				"Background app files could not be verified, so they were left untouched. See clio-coder gui background status.",
		};
	}
	if (state.status === "absent") return { kind: "absent" };
	const same = await Promise.all([realpath(state.config.packageRoot), realpath(packageRoot)]).then(
		([theirs, ours]) => theirs === ours,
		() => false,
	);
	if (!same)
		return {
			kind: "unavailable",
			reason: "The background app belongs to another Clio Coder installation, so this one will not take it over.",
		};
	try {
		const started = await startOwned(state, control, ready);
		if (version && started.running && started.running !== version && started.idle === true) {
			const restarted = await startOwned(state, control, ready, "restart");
			return { kind: "open", ...publicStart(restarted), restartedFrom: started.running };
		}
		return { kind: "open", ...publicStart(started) };
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}
export async function restartBackgroundIfIdle(
	directory: string,
	control: Control = controlService,
	ready: Ready = waitForLocalServer,
	probe: (port: number, token: string) => Promise<LocalServerMeta | null> = findLocalServer,
	launch?: LaunchPaths,
) {
	let state = await owned(directory);
	if (state.status === "absent") return { status: "absent" as const };
	const report = serverReport(await probe(state.config.port, state.config.token));
	if (report.running === null) return { status: "left" as const, reason: "stopped" as const, running: null };
	if (report.idle !== true)
		return {
			status: "left" as const,
			reason: report.idle === false ? ("busy" as const) : ("unknown" as const),
			running: report.running,
		};
	if (launch) state = await pinCurrentLaunch(state, directory, launch, control);
	const restarted = await startOwned(state, control, ready, "restart");
	return { status: "restarted" as const, running: restarted.running };
}

/** Navigation may reuse a verified installation, but never silently takes over another package. */
export async function tryStartBackground(
	directory: string,
	packageRoot: string,
	control: Control = controlService,
	ready: Ready = waitForLocalServer,
) {
	const state = await owned(directory);
	if (state.status === "absent") return undefined;
	if ((await realpath(state.config.packageRoot)) !== (await realpath(packageRoot)))
		throw new Error(
			"Background setup belongs to another installation. Use that installation or run gui without --reuse-background.",
		);
	return startBackground(directory, control, ready);
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

/** Verify before root uninstall removes the state needed to stop this service. */
export async function backgroundRemoval(directory: string, packageRoot: string, control: Control = controlService) {
	const state = await owned(directory);
	if (state.status === "absent") return null;
	if ((await realpath(state.config.packageRoot)) !== (await realpath(packageRoot)))
		throw new Error("Background service belongs to another installation; uninstall stopped before removing Clio state.");
	await serviceState(state.files, control);
	await desktopOwned(state.config, directory);
	return { path: directory, remove: () => uninstallBackground(directory, control) };
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
			"if-idle": { type: "boolean" },
		},
	});
	const command = positionals[0];
	if (
		positionals.length !== 1 ||
		!["install", "status", "start", "open", "restart", "stop", "uninstall"].includes(command ?? "")
	)
		throw new Error(
			"Usage: background install|status|start|open|restart [--if-idle]|stop|uninstall [--directory <absolute private directory>] [install: --port <port> --prefix <XDG data directory> --open]",
		);
	if (command !== "install" && (values.prefix !== undefined || values.port !== undefined || values.open !== undefined))
		throw new Error("--port, --prefix and --open apply to background install only.");
	if (command !== "restart" && values["if-idle"] !== undefined)
		throw new Error("--if-idle applies to background restart only.");
	const directory = values.directory ?? join(resolveClioDirs().state, "gui/background");
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
		console.log("Clio Coder background app stopped. It starts again at your next login, or with clio-coder gui.");
		return;
	}
	if (command === "install") {
		const installed = await owned(directory);
		const requested = values.port;
		if (requested !== undefined && (!/^\d+$/.test(requested) || Number(requested) < 1 || Number(requested) > 65535))
			throw new Error("--port must be an integer from 1 to 65535.");
		// Reinstalling keeps the stable address the app already has; only a first install picks the default.
		const port =
			requested !== undefined
				? Number(requested)
				: installed.status === "installed"
					? installed.config.port
					: DEFAULT_GUI_PORT;
		const prefix =
			values.prefix ??
			(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
				? process.env.XDG_DATA_HOME
				: join(homedir(), ".local/share"));
		const config = await newBackgroundConfig(port, launch, prefix);
		console.log(JSON.stringify(await installBackground(directory, config), null, 2));
		console.log(
			"Background sessions use Clio Coder's saved credentials. If a target key exists only in your terminal environment, save it with clio-coder auth login <target> before starting a conversation.",
		);
		if (!values.open) {
			console.log("Open it any time with: clio-coder gui");
			return;
		}
	}
	if (command === "restart") {
		if (values["if-idle"]) {
			const result = await restartBackgroundIfIdle(directory, undefined, undefined, undefined, launch);
			const line =
				result.status === "absent"
					? "Clio Coder background app is not installed."
					: result.status === "restarted"
						? "Clio Coder background app restarted."
						: result.reason === "busy"
							? "Clio Coder background app was left running because it is busy."
							: result.reason === "unknown"
								? "Clio Coder background app was left running because it does not report whether it is idle."
								: "Clio Coder background app was left stopped.";
			console.log(line);
			return;
		}
		const restarted = await restartBackground(directory, undefined, undefined, launch);
		console.log(`Clio Coder background app restarted and ready at ${new URL(restarted.url).origin}.`);
		return;
	}
	const url = await startBackground(directory);
	if (command === "start") {
		console.log(`Clio Coder background app is ready at ${new URL(url).origin}.`);
		return;
	}
	// The link is the way in when no desktop can take it, so a failed opener hands it over instead of failing.
	await openBrowser(url).catch(() => {
		console.log(`[clio-coder:gui] ${url}`);
		console.error("[clio-coder:gui] Could not open the browser. Open the printed URL manually.");
	});
}
