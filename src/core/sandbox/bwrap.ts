import path from "node:path";
import type { SandboxCommand, SandboxInvocation, SandboxInvocationSpec } from "./types.js";

export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";

/** The private /tmp mount point; anything the run must read under it is re-exposed. */
const SANDBOX_TMP = "/tmp";

/** The shell argv both exec seams hand the sandbox for a bash command string. */
export function sandboxCommandArgv(command: SandboxCommand): string[] {
	return "argv" in command ? [...command.argv] : ["/bin/bash", "-o", "pipefail", "-c", command.shell];
}

function isUnder(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Bind sources and targets are the same path; a trailing slash only marks a subtree. */
function bindPath(entry: string): string {
	const trimmed = entry.length > 1 ? entry.replace(/\/+$/u, "") : entry;
	return trimmed.length === 0 ? "/" : trimmed;
}

function uniquePaths(entries: ReadonlyArray<string> | undefined): string[] {
	return [...new Set((entries ?? []).map(bindPath))];
}

/**
 * Pure bubblewrap argv for one sandboxed command. Mount order is the policy:
 * later mounts shadow earlier ones, so the sequence is read-only root, fresh
 * /dev, /proc and private /tmp, then writable roots, then read-only
 * re-protection inside them, then the Git metadata the run may write, then
 * masks over secrets.
 *
 * `-try` binds skip a missing source instead of failing the whole command, so
 * a write root that does not exist yet stays unwritable rather than breaking
 * every call. Masks must name existing paths: bwrap cannot create a mount
 * point on the read-only root, and the impure caller filters them.
 *
 * The process keeps the operator's uid inside an unprivileged user namespace
 * (no `--uid 0`), with every capability dropped by bwrap's default.
 */
export function buildBwrapInvocation(
	spec: SandboxInvocationSpec,
	bwrapPath: string = DEFAULT_BWRAP_PATH,
): SandboxInvocation {
	const args: string[] = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
	if (!spec.network) args.push("--unshare-net");
	args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", SANDBOX_TMP);
	const readable = uniquePaths([spec.cwd, ...(spec.readableRoots ?? [])]);
	for (const entry of readable) {
		if (isUnder(SANDBOX_TMP, entry)) args.push("--ro-bind-try", entry, entry);
	}
	for (const entry of uniquePaths(spec.writableRoots)) args.push("--bind-try", entry, entry);
	for (const entry of uniquePaths(spec.readOnlyPaths)) args.push("--ro-bind-try", entry, entry);
	for (const entry of uniquePaths(spec.gitWritablePaths)) args.push("--bind-try", entry, entry);
	for (const mask of spec.maskedPaths) {
		if (mask.kind === "directory") args.push("--tmpfs", bindPath(mask.path));
		else args.push("--ro-bind-try", "/dev/null", bindPath(mask.path));
	}
	for (const [key, value] of Object.entries(spec.setEnv ?? {})) args.push("--setenv", key, value);
	for (const key of spec.unsetEnv ?? []) args.push("--unsetenv", key);
	args.push("--chdir", spec.cwd, "--", ...sandboxCommandArgv(spec.command));
	return { file: bwrapPath, args };
}
