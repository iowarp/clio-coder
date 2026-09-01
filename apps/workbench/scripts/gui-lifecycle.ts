/**
 * Install, upgrade, inspect, and uninstall the Clio Coder GUI on Linux.
 *
 * The GUI ships as one `deno compile` binary with the built `dist/` embedded,
 * so an installation is exactly three files: the binary in a bin directory, a
 * freedesktop `.desktop` entry, and a PNG icon. Every path this script writes
 * is recorded in a manifest, and uninstall removes only what the manifest
 * lists. Local state (`~/.local/state/clio-workbench`) is never touched unless
 * `--purge-state` says so.
 *
 *   deno run -A scripts/gui-lifecycle.ts install   [--prefix=DIR] [--binary=PATH] [--skip-build] [--state-dir=DIR]
 *   deno run -A scripts/gui-lifecycle.ts upgrade   (same as install over an existing installation)
 *   deno run -A scripts/gui-lifecycle.ts status    [--prefix=DIR]
 *   deno run -A scripts/gui-lifecycle.ts uninstall [--prefix=DIR] [--purge-state]
 *   deno run -A scripts/gui-lifecycle.ts compile   [--output=PATH] [--skip-build]
 *
 * Without `--prefix`, files go to `~/.local/bin`, `$XDG_DATA_HOME/applications`,
 * and `$XDG_DATA_HOME/clio-coder-gui` (manifest and icon). With `--prefix=DIR`
 * they go to `DIR/bin`, `DIR/share/applications`, and `DIR/share/clio-coder-gui`.
 * Tested on Linux (including WSL2) only; the Windows webview build is a
 * separate, unverified `deno desktop` task.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION, CLI_NAME } from "../main.ts";
import { type EnvReader, resolveStateDir } from "../workbench-state.ts";

export const MANIFEST_SCHEMA = 1;
export const DATA_DIRECTORY_NAME = "clio-coder-gui";
export const DESKTOP_ENTRY_NAME = `${CLI_NAME}.desktop`;
export const ICON_NAME = `${CLI_NAME}.png`;
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ICON_SOURCE = join(APP_ROOT, "public", "assets", "clio-coder-logo-128.png");

/** The permission grants baked into the compiled binary; identical to the `start` task. */
export const COMPILE_PERMISSIONS: readonly string[] = [
	"--no-prompt",
	"--allow-env=DENO_SERVE_ADDRESS,HOME,XDG_STATE_HOME,CLIO_CODER_GUI_STATE_DIR,CLIO_WORKBENCH_STATE_DIR",
	"--allow-net=127.0.0.1",
	"--allow-read",
	"--allow-write",
	"--allow-run=clio-coder,kill,xdg-open",
];

export type FileRole = "binary" | "desktop-entry" | "icon";

export interface ManifestFile {
	readonly path: string;
	readonly role: FileRole;
	readonly sha256: string;
	readonly bytes: number;
}

export interface InstallManifest {
	readonly schema: typeof MANIFEST_SCHEMA;
	readonly product: "Clio Coder";
	readonly version: string;
	readonly installedAt: string;
	readonly roots: { readonly bin: string; readonly applications: string; readonly data: string };
	/** Where the app keeps its own state; recorded so `--purge-state` removes exactly this. */
	readonly stateDir: string;
	/** Directories this installer created, deepest last; removed on uninstall only when empty. */
	readonly createdDirectories: readonly string[];
	readonly files: readonly ManifestFile[];
}

export interface Layout {
	readonly home: string;
	readonly bin: string;
	readonly applications: string;
	readonly data: string;
	readonly manifest: string;
	readonly stateDir: string;
}

export interface LifecycleContext {
	readonly env: EnvReader;
	readonly log: (line: string) => void;
	/** Overrides the `deno` executable used for `task build` and `compile` (tests). */
	readonly denoPath?: string;
}

export class LifecycleError extends Error {
	override readonly name = "LifecycleError";
}

interface CommonOptions {
	prefix?: string;
	stateDir?: string;
}

interface InstallOptions extends CommonOptions {
	binary?: string;
	skipBuild: boolean;
}

