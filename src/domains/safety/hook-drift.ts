import { realpathSync } from "node:fs";
import path from "node:path";
import {
	diffGitHookFiles,
	type GitHookChange,
	type GitHookFile,
	type GitHooksFingerprint,
	gitHookEntryId,
} from "../../core/sandbox/git-hooks-fingerprint.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "./action-classifier.js";
import { sanitizeCallTargetText } from "./call-target.js";

/**
 * The git hook drift guard. A hook runs with the full privileges of whoever
 * runs git next, outside Clio's sandbox, and it can be planted through routes
 * no per-path rule closes: a separate git dir created mid-run, a nested
 * repository, a hooks path a contained command created, a config change made
 * outside Clio. So the guard does not ask how a hook got there. The main
 * session takes a baseline of every hook file git could run in the workspace
 * (src/core/sandbox/git-hooks-fingerprint.ts) when it starts, and before a
 * git command runs outside the sandbox at autonomy default any file added or
 * changed since then makes the call an operator-only ask under
 * `git-hooks-changed`. The operator's allow accepts exactly the files the
 * card named; an approved or judge-allowed `git-control-file` write accepts
 * the file it wrote. An executable git config value (core.fsmonitor, a
 * filter driver, an `!` alias) counts as a hook: the fingerprint carries
 * each one by its config file and key.
 */
export const GIT_HOOKS_CHANGED_RULE_ID = "git-hooks-changed";

/** Files the card names before it says how many more there are. */
const REPORT_MAX_FILES = 5;

/** One drift: the added and changed files, and what an allow accepts. */
export interface GitHookDriftReport {
	changes: ReadonlyArray<GitHookChange>;
	/** The fingerprint of each named file as the check saw it. */
	files: ReadonlyMap<string, GitHookFile>;
	/** One line for the card, the audit row and a denied model. */
	summary: string;
}

export interface GitHookDriftGuard {
	/**
	 * Added or changed hook files since the baseline, or null when there are
	 * none. A `silent` check neither tells `onDrift` nor counts what it saw as
	 * reported, for a caller whose drift asks nothing (yolo).
	 */
	check(options?: { silent?: boolean }): GitHookDriftReport | null;
	/** The operator allowed a drift ask: the files it named, as it saw them, join the baseline. */
	accept(report: GitHookDriftReport): void;
	/** An approved git control write landed: hook files at or below `targets` join the baseline as they are now. */
	refresh(targets: ReadonlyArray<string>): void;
	/** Every hook file that changed since the guard started, including one changed and then put back. */
	sessionChanges(): GitHookChange[];
	/**
	 * Executable config values of the repository holding `dir` added or
	 * changed against the baseline, read through the cheap config path rather
	 * than a fingerprint walk. Empty without a `config` dependency.
	 */
	configDrift(dir: string): GitHookChange[];
}

export interface GitHookDriftDeps {
	fingerprint: () => GitHooksFingerprint;
	/** One repository's executable config by entry id (GitHooksFingerprinter.config). */
	config?: (dir: string) => ReadonlyMap<string, GitHookFile>;
	/** The workspace, so the card names a hook by its workspace path. */
	workspace: string;
	/** Told once per distinct change, the first time a check sees it. */
	onDrift?: (changes: ReadonlyArray<GitHookChange>) => void;
}

