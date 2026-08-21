import { execFileSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AI_AGENT_NAME } from "./agent-environment.js";
import { CLIO_COMMIT_TRAILERS, type CommitAttributionEvidence } from "./commit-attribution.js";
import { clioStateDir } from "./xdg.js";

/** Effective `attribution.gitCommits` for child-process seams. Internal state, not an operator override. */
export const CLIO_GIT_COMMITS_ENABLED_ENV = "CLIO_CODER_GIT_COMMITS_ENABLED";
const ASSISTED_ENV = "CLIO_CODER_COMMIT_ASSISTED";
const AUTHORED_ENV = "CLIO_CODER_COMMIT_AUTHORED";
/** Present iff this environment carries Clio's command-scope core.hooksPath pair; holds the count below it. */
const CONFIG_BASE_COUNT_ENV = "CLIO_CODER_GIT_CONFIG_BASE_COUNT";
const DEFAULT_HOOKS_EQUIVALENT_ENV = "CLIO_CODER_GIT_DEFAULT_HOOKS_EQUIVALENT";
const MANAGED_HOOK_VERSION = 2;
const DIAGNOSTIC_MAX_CHARS = 300;
const COUNT = /^(?:0|[1-9][0-9]*)$/u;
const reportedDiagnostics = new Set<string>();
/**
 * How long one repository probe (inside a work tree, effective core.hooksPath)
 * is reused for the same cwd and Git environment. Each probe costs two `git`
 * subprocesses, about 9 ms on a warm machine, and seams such as the verify
 * tool's per-file `node --check` spawn in bursts. The window is short so a
 * `git init` or a `core.hooksPath` change made during a session is seen on the
 * next spawn after it rather than for the rest of the session.
 */
const PROBE_CACHE_TTL_MS = 10_000;
const PROBE_CACHE_MAX_ENTRIES = 32;

type RepositoryProbe =
	| { kind: "outside" }
	| { kind: "custom"; hooksPath: string }
	| { kind: "default"; declaredDefaultHooksPath: string | null };

const probeCache = new Map<string, { at: number; probe: RepositoryProbe }>();
let installedHooksDirectory: string | null = null;

const PER_SPAWN_ENV_NAMES = [ASSISTED_ENV, AUTHORED_ENV, CONFIG_BASE_COUNT_ENV, DEFAULT_HOOKS_EQUIVALENT_ENV] as const;

export interface ManagedCommitAttributionOptions {
	cwd?: string;
	enabled?: boolean;
	evidence?: Readonly<CommitAttributionEvidence>;
}

export interface ManagedCommitAttributionEnvironment {
	env: NodeJS.ProcessEnv;
	/** Bounded, nonfatal reason the managed hook could not be composed. */
	diagnostic: string | null;
}

/** Report a bounded fail-open reason once without changing child command output. */
export function reportCommitAttributionDiagnostic(diagnostic: string | null): void {
	if (diagnostic === null || reportedDiagnostics.has(diagnostic)) return;
	reportedDiagnostics.add(diagnostic);
	process.stderr.write(`[clio:attribution] ${diagnostic}\n`);
}

export function setGitCommitAttributionEnabled(enabled: boolean): void {
	process.env[CLIO_GIT_COMMITS_ENABLED_ENV] = enabled ? "1" : "0";
}

export function gitCommitAttributionEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
	return source[CLIO_GIT_COMMITS_ENABLED_ENV] !== "0";
}

/** Forget cached repository probes and the installed managed hooks directory. */
export function resetGitCommitAttributionCachesForTests(): void {
	probeCache.clear();
	installedHooksDirectory = null;
}

function boundedDiagnostic(message: string): string {
	const folded = message.replace(/\s+/gu, " ").trim();
	return folded.length <= DIAGNOSTIC_MAX_CHARS ? folded : `${folded.slice(0, DIAGNOSTIC_MAX_CHARS - 3)}...`;
}

/**
 * Remove the command-scope config pair a parent Clio process installed, so a
 * nested seam starts from the operator's own GIT_CONFIG_* entries.
 */