interface UninstallOptions extends CommonOptions {
	purgeState: boolean;
}

function requireAbsolute(value: string, label: string): string {
	if (!isAbsolute(value)) throw new LifecycleError(`${label} must be an absolute path, got ${value}.`);
	return resolve(value);
}

function isWithin(root: string, candidate: string): boolean {
	const local = relative(root, candidate);
	return local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

/** Resolves where the three files and the manifest live for this environment. */
export function resolveLayout(options: CommonOptions, env: EnvReader): Layout {
	const homeValue = env("HOME");
	if (homeValue === undefined || !isAbsolute(homeValue)) {
		throw new LifecycleError("HOME must be an absolute path so the installer can place user-level files.");
	}
	const home = resolve(homeValue);
	const stateDir = options.stateDir === undefined
		? resolveStateDir(home, env)
		: requireAbsolute(options.stateDir, "--state-dir");
	if (options.prefix !== undefined) {
		const prefix = requireAbsolute(options.prefix, "--prefix");
		if (prefix === home || prefix === "/") throw new LifecycleError("--prefix must be a directory of its own.");
		const data = join(prefix, "share", DATA_DIRECTORY_NAME);
		return {
			home,
			bin: join(prefix, "bin"),
			applications: join(prefix, "share", "applications"),
			data,
			manifest: join(data, "install.json"),
			stateDir,
		};
	}
	const xdgData = env("XDG_DATA_HOME");
	const dataHome = xdgData !== undefined && isAbsolute(xdgData) ? resolve(xdgData) : join(home, ".local", "share");
	const data = join(dataHome, DATA_DIRECTORY_NAME);
	return {
		home,
		bin: join(home, ".local", "bin"),
		applications: join(dataHome, "applications"),
		data,
		manifest: join(data, "install.json"),
		stateDir,
	};
}

/** Every root must be a real directory of its own; the installer never treats `~` or `/` as one. */
function checkRoots(layout: Layout): void {
	for (const root of [layout.bin, layout.applications, layout.data]) {
		if (root === "/" || root === layout.home || !isAbsolute(root)) {
			throw new LifecycleError(`Refusing to use ${root} as an installation directory.`);
		}
	}
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await Deno.lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return false;
		throw error;
	}
}

