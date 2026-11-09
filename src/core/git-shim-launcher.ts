import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "./package-root.js";

/**
 * SHA-256 of the prebuilt Windows git launchers shipped in
 * `assets/git-shim/win32-<arch>/git.exe`. `scripts/build-git-shim.mjs` builds
 * them reproducibly from `assets/git-shim/launcher.c` and checks the committed
 * bytes against these pins; Clio installs a launcher only when its bytes match.
 */
export const GIT_SHIM_LAUNCHER_SHA256: Readonly<Record<string, string>> = {
	x64: "5ba4c896446da7149c5b8ceb961fa55c5c7d034161247bcdc50812c81a5fe493",
	arm64: "a20eb34d16d7e6bcd22e2f0bd3937e89c001e9aa7e2ecbdd7b36d4c1ea0c9006",
};

/** The launcher's name in the shim directory; PATHEXT and CreateProcess both find `.exe` before `git.cmd`. */
export const GIT_SHIM_LAUNCHER_NAME = "git.exe";
/** Beside the launcher: the Node executable it starts, as one UTF-8 line. */
export const GIT_SHIM_NODE_PATH_NAME = "git-shim.node";

export interface GitShimLauncherOptions {
	arch?: string;
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

/**
 * Install the native `git.exe` launcher and its Node path into the managed
 * shim directory. Returns null when the launcher is in place, else why not;
 * without it `git.cmd` stays the Windows entry, which cmd.exe expands `%NAME%`
 * through. A launcher whose bytes do not match the pin is never left on PATH.
 */
export function installGitShimLauncher(
	directory: string,
	nodeExecutable: string,
	options: GitShimLauncherOptions = {},
): string | null {
	const arch = options.arch ?? process.arch;
	const target = join(directory, GIT_SHIM_LAUNCHER_NAME);
	const pin = GIT_SHIM_LAUNCHER_SHA256[arch];
	try {
		if (pin === undefined) {
			rmSync(target, { force: true });
			return `no git launcher is built for ${arch}`;
		}
		const nodePath = join(directory, GIT_SHIM_NODE_PATH_NAME);
		const nodeLine = `${nodeExecutable}\n`;
		if (readOrNull(nodePath)?.toString("utf8") !== nodeLine) replaceFile(nodePath, nodeLine);
		const installed = readOrNull(target);
		if (installed !== null && sha256(installed) === pin) return null;
		const sourcePath = join(
			options.packageRoot ?? resolvePackageRoot(),
			"assets",
			"git-shim",
			`win32-${arch}`,
			"git.exe",
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
