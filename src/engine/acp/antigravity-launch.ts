import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import type { DelegationAgentConfig } from "../../core/defaults.js";
import { processAlive, processBirthToken, processIdentityAlive } from "../../core/process-identity.js";
import { GENERATED_TOOL_ENV_KEYS } from "../../core/tool-env-controls.js";

/** Clio-owned directory (0700, one per user) under the temp root that holds one `run-*` dir per agy launch. */
const ROOT_NAME = "clio-coder-agy";
const RUN_PREFIX = "run-";
const MARKER = "owner.json";
/** Always set for agy, over any entry value: no self-update mid-run, file-backed storage, unbuffered helpers. */
const FORCED: Readonly<Record<string, string>> = {
	AGY_CLI_DISABLE_AUTO_UPDATE: "1",
	AGY_ACP_FORCE_FILE_STORAGE: "1",
	PYTHONUNBUFFERED: "1",
};
const PATH_FLAGS = new Set(["--gemini-dir", "--gemini_dir", "--app-data-dir", "--app_data_dir"]);
const GEMINI_DIR_FLAGS = new Set(["--gemini-dir", "--gemini_dir"]);
const APP_DATA_DIR_FLAGS = new Set(["--app-data-dir", "--app_data_dir"]);
/** agy's defaults for a launch that names no profile flag: `~/.gemini` and `antigravity-cli` inside it. */
const DEFAULT_GEMINI_DIR = ".gemini";
const DEFAULT_APP_DATA_DIR = "antigravity-cli";

interface OwnerMarker {
	version: 1;
	host: string;
	namespace: string;
	pid: number;
	birthToken: string | null;
	childPid?: number;
}

export interface AntigravityLaunch {
	args: string[];
	env: Record<string, string>;
	/** agy's profile, `<gemini-dir>/<app-data-dir>` from the resolved args, which holds its `conversations/` store. */
	profileDir: string;
	/** Record the spawned agy pid in the owner marker, so a sweep waits for the child as well as for Clio. */
	recordChild(pid: number | null): void;
	/** Synchronous removal for a launch that never reached its run (transport creation threw). */
	discard(): void;
	/** Waits for the orphan sweep, then removes this launch's dir. Call after the child exited. */
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

function expandHome(value: string, home: string | undefined): string {
	if (home === undefined) return value;
	return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** The last value given for one of `flags`, as `--flag value` or `--flag=value`. */
function flagValue(args: ReadonlyArray<string>, flags: ReadonlySet<string>): string | undefined {
	let value: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const [flag, inline] = (args[index] ?? "").split(/=(.*)/su, 2);
		if (flag === undefined || !flags.has(flag)) continue;
		value = inline ?? args[index + 1];
	}
	return value;
}

/** Inode of this process's pid namespace on Linux; null where it cannot be read, which disables the sweep. */
function pidNamespace(): string | null {
	try {
		return /\[(\d+)\]/u.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Create this user's root 0700, or accept an existing one only when it is a real directory this user owns. */
function ownedRoot(parent: string): string {
	const uid = process.getuid?.();
	// Per user, so another account's root in a shared temp dir never blocks a launch.
	const root = path.join(parent, uid === undefined ? ROOT_NAME : `${ROOT_NAME}-${uid}`);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stat = lstatSync(root);
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid))
		throw new Error(`Antigravity temp root ${root} is not a directory owned by this user`);
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) chmodSync(root, 0o700);
	return root;
}

function parseMarker(text: string): OwnerMarker | null {
	try {
		const value = JSON.parse(text) as Partial<OwnerMarker>;
		if (
			value.version !== 1 ||
			typeof value.host !== "string" ||
			typeof value.namespace !== "string" ||
			!Number.isInteger(value.pid) ||
			!(typeof value.birthToken === "string" || value.birthToken === null) ||
			!(value.childPid === undefined || Number.isInteger(value.childPid))
		)
			return null;
		return value as OwnerMarker;
	} catch {
		return null;
	}
}

