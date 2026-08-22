/**
 * The one way a live driver picks a model.
 *
 * `--target <id>` names a target in the operator's own settings.yaml, found
 * through the same resolver the binary uses. That target is copied into a
 * throwaway Clio home, so the run sees exactly the runtime, URL, auth, and
 * model list the operator configured and nothing else. Nothing here writes to
 * the operator's real config, data, state, or cache.
 *
 * What the run is given, and no more:
 *
 *   - `credentials.yaml` holds the single entry the target's auth resolves
 *     to (its `oauthProfile`, else `apiKeyRef`, else the runtime's OAuth
 *     provider id, else the runtime id), converted to the current store shape.
 *     Every other profile the operator has stays home. A stored key that is a
 *     `!command` is resolved here, once, through the product's own resolver,
 *     and the result is what the copy holds, so the run never executes the
 *     command and the value it produced is known to the redactor.
 *   - The child environment is built from scratch: BASE_ENV_PASSTHROUGH, the
 *     Clio directory variables, and only the credential variables the
 *     target's resolver would consult: its explicit `apiKeyEnvVar` or the
 *     runtime's `credentialsEnvVar`, the provider's conventional names when
 *     no stored entry exists, the AWS or Google families for runtimes that
 *     authenticate through a cloud SDK, and any variable a stored key refers
 *     to (`MY_VAR` or `${MY_VAR}`). `--pass-env NAME` adds one explicitly.
 *     An ambient OPENAI_API_KEY never reaches a run against a local target.
 *   - Inline `auth.headers` are written to the scratch settings because the
 *     run needs them, and are replaced with a placeholder when the run ends.
 *
 * What BASE_ENV_PASSTHROUGH does and does not promise. It is process
 * plumbing, not a secret-free set: HOME and XDG_* expose the operator's own
 * dotfiles to the child (git config, node-pty, and a delegated agent's own
 * login live there, and Clio's own state cannot, because every Clio root is
 * forced under the home and CLIO_CODER_REQUIRE_HOME_PREFIX makes any escape
 * fatal; the contract test pins that). Proxy URLs may carry a password and
 * are redacted whole. NODE_OPTIONS is deliberately absent: it can preload
 * code into the child, and a run that needs it says so with --pass-env.
 *
 * Every home carries `lease.json`. Secrets are removed when the driver's
 * cleanup runs, whether the run passed, failed, threw, or was interrupted by
 * SIGINT/SIGTERM/SIGHUP; a tree retained for diagnosis holds none. The one
 * tree that keeps its credentials on purpose is `live:home`, because an
 * interactive pane runs out of it later; its lease bounds that. The next
 * driver to start removes any home whose lease has expired, and
 * `live:home --release <dir>` removes one now. A driver killed with SIGKILL
 * runs no cleanup; its tree is collected by that sweep instead.
 *
 * Nothing inside a candidate tree decides whether it may be deleted; only
 * this process's own `os.tmpdir()` does. See isLiveHomeDir for the two forms
 * that authorize a recursive delete and why `lease.root` is not one of them.
 *
 * Limits worth stating once. Process-tree termination is a POSIX process
 * group: on Windows there is no group and only the direct child is signalled,
 * so a driver's grandchildren are not reached. A descendant that starts its
 * own session (the bash tool, dispatch workers) leaves the group and is
 * reached only through the CLI's own SIGTERM handler. And a driver killed
 * with SIGKILL runs no handler at all: its children survive until their own
 * timeouts and its tree until the next driver's lease sweep.
 *
 * A child of the run that makes its own temporary directories (the eval runner
 * gives each item a state dir and each temp-copy workspace a tree under
 * `os.tmpdir()`) lands inside the home as well, because the home's environment
 * sets `TMPDIR` beneath it. That keeps `CLIO_CODER_REQUIRE_HOME_PREFIX` honest
 * for every process in the run, not only the first one.
 *
 * The binary runs in the home's own empty `workspace/` unless a driver passes
 * a cwd, so a prompt that writes files (the delegation smoke asks the agent to
 * create one) writes into the scratch tree and never into this checkout.
 *
 * Every driver under benchmarks/internal takes the same flags:
 *
 *   --target <id>        required; a configured target id
 *   --model <wireId>     override the target's defaultModel
 *   --thinking <level>   off|minimal|low|medium|high|xhigh|max (driver sets the default)
 *   --keep               retain the scratch tree on success (secrets removed)
 *   --pass-env <NAME>    hand one more environment variable to the run (repeatable)
 *   --lease <duration>   how long the tree may exist (90m, 8h, 2d; default 12h)
 *
 * A failed run always retains its scratch tree and prints the path.
 */
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { DEFAULT_SETTINGS, THINKING_LEVELS, type ThinkingLevel } from "../../src/core/defaults.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import { resolveStoredApiKey } from "../../src/domains/providers/auth/api-key.js";
import type { AuthCredential } from "../../src/domains/providers/auth/storage.js";
import {
	findBuiltinRuntimeBootMetadata,
	type RuntimeBootMetadata,
} from "../../src/domains/providers/runtimes/boot-manifest.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { findEngineEnvKeys } from "../../src/engine/env-api-keys.js";
import { scratchClioEnvVars } from "../../tests/harness/scratch-env.js";
import {
	killLiveProcessGroups,
	RunCliTimeoutError,
	type RunOptions,
	type RunResult,
	runCli,
} from "../../tests/harness/spawn.js";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

