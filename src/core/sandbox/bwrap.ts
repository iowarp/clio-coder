import path from "node:path";
import { relativePathEscapes } from "../path-containment.js";
import type { SandboxCommand, SandboxInvocation, SandboxInvocationSpec } from "./types.js";

export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";

/** The private /tmp mount point; anything the run must read under it is re-exposed. */
const SANDBOX_TMP = "/tmp";

/**
 * The descriptor the unix-socket filter travels on. It sits above stdio and
 * the Node IPC channel an extension runtime child holds on descriptor 3, and
 * stays a single digit because a POSIX shell redirects only 0 through 9.
 */
export const UNIX_SOCKET_FILTER_FD = 9;

/** A `unixSocketFilter` that reads the program from the launch's stdin, so probing support writes no file. */
export const UNIX_SOCKET_FILTER_STDIN = "-";

/** The descriptor bwrap writes its JSON status records on under the retrying launcher. */
const STATUS_FD = 8;

/** Where the retrying launcher keeps the caller's stdout while the first attempt's status is read. */
const STDOUT_FD = 7;

/** The shell argv both exec seams hand the sandbox for a bash command string. */
export function sandboxCommandArgv(command: SandboxCommand): string[] {
	return "argv" in command ? [...command.argv] : ["/bin/bash", "-o", "pipefail", "-c", command.shell];
}

function isUnder(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel.length > 0 && !relativePathEscapes(rel);
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
 * /dev, /proc and private /tmp (unless `privateTmp` is false), then writable roots, then read-only
 * re-protection inside them, then the Git metadata the run may write, then
 * masks over secrets, each directory mask followed by the subtrees it reveals.
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
	args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
	if (spec.privateTmp !== false) {
		args.push("--tmpfs", SANDBOX_TMP);
		const readable = uniquePaths([spec.cwd, ...(spec.readableRoots ?? [])]);
		for (const entry of readable) {
			if (isUnder(SANDBOX_TMP, entry)) args.push("--ro-bind-try", entry, entry);
		}
	}
	for (const entry of uniquePaths(spec.writableRoots)) args.push("--bind-try", entry, entry);
	for (const entry of uniquePaths(spec.readOnlyPaths)) args.push("--ro-bind-try", entry, entry);
	for (const entry of uniquePaths(spec.gitWritablePaths)) args.push("--bind-try", entry, entry);
	for (const mask of spec.maskedPaths) {
		if (mask.kind === "directory") {
			args.push("--tmpfs", bindPath(mask.path));
			for (const entry of mask.reveal ?? []) args.push("--ro-bind-try", entry.source, bindPath(entry.target));
		} else args.push("--ro-bind-try", "/dev/null", bindPath(mask.path));
	}
	for (const [key, value] of Object.entries(spec.setEnv ?? {})) args.push("--setenv", key, value);
	for (const key of spec.unsetEnv ?? []) args.push("--unsetenv", key);
	if (spec.unixSocketFilter !== undefined) args.push("--seccomp", String(UNIX_SOCKET_FILTER_FD));
	// Masks are mounts onto a host path, and a host program that renames a new file over that path while bwrap sets
	// up (Copilot CLI and Claude Code rewrite their configs so) makes bwrap abort the launch. A stdin filter is read
	// once, so that launch, used only to probe, keeps the single attempt.
	const retry = spec.maskedPaths.length > 0 && spec.unixSocketFilter !== UNIX_SOCKET_FILTER_STDIN;
	if (retry) args.push("--json-status-fd", String(STATUS_FD));
	args.push("--chdir", spec.cwd, "--", ...sandboxCommandArgv(spec.command));
	if (spec.unixSocketFilter === undefined && !retry) return { file: bwrapPath, args };
	// bwrap takes a seccomp program only as an open descriptor. A shell opens
	// the program file on it and execs bwrap in its own place, so every caller
	// keeps spawning one self-contained argv with its own stdio; bwrap reads
	// and closes the descriptor before the command starts.
	const fd = UNIX_SOCKET_FILTER_FD;
	const source =
		spec.unixSocketFilter === undefined
			? ""
			: spec.unixSocketFilter === UNIX_SOCKET_FILTER_STDIN
				? ` ${fd}<&0 0</dev/null`
				: ` ${fd}<"$filter"`;
	return {
		file: "/bin/sh",
		args: [
			"-c",
			retry ? retryingLaunch(source) : `filter=$1; shift; exec "$@"${source}`,
			"clio-coder-sandbox",
			spec.unixSocketFilter ?? "",
			bwrapPath,
			...args,
		],
	};
}

/**
 * The launcher script for a launch with masks. The first attempt runs as the
 * shell's child with bwrap's status records on a pipe. bwrap writes an
 * `exit-code` record whenever the command ran, whatever its exit, and a setup
 * failure exits 1 without one, so only that case runs the same launch again,
 * once, in the shell's own place; any other outcome exits with bwrap's own
 * code, which is the command's. The command never inherits the status pipe.
 * The payload's process groups stay one level below the launcher, where
 * signal.ts looks for them.
 */
function retryingLaunch(source: string): string {
	return [
		"filter=$1; shift",
		`exec ${STDOUT_FD}>&1`,
		`status=$("$@" ${STATUS_FD}>&1 1>&${STDOUT_FD} ${STDOUT_FD}>&-${source})`,
		"code=$?",
		`case $status in *'"exit-code"'*) exit "$code" ;; esac`,
		'[ "$code" -eq 1 ] || exit "$code"',
		"echo 'clio-coder-sandbox: bwrap could not mount a secret mask, likely a file a host program replaced while it started; running the launch again once' >&2",
		`exec "$@" ${STATUS_FD}>/dev/null ${STDOUT_FD}>&-${source}`,
	].join("\n");
}
