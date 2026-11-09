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
 * Windows paths do not resolve, so it is skipped. Git for Windows'
 * `<git>\bin\bash.exe` is a wrapper that puts its own git ahead of everything
 * on PATH, including Clio's managed git shim, so its sibling
 * `<git>\usr\bin\bash.exe` runs instead; {@link bashShellEnvironment} gives it
 * the tool directories the wrapper would have added.
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
	const found = candidates.find((file) => !isWslLauncher(file) && host.isFile(file));
	if (found === undefined) return null;
	const dir = win.dirname(found);
	if (win.basename(dir).toLowerCase() !== "bin" || win.basename(win.dirname(dir)).toLowerCase() === "usr") return found;
	const unwrapped = win.join(win.dirname(dir), "usr", "bin", "bash.exe");
	return host.isFile(unwrapped) ? unwrapped : found;
}

/** The MSYS2 environments Git for Windows ships its own git and tools under, in the order its wrapper prefers. */
const GIT_FOR_WINDOWS_MSYSTEMS = ["ucrt64", "mingw64", "clangarm64", "mingw32"] as const;

/**
 * The environment a bash from {@link resolveBashShell} runs with. A Windows
 * `<root>\usr\bin\bash.exe` started directly has no `/usr/bin` on PATH, so
 * sed, grep and ls are missing and `find` is the Windows one. This prepends what
 * Git for Windows' `bin\bash.exe` wrapper does, `<root>\<msystem>\bin` and
 * `<root>\usr\bin`, and sets MSYSTEM to match. Callers that put a directory
 * ahead of these, such as the managed git shim, add it after this runs.
 */
export function bashShellEnvironment(
	shell: string,
	env: NodeJS.ProcessEnv,
	host: BashShellHost = LIVE_HOST,
): NodeJS.ProcessEnv {
	if (host.platform !== "win32") return env;
	const win = path.win32;
	const usrBin = win.dirname(shell);
	if (win.basename(usrBin).toLowerCase() !== "bin" || win.basename(win.dirname(usrBin)).toLowerCase() !== "usr")
		return env;
	const root = win.dirname(win.dirname(usrBin));
	const msystem = GIT_FOR_WINDOWS_MSYSTEMS.find((name) => host.isFile(win.join(root, name, "bin", "git.exe")));
	const prefix = [...(msystem === undefined ? [] : [win.join(root, msystem, "bin")]), usrBin];
	const next = { ...env };
	const pathKey = Object.keys(next).find((key) => key.toUpperCase() === "PATH") ?? "Path";
	const current = next[pathKey];
	next[pathKey] = current === undefined || current.length === 0 ? prefix.join(";") : `${prefix.join(";")};${current}`;
	if (msystem !== undefined) {
		for (const key of Object.keys(next)) if (key.toUpperCase() === "MSYSTEM") Reflect.deleteProperty(next, key);
		next.MSYSTEM = msystem.toUpperCase();
	}
	return next;
}

let resolved: string | null | undefined;

/** This process's bash, resolved once: the answer varies per host, never per task. */
export function bashShellPath(): string | null {
	if (resolved === undefined) resolved = resolveBashShell();
	return resolved;
}
