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
import { delimiter, join, resolve } from "node:path";
import { AI_AGENT_NAME } from "./agent-environment.js";
import {
	CLIO_COMMIT_EMAIL,
	CLIO_COMMIT_NAME,
	CLIO_COMMIT_TRAILERS,
	CLIO_DECISION_TRAILER_KEY,
	type CommitAttributionEvidence,
	decisionTrailerRefs,
	humanCoAuthorTrailer,
} from "./commit-attribution.js";
import type { GitCommitAuthorSetting } from "./defaults.js";
import { writeDiagnostic } from "./diagnostics.js";
import { internalGitArgv } from "./internal-git.js";
import { clioStateDir } from "./xdg.js";

/** Effective `attribution.gitCommits` for child-process seams. Internal state, not an operator override. */
export const CLIO_GIT_COMMITS_ENABLED_ENV = "CLIO_CODER_GIT_COMMITS_ENABLED";
const ASSISTED_ENV = "CLIO_CODER_COMMIT_ASSISTED";
const AUTHORED_ENV = "CLIO_CODER_COMMIT_AUTHORED";
/** Space-separated decision refs the spawn was made under; each becomes one `Clio-Decision:` trailer. */
const DECISIONS_ENV = "CLIO_CODER_COMMIT_DECISIONS";
/** Effective `integrations.git.commitAuthor` for child-process seams. Internal state, not an operator override. */
export const CLIO_GIT_COMMIT_AUTHOR_ENV = "CLIO_CODER_GIT_COMMIT_AUTHOR";
/** Present iff this environment's GIT_AUTHOR_NAME/EMAIL name Clio because a Clio seam set them, not the operator. */
const AUTHOR_MANAGED_ENV = "CLIO_CODER_GIT_AUTHOR_MANAGED";
/** Present iff this environment carries Clio's command-scope core.hooksPath pair; holds the count below it. */
const CONFIG_BASE_COUNT_ENV = "CLIO_CODER_GIT_CONFIG_BASE_COUNT";
const DEFAULT_HOOKS_EQUIVALENT_ENV = "CLIO_CODER_GIT_DEFAULT_HOOKS_EQUIVALENT";
const MANAGED_HOOK_VERSION = 7;
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
const committerCache = new Map<string, { at: number; human: string | null }>();
let installedHooksDirectory: string | null = null;

const PER_SPAWN_ENV_NAMES = [
	ASSISTED_ENV,
	AUTHORED_ENV,
	DECISIONS_ENV,
	CONFIG_BASE_COUNT_ENV,
	DEFAULT_HOOKS_EQUIVALENT_ENV,
	AUTHOR_MANAGED_ENV,
] as const;

let decisionRefsProvider: (() => ReadonlyArray<string>) | null = null;

/**
 * Register the live decision board's active refs for the session seam. Each
 * Clio-spawned commit is then stamped with the decisions it was made under,
 * the same way `ASSISTED_ENV` carries assistance. Explicit `evidence.decisions`
 * on a spawn still wins over the provider.
 */
export function setCommitDecisionRefsProvider(provider: (() => ReadonlyArray<string>) | null): void {
	decisionRefsProvider = provider;
}

function providedDecisionRefs(): ReadonlyArray<string> {
	try {
		return decisionRefsProvider?.() ?? [];
	} catch {
		return [];
	}
}

/** Who authors a commit a seam's child process makes. */
export type GitCommitAuthor = "clio" | "human";

/**
 * Clio as the author of one commit, with the human who still commits it.
 * Only {@link resolveClioCommitAuthorship} builds one, so the human is always
 * resolvable when Clio authors.
 */
export interface ClioCommitAuthorship {
	env: { GIT_AUTHOR_NAME: string; GIT_AUTHOR_EMAIL: string };
	/** The human committer's `Name <email>`, credited with one `Co-authored-by:` trailer. */
	human: string;
}

