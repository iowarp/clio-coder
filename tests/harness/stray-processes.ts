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
import { setTimeout as sleep } from "node:timers/promises";

export interface StrayProcess {
	readonly pid: number;
	readonly argv: readonly string[];
	/** True for `herdr server`: the pane host a Clio launcher starts. */
	readonly herdrHost: boolean;
	/** The host socket the process was given, for a pane host or a pane in one. */
	readonly socketPath: string | undefined;
	/** Start time in clock ticks since boot (stat field 22): with the pid, the process's identity. */
	readonly startTime: string;
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
		let startTime: string;
		try {
			environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
			argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
			// The command name in field 2 may hold spaces and parentheses; the parent pid follows the last ")".
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			parent = Number(fields[1]);
			startTime = fields[19] ?? "";
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
			startTime,
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

/** State and start time of `pid`, or null once it is gone. */
function statOf(pid: number): { state: string; startTime: string } | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { state: fields[0] ?? "", startTime: fields[19] ?? "" };
	} catch {
		return null;
	}
}

/** Whether `pid` still runs. A zombie has exited; only its parent's wait is missing. */
export function processAlive(pid: number): boolean {
	const stat = statOf(pid);
	return stat !== null && stat.state !== "Z";
}

/** Whether `stray` itself still runs, and its pid has not been handed to a newer process. */
function stillRunning(stray: StrayProcess): boolean {
	const stat = statOf(stray.pid);
	return stat !== null && stat.state !== "Z" && stat.startTime === stray.startTime;
}

async function waitForExit(strays: readonly StrayProcess[], timeoutMs: number): Promise<StrayProcess[]> {
	const deadline = Date.now() + timeoutMs;
	let alive = strays.filter(stillRunning);
	while (alive.length > 0 && Date.now() < deadline) {
		await sleep(25);
		alive = alive.filter(stillRunning);
	}
	return alive;
}

/**
 * Stop every process whose environment holds `name=value` and wait until each
 * has exited. A pane host is first asked to stop through its own socket, the
 * way a launcher stops it, so it closes its panes and removes its socket;
 * whatever is still running after `graceMs` is SIGKILLed and waited for.
 * Throws when a process survives SIGKILL, so a test cannot delete a home that
 * a host still runs in. Returns what it found.
 */
export async function stopProcessesCarrying(
	name: string,
	value: string,
	options: { graceMs?: number } = {},
): Promise<StrayProcess[]> {
	const strays = processesCarrying(name, value);
	if (strays.length === 0) return strays;
	const hosts = strays.filter((stray) => stray.herdrHost && stray.socketPath);
	if (hosts.length > 0) {
		const { createMuxClient } = await import("../../src/domains/mux/index.js");
		await Promise.all(
			hosts.map(async (host) => {
				const client = createMuxClient({
					socketPath: host.socketPath as string,
					requestTimeoutMs: 1_000,
					connectTimeoutMs: 500,
				});
				try {
					await client.serverStop();
				} catch {
					// A host that will not answer is killed below.
				} finally {
					await client.close().catch(() => undefined);
				}
			}),
		);
		await waitForExit(hosts, options.graceMs ?? 3_000);
	}
	// A host shutting down may still start a child (a pane shell, a fetch), so
	// scan again after each round until a scan comes back empty.
	const seen = new Map(strays.map((stray) => [stray.pid, stray]));
	let round = strays;
	for (let attempt = 0; round.length > 0; attempt++) {
		for (const stray of round) {
			seen.set(stray.pid, stray);
			// Checked against the start time so a pid reused while this waited is never signalled.
			if (!stillRunning(stray)) continue;
			try {
				process.kill(stray.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		const survivors = await waitForExit(round, 5_000);
		if (survivors.length > 0)
			throw new Error(
				`processes carrying ${name}=${value} outlived SIGKILL: ${survivors.map((stray) => stray.pid).join(", ")}`,
			);
		round = processesCarrying(name, value).filter(stillRunning);
		if (round.length > 0 && attempt === 4)
			throw new Error(`processes carrying ${name}=${value} kept starting: ${round.map((stray) => stray.pid).join(", ")}`);
	}
	const found = [...seen.values()];
	for (const stray of found) if (stray.herdrHost && stray.socketPath) removeHostSocket(stray.socketPath);
	return found;
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
