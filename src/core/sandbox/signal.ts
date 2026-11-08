import { readFileSync } from "node:fs";

/**
 * Signals the process groups that hold a sandboxed command's payload.
 *
 * bubblewrap (`--unshare-pid --new-session`) runs the payload under an init
 * process in a new PID namespace and a new session, so the payload is not in
 * the process group of the launcher the caller spawned. Signalling only the
 * launcher's group reaches the outer bwrap, which dies at once; its
 * `--die-with-parent` then SIGKILLs the whole namespace, and the payload never
 * sees the SIGTERM it was meant to handle. The payload's groups are led by the
 * launcher's direct children, whose host PIDs Linux lists in
 * `/proc/<pid>/task/<pid>/children`.
 *
 * Returns true when at least one payload group was signalled, so the caller
 * can let the launcher exit on its own once the payload does. Returns false
 * where no such group is visible (not Linux, the namespace is not up yet, the
 * launcher is gone), and the caller falls back to the launcher's group.
 */
export function signalSandboxPayload(launcherPid: number, signal: NodeJS.Signals): boolean {
	if (process.platform !== "linux") return false;
	let children: number[];
	try {
		children = readFileSync(`/proc/${launcherPid}/task/${launcherPid}/children`, "utf8")
			.trim()
			.split(/\s+/u)
			.map(Number)
			.filter((pid) => Number.isSafeInteger(pid) && pid > 1);
	} catch {
		// No such launcher, or a kernel without the children file: the caller's
		// launcher-group signal is the fallback.
		return false;
	}
	let signalled = false;
	for (const child of children) {
		if (child === launcherPid) continue;
		try {
			process.kill(-child, signal);
			signalled = true;
		} catch {
			// ESRCH: the child exited or leads no group; EPERM: not ours. Either way
			// the launcher-group signal remains the fallback.
		}
	}
	return signalled;
}