export interface ManagedCommitAttributionOptions {
	cwd?: string;
	enabled?: boolean;
	evidence?: Readonly<CommitAttributionEvidence>;
	/**
	 * Who authors commits made under this environment. Omitted follows the
	 * process: Clio while an autonomous process or scope is active and the
	 * setting is `auto`, the human otherwise. Clio authors only through the
	 * managed hook, which credits the human, so a repository the hook cannot
	 * reach (its own core.hooksPath, or Windows) keeps the human author with no
	 * Clio trailer, and the managed git shim keeps the human author on every
	 * command that writes a commit without that hook.
	 */
	author?: GitCommitAuthor;
	/**
	 * A seam that writes the human's trailer into the message itself (a fleet
	 * commit step) passes the authorship it credited, and Clio authors even
	 * where the managed hook cannot run.
	 */
	authorship?: ClioCommitAuthorship;
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
	writeDiagnostic(`[clio-coder:attribution] ${diagnostic}\n`);
}

export function setGitCommitAttributionEnabled(enabled: boolean): void {
	process.env[CLIO_GIT_COMMITS_ENABLED_ENV] = enabled ? "1" : "0";
}

export function gitCommitAttributionEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
	return source[CLIO_GIT_COMMITS_ENABLED_ENV] !== "0";
}

export function setGitCommitAuthorSetting(setting: GitCommitAuthorSetting): void {
	process.env[CLIO_GIT_COMMIT_AUTHOR_ENV] = setting;
}

export function gitCommitAuthorSetting(source: NodeJS.ProcessEnv = process.env): GitCommitAuthorSetting {
	return source[CLIO_GIT_COMMIT_AUTHOR_ENV] === "human" ? "human" : "auto";
}

/** Apply `integrations.git` to this process's commit seams. */
export function configureGitCommitAttribution(git: {
	commitAttribution: boolean;
	commitAuthor: GitCommitAuthorSetting;
}): void {
	setGitCommitAttributionEnabled(git.commitAttribution);
	setGitCommitAuthorSetting(git.commitAuthor);
}

let autonomousProcess = false;
let autonomousScopes = 0;

/**
 * Mark this whole process as autonomous: a dispatched worker or a headless
 * `clio-coder run`. Interactive TUI, GUI and ACP sessions never are, at any
 * autonomy level. Process state, so a child process decides for itself.
 */
export function setAutonomousCommitProcess(autonomous: boolean): void {
	autonomousProcess = autonomous;
}

/**
 * Open an autonomous scope inside an interactive process, such as a scheduled
 * job's machine turn. Main-conversation turns are serial, so the scope covers
 * exactly that turn's tool calls. The returned release is idempotent.
 */
export function enterAutonomousCommitScope(): () => void {
	autonomousScopes += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		autonomousScopes = Math.max(0, autonomousScopes - 1);
	};
}

/** Who authors commits a seam spawns now: Clio for autonomous work under `auto`, else the human. */
function autonomousCommitAuthor(source: NodeJS.ProcessEnv = process.env): GitCommitAuthor {
	return (autonomousProcess || autonomousScopes > 0) && gitCommitAuthorSetting(source) === "auto" ? "clio" : "human";
}

/** Whether `env` names an author the operator or the command chose, which always wins over Clio. */
function hasChosenAuthor(env: NodeJS.ProcessEnv): boolean {
	return (env.GIT_AUTHOR_NAME ?? "").length > 0 || (env.GIT_AUTHOR_EMAIL ?? "").length > 0;
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
	// Only the author a Clio seam set is Clio's to remove; one the operator or
	// the model set afterwards is theirs and stays.
	if (env.PATH !== undefined) env.PATH = pathWithoutManagedShim(env.PATH);
	if (env[AUTHOR_MANAGED_ENV] === "1") {
		if (env.GIT_AUTHOR_NAME === CLIO_COMMIT_NAME) Reflect.deleteProperty(env, "GIT_AUTHOR_NAME");
		if (env.GIT_AUTHOR_EMAIL === CLIO_COMMIT_EMAIL) Reflect.deleteProperty(env, "GIT_AUTHOR_EMAIL");
	}
	for (const name of PER_SPAWN_ENV_NAMES) Reflect.deleteProperty(env, name);
	return env;
}