function displayPath(file: string, workspace: string): string {
	const rel = path.relative(workspace, file);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

/**
 * `added .git/hooks/pre-commit (57 bytes, executable, '#!/bin/sh')`, or for
 * config `changed core.fsmonitor in .git/config ('./watch.sh')`.
 */
export function describeGitHookChange(change: GitHookChange, workspace: string): string {
	if (change.key !== undefined) {
		const value = change.kind !== "removed" && change.firstLine.length > 0 ? ` ('${change.firstLine}')` : "";
		return sanitizeCallTargetText(`${change.kind} ${change.key} in ${displayPath(change.path, workspace)}${value}`);
	}
	const facts = [
		change.size < 0 ? "unreadable" : `${change.size} bytes`,
		...(change.kind !== "removed" && !change.executable ? ["not executable"] : []),
		...(change.firstLine.length > 0 ? [`'${change.firstLine}'`] : []),
	];
	// A planted file names itself and writes its own first line, so both are neutralized for display.
	return sanitizeCallTargetText(`${change.kind} ${displayPath(change.path, workspace)} (${facts.join(", ")})`);
}

function summarize(changes: ReadonlyArray<GitHookChange>, workspace: string): string {
	const named = changes.slice(0, REPORT_MAX_FILES).map((change) => describeGitHookChange(change, workspace));
	const more = changes.length > REPORT_MAX_FILES ? `; and ${changes.length - REPORT_MAX_FILES} more` : "";
	return `git hook files or executable git config changed since the session started or the operator last accepted them, and this git command would run them outside the sandbox: ${named.join("; ")}${more}`;
}

/** The transcript notice for changes a check saw for the first time. */
export function gitHookDriftNotice(changes: ReadonlyArray<GitHookChange>, workspace: string): string {
	const named = changes.slice(0, REPORT_MAX_FILES).map((change) => describeGitHookChange(change, workspace));
	const more = changes.length > REPORT_MAX_FILES ? `; and ${changes.length - REPORT_MAX_FILES} more` : "";
	return `[safety] git hook files or executable git config changed during this session: ${named.join("; ")}${more}. A hook runs outside the sandbox, so the next git command the agent runs outside it asks you first, and Clio's own git operations run with hooks off.`;
}

function changeKey(change: GitHookChange): string {
	return `${gitHookEntryId(change)}\0${change.kind}\0${change.hash}`;
}

function realOrSelf(entry: string): string {
	try {
		return realpathSync(entry);
	} catch {
		return entry;
	}
}

function atOrBelow(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Impure: the guard, with its baseline taken now. */
export function createGitHookDriftGuard(deps: GitHookDriftDeps): GitHookDriftGuard {
	const start = deps.fingerprint().files;
	const baseline = new Map(start);
	const reported = new Set<string>();
	const detected = new Map<string, GitHookChange>();
	return {
		check(options) {
			const current = deps.fingerprint().files;
			// A removed hook adds no code; drift is what git would now run that the operator has not seen.
			const changes = diffGitHookFiles(baseline, current).filter((change) => change.kind !== "removed");
			if (changes.length === 0) return null;
			const summary = summarize(changes, deps.workspace);
			const silent = options?.silent === true;
			const fresh = silent ? [] : changes.filter((change) => !reported.has(changeKey(change)));
			for (const change of changes) {
				if (!silent) reported.add(changeKey(change));
				detected.set(gitHookEntryId(change), change);
			}
			if (fresh.length > 0) {
				try {
					deps.onDrift?.(fresh);
				} catch {
					// A notice sink failure never changes the ask.
				}
			}
			const files = new Map<string, GitHookFile>();
			for (const change of changes) {
				const id = gitHookEntryId(change);
				const file = current.get(id);
				if (file !== undefined) files.set(id, file);
			}
			return { changes, files, summary };
		},
		accept(report) {
			for (const [file, fingerprint] of report.files) baseline.set(file, fingerprint);
		},
		refresh(targets) {
			if (targets.length === 0) return;
			const scopes = [...new Set(targets.flatMap((target) => [path.resolve(target), realOrSelf(target)]))];
			const inScope = (file: string): boolean => {
				const forms = [file, realOrSelf(file)];
				return scopes.some((scope) => forms.some((form) => atOrBelow(scope, form)));
			};
			const current = deps.fingerprint().files;
			for (const id of new Set([...baseline.keys(), ...current.keys()])) {
				// A config value is in scope when the file that sets it was the write's target.
				const entry = current.get(id) ?? baseline.get(id);
				if (entry === undefined || !inScope(entry.path)) continue;
				const now = current.get(id);
				if (now === undefined) baseline.delete(id);
				else baseline.set(id, now);
			}
		},
		configDrift(dir) {
			if (deps.config === undefined) return [];
			const current = deps.config(dir);
			const changes: GitHookChange[] = [];
			for (const [id, file] of current) {
				const prior = baseline.get(id);
				if (prior !== undefined && prior.hash === file.hash) continue;
				const change: GitHookChange = {
					path: file.path,
					kind: prior === undefined ? "added" : "changed",
					...(file.key !== undefined ? { key: file.key } : {}),
					size: file.size,
					firstLine: file.firstLine,
					executable: file.executable,
					hash: file.hash,
				};
				changes.push(change);
				detected.set(id, change);
			}
			return changes.sort((a, b) => a.path.localeCompare(b.path) || (a.key ?? "").localeCompare(b.key ?? ""));
		},
		sessionChanges() {
			const changes = new Map(
				diffGitHookFiles(start, deps.fingerprint().files).map((change) => [gitHookEntryId(change), change]),
			);
			for (const [id, change] of detected) if (!changes.has(id)) changes.set(id, change);
			return [...changes.values()].sort(
				(a, b) => a.path.localeCompare(b.path) || (a.key ?? "").localeCompare(b.key ?? ""),
			);
		},
	};
}

/**
 * A command word that runs git: git itself and the code-host CLIs that drive
 * it (`gh pr checkout`, `gh repo clone`). A false match only costs a
 * fingerprint check.
 */
const GIT_INVOKING_COMMAND = /(?:^|[^\w.-])(?:git|gh|glab|hub)(?=$|[^\w.-])/u;

/** True when a shell command names a program that runs git. */
export function commandInvokesGit(command: string): boolean {
	return GIT_INVOKING_COMMAND.test(command);
}

/**
 * Whether a call can run a git hook outside Clio's sandbox: the typed git
 * tool's add and commit, which run in this process, and an uncontained bash
 * call naming git or an uncontained run_script, whose source is not read.
 * `contained` is true when the call runs in the main-session sandbox, where
 * a hook runs bounded by it.
 */
export function runsGitHooksOutsideSandbox(call: ClassifierCall, contained: boolean): boolean {
	if (call.projection === "typed-git") return true;
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return false;
	if (contained) return false;
	if (call.tool === ToolNames.RunScript) return true;
	const command = call.args?.command;
	return typeof command === "string" && commandInvokesGit(command);
}
