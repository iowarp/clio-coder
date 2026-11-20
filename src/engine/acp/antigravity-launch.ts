import { mkdtempSync, readlinkSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { DelegationAgentConfig } from "../../core/defaults.js";
import { processAlive } from "../../core/process-identity.js";

/**
 * Per-process temp dirs are named `clio-coder-agy-<pid namespace>-<owner pid>-<random>` so a later launch can sweep
 * orphans. A pid is only meaningful inside its namespace (a sandboxed run sees itself as pid 5), so a sweep touches
 * only dirs from its own namespace and leaves the rest alone.
 */
const TEMP_PREFIX = "clio-coder-agy-";
const TEMP_OWNER = /^clio-coder-agy-(\d+)-(\d+)-/u;
/** Credentials and launch hooks agy would otherwise act on; kept only when the entry names them in `env`. */
const STRIPPED = new Set([
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GEMINI_HOME",
	"BROWSER",
]);
const FORCED: Readonly<Record<string, string>> = {
	AGY_CLI_DISABLE_AUTO_UPDATE: "1",
	AGY_ACP_FORCE_FILE_STORAGE: "1",
	PYTHONUNBUFFERED: "1",
};
const PATH_FLAGS = new Set(["--gemini-dir", "--gemini_dir", "--app-data-dir", "--app_data_dir"]);

export interface AntigravityLaunch {
	args: string[];
	env: Record<string, string>;
	/** Waits for the orphan sweep, then removes this launch's temp dir. Call after the child exited. */
	cleanup(): Promise<void>;
}

/** An `agy acp` recipe, whether the command is the bare name or a path to the binary. */
export function isAntigravityAcp(agent: DelegationAgentConfig): boolean {
	const name = path
		.basename(agent.command)
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/u, "");
	return name === "agy" && agent.args[0] === "acp";
}

function expandHome(value: string, home: string): string {
	return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Inode of this process's pid namespace on Linux, else "0". */
function pidNamespace(): string {
	try {
		return /\[(\d+)\]/u.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? "0";
	} catch {
		return "0";
	}
}

/** Remove temp dirs whose owning Clio process is gone; agy unpacks about 1 GB into each one. */
async function sweepOrphans(root: string, namespace: string): Promise<void> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return;
	}
	await Promise.all(
		names.map(async (name) => {
			const match = TEMP_OWNER.exec(name);
			if (match === null || match[1] !== namespace) return;
			const owner = Number(match[2]);
			if (owner === process.pid || processAlive(owner)) return;
			await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
		}),
	);
}

/**
 * Launch facts for an `agy acp` peer: `~` in the profile flags resolved against the child's HOME, the overlay
 * environment cut to an allowlist (the transport adds only its safe base), and a temp dir private to this process.
 */
export function prepareAntigravityLaunch(
	agent: DelegationAgentConfig,
	overlay: Record<string, string> = {},
): AntigravityLaunch {
	const configured = agent.env ?? {};
	const home = overlay.HOME ?? process.env.HOME ?? homedir();
	const args = agent.args.map((arg, index) => {
		const [flag, inline] = arg.split(/=(.*)/su, 2);
		if (inline !== undefined && flag !== undefined && PATH_FLAGS.has(flag)) return `${flag}=${expandHome(inline, home)}`;
		return PATH_FLAGS.has(agent.args[index - 1] ?? "") ? expandHome(arg, home) : arg;
	});
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(overlay)) {
		if ((STRIPPED.has(name) || name.startsWith("GOOGLE_CLOUD_")) && !Object.hasOwn(configured, name)) continue;
		env[name] = value;
	}
	for (const [name, value] of Object.entries(FORCED)) if (!Object.hasOwn(configured, name)) env[name] = value;
	const root = Object.hasOwn(configured, "TMPDIR") && env.TMPDIR ? env.TMPDIR : tmpdir();
	const namespace = pidNamespace();
	const sweep = sweepOrphans(root, namespace);
	const tempDir = mkdtempSync(path.join(root, `${TEMP_PREFIX}${namespace}-${process.pid}-`));
	env.TMPDIR = tempDir;
	if (process.platform === "win32") {
		env.TEMP = tempDir;
		env.TMP = tempDir;
	}
	return {
		args,
		env,
		async cleanup() {
			await sweep;
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}