function gitOutput(cwd: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", internalGitArgv(args, cwd), {
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
 * appends the assistance and authorship trailers this spawn was given. When
 * the commit's resolved author is Clio (an autonomous commit), it instead
 * credits the human committer with one `Co-authored-by:` trailer.
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
    printf '%s\\n' '[clio-coder:attribution] invalid managed hook environment' >&2
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

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# git commit exports the author it resolved, so --author and an amended
# commit's author are seen here; git merge and git revert inherit it from the
# environment. A cherry-pick does not export the picked commit's author, which
# is why the CHERRY_PICK_HEAD state below exits before this is trusted.
author_email=$(lower "$GIT_AUTHOR_EMAIL")
clio_authored=
if [ "$author_email" = '${CLIO_COMMIT_EMAIL.toLowerCase()}' ]; then clio_authored=1; fi

if git config --get core.hooksPath >/dev/null 2>&1 &&
   [ "$${DEFAULT_HOOKS_EQUIVALENT_ENV}" != "$default_hooks_directory" ]; then
	custom_hooks=$(git config --path --get core.hooksPath 2>/dev/null || true)
  case "$custom_hooks" in
    '') ;;
    /*) custom_hook=$custom_hooks/$hook_name ;;
    *) custom_hook=$PWD/$custom_hooks/$hook_name ;;
  esac
  # The operator's hooks own this repository: Clio adds none of its own
  # trailers. A repository Clio probed with its own core.hooksPath never gets
  # Clio as author, but a command that moved into such a repository after the
  # probe still carries Clio's author, and then the human committer is
  # credited after the operator's hook succeeds so the human is never dropped.
  if [ "$hook_name" != 'prepare-commit-msg' ] || [ -z "$clio_authored" ]; then
    if [ -n "$custom_hooks" ] && [ -x "$custom_hook" ]; then exec "$custom_hook" "$@"; fi
    exit 0
  fi
  if [ -n "$custom_hooks" ] && [ -x "$custom_hook" ]; then "$custom_hook" "$@" || exit $?; fi
  operator_hooks=1
else
  operator_hooks=
  if [ "$hook_name" != 'prepare-commit-msg' ]; then
    if [ -n "$default_hook" ] && [ -x "$default_hook" ]; then exec "$default_hook" "$@"; fi
    exit 0
  fi
  if [ -n "$default_hook" ] && [ -x "$default_hook" ]; then
    "$default_hook" "$@" || exit $?
  fi
fi

message_file=$1
message_source=$2

# The repository's own hook semantics are settled. Everything below is
# fail-open and applies only to Clio-spawned commits with attribution enabled.
if [ "$AI_AGENT" != '${AI_AGENT_NAME}' ] || [ "$${CLIO_GIT_COMMITS_ENABLED_ENV}" != '1' ]; then exit 0; fi

# Only a message supplied up front (-m, -F, or a merge) is attributed. --amend,
# -c/-C, squash, and template sources reuse or lack a real message, and an
# editor session starts from an all-comment template where added trailers
# would turn an abandoned editor into a commit whose whole message is trailers.
# Clio's managed git shim keeps Clio as author only for invocations that reach
# these sources, so an editor commit stays the human's.
case "$message_source" in message|merge) ;; *) exit 0 ;; esac
git_path() { git rev-parse --git-path "$1" 2>/dev/null || true; }
# A cherry-pick or rebase commits someone else's change under that commit's
# author: no trailer of Clio's belongs on it.
for marker in CHERRY_PICK_HEAD rebase-apply rebase-merge; do
  marker_path=$(git_path "$marker")
  if [ -n "$marker_path" ] && [ -e "$marker_path" ]; then exit 0; fi
done
# A revert is authored by the current identity, so when that is Clio the human
# committer must still be credited: on a stopped revert (REVERT_HEAD) and on
# each commit of a revert range, whose sequencer todo starts with "revert".
reverting=
marker_path=$(git_path REVERT_HEAD)
if [ -n "$marker_path" ] && [ -e "$marker_path" ]; then reverting=1; fi
marker_path=$(git_path sequencer)
if [ -n "$marker_path" ] && [ -e "$marker_path" ]; then
  case "$(sed -n '1s/[[:space:]].*//p' "$marker_path/todo" 2>/dev/null)" in
    revert) reverting=1 ;;
    *) exit 0 ;;
  esac