function withoutManagedGitConfig(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...source };
	const baseRaw = env[CONFIG_BASE_COUNT_ENV];
	const currentRaw = env.GIT_CONFIG_COUNT;
	if (baseRaw !== undefined && COUNT.test(baseRaw) && currentRaw !== undefined && COUNT.test(currentRaw)) {
		const base = Number(baseRaw);
		for (let index = base; index < Number(currentRaw); index += 1) {
			Reflect.deleteProperty(env, `GIT_CONFIG_KEY_${index}`);
			Reflect.deleteProperty(env, `GIT_CONFIG_VALUE_${index}`);
		}
		if (base === 0) Reflect.deleteProperty(env, "GIT_CONFIG_COUNT");
		else env.GIT_CONFIG_COUNT = String(base);
	}
	for (const name of PER_SPAWN_ENV_NAMES) Reflect.deleteProperty(env, name);
	return env;
}

function gitOutput(cwd: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", [...args], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Every hook name Git resolves through core.hooksPath. Pointing core.hooksPath
 * at the managed directory would otherwise silently disable each repository
 * hook that is not prepare-commit-msg, so each name gets a chaining wrapper.
 */
const MANAGED_HOOK_NAMES = [
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
	"pre-commit",
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
	"pre-rebase",
	"post-checkout",
	"post-merge",
	"pre-push",
	"pre-receive",
	"update",
	"proc-receive",
	"post-receive",
	"post-update",
	"reference-transaction",
	"push-to-checkout",
	"pre-auto-gc",
	"post-rewrite",
	"sendemail-validate",
	"post-index-change",
] as const;

/**
 * One script serves every hook name. It restores the Git configuration the
 * command would have had without Clio, chains the repository's own hook of the
 * same name with the original exit status, and, for prepare-commit-msg only,
 * appends the assistance and authorship trailers this spawn was given.
 *
 * Testing, review, and receipt trailers never cross the environment. The fleet
 * seam writes them into the message in process from coordinator-owned facts;
 * an environment channel could be forged by exporting a variable before
 * `git commit`.
 */
const MANAGED_HOOK_SCRIPT = `#!/bin/sh
# Clio Coder managed Git hook v${MANAGED_HOOK_VERSION}. Selected only through
# command-scope configuration in Clio child-process environments.

hook_name=$(basename "$0")

base_count=$${CONFIG_BASE_COUNT_ENV}
case "$base_count" in
  '' | *[!0-9]*)
    printf '%s\\n' '[clio:attribution] invalid managed hook environment' >&2
    exit 0
    ;;
  0) unset GIT_CONFIG_COUNT ;;
  *)
    GIT_CONFIG_COUNT=$base_count
    export GIT_CONFIG_COUNT
    ;;
esac

# Resolve the current repository's default hooks directory before interpreting
# the environment prepared for the originating repository. A command may have
# moved into a different repository in between; an explicit default path is
# composable only while it still names this same repository's default.
common_dir=$(git rev-parse --git-common-dir 2>/dev/null || true)
common_dir_absolute=$(cd "$common_dir" 2>/dev/null && pwd -P || true)
case "$common_dir_absolute" in
  '') default_hooks_directory=; default_hook= ;;
  *) default_hooks_directory=$common_dir_absolute/hooks; default_hook=$default_hooks_directory/$hook_name ;;
esac

if git config --get core.hooksPath >/dev/null 2>&1 &&
   [ "$${DEFAULT_HOOKS_EQUIVALENT_ENV}" != "$default_hooks_directory" ]; then
	custom_hooks=$(git config --path --get core.hooksPath 2>/dev/null || true)
  case "$custom_hooks" in
    '') ;;
    /*) custom_hook=$custom_hooks/$hook_name ;;
    *) custom_hook=$PWD/$custom_hooks/$hook_name ;;
  esac
  if [ -n "$custom_hooks" ] && [ -x "$custom_hook" ]; then exec "$custom_hook" "$@"; fi
	exit 0
fi

if [ "$hook_name" != 'prepare-commit-msg' ]; then
  if [ -n "$default_hook" ] && [ -x "$default_hook" ]; then exec "$default_hook" "$@"; fi
  exit 0
fi

message_file=$1
message_source=$2

if [ -n "$default_hook" ] && [ -x "$default_hook" ]; then
  "$default_hook" "$@" || exit $?
fi

# The repository's own hook semantics are settled. Everything below is
# fail-open and applies only to Clio-spawned commits with attribution enabled.
if [ "$AI_AGENT" != '${AI_AGENT_NAME}' ] || [ "$${CLIO_GIT_COMMITS_ENABLED_ENV}" != '1' ]; then exit 0; fi

# Only a message supplied up front (-m, -F, or a merge) is attributed. --amend,
# -c/-C, squash, and template sources reuse or lack a real message, and an
# editor session starts from an all-comment template where added trailers
# would turn an abandoned editor into a commit whose whole message is trailers.
case "$message_source" in message|merge) ;; *) exit 0 ;; esac
for marker in CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge sequencer; do
  marker_path=$(git rev-parse --git-path "$marker" 2>/dev/null || true)
  if [ -n "$marker_path" ] && [ -e "$marker_path" ]; then exit 0; fi
done

# Case-insensitive presence check on the whole message, so a human-written
# variant of a Clio trailer is respected rather than duplicated.
has_trailer() {
  awk -v wanted="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    { line=$0; gsub(/[ \\t]+/, " ", line); sub(/ $/, "", line); if (tolower(line) == wanted) found=1 }
    END { exit found ? 0 : 1 }' "$message_file"
}

append_trailer() {
  if has_trailer "$1"; then return 0; fi
  git interpret-trailers --in-place --if-exists=addIfDifferent --trailer "$1" "$message_file" ||
    printf '%s\\n' '[clio:attribution] git interpret-trailers failed; commit left as written' >&2
}

if [ "$${ASSISTED_ENV}" = '1' ] || [ "$${AUTHORED_ENV}" = '1' ]; then
  append_trailer '${CLIO_COMMIT_TRAILERS.assisted}'
fi
if [ "$${AUTHORED_ENV}" = '1' ]; then append_trailer '${CLIO_COMMIT_TRAILERS.coAuthored}'; fi
exit 0
`;

function installManagedHook(directory: string, name: string): void {
	const hook = join(directory, name);
	try {
		if (existsSync(hook) && readFileSync(hook, "utf8") === MANAGED_HOOK_SCRIPT) {
			chmodSync(hook, 0o755);
			return;
		}
	} catch {
		// Unreadable content is replaced below; the path is Clio-owned.
	}
	const temporary = `${hook}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temporary, MANAGED_HOOK_SCRIPT, { encoding: "utf8", mode: 0o755 });
		renameSync(temporary, hook);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function managedHooksDirectoryIsIntact(directory: string): boolean {
	try {
		for (const name of MANAGED_HOOK_NAMES) {
			const hook = join(directory, name);
			if (readFileSync(hook, "utf8") !== MANAGED_HOOK_SCRIPT) return false;
			accessSync(hook, fsConstants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

function managedHooksDirectory(): string {
	const directory = join(clioStateDir(), "git-hooks", `v${MANAGED_HOOK_VERSION}`);
	if (installedHooksDirectory === directory && managedHooksDirectoryIsIntact(directory)) return directory;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const name of MANAGED_HOOK_NAMES) installManagedHook(directory, name);
	installedHooksDirectory = directory;
	return directory;
}

/** The environment entries that change what `git` resolves for a cwd. */
function gitEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
	const parts: string[] = [];
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_") || key === "HOME" || key === "XDG_CONFIG_HOME") parts.push(`${key}=${env[key] ?? ""}`);
	}
	return parts.sort().join("\0");
}

function probeRepositoryUncached(cwd: string, env: NodeJS.ProcessEnv): RepositoryProbe {
	if (gitOutput(cwd, env, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { kind: "outside" };
	const customHooksPath = gitOutput(cwd, env, ["config", "--path", "--get", "core.hooksPath"]);
	if (customHooksPath === null) return { kind: "default", declaredDefaultHooksPath: null };
	const commonDirectory = gitOutput(cwd, env, ["rev-parse", "--git-common-dir"]);
	const defaultHooksPath = commonDirectory === null ? null : resolve(cwd, commonDirectory, "hooks");
	if (customHooksPath.length === 0 || resolve(cwd, customHooksPath) !== defaultHooksPath) {
		return { kind: "custom", hooksPath: customHooksPath };
	}
	return { kind: "default", declaredDefaultHooksPath: defaultHooksPath };
}

function probeRepository(cwd: string, env: NodeJS.ProcessEnv, now = Date.now()): RepositoryProbe {
	const key = `${cwd}\0${gitEnvironmentFingerprint(env)}`;
	const cached = probeCache.get(key);
	if (cached !== undefined && now - cached.at < PROBE_CACHE_TTL_MS && now >= cached.at) return cached.probe;
	const probe = probeRepositoryUncached(cwd, env);
	if (cached === undefined && probeCache.size >= PROBE_CACHE_MAX_ENTRIES) {
		const oldest = probeCache.keys().next().value;
		if (oldest !== undefined) probeCache.delete(oldest);
	}
	probeCache.delete(key);
	probeCache.set(key, { at: now, probe });
	return probe;
}

/**
 * Build a child environment that selects Clio's managed hooks directory through
 * command-scope Git configuration. Repository and user configuration are never
 * written. An effective core.hooksPath that is not the repository's default
 * hooks directory is left alone: attribution fails open with a diagnostic.
 *
 * The repository probe behind this is cached per cwd and Git environment for
 * `PROBE_CACHE_TTL_MS`, and the managed hooks directory is installed once per
 * process, so a burst of spawns pays the git subprocesses once.
 */
export function withManagedGitCommitAttributionEnvironment(
	source: NodeJS.ProcessEnv,
	options: ManagedCommitAttributionOptions = {},
): ManagedCommitAttributionEnvironment {
	const env = withoutManagedGitConfig(source);
	env.AI_AGENT = AI_AGENT_NAME;
	const enabled = options.enabled ?? gitCommitAttributionEnabled(source);
	env[CLIO_GIT_COMMITS_ENABLED_ENV] = enabled ? "1" : "0";
	if (!enabled) return { env, diagnostic: null };

	const evidence = options.evidence ?? { materiallyAssisted: true, materiallyAuthored: true };
	env[ASSISTED_ENV] = evidence.materiallyAssisted === true ? "1" : "0";
	env[AUTHORED_ENV] = evidence.materiallyAuthored === true ? "1" : "0";

	const countRaw = env.GIT_CONFIG_COUNT;
	const count = countRaw === undefined ? 0 : COUNT.test(countRaw) ? Number(countRaw) : Number.NaN;
	if (!Number.isSafeInteger(count) || count > 1_024) {
		return { env, diagnostic: boundedDiagnostic("GIT_CONFIG_COUNT is invalid; Clio commit attribution skipped") };
	}
	const cwd = resolve(options.cwd ?? process.cwd());
	const probe = probeRepository(cwd, env);
	if (probe.kind === "outside") return { env, diagnostic: null };
	if (probe.kind === "custom") {
		return {
			env,
			diagnostic: boundedDiagnostic(`core.hooksPath is set to '${probe.hooksPath}'; Clio commit attribution skipped`),
		};
	}
	if (probe.declaredDefaultHooksPath !== null) {
		env[DEFAULT_HOOKS_EQUIVALENT_ENV] = probe.declaredDefaultHooksPath;
	}

	let hooksDirectory: string;
	try {
		hooksDirectory = managedHooksDirectory();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			env,
			diagnostic: boundedDiagnostic(`managed hooks unavailable; Clio commit attribution skipped (${reason})`),
		};
	}
	env[CONFIG_BASE_COUNT_ENV] = String(count);
	env.GIT_CONFIG_COUNT = String(count + 1);
	env[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
	env[`GIT_CONFIG_VALUE_${count}`] = hooksDirectory;
	return { env, diagnostic: null };
}
