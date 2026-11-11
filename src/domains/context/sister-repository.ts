/**
 * Rules for work in a sister repository: one the session did not start in.
 *
 * The repository that owns a run's files decides its rules, never the
 * directory the session started in, so a scout reading another checkout gets
 * that checkout's handbook and nothing of the session's. Another repository's
 * handbook is prompt text from a project the operator did not open: until its
 * `handbook` trust surface is approved, only the rules its own tree verifies
 * (cited paths resolve, checker ids exist, no tree fact contradicts them) and
 * the rules its checkers declare are compiled; the uncheckable rest is counted
 * and left out. Nothing is written into the sister repository: the compile and
 * its ledger are cached under the Clio state root, keyed by the repository root.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { repositoryIdentity, repositoryRoot } from "../../core/project-root.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { enumerateWorkspaceFilesAsync } from "../../core/workspace-files.js";
import { captureProjectSurface } from "../../core/workspace-trust.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { type HandbookLedgerEntry, verifyHandbookRules } from "./bootstrap.js";
import { loadProjectClioMd } from "./clio-md.js";
import { compileHandbook } from "./handbook-units.js";
import { instructionUnits } from "./instruction-units.js";

/** The handbook text a sister-repository run receives, and how it was chosen. */
export interface SisterRepositoryRules {
	/** The owning repository's root. */
	root: string;
	name: string;
	/** Whether the operator approved this repository's handbook bytes. */
	trusted: boolean;
	/** Repository-relative handbook files the rules were compiled from. */
	files: string[];
	/** Trusted: the authored handbooks. Untrusted: the rules the tree verifies, with the checker rules. */
	sources: Array<{ path: string; source: string }>;
	/** Rules left out because the tree could not check them; always 0 when trusted. */
	withheld: number;
	/** Digest of `sources`, so a delivery repeats only when the compile changes. */
	hash: string;
}

/** A sister repository as a synchronous caller sees it: its rules, or null while the first compile is still running. */
export interface SisterRepositoryRead {
	root: string;
	name: string;
	rules: SisterRepositoryRules | null;
}

interface CachedCompile {
	version: 2;
	key: string;
	/** The commit the rules were verified against. */
	head: string;
	rules: SisterRepositoryRules;
	ledger: HandbookLedgerEntry[];
}

const CACHE_VERSION = 2;
const memo = new Map<string, CachedCompile>();
/** The running refresh per compile key, with the HEAD stamp it started from. */
const inflight = new Map<string, { stamp: string; run: Promise<SisterRepositoryRules | null> }>();
const heads = new Map<string, { stamp: string; head: string }>();

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function physical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The repository owning `path` when it is not the one the session started in
 * at `sessionCwd`, else null. A linked worktree of the session's repository is
 * the same repository; a submodule or a nested clone inside it is not.
 */
export function sisterRepositoryRoot(path: string, sessionCwd: string): string | null {
	const root = repositoryRoot(path);
	if (root === null) return null;
	const session = repositoryRoot(sessionCwd);
	return session !== null && repositoryIdentity(session) === repositoryIdentity(root) ? null : root;
}

/** Where the compile and ledger of the repository at `root` are kept: the state root, never the repository. */
function sisterRepositoryStateDir(root: string): string {
	return join(resolveClioDirs().state, "handbooks", sha256(physical(root)).slice(0, 16));
}

/** The worktree's own Git directory: `.git` itself, or where its `gitdir:` file points. */
function gitDirectory(root: string): string {
	const dotGit = join(root, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return dotGit;
		const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
		return gitdir === undefined ? dotGit : resolve(root, gitdir);
	} catch {
		return dotGit;
	}
}

function mtime(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "-";
	}
}

/** What changes when HEAD moves: HEAD, the ref it names and the packed refs, by modification time. */
function headStamp(root: string): string {
	const gitDir = gitDirectory(root);
	const common = repositoryIdentity(root);
	let ref = "";
	try {
		ref = /^ref:\s*(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]?.trim() ?? "";
	} catch {
		// No readable HEAD: the stamp still changes once one appears.
	}
	return [
		mtime(join(gitDir, "HEAD")),
		ref,
		ref ? mtime(join(common, ref)) : "",
		mtime(join(common, "packed-refs")),
	].join("|");
}

/** The commit at `root`, through safe-exec off the caller's thread, and asked again only after HEAD or its ref changes. */
async function headCommit(root: string): Promise<string> {
	const stamp = headStamp(root);
	const known = heads.get(root);
	if (known?.stamp === stamp) return known.head;
	const result = await runCommandVector("git", ["-C", root, "rev-parse", "HEAD"], {
		cwd: root,
		workspaceRoot: root,
		timeoutMs: 5_000,
		maxOutputBytes: 4_096,
	});
	const head = result.exitCode === 0 ? result.stdout.trim() || "uncommitted" : "uncommitted";
	heads.set(root, { stamp, head });
	return head;
}