/** Creates a directory chain and returns the directories that did not exist, shallowest first. */
async function ensureDirectory(path: string): Promise<string[]> {
	const missing: string[] = [];
	let current = path;
	while (!(await pathExists(current))) {
		missing.unshift(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (missing.length > 0) await Deno.mkdir(path, { recursive: true });
	return missing;
}

/** Writes through a sibling temp file so a crash never leaves a half-written binary in place. */
async function writeFileAtomically(path: string, bytes: Uint8Array, mode: number): Promise<void> {
	const temp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	await Deno.writeFile(temp, bytes, { mode });
	await Deno.rename(temp, path);
}

export function desktopEntry(binaryPath: string, iconPath: string): string {
	const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Version=1.5",
		"Name=Clio Coder",
		"Comment=The desktop and browser GUI for Clio Coder",
		// The GUI is a loopback server plus the default browser. It runs in a
		// terminal so closing that window is the documented way to stop it.
		`Exec=${quote(binaryPath)} --open`,
		`Icon=${iconPath}`,
		"Terminal=true",
		"Categories=Development;Science;",
		"Keywords=Clio Coder;agent;research;",
		"StartupNotify=false",
		"",
	].join("\n");
}

export async function readManifest(path: string): Promise<InstallManifest | null> {
	let text: string;
	try {
		text = await Deno.readTextFile(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new LifecycleError(`The install manifest at ${path} is not valid JSON.`);
	}
	if (
		typeof parsed !== "object" || parsed === null || (parsed as { schema?: unknown }).schema !== MANIFEST_SCHEMA ||
		!Array.isArray((parsed as { files?: unknown }).files)
	) {
		throw new LifecycleError(`The install manifest at ${path} has an unsupported shape.`);
	}
	return parsed as InstallManifest;
}

async function runDeno(context: LifecycleContext, args: readonly string[], cwd: string): Promise<void> {
	const command = new Deno.Command(context.denoPath ?? Deno.execPath(), {
		args: [...args],
		cwd,
		stdin: "null",
		stdout: "inherit",
		stderr: "inherit",
	});
	const status = await command.output();
	if (!status.success) throw new LifecycleError(`deno ${args[0]} failed with code ${status.code}.`);
}

/** Builds `dist/` and compiles the binary with the embedded assets. Returns the output path. */
export async function compileBinary(
	context: LifecycleContext,
	output: string,
	skipBuild: boolean,
): Promise<string> {
	const target = requireAbsolute(output, "--output");
	if (!skipBuild) {
		context.log("Building dist/ with Vite.");
		await runDeno(context, ["task", "build"], APP_ROOT);
	}
	if (!(await pathExists(join(APP_ROOT, "dist", "index.html")))) {
		throw new LifecycleError("dist/index.html is missing; run without --skip-build.");
	}
	context.log(`Compiling ${CLI_NAME} ${APP_VERSION} with dist/ embedded.`);
	await ensureDirectory(dirname(target));
	await runDeno(
		context,
		["compile", ...COMPILE_PERMISSIONS, "--include", "dist", "--output", target, "main.ts"],
		APP_ROOT,
	);
	return target;
}

async function placeFile(
	destination: string,
	bytes: Uint8Array,
	role: FileRole,
	mode: number,
): Promise<ManifestFile> {
	await writeFileAtomically(destination, bytes, mode);
	return { path: destination, role, sha256: await sha256(bytes), bytes: bytes.byteLength };
}

export async function install(options: InstallOptions, context: LifecycleContext): Promise<InstallManifest> {
	const layout = resolveLayout(options, context.env);
	checkRoots(layout);
	const previous = await readManifest(layout.manifest);
	if (previous !== null) context.log(`Upgrading ${CLI_NAME} ${previous.version} → ${APP_VERSION}.`);

	let binarySource: string;
	if (options.binary === undefined) {
		const staging = await Deno.makeTempDir({ prefix: "clio-coder-gui-compile-" });
		try {
			binarySource = await compileBinary(context, join(staging, CLI_NAME), options.skipBuild);
			return await placeInstallation(layout, previous, binarySource, context);
		} finally {
			await Deno.remove(staging, { recursive: true }).catch(() => undefined);
		}
	}
	binarySource = requireAbsolute(options.binary, "--binary");
	return await placeInstallation(layout, previous, binarySource, context);
}

async function placeInstallation(
	layout: Layout,
	previous: InstallManifest | null,
	binarySource: string,
	context: LifecycleContext,
): Promise<InstallManifest> {
	const binaryBytes = await Deno.readFile(binarySource);
	const iconBytes = await Deno.readFile(ICON_SOURCE);
	const created: string[] = [];
	for (const root of [layout.bin, layout.applications, layout.data]) created.push(...await ensureDirectory(root));

	const binaryPath = join(layout.bin, CLI_NAME);
	const iconPath = join(layout.data, ICON_NAME);
	const entryPath = join(layout.applications, DESKTOP_ENTRY_NAME);
	const files: ManifestFile[] = [
		await placeFile(binaryPath, binaryBytes, "binary", 0o755),
		await placeFile(iconPath, iconBytes, "icon", 0o644),
		await placeFile(entryPath, new TextEncoder().encode(desktopEntry(binaryPath, iconPath)), "desktop-entry", 0o644),
	];

	// An upgrade that moved a file leaves the old one listed; remove exactly those.
	const kept = new Set(files.map((file) => file.path));
	for (const stale of previous?.files ?? []) {
		if (kept.has(stale.path)) continue;
		if (await removeListedFile(stale, previous!, context)) context.log(`Removed stale ${stale.role} ${stale.path}`);
	}
	const createdDirectories = [...new Set([...(previous?.createdDirectories ?? []), ...created])];

	const manifest: InstallManifest = {
		schema: MANIFEST_SCHEMA,
		product: "Clio Coder",
		version: APP_VERSION,
		installedAt: new Date().toISOString(),
		roots: { bin: layout.bin, applications: layout.applications, data: layout.data },
		stateDir: layout.stateDir,
		createdDirectories,
		files,
	};
	await writeFileAtomically(
		layout.manifest,
		new TextEncoder().encode(`${JSON.stringify(manifest, null, "\t")}\n`),
		0o644,
	);
	for (const file of files) context.log(`Installed ${file.role.padEnd(13)} ${file.path}`);
	context.log(`Manifest              ${layout.manifest}`);
	context.log(`State directory       ${layout.stateDir} (untouched)`);
	const pathEntries = (context.env("PATH") ?? "").split(":");
	if (!pathEntries.includes(layout.bin)) {
		context.log(`Note: ${layout.bin} is not on PATH; run ${binaryPath} directly or add the directory.`);
	}
	return manifest;
}

/** Removes one manifest-listed regular file after confirming it sits under a recorded root. */
async function removeListedFile(
	file: ManifestFile,
	manifest: InstallManifest,
	context: LifecycleContext,
): Promise<boolean> {
	const roots = [manifest.roots.bin, manifest.roots.applications, manifest.roots.data];
	if (!isAbsolute(file.path) || !roots.some((root) => isWithin(root, file.path))) {
		context.log(`Left alone: ${file.path} is outside the recorded installation directories.`);
		return false;
	}
	let info: Deno.FileInfo;
	try {
		info = await Deno.lstat(file.path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			context.log(`Already gone: ${file.path}`);
			return false;
		}
		throw error;
	}
	if (!info.isFile) {
		context.log(`Left alone: ${file.path} is not a regular file any more.`);
		return false;
	}
	await Deno.remove(file.path);
	return true;
}

export interface StatusReport {
	readonly installed: boolean;
	readonly manifestPath: string;
	readonly version: string | null;
	readonly files: ReadonlyArray<{ readonly file: ManifestFile; readonly state: "ok" | "modified" | "missing" }>;
	readonly stateDir: string;
	readonly stateDirPresent: boolean;
	readonly binOnPath: boolean;
}

export async function status(options: CommonOptions, context: LifecycleContext): Promise<StatusReport> {
	const layout = resolveLayout(options, context.env);
	const manifest = await readManifest(layout.manifest);
	const files: Array<{ file: ManifestFile; state: "ok" | "modified" | "missing" }> = [];
	for (const file of manifest?.files ?? []) {
		try {
			const bytes = await Deno.readFile(file.path);
			files.push({ file, state: await sha256(bytes) === file.sha256 ? "ok" : "modified" });
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
			files.push({ file, state: "missing" });
		}
	}
	const stateDir = manifest?.stateDir ?? layout.stateDir;
	const report: StatusReport = {
		installed: manifest !== null,
		manifestPath: layout.manifest,
		version: manifest?.version ?? null,
		files,
		stateDir,
		stateDirPresent: await pathExists(stateDir),
		binOnPath: (context.env("PATH") ?? "").split(":").includes(layout.bin),
	};
	if (!report.installed) {
		context.log(`${CLI_NAME} is not installed (no manifest at ${layout.manifest}).`);
	} else {
		context.log(`${CLI_NAME} ${report.version} installed; source version is ${APP_VERSION}.`);
		for (const entry of report.files) {
			context.log(`${entry.state.padEnd(9)} ${entry.file.role.padEnd(13)} ${entry.file.path}`);
		}
	}
	context.log(`State directory ${stateDir} ${report.stateDirPresent ? "exists" : "does not exist yet"}.`);
	if (report.installed && !report.binOnPath) context.log(`Note: ${layout.bin} is not on PATH.`);
	return report;
}

export async function uninstall(options: UninstallOptions, context: LifecycleContext): Promise<boolean> {
	const layout = resolveLayout(options, context.env);
	const manifest = await readManifest(layout.manifest);
	if (manifest === null) {
		context.log(`${CLI_NAME} is not installed (no manifest at ${layout.manifest}); nothing removed.`);
		return false;
	}
	for (const file of manifest.files) {
		if (await removeListedFile(file, manifest, context)) context.log(`Removed ${file.role.padEnd(13)} ${file.path}`);
	}
	await Deno.remove(layout.manifest);
	context.log(`Removed manifest      ${layout.manifest}`);
	// Directories the installer created come out deepest first, and only when empty.
	const candidates = [...manifest.createdDirectories].sort((a, b) => b.length - a.length);
	for (const directory of candidates) {
		if (directory === "/" || directory === layout.home) continue;
		try {
			await Deno.remove(directory);
			context.log(`Removed empty dir     ${directory}`);
		} catch {
			// Not empty, already gone, or not ours to remove any more.
		}
	}
	if (options.purgeState) {
		const stateDir = manifest.stateDir;
		if (!isAbsolute(stateDir) || stateDir === "/" || stateDir === layout.home || basename(stateDir).length === 0) {
			throw new LifecycleError(`Refusing to purge ${stateDir}.`);
		}
		if (await pathExists(stateDir)) {
			await Deno.remove(stateDir, { recursive: true });
			context.log(`Purged state          ${stateDir}`);
		} else context.log(`State directory ${stateDir} was already absent.`);
	} else {
		context.log(`Kept state directory  ${manifest.stateDir} (pass --purge-state to remove it).`);
	}
	return true;
}

function parseCommon(argument: string, options: CommonOptions): boolean {
	if (argument.startsWith("--prefix=")) options.prefix = argument.slice("--prefix=".length);
	else if (argument.startsWith("--state-dir=")) options.stateDir = argument.slice("--state-dir=".length);
	else return false;
	return true;
}

export const USAGE = `Usage: deno run -A scripts/gui-lifecycle.ts <command> [options]

  install   [--prefix=DIR] [--binary=PATH] [--skip-build] [--state-dir=DIR]
  upgrade   (alias of install; replaces the recorded files in place)
  status    [--prefix=DIR] [--state-dir=DIR]
  uninstall [--prefix=DIR] [--state-dir=DIR] [--purge-state]
  compile   [--output=PATH] [--skip-build]`;

export async function runLifecycle(args: readonly string[], context: LifecycleContext): Promise<number> {
	const [command, ...rest] = args;
	switch (command) {
		case "install":
		case "upgrade": {
			const options: InstallOptions = { skipBuild: false };
			for (const argument of rest) {
				if (parseCommon(argument, options)) continue;
				if (argument.startsWith("--binary=")) options.binary = argument.slice("--binary=".length);
				else if (argument === "--skip-build") options.skipBuild = true;
				else throw new LifecycleError(`Unknown ${command} option: ${argument}`);
			}
			await install(options, context);
			return 0;
		}
		case "status": {
			const options: CommonOptions = {};
			for (const argument of rest) {
				if (!parseCommon(argument, options)) throw new LifecycleError(`Unknown status option: ${argument}`);
			}
			const report = await status(options, context);
			return report.installed && report.files.every((entry) => entry.state === "ok") ? 0 : 1;
		}
		case "uninstall": {
			const options: UninstallOptions = { purgeState: false };
			for (const argument of rest) {
				if (parseCommon(argument, options)) continue;
				if (argument === "--purge-state") options.purgeState = true;
				else throw new LifecycleError(`Unknown uninstall option: ${argument}`);
			}
			await uninstall(options, context);
			return 0;
		}
		case "compile": {
			let output = join(APP_ROOT, ".desktop", CLI_NAME);
			let skipBuild = false;
			for (const argument of rest) {
				if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
				else if (argument === "--skip-build") skipBuild = true;
				else throw new LifecycleError(`Unknown compile option: ${argument}`);
			}
			const path = await compileBinary(context, output, skipBuild);
			context.log(`Compiled ${path}`);
			return 0;
		}
		default:
			context.log(USAGE);
			return command === undefined || command === "--help" || command === "help" ? 0 : 2;
	}
}

if (import.meta.main) {
	const env: EnvReader = (name) => {
		const value = Deno.env.get(name);
		return value === undefined || value.length === 0 ? undefined : value;
	};
	try {
		Deno.exit(await runLifecycle(Deno.args, { env, log: console.log }));
	} catch (error) {
		console.error(error instanceof LifecycleError ? error.message : error);
		Deno.exit(1);
	}
}