/**
 * Remove launch dirs left by crashed runs (agy unpacks about 1 GB into each). A `run-*` dir goes only when its marker
 * parses, names this host and pid namespace, records the agy child, and both the Clio owner (pid and birth token) and
 * that child are gone. Anything else, including a marker written before the child pid was recorded (a crash between
 * spawn and recordChild could leave agy running), is left alone: a leak, never a deletion of a live dir.
 */
async function sweepOrphans(root: string, namespace: string | null): Promise<void> {
	if (namespace === null) return;
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return;
	}
	await Promise.all(
		names.map(async (name) => {
			if (!name.startsWith(RUN_PREFIX)) return;
			const dir = path.join(root, name);
			try {
				if (!(await lstat(dir)).isDirectory()) return;
				const marker = parseMarker(await readFile(path.join(dir, MARKER), "utf8"));
				if (marker === null || marker.host !== hostname() || marker.namespace !== namespace) return;
				if (marker.childPid === undefined || processAlive(marker.childPid)) return;
				if (processIdentityAlive({ host: marker.host, pid: marker.pid, birthToken: marker.birthToken }) !== false) return;
				await rm(dir, { recursive: true, force: true });
			} catch {
				// Unreadable or vanished: leave it.
			}
		}),
	);
}

/**
 * Launch facts for an `agy acp` peer: `~` in the profile flags resolved against the child's HOME, an environment
 * overlay that is the entry's own `env`, the forced keys and the autonomy ceiling and confinement pin the shared tool
 * controls read (they only tighten; credentials the adapter resolved for other peers never reach agy), and a private
 * temp dir with an owner marker.
 */
export function prepareAntigravityLaunch(
	agent: DelegationAgentConfig,
	overlay: Record<string, string> = {},
	/** The child's working directory, against which agy resolves a relative profile flag. */
	cwd: string = process.cwd(),
): AntigravityLaunch {
	const env: Record<string, string> = {};
	for (const name of [...Object.keys(agent.env ?? {}), ...GENERATED_TOOL_ENV_KEYS]) {
		const value = overlay[name];
		if (value !== undefined) env[name] = value;
	}
	Object.assign(env, FORCED);
	const home = [env.HOME, process.env.HOME, homedir()].find((value) => value !== undefined && value.length > 0);
	const args = agent.args.map((arg, index) => {
		const [flag, inline] = arg.split(/=(.*)/su, 2);
		if (inline !== undefined && flag !== undefined && PATH_FLAGS.has(flag)) return `${flag}=${expandHome(inline, home)}`;
		return PATH_FLAGS.has(agent.args[index - 1] ?? "") ? expandHome(arg, home) : arg;
	});
	const profileDir = path.resolve(
		cwd,
		flagValue(args, GEMINI_DIR_FLAGS) ?? path.join(home ?? homedir(), DEFAULT_GEMINI_DIR),
		flagValue(args, APP_DATA_DIR_FLAGS) ?? DEFAULT_APP_DATA_DIR,
	);
	// An entry TMPDIR relocates the Clio-owned root; the entry's directory itself is never scanned.
	const root = ownedRoot(env.TMPDIR ? env.TMPDIR : tmpdir());
	const namespace = pidNamespace();
	const sweep = sweepOrphans(root, namespace);
	const dir = mkdtempSync(path.join(root, RUN_PREFIX));
	const marker: OwnerMarker = {
		version: 1,
		host: hostname(),
		namespace: namespace ?? "unknown",
		pid: process.pid,
		birthToken: processBirthToken(),
	};
	const writeMarker = (): void => writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
	const childTemp = path.join(dir, "tmp");
	try {
		writeMarker();
		mkdirSync(childTemp, { mode: 0o700 });
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	env.TMPDIR = childTemp;
	if (process.platform === "win32") {
		env.TEMP = childTemp;
		env.TMP = childTemp;
	}
	return {
		args,
		env,
		profileDir,
		recordChild(pid) {
			if (pid === null) return;
			marker.childPid = pid;
			try {
				writeMarker();
			} catch {
				// The marker keeps the owner identity; a sweep still waits for this Clio process.
			}
		},
		discard() {
			rmSync(dir, { recursive: true, force: true });
		},
		async cleanup() {
			await sweep;
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		},
	};
}