fi
if [ -n "$reverting" ] && [ -z "$clio_authored" ]; then exit 0; fi

# Case-insensitive presence check on the whole message, so a human-written
# variant of a Clio trailer is respected rather than duplicated.
has_trailer() {
  awk -v wanted="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    { line=$0; gsub(/[ \\t]+/, " ", line); sub(/ $/, "", line); if (tolower(line) == wanted) found=1 }
    END { exit found ? 0 : 1 }' "$message_file"
}

# git merge -m writes its message without a final newline, and
# interpret-trailers then glues the first trailer under the subject.
if [ -s "$message_file" ] && [ -n "$(tail -c 1 "$message_file")" ]; then
  printf '\\n' >> "$message_file"
fi

append_trailer() {
  if has_trailer "$1"; then return 0; fi
  git interpret-trailers --in-place --if-exists=addIfDifferent --trailer "$1" "$message_file" ||
    printf '%s\\n' '[clio-coder:attribution] git interpret-trailers failed; commit left as written' >&2
}

if [ -n "$clio_authored" ]; then
  # Clio authored this commit: its own Assisted-by and Co-authored-by would be
  # redundant, and the human committer is credited instead. An unconfigured
  # identity is never guessed into a trailer.
  human=$(git -c user.useConfigOnly=true var GIT_COMMITTER_IDENT 2>/dev/null |
    sed 's/ [0-9][0-9]* [-+][0-9][0-9]*$//')
  human_email=$(lower "$(printf '%s' "$human" | sed -n 's/^.*<\\([^<>]*\\)>$/\\1/p')")
  case "$human_email" in
    '' | '${CLIO_COMMIT_EMAIL.toLowerCase()}' | 'clio-coder@iowarp.ai') ;;
    *) append_trailer "Co-authored-by: $human" ;;
  esac
  # Under the operator's own hooks or in a revert, the credit is all Clio adds.
  if [ -n "$operator_hooks" ] || [ -n "$reverting" ]; then exit 0; fi
else
  if [ "$${ASSISTED_ENV}" = '1' ] || [ "$${AUTHORED_ENV}" = '1' ]; then
    append_trailer '${CLIO_COMMIT_TRAILERS.assisted}'
  fi
  if [ "$${AUTHORED_ENV}" = '1' ]; then append_trailer '${CLIO_COMMIT_TRAILERS.coAuthored}'; fi
fi
# Decision refs are validated again here: only <id>/<key> shapes become
# trailers, so a stray value cannot inject a second line into the message.
for decision_ref in $${DECISIONS_ENV}; do
  case "$decision_ref" in
    *[!A-Za-z0-9:._/-]* | */*/* | /* | */ | *-*-) continue ;;
    */*) append_trailer "${CLIO_DECISION_TRAILER_KEY}: $decision_ref" ;;
  esac
done
exit 0
`;

/**
 * A `git` found first on PATH wherever a Clio seam made Clio the author
 * through the environment. Git applies GIT_AUTHOR_* to every command that
 * writes a commit, but the managed hook can credit the human only where
 * prepare-commit-msg runs with a message given up front: `git commit -m/-F`,
 * `git merge` (also under `git pull`) and `git revert`. Every other
 * invocation (`commit-tree`, `stash`, `notes`, an editor or template
 * `git commit`, an alias) runs with Clio's author removed, so the human stays
 * author and is never dropped. Cherry-pick, rebase and am keep the original
 * commits' authors either way. An author the operator or the model chose
 * (any other GIT_AUTHOR_* value) passes through untouched.
 */
