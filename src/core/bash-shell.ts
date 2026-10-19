import { statSync } from "node:fs";
import path from "node:path";

/** The shell every POSIX host runs bash commands under. */
export const POSIX_BASH = "/bin/bash";

/** What the resolver reads from the host, injectable so the Windows ladder runs on any platform. */
export interface BashShellHost {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	isFile(file: string): boolean;
}

const LIVE_HOST: BashShellHost = {
	platform: process.platform,
	env: process.env,
	isFile: (file) => statSync(file, { throwIfNoEntry: false })?.isFile() === true,
};

/** Windows env names are case-insensitive, and an injected env is a plain object. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	const value = key === undefined ? undefined : env[key];
	return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * The bash a command runs under, or null when this host has none. POSIX hosts
 * keep `/bin/bash`. Windows has nothing there, and `spawn /bin/bash ENOENT`
 * pushed every shell step onto run_script (#421), so it resolves Git Bash: the
 * first `bash.exe` on PATH, then the standard Git for Windows locations. The
 * `bash.exe` under the system directory or WindowsApps is the WSL launcher,
 * which runs the command inside a Linux distribution where the workspace's
 * Windows paths do not resolve, so it is skipped.
 */
export function resolveBashShell(host: BashShellHost = LIVE_HOST): string | null {
	if (host.platform !== "win32") return POSIX_BASH;
	const win = path.win32;
	const systemRoot = (envValue(host.env, "SystemRoot") ?? envValue(host.env, "windir") ?? "C:\\Windows").toLowerCase();
	const wslLauncherDirs = ["system32", "syswow64", "sysnative"].map((dir) => `${win.join(systemRoot, dir)}\\`);
	const isWslLauncher = (file: string): boolean => {
		const normalized = win.normalize(file).toLowerCase();
		return wslLauncherDirs.some((dir) => normalized.startsWith(dir)) || normalized.includes("\\microsoft\\windowsapps\\");
	};
	const candidates: string[] = [];
	for (const entry of (envValue(host.env, "PATH") ?? "").split(";")) {
		const dir = entry.trim().replace(/^"(.*)"$/u, "$1");
		if (dir.length > 0 && win.isAbsolute(dir)) candidates.push(win.join(dir, "bash.exe"));
	}
	for (const root of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].map((name) => envValue(host.env, name))) {
		if (root !== undefined) candidates.push(win.join(root, "Git", "bin", "bash.exe"));
	}
	const localAppData = envValue(host.env, "LOCALAPPDATA");
	if (localAppData !== undefined) candidates.push(win.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
	candidates.push("C:\\Program Files\\Git\\bin\\bash.exe");
	return candidates.find((file) => !isWslLauncher(file) && host.isFile(file)) ?? null;
}

let resolved: string | null | undefined;

/** This process's bash, resolved once: the answer varies per host, never per task. */
export function bashShellPath(): string | null {
	if (resolved === undefined) resolved = resolveBashShell();
	return resolved;
}