/** The units of `content` the tree verified, under their own headings, as a handbook the worker compile can route. */
function verifiedHandbook(
	title: string,
	file: string,
	content: string,
	verified: ReadonlySet<string>,
	checks: ReadonlyArray<string>,
): string {
	const sections = new Map<string, string[]>();
	for (const unit of instructionUnits(content, 600, file)) {
		if (!verified.has(`${unit.file}:${unit.line}`)) continue;
		const heading = unit.heading.trim() || "Rules";
		sections.set(heading, [...(sections.get(heading) ?? []), `- ${unit.text}`]);
	}
	if (checks.length > 0)
		sections.set(
			"Checks",
			checks.map((rule) => `- ${rule}`),
		);
	if (sections.size === 0) return "";
	return [`# ${title}`, ...[...sections].flatMap(([heading, lines]) => ["", `## ${heading}`, "", ...lines])].join("\n");
}

interface CompileInputs {
	key: string;
	root: string;
	name: string;
	files: string[];
	trusted: boolean;
	loaded: ReturnType<typeof loadProjectClioMd>;
}

/**
 * What decides the compile, read without verifying anything or running Git:
 * the handbook bytes and their trust. The commit is checked only by the
 * background refresh, so these reads are all a prompt or tool path pays.
 */
function compileInputs(cwd: string, root: string): CompileInputs {
	const loaded = loadProjectClioMd(cwd);
	const files = loaded.files.map((file) => relative(root, file.path).split("\\").join("/"));
	const snapshot = captureProjectSurface(root, "handbook");
	const pinned = new Set(snapshot.files.filter((file) => file.text !== null).map((file) => physical(file.path)));
	const trusted = snapshot.verdict === "trusted" && loaded.files.every((file) => pinned.has(physical(file.path)));
	const key = sha256(
		JSON.stringify([
			CACHE_VERSION,
			physical(root),
			physical(cwd),
			trusted ? snapshot.contentHash : null,
			loaded.files.map((file) => [file.path, sha256(file.source)]),
		]),
	);
	return { key, root, name: basename(root), files, trusted, loaded };
}

/** A trusted handbook enters as the operator approved it: nothing to verify, so it never waits on a compile. */
function trustedRules(inputs: CompileInputs): SisterRepositoryRules {
	const { root, name, files, loaded } = inputs;
	const sources = loaded.files.map((file) => ({ path: file.path, source: file.source }));
	return { root, name, trusted: true, files, sources, withheld: 0, hash: sha256(JSON.stringify(sources)) };
}

/**
 * The untrusted compile: the rules the tree verifies and the checker rules.
 * A repository with no handbook gets nothing yet; a checker-only compile for
 * it belongs with the store's handbook compile and is not built here.
 */
function compileUntrusted(
	inputs: CompileInputs,
	repositoryFiles: ReadonlyArray<string>,
): { rules: SisterRepositoryRules; ledger: HandbookLedgerEntry[] } {
	const { root, name, files, loaded } = inputs;
	const title = `Rules of ${name}, compiled from ${files.join(", ")}`;
	const handbooks = loaded.files.map((file, index) => ({
		file: files[index] ?? file.path,
		path: file.path,
		content: file.source,
	}));
	const { entries, checkerRules } =
		handbooks.length > 0 ? verifyHandbookRules(root, handbooks, { repositoryFiles }) : { entries: [], checkerRules: [] };
	const verified = new Set(
		entries
			.filter((entry) => entry.verdict === "verified")
			.map((entry) => `${entry.source?.file ?? ""}:${entry.source?.line ?? 0}`),
	);
	const sources = handbooks
		.map((handbook, index) => ({
			path: handbook.path,
			// The checker rules are the repository's, not one file's: they ride with the first.
			source: verifiedHandbook(title, handbook.file, handbook.content, verified, index === 0 ? checkerRules : []),
		}))
		.filter((source) => source.source.length > 0);
	return {
		ledger: entries,
		rules: {
			root,
			name,
			trusted: false,
			files,
			sources,
			withheld: entries.filter((entry) => entry.verdict !== "verified").length,
			hash: sha256(JSON.stringify(sources)),
		},
	};
}

function cachePathFor(inputs: CompileInputs): string {
	return join(sisterRepositoryStateDir(inputs.root), `${inputs.key.slice(0, 16)}.json`);
}

function readCache(inputs: CompileInputs): CachedCompile | null {
	const remembered = memo.get(inputs.key);
	if (remembered) return remembered;
	try {
		const cached = JSON.parse(readFileSync(cachePathFor(inputs), "utf8")) as Partial<CachedCompile>;
		if (cached.version !== CACHE_VERSION || cached.key !== inputs.key || !cached.rules || typeof cached.head !== "string")
			return null;
		const record = cached as CachedCompile;
		memo.set(inputs.key, record);
		return record;
	} catch {
		return null;
	}
}

const HANDBOOK_FILES: ReadonlySet<string> = new Set(["CLIO-CODER.md", "CLIO-DEV.md"]);