const MANAGED_GIT_SHIM_SCRIPT = `#!/bin/sh
# Clio Coder managed git shim v${MANAGED_HOOK_VERSION}. On PATH only in Clio
# child-process environments where Clio is the commit author.

shim_directory=\${0%/*}
real_git=
saved_ifs=$IFS
set -f
IFS=:
for directory in $PATH; do
  # Skip this shim under any name (a symlink to it elsewhere on PATH) and
  # every managed shim generation, so two shims never exec each other.
  case "$directory" in '' | "$shim_directory" | */git-hooks/v*-shim) continue ;; esac
  candidate=$directory/git
  [ "$candidate" -ef "$0" ] && continue
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then real_git=$candidate; break; fi
done
IFS=$saved_ifs
set +f
if [ -z "$real_git" ]; then
  printf '%s\\n' 'clio-coder: git was not found on PATH' >&2
  exit 127
fi

if [ "$${AUTHOR_MANAGED_ENV}" = '1' ] && [ "$GIT_AUTHOR_NAME" = '${CLIO_COMMIT_NAME}' ] &&
   [ "$GIT_AUTHOR_EMAIL" = '${CLIO_COMMIT_EMAIL}' ]; then
  subcommand=
  takes_value=
  message=
  unsure=
  for argument do
    if [ -z "$subcommand" ]; then
      if [ -n "$takes_value" ]; then takes_value=; continue; fi
      case "$argument" in
        -C | -c | --git-dir | --work-tree | --namespace | --super-prefix | --config-env | --attr-source) takes_value=1 ;;
        -*) ;;
        *) subcommand=$argument ;;
      esac
      continue
    fi
    [ "$subcommand" = commit ] || break
    # Consume every option value, so a value spelled like -m is never read
    # as a message flag. Anything that may start the editor or a template,
    # or that cannot be parsed for sure, leaves the human author.
    if [ -n "$takes_value" ]; then takes_value=; continue; fi
    case "$argument" in
      --) break ;;
      --message=* | --file=*) message=1 ;;
      --message | --file) message=1; takes_value=1 ;;
      --author | --date | --cleanup | --trailer | --pathspec-from-file) takes_value=1 ;;
      --author=* | --date=* | --cleanup=* | --trailer=* | --pathspec-from-file=* | --untracked-files=* | --gpg-sign=*) ;;
      --template | --template=* | --reuse-message | --reuse-message=* | --reedit-message | --reedit-message=* | \
        --fixup | --fixup=* | --squash | --squash=* | --edit) unsure=1; break ;;
      --all | --quiet | --verbose | --amend | --no-edit | --no-verify | --verify | --allow-empty | \
        --allow-empty-message | --signoff | --no-signoff | --reset-author | --include | --only | \
        --no-post-rewrite | --status | --no-status | --untracked-files | --gpg-sign | --no-gpg-sign | \
        --pathspec-file-nul) ;;
      # Anything else, such as --no-message or an abbreviation git expands,
      # may cancel the message or start the editor.
      --*) unsure=1; break ;;
      -?*)
        cluster=\${argument#-}
        while [ -n "$cluster" ]; do
          rest=\${cluster#?}
          case "\${cluster%"$rest"}" in
            m | F) message=1; [ -n "$rest" ] || takes_value=1; break ;;
            C | c | t | e) unsure=1; break 2 ;;
            S | u) break ;;
            [a-zA-Z0-9]) ;;
            *) unsure=1; break 2 ;;
          esac
          cluster=$rest
        done
        ;;
    esac
  done
  [ -z "$takes_value" ] || unsure=1
  case "$subcommand" in
    merge | pull | revert) ;;
    commit) [ -n "$message" ] && [ -z "$unsure" ] || unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL ${AUTHOR_MANAGED_ENV} ;;
    *) unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL ${AUTHOR_MANAGED_ENV} ;;
  esac
fi
exec "$real_git" "$@"
`;

