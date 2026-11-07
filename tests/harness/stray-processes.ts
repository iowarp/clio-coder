/**
 * Processes a test left running, found by the environment they inherited and killed.
 *
 * A Clio launcher that opens its pane host starts `herdr server` detached, in
 * a session of its own, so the host outlives a launcher that a test SIGKILLs
 * and keeps running after the test deletes the home it was started from. Three
 * boot-handoff runs left 24 such hosts, each with its pane shell, still alive
 * sixteen hours later. Once the launcher is gone nothing in the process tree
 * leads back to the test, but every process Clio starts carries the
 * environment it was given, so a test's scratch home, or the run root, in
 * `/proc/<pid>/environ` names the test that owns it.
 *
 * Linux only. Elsewhere no unprivileged interface reads another process's
 * environment, and these find nothing.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface StrayProcess {
	readonly pid: number;
	readonly argv: readonly string[];
	/** True for `herdr server`: the pane host a Clio launcher starts. */
	readonly herdrHost: boolean;
	/** The host socket the process was given, for a pane host or a pane in one. */
	readonly socketPath: string | undefined;
}

/**
 * Every process of this user whose environment holds `name=value`, other than
 * this one and its live children. Those are the caller's own: the runner's
 * esbuild service carries the run root, and a process a test abandoned has lost
 * the parent that started it by the time anyone looks.
 */
export function processesCarrying(name: string, value: string): StrayProcess[] {
	if (process.platform !== "linux" || value.length === 0) return [];
	const needle = `${name}=${value}`;
	const found: StrayProcess[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
		let environ: string[];
		let argv: string[];
		let parent: number;
		try {
			environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
			argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
			// The command name in field 2 may hold spaces and parentheses; the parent pid follows the last ")".
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		} catch {
			// Another user's process, or one that exited during the scan.
			continue;
		}
		if (parent === process.pid || !environ.includes(needle)) continue;
		const socket = environ.find((line) => line.startsWith("HERDR_SOCKET_PATH="));
		found.push({
			pid: Number(entry),
			argv,
			herdrHost: basename(argv[0] ?? "") === "herdr" && argv.includes("server"),
			socketPath: socket?.slice("HERDR_SOCKET_PATH=".length),
		});
	}
	return found;
}

/**
 * SIGKILL every process whose environment holds `name=value`, once, and remove
 * the socket files a killed pane host cannot remove itself. Call it after the
 * process the test started has exited, so nothing is left to start another.
 * Returns what it killed.
 */
export function reapProcessesCarrying(name: string, value: string): StrayProcess[] {
	const strays = processesCarrying(name, value);
	for (const stray of strays) {
		try {
			process.kill(stray.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	for (const stray of strays) if (stray.herdrHost && stray.socketPath) removeHostSocket(stray.socketPath);
	return strays;
}

/** A Clio host's server and client sockets and its exit markers, named after the server socket. */
function removeHostSocket(socketPath: string): void {
	const name = basename(socketPath);
	if (!isAbsolute(socketPath) || !/^clio-coder-[0-9a-f]{12}\.sock$/u.test(name)) return;
	const dir = dirname(socketPath);
	const stem = name.slice(0, -".sock".length);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === name || entry === `${stem}-client.sock` || entry.startsWith(`${stem}.exit-`))
			rmSync(join(dir, entry), { force: true });
	}
}
