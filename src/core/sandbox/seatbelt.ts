import { sandboxCommandArgv } from "./bwrap.js";
import type { SandboxInvocation, SandboxInvocationSpec } from "./types.js";

export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

/**
 * UNVERIFIED: no macOS host was available when this was written. The profile
 * follows the shape of Codex CLI's workspace-write seatbelt policy, and
 * `sandboxAvailability()` only selects it after `sandbox-exec` accepts it on a
 * trivial command, so a profile the kernel rejects degrades `auto` to
 * unsandboxed instead of breaking every worker command. Nothing here has been
 * exercised against a real build, test run, or network probe on macOS.
 *
 * Semantics mirror the bubblewrap builder: read everything except masked
 * secrets, write only the writable roots, the Git paths the run may write and
 * the temporary directories, keep re-protected paths read-only, and allow
 * network only when the run was granted it. Paths travel as `-D` parameters
 * so no path is spliced into the profile text.
 */
const SEATBELT_BASE_POLICY = [
	"(version 1)",
	"(deny default)",
	"(allow process-exec)",
	"(allow process-fork)",
	"(allow signal (target same-sandbox))",
	"(allow process-info* (target same-sandbox))",
	"(allow sysctl-read)",
	"(allow mach-lookup)",
	"(allow ipc-posix-shm)",
	"(allow pseudo-tty)",
	'(allow file-ioctl (literal "/dev/tty"))',
	"(allow file-read*)",
	'(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
];

function paramRule(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `(subpath (param "${prefix}_${index}"))`).join(" ");
}

function literalRule(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `(literal (param "${prefix}_${index}"))`).join(" ");
}

function buildSeatbeltProfile(spec: SandboxInvocationSpec): { profile: string; params: string[] } {
	const params: string[] = [];
	const define = (prefix: string, values: ReadonlyArray<string>): number => {
		values.forEach((value, index) => {
			params.push("-D", `${prefix}_${index}=${value.length > 1 ? value.replace(/\/+$/u, "") : value}`);
		});
		return values.length;
	};
	const writable = define("WRITABLE_ROOT", spec.writableRoots);
	const readOnly = define("READ_ONLY_PATH", spec.readOnlyPaths ?? []);
	const gitWritable = define("GIT_WRITABLE_PATH", spec.gitWritablePaths ?? []);
	const maskedDirs = define(
		"MASKED_DIR",
		spec.maskedPaths.filter((mask) => mask.kind === "directory").map((mask) => mask.path),
	);
	const maskedFiles = define(
		"MASKED_FILE",
		spec.maskedPaths.filter((mask) => mask.kind === "file").map((mask) => mask.path),
	);
	const lines = [...SEATBELT_BASE_POLICY];
	// Temporary directories: macOS resolves /tmp to /private/tmp and gives each
	// user a per-session TMPDIR under /private/var/folders.
	lines.push('(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))');
	if (writable > 0) {
		const roots = paramRule("WRITABLE_ROOT", writable);
		const protectedPaths = paramRule("READ_ONLY_PATH", readOnly);
		lines.push(
			readOnly > 0
				? `(allow file-write* (require-all (require-any ${roots}) (require-not (require-any ${protectedPaths}))))`
				: `(allow file-write* ${roots})`,
		);
	}
	if (gitWritable > 0) lines.push(`(allow file-write* ${paramRule("GIT_WRITABLE_PATH", gitWritable)})`);
	// A later matching rule takes precedence in SBPL, so masks come last.
	if (maskedDirs > 0) lines.push(`(deny file-read* file-write* ${paramRule("MASKED_DIR", maskedDirs)})`);
	if (maskedFiles > 0) lines.push(`(deny file-read* file-write* ${literalRule("MASKED_FILE", maskedFiles)})`);
	// Without a network grant, `(deny default)` already refuses every socket,
	// Unix-domain ones included.
	if (spec.network) lines.push("(allow network*)", "(allow system-socket)");
	return { profile: lines.join("\n"), params };
}

/** Pure `sandbox-exec` argv. Environment changes ride the caller's spawn env. */
export function buildSeatbeltInvocation(
	spec: SandboxInvocationSpec,
	executable: string = SEATBELT_EXECUTABLE,
): SandboxInvocation {
	const { profile, params } = buildSeatbeltProfile(spec);
	const argv = sandboxCommandArgv(spec.command);
	const envPrefix: string[] = [];
	const setEnv = Object.entries(spec.setEnv ?? {});
	if (setEnv.length > 0 || (spec.unsetEnv ?? []).length > 0) {
		envPrefix.push("/usr/bin/env");
		for (const key of spec.unsetEnv ?? []) envPrefix.push("-u", key);
		for (const [key, value] of setEnv) envPrefix.push(`${key}=${value}`);
	}
	return { file: executable, args: ["-p", profile, ...params, ...envPrefix, ...argv] };
}
