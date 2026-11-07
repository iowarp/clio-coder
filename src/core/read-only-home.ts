/**
 * `run --read-only` on a home Clio has never set up writes nothing to it.
 *
 * A run records its session, telemetry, run ledger, heartbeat and running-build
 * entry, and its first boot scaffolds config, credentials, data and state. On
 * a home that holds none of that yet, a read-only run would leave behind the
 * very install it promised not to make. So the run moves this process to a
 * private home under the temp dir instead: the operator's config, if any, is
 * copied in and read there, settings default in memory when there is none,
 * credentials come from the environment, and the whole private home is removed
 * when the process exits. A home with `state/home.json` was set up, and a
 * read-only run there still records its session where it always did.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relocateClioHomeForProcess, resolveClioDirs } from "./xdg.js";

/** The private home this process moved to, or null when the operator's home was already set up. */
export function enterPrivateHomeIfNeverSetUp(): string | null {
	const home = resolveClioDirs();
	if (existsSync(join(home.state, "home.json"))) return null;
	const root = mkdtempSync(join(tmpdir(), "clio-coder-read-only-"));
	process.once("exit", () => rmSync(root, { recursive: true, force: true }));
	if (existsSync(home.config)) cpSync(home.config, join(root, "config"), { recursive: true });
	relocateClioHomeForProcess(root);
	return root;
}