function refresh(inputs: CompileInputs): Promise<SisterRepositoryRules | null> {
	const stamp = headStamp(inputs.root);
	const running = inflight.get(inputs.key);
	if (running?.stamp === stamp) return running.run;
	// A refresh that started before HEAD moved would answer for the old commit: run again once it settles.
	const previous = running?.run.catch(() => null) ?? Promise.resolve(null);
	const run = (async (): Promise<SisterRepositoryRules | null> => {
		await previous;
		const head = await headCommit(inputs.root);
		const cached = readCache(inputs);
		if (cached?.head === head) return cached.rules;
		const repositoryFiles = (await enumerateWorkspaceFilesAsync(inputs.root)).filter((path) => !HANDBOOK_FILES.has(path));
		const { rules, ledger } = compileUntrusted(inputs, repositoryFiles);
		const record: CachedCompile = { version: CACHE_VERSION, key: inputs.key, head, rules, ledger };
		memo.set(inputs.key, record);
		try {
			await safeResourceWriteAsync(cachePathFor(inputs), `${JSON.stringify(record, null, 2)}\n`);
			await safeResourceWriteAsync(
				join(sisterRepositoryStateDir(inputs.root), "ledger.json"),
				`${JSON.stringify({ version: 1, root: inputs.root, head, entries: ledger }, null, 2)}\n`,
			);
		} catch {
			// The cache saves the next process a compile; it decides nothing.
		}
		return rules;
	})().finally(() => {
		if (inflight.get(inputs.key)?.run === run) inflight.delete(inputs.key);
	});
	inflight.set(inputs.key, { stamp, run });
	return run;
}

/**
 * The rules a run at `cwd` receives from the repository that owns it, read
 * without verifying anything: a trusted handbook as approved, an untrusted
 * one from the last compile cached under the state root. It starts a
 * background refresh, which recompiles only when the commit, handbook bytes or
 * trust changed, so a prompt, dispatch or tool-result path never waits on a
 * tree walk. `rules` is null until the first compile lands. Null outside any
 * repository.
 */
export function sisterRepositoryRules(cwd: string): SisterRepositoryRead | null {
	const root = repositoryRoot(cwd);
	if (root === null) return null;
	const inputs = compileInputs(cwd, root);
	if (inputs.trusted) return { root, name: inputs.name, rules: trustedRules(inputs) };
	const cached = readCache(inputs);
	refresh(inputs).catch(() => {
		// A failed compile leaves the last one, or none; the next call tries again.
	});
	return { root, name: inputs.name, rules: cached?.rules ?? null };
}

/** The compile of the repository owning `cwd`, waiting for a refresh to land; for a caller off the prompt path. */
export async function refreshSisterRepositoryRules(cwd: string): Promise<SisterRepositoryRules | null> {
	const root = repositoryRoot(cwd);
	if (root === null) return null;
	const inputs = compileInputs(cwd, root);
	return inputs.trusted ? trustedRules(inputs) : refresh(inputs);
}

/** The operator-facing notice for a sister repository whose rules are not complete this time, or null. */
export function sisterRepositoryPendingNotice(read: SisterRepositoryRead): string | null {
	if (read.rules !== null) return null;
	return `Rules of ${read.name}: its handbook is still being checked against its tree, so this run receives none of its handbook rules and none of this session's. Later runs in ${read.root} receive the rules its tree verifies.`;
}

/** The operator-facing notice for an untrusted compile that left rules out, or null when nothing was withheld. */
export function sisterRepositoryNotice(rules: SisterRepositoryRules): string | null {
	if (rules.trusted || rules.withheld === 0) return null;
	return `Rules of ${rules.name}: ${rules.withheld} handbook rule${rules.withheld === 1 ? "" : "s"} the tree cannot check left out, because ${rules.root} is a repository this session did not start in and its handbook is not trusted. Review it with clio-coder config trust handbook, run in ${rules.root}.`;
}

export const SISTER_REPOSITORY_REMINDER_MAX_CHARS = 1_500;

/**
 * The invariants of a sister repository's compile as one labeled reminder for
 * the main agent, at most 1,500 characters, or null when it has none. Whole
 * rules only; what does not fit is named, not cut.
 */
export function sisterRepositoryReminder(rules: SisterRepositoryRules): string | null {
	const invariants = rules.sources.flatMap(({ path, source }) =>
		(compileHandbook(source, path)?.units ?? []).filter((unit) => unit.audience.includes("all")).map((unit) => unit.text),
	);
	if (invariants.length === 0) return null;
	const header = `Rules of ${rules.name}, compiled from ${rules.files.join(", ")}. They apply to files under ${rules.root}, not to this session's repository.`;
	const lines = [header];
	let length = header.length;
	for (const [index, text] of invariants.entries()) {
		const rest = invariants.length - index - 1;
		const tail = rest > 0 ? `\n${rest} more in ${rules.files.join(", ")}.`.length : 0;
		if (length + 1 + text.length + tail > SISTER_REPOSITORY_REMINDER_MAX_CHARS) {
			lines.push(`${invariants.length - index} more in ${rules.files.join(", ")}.`);
			break;
		}
		lines.push(text);
		length += 1 + text.length;
	}
	return lines.join("\n");
}