/** Every scratch home this module makes is named with this; the sweep touches nothing else. */
export const LIVE_HOME_PREFIX = "clio-live-";
export const LEASE_FILE = "lease.json";
export const LAUNCHER_SHIM = "clio";
export const LAUNCHER_SCRIPT = "launch.mjs";
export const DEFAULT_LEASE_MS = 12 * 60 * 60 * 1000;
export const REDACTED = "[REDACTED]";

export type LiveSettings = typeof DEFAULT_SETTINGS;

export interface LiveArgs {
	target: string;
	model: string | null;
	thinking: ThinkingLevel;
	keep: boolean;
	/** Extra environment variables the operator wants the run to see. */
	passEnv: string[];
	leaseMs: number;
	/** Flags the shared parser did not consume, for the driver to interpret. */
	rest: string[];
}

export class LiveUsageError extends Error {}

const DURATION = /^(\d+)(m|h|d)$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function parseLeaseDuration(text: string): number {
	const match = DURATION.exec(text.trim());
	if (!match) throw new LiveUsageError(`--lease must look like 90m, 8h, or 2d; got ${JSON.stringify(text)}`);
	const amount = Number.parseInt(match[1] as string, 10);
	const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
	const ms = amount * unit;
	if (ms <= 0) throw new LiveUsageError("--lease must be positive");
	return ms;
}

/**
 * Parse the shared flags. Unknown flags and positionals are handed back in
 * `rest` so a driver can add its own without a second parser.
 */
export function parseLiveArgs(argv: ReadonlyArray<string>, defaultThinking: ThinkingLevel = "off"): LiveArgs {
	let target: string | null = null;
	let model: string | null = null;
	let thinking = defaultThinking;
	let keep = false;
	let leaseMs = DEFAULT_LEASE_MS;
	const passEnv: string[] = [];
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined) throw new LiveUsageError(`${arg} needs a value`);
			index += 1;
			return next;
		};
		if (arg === "--target") target = value();
		else if (arg === "--model") model = value();
		else if (arg === "--thinking") {
			const level = value();
			if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
				throw new LiveUsageError(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
			}
			thinking = level as ThinkingLevel;
		} else if (arg === "--keep") keep = true;
		else if (arg === "--pass-env") {
			const name = value();
			if (!ENV_NAME.test(name)) throw new LiveUsageError(`--pass-env needs a variable name, got ${name}`);
			passEnv.push(name);
		} else if (arg === "--lease") leaseMs = parseLeaseDuration(value());
		else rest.push(arg);
	}
	if (!target) throw new LiveUsageError("--target <id> is required; run `clio-coder targets` for the configured ids");
	return { target, model, thinking, keep, passEnv, leaseMs, rest };
}

/** Read one flag's value out of `rest`, removing it. */
export function takeFlag(rest: string[], flag: string): string | null {
	const index = rest.indexOf(flag);
	if (index === -1) return null;
	const value = rest[index + 1];
	if (value === undefined) throw new LiveUsageError(`${flag} needs a value`);
	rest.splice(index, 2);
	return value;
}

/** Remove a boolean flag from `rest`, reporting whether it was present. */
export function takeSwitch(rest: string[], flag: string): boolean {
	const index = rest.indexOf(flag);
	if (index === -1) return false;
	rest.splice(index, 1);
	return true;
}

export function rejectUnknown(rest: ReadonlyArray<string>): void {
	if (rest.length > 0) throw new LiveUsageError(`unknown argument: ${rest[0]}`);
}