function installManagedScript(path: string, script: string): void {
	try {
		if (existsSync(path) && readFileSync(path, "utf8") === script) {
			chmodSync(path, 0o755);
			return;
		}
	} catch {
		// Unreadable content is replaced below; the path is Clio-owned.
	}
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temporary, script, { encoding: "utf8", mode: 0o755 });
		renameSync(temporary, path);
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

/** The installed hooks directory, installed on first use. */
function managedHooksDirectory(): string | null {
	const directory = join(clioStateDir(), "git-hooks", `v${MANAGED_HOOK_VERSION}`);
	if (installedHooksDirectory === directory && managedHooksDirectoryIsIntact(directory)) return directory;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const name of MANAGED_HOOK_NAMES) installManagedScript(join(directory, name), MANAGED_HOOK_SCRIPT);
	installedHooksDirectory = directory;
	return directory;
}

/** Where the managed git shim lives: a sibling of the hooks directory, so Git never reads it as a hook. */
const MANAGED_SHIM_DIRECTORY_PATTERN = /[\\/]git-hooks[\\/]v\d+-shim$/u;

/** The installed git shim's directory, installed or repaired on use. */
function managedGitShimDirectory(): string {
	const directory = join(clioStateDir(), "git-hooks", `v${MANAGED_HOOK_VERSION}-shim`);
	const shim = join(directory, "git");
	try {
		if (readFileSync(shim, "utf8") === MANAGED_GIT_SHIM_SCRIPT) {
			accessSync(shim, fsConstants.X_OK);
			return directory;
		}
	} catch {
		// Missing or damaged: installed below.
	}
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	installManagedScript(shim, MANAGED_GIT_SHIM_SCRIPT);
	return directory;
}

/**
 * `pathValue` without any managed shim directory, of this or an earlier hook
 * version. Matched by shape so stripping never resolves (and so creates) the
 * state directory. A symlink to the shim in another directory is left on
 * PATH: that directory is the operator's and holds other programs, and the
 * shim itself skips any candidate that is the same file, so it never loops.
 */
