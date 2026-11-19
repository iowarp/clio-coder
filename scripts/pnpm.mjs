#!/usr/bin/env node
/**
 * The one way a script starts pnpm. Agent and CI shells often carry corepack and no `pnpm`
 * shim, and a script that spawned bare `pnpm` then failed with ENOENT partway through a gate.
 *
 * `node scripts/pnpm.mjs <args>` forwards to pnpm, for package.json scripts that call it nested.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const shell = process.platform === "win32";

/** `pnpm` when `env.PATH` runs it, else `corepack pnpm` (pinned by `packageManager`) for corepack-only shells. */
export function pnpmCommand(env = process.env) {
	const probe = spawnSync("pnpm", ["--version"], { env, stdio: "ignore", shell });
	return probe.error === undefined && probe.status === 0 ? ["pnpm"] : ["corepack", "pnpm"];
}

let resolved;
/** `[command, args]` that runs pnpm with `args`, resolved once per process against this process's PATH. */
export function pnpmArgv(args = []) {
	resolved ??= pnpmCommand();
	return [resolved[0], [...resolved.slice(1), ...args]];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, args] = pnpmArgv(process.argv.slice(2));
	const result = spawnSync(command, args, { stdio: "inherit", shell });
	if (result.error) {
		console.error(`pnpm: could not start ${command}: ${result.error.message}`);
		process.exit(1);
	}
	process.exit(result.status ?? 1);
}