export interface LiveLease {
	version: 1;
	driver: string;
	target: string;
	pid: number;
	/**
	 * The temp root the home was made in, recorded for a human reading the file.
	 * It is never an input to the deletion guard: the lease lives inside the tree
	 * it describes, so trusting it would let a forged tree authorize its own
	 * removal. See isLiveHomeDir.
	 */
	root: string;
	createdAt: string;
	expiresAt: string;
	/** True for a `live:home` tree, which keeps its credentials for a pane to use. */
	retainsSecrets: boolean;
}

export interface LiveHome {
	dir: string;
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	/** Empty directory under the home; the default cwd for the binary. */
	workspace: string;
	/** The complete environment for every process of the run; nothing ambient leaks through. */
	env: NodeJS.ProcessEnv;
	target: TargetDescriptor;
	model: string;
	thinking: ThinkingLevel;
	lease: LiveLease;
	/** Names of the credential variables the run was given, for the operator's eyes. */
	authEnvNames: ReadonlyArray<string>;
	/** `<dir>/clio`, present when the home was made with `launcher: true`. */
	launcher: string | null;
	/** Hide every secret the run was given: env values, stored keys and tokens, header values. */
	redact(text: string): string;
	/** Remove the credentials file and blank inline headers. Idempotent; safe from a signal handler. */
	scrubSecrets(): void;
	/** Scrub always; remove the tree on success unless --keep. */
	cleanup(passed: boolean): void;
}

/** Fail early with the one message that matters when dist/ is missing. */
export function requireBuild(): void {
	if (!existsSync(CLI_ENTRY)) throw new LiveUsageError(`${CLI_ENTRY} is missing; run \`npm run build\` first`);
}

export interface LiveHomeOptions {
	/** Must start with LIVE_HOME_PREFIX so the lease sweep can recognise the tree. */
	prefix: string;
	autonomy?: LiveSettings["autonomy"];
	/** Last word on the scratch settings before they are written. */
	settings?: (settings: LiveSettings) => void;
	/** Leave credentials in place for a later process (live:home). Drivers never set this. */
	retainSecrets?: boolean;
	/** Write `<dir>/clio` and `<dir>/launch.mjs` for starting Clio by hand with the run's environment. */
	launcher?: boolean;
}

function operatorTarget(id: string): TargetDescriptor {
	const settingsPath = join(resolveClioDirs().config, "settings.yaml");
	if (!existsSync(settingsPath)) {
		throw new LiveUsageError(`no operator settings at ${settingsPath}; run \`clio-coder configure\` first`);
	}
	const parsed = parse(readFileSync(settingsPath, "utf8")) as { targets?: TargetDescriptor[] } | null;
	const targets = Array.isArray(parsed?.targets) ? parsed.targets : [];
	const target = targets.find((candidate) => candidate.id === id);
	if (!target) {
		const known = targets.map((candidate) => candidate.id).join(", ") || "(none)";
		throw new LiveUsageError(`target "${id}" is not configured; configured ids: ${known}`);
	}
	return target;
}

/** The provider id the binary's auth storage keys this target's credential on. */
export function credentialProviderId(target: TargetDescriptor, runtime: RuntimeBootMetadata | null): string {
	return (
		target.auth?.oauthProfile?.trim() ||
		target.auth?.apiKeyRef?.trim() ||
		runtime?.oauthProviderId ||
		runtime?.id ||
		target.runtime
	);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The one credential the target resolves to, read from the operator's store
 * without taking its lock or creating it. Both store shapes are accepted; the
 * entry is returned in the current one. Anything unreadable is reported as
 * absent with a note on stderr, which is also how the binary treats it.
 */
export function readCredentialEntry(path: string, providerId: string): AuthCredential | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = parse(readFileSync(path, "utf8"));
	} catch (error) {
		process.stderr.write(`live: ${path} is not valid YAML (${error instanceof Error ? error.message : String(error)})\n`);
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.entries)) return null;
	const raw = parsed.entries[providerId];
	if (!isRecord(raw)) return null;
	const updatedAt =
		typeof raw.updatedAt === "string" && raw.updatedAt.length > 0 ? raw.updatedAt : new Date().toISOString();
	if (raw.type === "oauth") {
		if (typeof raw.access !== "string" || typeof raw.refresh !== "string" || typeof raw.expires !== "number") {
			process.stderr.write(`live: credential "${providerId}" has an OAuth shape this driver cannot read; not copied\n`);
			return null;
		}
		return { ...raw, type: "oauth", access: raw.access, refresh: raw.refresh, expires: raw.expires, updatedAt };
	}
	// v2 api_key, or a v1 entry (no type, just key).
	if ((raw.type === "api_key" || raw.type === undefined) && typeof raw.key === "string" && raw.key.trim().length > 0) {
		return { type: "api_key", key: raw.key, updatedAt };
	}
	process.stderr.write(`live: credential "${providerId}" has a shape this driver cannot read; not copied\n`);
	return null;
}

