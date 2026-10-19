import { mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { InternalGitOperation, InternalGitPolicy } from "../../core/internal-git.js";
import {
	createGitHooksFingerprinter,
	type GitHookChange,
	gitHookEntryId,
} from "../../core/sandbox/git-hooks-fingerprint.js";
import type { AutonomyLevel } from "./autonomy.js";
import {
	createGitHookDriftGuard,
	describeGitHookChange,
	type GitHookDriftGuard,
	type GitHookDriftReport,
} from "./hook-drift.js";

/**
 * How git that Clio runs itself (src/core/internal-git.ts) meets hook drift.
 * A task worktree's `git worktree add`, the merge that lands a worker's
 * result and the ref updates around them run in Clio's own process, outside
 * any sandbox, so a hook or an executable config value planted during the
 * session would run with the operator's privileges on Clio's next internal
 * operation, without any tool call for the drift guard's ask to stop.
 *
 * Before such an operation the policy checks the session's drift guard, and
 * for a repository outside the workspace a guard of its own whose baseline is
 * the first operation there. Without drift the operation runs as the
 * repository configures it. After drift at autonomy `default` it runs with
 * hooks off (core.hooksPath at an empty directory) and every changed
 * executable config key set to a value that runs nothing, and the transcript
 * and the exit summary name the operation and the changes. At `yolo` it runs
 * as configured and the exit summary still records the drift.
 */

/**
 * How an internal operation ran after drift: a mutation with hooks off and
 * the changed config overridden, a read with the changed config overridden,
 * a read skipped because a changed key cannot be overridden, or a mutation
 * under yolo, as configured.
 */
export type InternalGitOutcome = "hooks-off" | "overridden" | "skipped" | "yolo";

/** The operation label of Clio's read-only git (status, diff, ls-files, hash-object) after config drift. */
export const INTERNAL_GIT_READS = "read-only git";

/** What one internal operation met: reported once per operation and set of changes. */
export interface InternalGitDriftRecord {
	operation: string;
	repository: string;
	/** True unless it ran as configured under yolo. */
	hardened: boolean;
	outcome: InternalGitOutcome;
	changes: ReadonlyArray<GitHookChange>;
	/** Changed config keys no command-line value turns off. */
	unneutralized: ReadonlyArray<string>;
	/**
	 * True for the first operation that met this set of changes, the one the
	 * transcript announces; later operations only join the exit summary.
	 */
	announce: boolean;
	message: string;
}

export interface InternalGitPolicyDeps {
	/** The workspace the session guard fingerprints. */
	workspace: string;
	guard: Pick<GitHookDriftGuard, "check" | "configDrift">;
	autonomy: () => AutonomyLevel;
	/** Directory kept empty for core.hooksPath, under Clio's own state directory. */
	emptyHooksDir: string;
	onDrift?: (record: InternalGitDriftRecord) => void;
}

/** Repositories outside the workspace that get a guard of their own. */
const OUTSIDE_GUARDS_KEPT = 8;
/** Changes a notice names before it says how many more there are. */
const NOTICE_MAX_CHANGES = 5;

/** Hooks off without the policy's directory: git looks for each hook under a path that cannot hold one. */
const UNREACHABLE_HOOKS_DIR = "/dev/null";

const GPG_DEFAULT_PROGRAMS: Readonly<Record<string, string>> = {
	openpgp: "gpg",
	x509: "gpgsm",
	ssh: "ssh-keygen",
};

function configWord(key: string, value: string): string[] {
	return ["-c", `${key}=${value}`];
}

/**
 * Pure: the `-c` words that make git run nothing for a changed executable
 * config `key`, an empty list when no operation Clio runs itself reads it,
 * or null when no command-line value turns it off. `-c` splits at the first
 * `=`, so a key whose subsection holds one cannot be named.
 */
function neutralizingConfig(key: string): string[] | null {
	if (key.includes("=")) return null;
	const first = key.indexOf(".");
	const last = key.lastIndexOf(".");
	if (first <= 0) return null;
	const section = key.slice(0, first);
	const name = key.slice(last + 1);
	const sub = first === last ? null : key.slice(first + 1, last);
	switch (section) {
		case "core":
			switch (name) {
				case "fsmonitor":
					return configWord(key, "false");
				case "sshcommand":
					return configWord(key, "ssh");
				case "pager":
					return configWord(key, "cat");
				case "editor":
					// The shell's no-op: git never waits on an editor.
					return configWord(key, ":");
				case "askpass":
				case "alternaterefscommand":
					return configWord(key, "");
				case "hookspath":
					// Hooks are already off.
					return [];
				default:
					return null;
			}
		case "sequence":
			return configWord(key, ":");
		case "filter":
			// An empty driver command is skipped, and a required filter that no longer runs must not fail the operation.
			return sub === null ? null : [...configWord(key, ""), ...configWord(`filter.${sub}.required`, "false")];
		case "merge":
			// A driver that always fails leaves a conflict, which Clio aborts, rather than a silent merge.
			return configWord(key, "false");
		case "credential":
			// An empty helper resets the helper list.
			return configWord(key, "");
		case "gpg": {
			const program = name === "program" ? (sub === null ? "gpg" : GPG_DEFAULT_PROGRAMS[sub]) : undefined;
			return [
				...(program !== undefined ? configWord(key, program) : []),
				...configWord("commit.gpgSign", "false"),
				...configWord("tag.gpgSign", "false"),
			];
		}
		case "pager":
			return configWord(key, "false");
		case "remote":
			if (name === "uploadpack") return configWord(key, "git-upload-pack");
			if (name === "receivepack") return configWord(key, "git-receive-pack");
			return null;
		case "submodule":
			return configWord(key, "checkout");
		// Read only by commands Clio never runs itself: aliases, patch output
		// (internal reads carry --no-ext-diff and --no-textconv), interactive
		// add, difftool, mergetool and commit trailers.
		case "alias":
		case "diff":
		case "interactive":
		case "difftool":
		case "mergetool":
		case "trailer":
			return [];
		default:
			return null;
	}
}

function realOrResolved(entry: string): string {
	try {
		return realpathSync(entry);
	} catch {
		return path.resolve(entry);
	}
}

function atOrBelow(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Impure: `dir`, created and emptied, or null when it cannot be. */
function emptyDirectory(dir: string): string | null {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (readdirSync(dir).length > 0) {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		return dir;
	} catch {
		return null;
	}
}

function noticeFor(record: Omit<InternalGitDriftRecord, "message" | "announce">, workspace: string): string {
	const named = record.changes.slice(0, NOTICE_MAX_CHANGES).map((change) => describeGitHookChange(change, workspace));
	const more =
		record.changes.length > NOTICE_MAX_CHANGES ? `; and ${record.changes.length - NOTICE_MAX_CHANGES} more` : "";
	const changed = `${named.join("; ")}${more}`;
	if (record.outcome === "yolo")
		return `[safety] Clio ran ${record.operation} under yolo with changed git hooks or config: ${changed}.`;
	if (record.outcome === "skipped")
		return `[safety] Clio stopped running its own status and diff probes in ${record.repository}, because executable git config changed during this session and cannot be overridden from the command line: ${changed}. They resume once the change is reverted or you approve it on the agent's next git command.`;
	if (record.outcome === "overridden")
		return `[safety] Clio's own status and diff probes in ${record.repository} now override executable git config that changed during this session: ${changed}.`;
	const kept =
		record.unneutralized.length > 0
			? ` These keys could not be overridden and still apply: ${record.unneutralized.join(", ")}.`
			: "";
	return `[safety] Clio ran ${record.operation} with hooks off and changed git config overridden, because these changed during this session: ${changed}.${kept} Review them; the agent's next git command outside the sandbox asks you first.`;
}

/** Impure: the policy, holding the session guard and the guards it makes for outside repositories. */
export function createInternalGitPolicy(deps: InternalGitPolicyDeps): InternalGitPolicy {
	const workspace = realOrResolved(deps.workspace);
	const outside = new Map<string, GitHookDriftGuard>();
	const outsideConfig = new Map<string, GitHookDriftGuard>();
	const told = new Set<string>();
	const announced = new Set<string>();

	/** A guard for a repository the session guard does not fingerprint, baselined the first time Clio runs git there. */
	const outsideGuard = (repository: string): GitHookDriftGuard | null => {
		const real = realOrResolved(repository);
		// The session guard covers the repository holding the workspace and every one nested in it.
		if (atOrBelow(workspace, real) || atOrBelow(real, workspace)) return null;
		let guard = outside.get(real);
		if (guard === undefined) {
			const fingerprinter = createGitHooksFingerprinter(real);
			guard = createGitHookDriftGuard({ workspace: real, fingerprint: () => fingerprinter.fingerprint() });
			if (outside.size >= OUTSIDE_GUARDS_KEPT) {
				const oldest = outside.keys().next().value;
				if (oldest !== undefined) outside.delete(oldest);
			}
			outside.set(real, guard);
		}
		return guard;
	};

	/**
	 * A config-only guard for reads in a repository outside the workspace,
	 * baselined at Clio's first read there without a fingerprint walk.
	 */
	const outsideConfigGuard = (repository: string): GitHookDriftGuard | null => {
		const real = realOrResolved(repository);
		if (atOrBelow(workspace, real) || atOrBelow(real, workspace)) return null;
		let guard = outsideConfig.get(real);
		if (guard === undefined) {
			const fingerprinter = createGitHooksFingerprinter(real);
			const config = (dir: string) => fingerprinter.config(dir);
			guard = createGitHookDriftGuard({
				workspace: real,
				fingerprint: () => ({ directories: [], files: config(real), capped: false }),
				config,
			});
			if (outsideConfig.size >= OUTSIDE_GUARDS_KEPT) {
				const oldest = outsideConfig.keys().next().value;
				if (oldest !== undefined) outsideConfig.delete(oldest);
			}
			outsideConfig.set(real, guard);
		}
		return guard;
	};

	/** The overrides for the changed config keys, and the keys no command-line value turns off. */
	const neutralize = (changes: ReadonlyArray<GitHookChange>): { overrides: string[]; unneutralized: string[] } => {
		const overrides: string[] = [];
		const unneutralized: string[] = [];
		for (const key of new Set(changes.flatMap((change) => (change.key === undefined ? [] : [change.key])))) {
			const words = neutralizingConfig(key);
			if (words === null) unneutralized.push(key);
			else overrides.push(...words);
		}
		return { overrides, unneutralized };
	};

	const hooksOff = (): string[] =>
		configWord("core.hooksPath", emptyDirectory(deps.emptyHooksDir) ?? UNREACHABLE_HOOKS_DIR);

	const report = (record: Omit<InternalGitDriftRecord, "message" | "announce">): void => {
		const changes = [record.outcome, ...record.changes.map((change) => `${gitHookEntryId(change)}\0${change.hash}`)].join(
			"\n",
		);
		const key = `${record.operation}\n${changes}`;
		if (told.has(key)) return;
		told.add(key);
		const announce = !announced.has(changes);
		announced.add(changes);
		try {
			deps.onDrift?.({ ...record, announce, message: noticeFor(record, deps.workspace) });
		} catch {
			// A notice sink failure never changes how the operation runs.
		}
	};

	return {
		harden(operation: InternalGitOperation) {
			let yolo = false;
			let reports: GitHookDriftReport[];
			try {
				yolo = deps.autonomy() === "yolo";
				// Yolo asks nothing, so its check neither notifies nor marks the drift reported.
				const own = deps.guard.check({ silent: yolo });
				const theirs = outsideGuard(operation.repository)?.check({ silent: true }) ?? null;
				reports = [own, theirs].filter((entry): entry is GitHookDriftReport => entry !== null);
			} catch {
				// A drift check that fails cannot clear the operation: at default it runs without hooks.
				return yolo ? [] : hooksOff();
			}
			const changes = [
				...new Map(reports.flatMap((entry) => entry.changes).map((change) => [gitHookEntryId(change), change])).values(),
			];
			if (changes.length === 0) return [];
			if (yolo) {
				report({ ...operation, hardened: false, outcome: "yolo", changes, unneutralized: [] });
				return [];
			}
			const { overrides, unneutralized } = neutralize(changes);
			report({ ...operation, hardened: true, outcome: "hooks-off", changes, unneutralized });
			return [...hooksOff(), ...overrides];
		},
		read(operation: InternalGitOperation) {
			// Yolo trusts the run; a read's check is skipped outright, so the footer pays nothing.
			if (deps.autonomy() === "yolo") return [];
			const guard = outsideConfigGuard(operation.repository) ?? deps.guard;
			const changes = guard.configDrift(operation.repository);
			if (changes.length === 0) return [];
			const { overrides, unneutralized } = neutralize(changes);
			const record = { repository: operation.repository, operation: INTERNAL_GIT_READS, hardened: true, changes };
			// A planted command no -c can reach must not run from Clio's own probes: the read is refused instead.
			if (unneutralized.length > 0) {
				report({ ...record, outcome: "skipped", unneutralized });
				return null;
			}
			report({ ...record, outcome: "overridden", unneutralized: [] });
			return overrides;
		},
	};
}