function pathWithoutManagedShim(pathValue: string): string {
	return pathValue
		.split(delimiter)
		.filter((entry) => !MANAGED_SHIM_DIRECTORY_PATTERN.test(entry))
		.join(delimiter);
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

function committerIdentUncached(cwd: string, env: NodeJS.ProcessEnv): string | null {
	// Only an identity the operator configured counts; a guessed user@host is not a person to credit.
	const raw = gitOutput(cwd, env, ["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"]);
	if (raw === null) return null;
	const human = raw.replace(/\s+\d+\s+[-+]\d{4}$/u, "");
	return humanCoAuthorTrailer(human) === null ? null : human;
}

function committerIdent(cwd: string, env: NodeJS.ProcessEnv, now = Date.now()): string | null {
	const key = `${cwd}\0${gitEnvironmentFingerprint(env)}`;
	const cached = committerCache.get(key);
	if (cached !== undefined && now - cached.at < PROBE_CACHE_TTL_MS && now >= cached.at) return cached.human;
	const human = committerIdentUncached(cwd, env);
	if (cached === undefined && committerCache.size >= PROBE_CACHE_MAX_ENTRIES) {
		const oldest = committerCache.keys().next().value;
		if (oldest !== undefined) committerCache.delete(oldest);
	}
	committerCache.delete(key);
	committerCache.set(key, { at: now, human });
	return human;
}

/**
 * Clio as the author of a commit in `cwd`, or null when the human must stay
 * the author: an author is already chosen in the environment, or no
 * configured committer identity resolves (Clio never drops the human), or
 * the committer is Clio itself. Does not consult the setting or the process
 * mode; see {@link autonomousLandAuthorship}.
 */
export function resolveClioCommitAuthorship(
	cwd: string,
	source: NodeJS.ProcessEnv = process.env,
): ClioCommitAuthorship | null {
	const env = withoutManagedGitConfig(source);
	if (hasChosenAuthor(env)) return null;
	const human = committerIdent(resolve(cwd), env);
	if (human === null) return null;
	return { env: { GIT_AUTHOR_NAME: CLIO_COMMIT_NAME, GIT_AUTHOR_EMAIL: CLIO_COMMIT_EMAIL }, human };
}

/**
 * Authorship for a commit Clio makes in process when it lands dispatched work
 * (task worktree commits and merges, `fleet land`). Those commits are
 * autonomous wherever the host runs, so only attribution being enabled and
 * the setting being `auto` are consulted.
 */
export function autonomousLandAuthorship(
	cwd: string,
	source: NodeJS.ProcessEnv = process.env,
): ClioCommitAuthorship | null {
	if (!gitCommitAttributionEnabled(source) || gitCommitAuthorSetting(source) !== "auto") return null;
	return resolveClioCommitAuthorship(cwd, source);
}

function applyClioAuthor(env: NodeJS.ProcessEnv, authorship: ClioCommitAuthorship): void {
	if (hasChosenAuthor(env)) return;
	env.GIT_AUTHOR_NAME = authorship.env.GIT_AUTHOR_NAME;
	env.GIT_AUTHOR_EMAIL = authorship.env.GIT_AUTHOR_EMAIL;
	env[AUTHOR_MANAGED_ENV] = "1";
}

/**
 * Build a child environment that selects Clio's managed hooks directory through
 * command-scope Git configuration. Repository and user configuration are never
 * written. An effective core.hooksPath that is not the repository's default
 * hooks directory is left alone: attribution fails open with a diagnostic, and
 * the commit stays plainly the human's (human author and committer, no Clio
 * trailer), because Clio never runs its hook in place of the operator's.
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
	const decisions = decisionTrailerRefs(evidence.decisions ?? providedDecisionRefs());
	if (decisions.length > 0) env[DECISIONS_ENV] = decisions.join(" ");
	if (options.authorship !== undefined) applyClioAuthor(env, options.authorship);

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

	let hooksDirectory: string | null;
	try {
		hooksDirectory = managedHooksDirectory();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			env,
			diagnostic: boundedDiagnostic(`managed hooks unavailable; Clio commit attribution skipped (${reason})`),
		};
	}
	if (hooksDirectory === null) return { env, diagnostic: null };
	env[CONFIG_BASE_COUNT_ENV] = String(count);
	env.GIT_CONFIG_COUNT = String(count + 1);
	env[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
	env[`GIT_CONFIG_VALUE_${count}`] = hooksDirectory;
	// Clio authors through the environment only with the managed git shim in
	// front of PATH, which drops that author from every command the hook cannot
	// credit the human on. Windows resolves `git` without a POSIX shim, so
	// there the human stays the author.
	if (
		options.authorship === undefined &&
		process.platform !== "win32" &&
		(options.author ?? autonomousCommitAuthor(source)) === "clio"
	) {
		const authorship = resolveClioCommitAuthorship(cwd, env);
		if (authorship !== null) {
			try {
				const shimDirectory = managedGitShimDirectory();
				applyClioAuthor(env, authorship);
				env.PATH =
					env.PATH === undefined || env.PATH.length === 0 ? shimDirectory : `${shimDirectory}${delimiter}${env.PATH}`;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return {
					env,
					diagnostic: boundedDiagnostic(`managed git shim unavailable; the human stays commit author (${reason})`),
				};
			}
		}
	}
	return { env, diagnostic: null };
}