/**
 * Process plumbing a child needs to run at all. The module comment says what
 * each group exposes; the contract test pins this list so an addition is a
 * deliberate change to that statement. Anything not named here or in the
 * target's credential set does not reach the child.
 */
export const BASE_ENV_PASSTHROUGH: ReadonlyArray<string> = [
	// Finding programs and the operator's own dotfiles (git, node-pty, delegated agents).
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	// Locale and terminal.
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TZ",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CI",
	// Network path to the target. A proxy URL with a password is redacted whole.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	// Windows process plumbing; inert elsewhere.
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"PROGRAMFILES",
	"WINDIR",
];

const AWS_SDK_ENV: ReadonlyArray<string> = [
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
];

const GOOGLE_ADC_ENV: ReadonlyArray<string> = [
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
];

/**
 * Credential variables whose value is a selector, not a secret: a profile
 * name, a region, a project id, a path to a file. They are handed to the run
 * because the SDK needs them, and they are kept out of the redaction set
 * because replacing a value like `default` or `us-east-1` everywhere would
 * corrupt the very output an operator reads a failed run from.
 */
const NON_SECRET_ENV: ReadonlySet<string> = new Set([
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
]);

/** Environment variable names a stored key value refers to, per the binary's config-value resolver. */
function storedKeyEnvRefs(key: string): string[] {
	const trimmed = key.trim();
	if (trimmed.startsWith("!")) return [];
	const names: string[] = [];
	if (ENV_NAME.test(trimmed)) names.push(trimmed);
	for (const match of trimmed.matchAll(/\$(\w+)|\$\{([^}]+)\}/gu)) names.push((match[1] ?? match[2]) as string);
	return names;
}

/**
 * The credential variables this target's auth resolution would consult, in
 * the binary's own order: explicit env var, the provider's conventional names
 * when nothing is stored, SDK families, references from a stored key, and
 * whatever the operator passed by name. Only names set in this process count.
 */
export function authEnvNamesFor(
	target: TargetDescriptor,
	runtime: RuntimeBootMetadata | null,
	stored: AuthCredential | null,
	passEnv: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const providerId = credentialProviderId(target, runtime);
	const names: string[] = [];
	const explicit = target.auth?.apiKeyEnvVar ?? runtime?.credentialsEnvVar;
	if (explicit) names.push(explicit);
	if (!stored && !(explicit && env[explicit])) {
		const defined: Record<string, string> = {};
		for (const [name, value] of Object.entries(env)) if (typeof value === "string") defined[name] = value;
		names.push(...(findEngineEnvKeys(providerId, defined) ?? []));
	}
	if (runtime?.auth === "aws-sdk") names.push(...AWS_SDK_ENV);
	if (runtime?.auth === "vertex-adc") names.push(...GOOGLE_ADC_ENV);
	if (stored?.type === "api_key") names.push(...storedKeyEnvRefs(stored.key));
	names.push(...passEnv);
	return [...new Set(names)].filter((name) => typeof env[name] === "string" && (env[name] as string).length > 0);
}

function headerValues(target: TargetDescriptor): string[] {
	return Object.values(target.auth?.headers ?? {}).filter((value): value is string => typeof value === "string");
}

/** A proxy URL whose userinfo carries a password. */
function proxyCarriesCredentials(name: string, value: string): boolean {
	if (!/proxy$/iu.test(name)) return false;
	try {
		const url = new URL(value);
		return url.username.length > 0 || url.password.length > 0;
	} catch {
		return /\/\/[^/@]+@/u.test(value);
	}
}

