/**
 * `run --read-only`, and a read-only worker (local or over SSH), on a home Clio
 * has never set up writes nothing to it.
 *
 * A run records its session, telemetry, run ledger, heartbeat and running-build
 * entry, and its first boot scaffolds config, credentials, data and state. On
 * a home that holds none of that yet, a read-only run would leave behind the
 * very install it promised not to make. So the run moves this process to a
 * private home under the temp dir instead: the operator's config, if any, is
 * copied in and read there, settings default in memory when there is none,
 * credentials come from the environment, and the whole private home is removed
 * when the process exits. A home with `state/home.json` was set up, and a
 * read-only run there keeps those records in memory (see home-write-guard.ts).
 *
 * `credentials.yaml` is never copied: a copy would outlive a killed run in the
 * temp dir, and an OAuth refresh inside it would rotate the operator's token
 * into a file that is then thrown away. A termination signal nobody else
 * handles removes the private home before the process dies of it, and a home
 * whose owner died anyway (SIGKILL, a crash) is swept by the next one created.
 */

import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { processBirthToken, processIdentityAlive } from "./process-identity.js";
import { relocateClioHomeForProcess, resolveClioDirs } from "./xdg.js";

const PRIVATE_HOME_PREFIX = "clio-coder-read-only-";
const OWNER_FILE = "read-only-owner.json";
const CLEANUP_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The private home this process moved to, or null when the operator's home was already set up. */
export function enterPrivateHomeIfNeverSetUp(): string | null {
	const home = resolveClioDirs();
	if (existsSync(join(home.state, "home.json"))) return null;
	sweepOrphanedPrivateHomes();
	const root = mkdtempSync(join(tmpdir(), PRIVATE_HOME_PREFIX));
	const remove = (): void => rmSync(root, { recursive: true, force: true });
	process.once("exit", remove);
	removeOnUnhandledSignal(remove);
	writeFileSync(
		join(root, OWNER_FILE),
		`${JSON.stringify({ host: hostname(), pid: process.pid, birthToken: processBirthToken() })}\n`,
		{ mode: 0o600 },
	);
	const credentials = join(home.config, "credentials.yaml");
	if (existsSync(home.config)) {
		cpSync(home.config, join(root, "config"), {
			recursive: true,
			filter: (source) => source !== credentials && !source.startsWith(`${credentials}.`),
		});
	}
	relocateClioHomeForProcess(root);
	return root;
}

/**
 * A signal with a listener no longer takes its default action, so this one acts
 * only when it is the sole listener: it removes the home and re-raises the signal,
 * and the process dies of it exactly as it would have. When another listener
 * (the termination coordinator, a worker's abort) owns the signal, that owner
 * ends the process through `exit`, which removes the home. Prepending keeps this
 * listener first, before a `once` owner has unregistered itself.
 */
function removeOnUnhandledSignal(remove: () => void): void {
	const handler = (signal: NodeJS.Signals): void => {
		if (process.listenerCount(signal) > 1) return;
		remove();
		for (const each of CLEANUP_SIGNALS) process.off(each, handler);
		try {
			process.kill(process.pid, signal);
		} catch {
			process.exit(128 + (constants.signals[signal] ?? 15));
		}
	};
	for (const signal of CLEANUP_SIGNALS) process.prependListener(signal, handler);
}

/**
 * Removes the private homes of read-only processes on this host that died without
 * removing their own. A home without a readable owner record is left alone: it
 * may be one another process is still creating, or one this user cannot inspect.
 */
function sweepOrphanedPrivateHomes(): void {
	const dir = tmpdir();
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.startsWith(PRIVATE_HOME_PREFIX));
	} catch {
		return;
	}
	const uid = process.getuid?.();
	for (const name of names) {
		const root = join(dir, name);
		try {
			const stat = lstatSync(root);
			if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
			const owner = JSON.parse(readFileSync(join(root, OWNER_FILE), "utf8")) as Record<string, unknown>;
			const { host, pid, birthToken } = owner;
			if (typeof host !== "string" || typeof pid !== "number" || !Number.isInteger(pid)) continue;
			if (birthToken !== null && typeof birthToken !== "string") continue;
			if (processIdentityAlive({ host, pid, birthToken }) !== false) continue;
			rmSync(root, { recursive: true, force: true });
		} catch {
			// A home that vanished or cannot be read is not this sweep's to remove.
		}
	}
}
