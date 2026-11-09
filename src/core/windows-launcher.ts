import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "./package-root.js";

/**
 * The native Windows launcher ships prebuilt in
 * `assets/windows-launcher/win32-<arch>/launcher.exe`, built reproducibly from
 * `assets/windows-launcher/launcher.c` by `scripts/build-windows-launcher.mjs`,
 * which records each binary's SHA-256 in `assets/windows-launcher/pins.json`.
 * Clio installs a copy only when its bytes match the pin. A copy named
 * `<name>.exe` starts what `<name>.launch` beside it names, with the caller's
 * command line appended unchanged, so no cmd.exe runs in between.
 */
export const WINDOWS_LAUNCHER_LAUNCH_SUFFIX = ".launch";

export interface WindowsLauncherOptions {
	arch?: string;
	/** Where to take the launcher binaries from; pins always come from the running package. */
	packageRoot?: string;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function readOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		// Missing or unreadable reads as absent; the caller installs or reports.
		return null;
	}
}

function replaceFile(path: string, bytes: Buffer | string): void {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temporary, bytes, { mode: 0o755 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** The pinned SHA-256 of the launcher built for `arch`, or undefined when none is built. */
function windowsLauncherPin(arch: string): string | undefined {
	try {
		const pins = JSON.parse(
			readFileSync(join(resolvePackageRoot(), "assets", "windows-launcher", "pins.json"), "utf8"),
		) as Record<string, unknown>;
		const pin = pins[arch];
		return typeof pin === "string" && /^[0-9a-f]{64}$/.test(pin) ? pin : undefined;
	} catch {
		// A package without pins installs no launcher; the caller reports why.
		return undefined;
	}
}

/** Quote one argument so the MSVCRT rules (and Node's) read it back unchanged. */
function quoteWindowsArgument(value: string): string {
	if (value !== "" && !/[\s"]/.test(value)) return value;
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** The `.launch` text that starts `program` with `prefix` before the caller's arguments. */
export function windowsLaunchFile(program: string, prefix: readonly string[], options: readonly string[] = []): string {
	return [program, prefix.map(quoteWindowsArgument).join(" "), ...options].map((line) => `${line}\n`).join("");
}

/**
 * Install the native launcher as `<directory>/<name>.exe` with its
 * `<name>.launch`. Returns null when the launcher is in place, else why not.
 * A launcher whose bytes do not match the pin is never left in place.
 */
export function installWindowsLauncher(
	directory: string,
	name: string,
	launchFile: string,
	options: WindowsLauncherOptions = {},
): string | null {
	const arch = options.arch ?? process.arch;
	const target = join(directory, `${name}.exe`);
	const pin = windowsLauncherPin(arch);
	try {
		if (pin === undefined) {
			rmSync(target, { force: true });
			return `no Windows launcher is built for ${arch}`;
		}
		const launchPath = join(directory, `${name}${WINDOWS_LAUNCHER_LAUNCH_SUFFIX}`);
		if (readOrNull(launchPath)?.toString("utf8") !== launchFile) replaceFile(launchPath, launchFile);
		const installed = readOrNull(target);
		if (installed !== null && sha256(installed) === pin) return null;
		const sourcePath = join(
			options.packageRoot ?? resolvePackageRoot(),
			"assets",
			"windows-launcher",
			`win32-${arch}`,
			"launcher.exe",
		);
		const source = readOrNull(sourcePath);
		if (source === null || sha256(source) !== pin) {
			rmSync(target, { force: true });
			return source === null ? `${sourcePath} is missing` : `${sourcePath} does not match its pinned SHA-256`;
		}
		replaceFile(target, source);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