/** Blank every `targets[].auth.headers` value in a settings file. Returns whether anything changed. */
function scrubSettingsHeaders(settingsPath: string): boolean {
	if (!existsSync(settingsPath)) return false;
	const parsed = parse(readFileSync(settingsPath, "utf8")) as { targets?: TargetDescriptor[] } | null;
	if (!isRecord(parsed) || !Array.isArray(parsed.targets)) return false;
	let changed = false;
	for (const target of parsed.targets) {
		const headers = isRecord(target) && isRecord(target.auth) ? target.auth.headers : undefined;
		if (!isRecord(headers)) continue;
		for (const name of Object.keys(headers)) {
			if (headers[name] === REDACTED) continue;
			headers[name] = REDACTED;
			changed = true;
		}
	}
	if (changed) {
		writeFileSync(settingsPath, stringify(parsed), { encoding: "utf8", mode: 0o600 });
		chmodSync(settingsPath, 0o600);
	}
	return changed;
}

/** Remove every secret a home holds on disk. Throws only after trying all of them. */
function scrubHomeSecrets(dir: string): void {
	const configDir = join(dir, "config");
	const failures: string[] = [];
	try {
		rmSync(join(configDir, "credentials.yaml"), { force: true });
	} catch (error) {
		failures.push(`credentials.yaml: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		scrubSettingsHeaders(join(configDir, "settings.yaml"));
	} catch (error) {
		failures.push(`settings.yaml headers: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (failures.length > 0) throw new Error(`could not remove secrets under ${dir}: ${failures.join("; ")}`);
}

export function readLease(dir: string): LiveLease | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, LEASE_FILE), "utf8"));
		if (!isRecord(parsed) || parsed.version !== 1) return null;
		if (typeof parsed.expiresAt !== "string" || typeof parsed.root !== "string") return null;
		return parsed as unknown as LiveLease;
	} catch {
		return null;
	}
}

/**
 * Whether `dir` is a tree this module made, checked immediately before a
 * recursive delete. Same shape of guard as tests/harness/tmp-root.ts: our
 * prefix, a real directory and not a symlink, a lease file that is a real
 * file and parses, and a location this process can vouch for.
 *
 * Location is the part that has to be got right, because everything inside
 * the candidate is writable by whoever owns the candidate. `lease.root` is
 * therefore not consulted: the lease sits inside the tree it describes, so
 * believing it would let a forged `clio-live-*` directory name its own parent
 * and authorize its own recursive deletion. The two accepted forms are both
 * derived from this process's environment instead:
 *
 *   (a) the candidate's parent is the current resolved os.tmpdir(). The
 *       ordinary case: a driver or `--release` run from a normal shell.
 *   (b) the current resolved os.tmpdir() is the candidate's own `tmp/`. The
 *       sourced case: a shell or pane running inside the home, whose TMPDIR
 *       the home itself set. That names exactly one candidate and cannot be
 *       claimed by a tree the environment does not already point into.
 *
 * A path that fails any check is left alone: leaking one directory is
 * recoverable and deleting the wrong tree is not.
 */
export function isLiveHomeDir(dir: string): boolean {
	if (typeof dir !== "string" || dir.length === 0) return false;
	const path = resolve(dir);
	if (!basename(path).startsWith(LIVE_HOME_PREFIX)) return false;
	const stats = lstatSync(path, { throwIfNoEntry: false });
	if (!stats?.isDirectory()) return false;
	if (!lstatSync(join(path, LEASE_FILE), { throwIfNoEntry: false })?.isFile()) return false;
	if (!readLease(path)) return false;
	const temp = resolve(tmpdir());
	return dirname(path) === temp || temp === join(path, "tmp");
}

/**
 * Scrub and remove one live home now. Refuses anything that is not one, and
 * works both from a normal shell and from a shell the home's own TMPDIR
 * points into (see isLiveHomeDir).
 */
export function releaseLiveHome(dir: string): void {
	if (!isLiveHomeDir(dir))
		throw new LiveUsageError(
			`${dir} is not a live scratch home this process can vouch for: it must be named ${LIVE_HOME_PREFIX}*, ` +
				`be a real directory holding a readable ${LEASE_FILE}, and sit directly in ${resolve(tmpdir())} ` +
				"(or be the home that TMPDIR already points into)",
		);
	const path = resolve(dir);
	scrubHomeSecrets(path);
	rmSync(path, { recursive: true, force: true });
}

/** Remove every live home whose lease has expired. Returns the paths removed. */
export function sweepExpiredLiveHomes(now: number = Date.now()): string[] {
	const root = resolve(tmpdir());
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		if (!name.startsWith(LIVE_HOME_PREFIX)) continue;
		const path = join(root, name);
		if (!isLiveHomeDir(path)) continue;
		const lease = readLease(path);
		if (!lease) continue;
		const expiresAt = Date.parse(lease.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
		try {
			scrubHomeSecrets(path);
			rmSync(path, { recursive: true, force: true });
			removed.push(path);
		} catch (error) {
			process.stderr.write(
				`live: could not remove expired home ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
	return removed;
}

/**
 * A process whose CLIO_CODER_HOME is a live home is running inside one (an
 * old-style sourced shell, or a pane). Starting a driver there would read the
 * scratch settings as the operator's and nest a home inside a home.
 */
function refuseNestedLiveHome(): void {
	const current = process.env.CLIO_CODER_HOME?.trim();
	if (current && existsSync(join(current, LEASE_FILE))) {
		throw new LiveUsageError(
			`this shell is inside the live home ${current}; open a fresh shell, or release it with \`npm run -s live:home -- --release ${JSON.stringify(current)}\``,
		);
	}
}

/**
 * The launcher a `live:home` tree carries. It rebuilds the run's environment
 * from a list of names at start, reading values from whatever shell runs it,
 * so no secret is written to disk or to shell history, and nothing outside
 * that list reaches Clio. It refuses to start once the lease has expired.
 */
function launcherScript(dir: string, fixed: Record<string, string>, passthrough: ReadonlyArray<string>): string {
	return `#!/usr/bin/env node
// Generated by live:home for ${dir}.
// Starts the built Clio with only this home's environment. The variables named
// in PASSTHROUGH are read from the shell that runs this script, at start;
// everything else in that shell's environment stays out. FIXED is the home.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";

const HOME_DIR = ${JSON.stringify(dir)};
const NODE = ${JSON.stringify(process.execPath)};
const ENTRY = ${JSON.stringify(CLI_ENTRY)};
const PASSTHROUGH = ${JSON.stringify([...passthrough, "TERM"])};
const FIXED = ${JSON.stringify(fixed)};

let lease;
try {
	lease = JSON.parse(readFileSync(\`\${HOME_DIR}/${LEASE_FILE}\`, "utf8"));
} catch {
	lease = null;
}
if (!lease || Date.parse(lease.expiresAt) <= Date.now()) {
	process.stderr.write(\`live home \${HOME_DIR} has no valid lease or it has expired; release it and make a new one\\n\`);
	process.exit(2);
}

const env = {};
for (const name of PASSTHROUGH) if (process.env[name] !== undefined) env[name] = process.env[name];
Object.assign(env, FIXED);
env.TERM ??= "xterm-256color";

const child = spawn(NODE, [ENTRY, ...process.argv.slice(2)], { stdio: "inherit", env });
// Ctrl-C reaches Clio through the terminal; this wrapper only waits for it.
process.on("SIGINT", () => {});
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
});
`;
}

/** Homes a driver currently has open; scrubbed on exit and on a terminating signal. */
const activeHomes = new Set<LiveHome>();

function scrubActiveHomes(): void {
	for (const home of activeHomes) {
		try {
			home.scrubSecrets();
		} catch (error) {
			process.stderr.write(`live: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
}

process.on("exit", scrubActiveHomes);

export function prepareLiveHome(args: LiveArgs, options: LiveHomeOptions): LiveHome {
	if (!options.prefix.startsWith(LIVE_HOME_PREFIX)) {
		throw new Error(`live home prefix must start with ${LIVE_HOME_PREFIX}; got ${options.prefix}`);
	}
	refuseNestedLiveHome();
	const target = operatorTarget(args.target);
	const model = args.model ?? target.defaultModel ?? null;
	if (!model) throw new LiveUsageError(`target "${target.id}" has no defaultModel; pass --model <wireId>`);
	const keyEnvVar = target.auth?.apiKeyEnvVar;
	if (keyEnvVar && !process.env[keyEnvVar]) {
		throw new LiveUsageError(`target "${target.id}" reads its key from ${keyEnvVar}, which is not set`);
	}
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	const providerId = credentialProviderId(target, runtime);
	const operatorConfig = resolveClioDirs().config;
	const stored = readCredentialEntry(join(operatorConfig, "credentials.yaml"), providerId);
	// Env names come from the stored *reference* (`MY_VAR`, `${MY_VAR}`), so they
	// are read before a `!command` reference is replaced by its output below.
	// Otherwise the output itself would be scanned for variable names.
	const authEnvNames = authEnvNamesFor(target, runtime, stored, args.passEnv);
	// The value a stored key stands for, through the product's resolver: an env
	// name, a $VAR expansion, or a !command's output. Known to the redactor
	// either way; a command is replaced by its output so the run never runs it.
	let copied = stored;
	let storedKeyValue: string | undefined;
	if (stored?.type === "api_key") {
		storedKeyValue = resolveStoredApiKey(stored.key, providerId);
		if (stored.key.trim().startsWith("!")) {
			if (!storedKeyValue) {
				throw new LiveUsageError(`stored key for "${providerId}" is a command that produced no output; cannot copy it`);
			}
			copied = { ...stored, key: storedKeyValue };
		}
	}

	for (const removed of sweepExpiredLiveHomes()) process.stderr.write(`live: removed expired scratch home ${removed}\n`);

	const root = resolve(tmpdir());
	const dir = mkdtempSync(join(root, options.prefix));
	try {
		chmodSync(dir, 0o700);
		const clioEnv = scratchClioEnvVars(dir, { requireHomePrefix: true });
		const configDir = clioEnv.CLIO_CODER_CONFIG_DIR as string;
		const dataDir = clioEnv.CLIO_CODER_DATA_DIR as string;
		const stateDir = clioEnv.CLIO_CODER_STATE_DIR as string;
		const cacheDir = clioEnv.CLIO_CODER_CACHE_DIR as string;
		const tmpDir = join(dir, "tmp");
		const workspace = join(dir, "workspace");
		for (const path of [configDir, dataDir, stateDir, cacheDir, tmpDir, workspace]) {
			mkdirSync(path, { recursive: true, mode: 0o700 });
		}

		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [structuredClone(target)];
		settings.orchestrator = { target: target.id, model, thinkingLevel: args.thinking };
		settings.workers.default = { target: target.id, model, thinkingLevel: args.thinking };
		if (options.autonomy) settings.autonomy = options.autonomy;
		options.settings?.(settings);
		const settingsPath = join(configDir, "settings.yaml");
		writeFileSync(settingsPath, stringify(settings), { encoding: "utf8", mode: 0o600 });
		chmodSync(settingsPath, 0o600);

		const copiedCredentials = join(configDir, "credentials.yaml");
		if (copied) {
			writeFileSync(copiedCredentials, stringify({ version: 2, entries: { [providerId]: copied } }), {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(copiedCredentials, 0o600);
		}

		const fixed: Record<string, string> = {
			...(clioEnv as Record<string, string>),
			TMPDIR: tmpDir,
			TEMP: tmpDir,
			TMP: tmpDir,
		};
		const env: NodeJS.ProcessEnv = {};
		for (const name of [...BASE_ENV_PASSTHROUGH, ...authEnvNames]) {
			const value = process.env[name];
			if (value !== undefined) env[name] = value;
		}
		Object.assign(env, fixed, { TERM: "xterm-256color" });

		const secrets = new Set<string>();
		for (const name of authEnvNames) {
			if (!NON_SECRET_ENV.has(name)) secrets.add(process.env[name] as string);
		}
		for (const name of BASE_ENV_PASSTHROUGH) {
			const value = process.env[name];
			if (value && proxyCarriesCredentials(name, value)) secrets.add(value);
		}
		if (stored?.type === "api_key") {
			secrets.add(stored.key);
			if (storedKeyValue) secrets.add(storedKeyValue);
		}
		if (stored?.type === "oauth") {
			secrets.add(stored.access);
			secrets.add(stored.refresh);
		}
		for (const value of headerValues(target)) secrets.add(value);
		// Longest first so a secret that contains another is replaced whole.
		const redactable = [...secrets].filter((value) => value.length > 4).sort((a, b) => b.length - a.length);

		const createdAt = new Date();
		const lease: LiveLease = {
			version: 1,
			driver: options.prefix,
			target: target.id,
			pid: process.pid,
			root,
			createdAt: createdAt.toISOString(),
			expiresAt: new Date(createdAt.getTime() + args.leaseMs).toISOString(),
			retainsSecrets: options.retainSecrets === true,
		};
		writeFileSync(join(dir, LEASE_FILE), `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

		let launcher: string | null = null;
		if (options.launcher) {
			const script = join(dir, LAUNCHER_SCRIPT);
			writeFileSync(script, launcherScript(dir, fixed, [...BASE_ENV_PASSTHROUGH, ...authEnvNames]), {
				encoding: "utf8",
				mode: 0o700,
			});
			launcher = join(dir, LAUNCHER_SHIM);
			writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
				encoding: "utf8",
				mode: 0o700,
			});
			chmodSync(launcher, 0o700);
		}

		const home: LiveHome = {
			dir,
			configDir,
			dataDir,
			stateDir,
			cacheDir,
			workspace,
			env,
			target,
			model,
			thinking: args.thinking,
			lease,
			authEnvNames,
			launcher,
			redact(text) {
				let out = text;
				for (const secret of redactable) out = out.split(secret).join(REDACTED);
				return out;
			},
			scrubSecrets() {
				scrubHomeSecrets(dir);
			},
			cleanup(passed) {
				activeHomes.delete(home);
				let scrubError: Error | null = null;
				try {
					scrubHomeSecrets(dir);
				} catch (error) {
					scrubError = error instanceof Error ? error : new Error(String(error));
				}
				// A tree whose secrets cannot be removed is not retained for any reason.
				if (scrubError || (passed && !args.keep)) {
					rmSync(dir, { recursive: true, force: true });
					if (scrubError && existsSync(dir)) throw scrubError;
					if (scrubError) process.stderr.write(`live: ${scrubError.message}; removed the tree instead\n`);
					return;
				}
				process.stderr.write(
					`${passed ? "kept" : "failed; retained"} scratch tree at ${dir} (secrets removed; lease expires ${lease.expiresAt})\n`,
				);
			},
		};
		return home;
	} catch (error) {
		// Nothing credential-bearing outlives a setup that did not finish.
		try {
			scrubHomeSecrets(dir);
		} catch {
			// The recursive removal below is the stronger step.
		}
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The driver shape: prepare the home, run the body, clean up. Cleanup is in
 * place before the body's first line, so a body that throws, a PTY that will
 * not die, or a signal that lands mid-run all still remove the secrets. The
 * body's boolean is the pass/fail verdict and decides whether the tree stays.
 */
export async function withLiveHome(
	args: LiveArgs,
	options: LiveHomeOptions,
	body: (home: LiveHome) => Promise<boolean>,
): Promise<boolean> {
	const home = prepareLiveHome(args, options);
	activeHomes.add(home);
	let passed = false;
	try {
		passed = await body(home);
	} finally {
		home.cleanup(passed);
	}
	return passed;
}

/** Run the built binary inside the scratch home, in its workspace unless told otherwise. Rejects on timeout. */
export function clio(
	home: LiveHome,
	args: ReadonlyArray<string>,
	options: Omit<RunOptions, "env" | "replaceEnv"> = {},
): Promise<RunResult> {
	return runCli(args, { cwd: home.workspace, ...options, env: home.env, replaceEnv: true });
}

export interface SettledRun extends RunResult {
	/** The child was killed at the timeout; stdout and stderr hold what it wrote before that. */
	timedOut: boolean;
}

/**
 * Resolve a run whether it finished or hit its timeout. A timeout keeps the
 * partial output, which for a `run --json` turn is the JSONL stream that says
 * how far the lifecycle got. Any other failure still rejects.
 */
export async function settleRun(run: Promise<RunResult>): Promise<SettledRun> {
	try {
		return { ...(await run), timedOut: false };
	} catch (error) {
		if (error instanceof RunCliTimeoutError) {
			return { code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr, timedOut: true };
		}
		throw error;
	}
}

const TERMINATING_SIGNALS: ReadonlyArray<[NodeJS.Signals, number]> = [
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
];

/**
 * Standard driver entry: usage on error, exit 2 for usage, 1 for a failed run.
 *
 * A terminating signal kills every process group the harness has in flight,
 * removes the secrets from every open home, and exits with the conventional
 * code. A PTY child is not in one of those groups; it gets SIGHUP when this
 * process exits and its master side closes. SIGKILL runs none of this; the
 * lease sweep on the next driver start is the backstop for that.
 */
export async function runDriver(usage: string, body: () => Promise<boolean>): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		process.stdout.write(usage);
		return;
	}
	for (const [signal, code] of TERMINATING_SIGNALS) {
		process.once(signal, () => {
			const groups = killLiveProcessGroups();
			scrubActiveHomes();
			process.stderr.write(
				`\n${signal}: killed ${groups} process group(s), removed secrets from ${activeHomes.size} home(s)\n`,
			);
			process.exit(code);
		});
	}
	try {
		process.exitCode = (await body()) ? 0 : 1;
	} catch (error) {
		if (error instanceof LiveUsageError) {
			process.stderr.write(`error: ${error.message}\n\n${usage}`);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
}
