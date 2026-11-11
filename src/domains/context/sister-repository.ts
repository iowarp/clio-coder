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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { repositoryIdentity, repositoryRoot } from "../../core/project-root.js";
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

interface CachedCompile {
	version: 1;
	key: string;
	rules: SisterRepositoryRules;
	ledger: HandbookLedgerEntry[];
}

const CACHE_VERSION = 1;
const memo = new Map<string, SisterRepositoryRules>();

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
 * the same repository.
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

function headCommit(root: string): string {
	try {
		return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
	} catch {
		return "uncommitted";
	}
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

/** What decides the compile, read without verifying anything, so an unchanged repository costs a cache read. */
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
			headCommit(root),
			trusted ? snapshot.contentHash : null,
			loaded.files.map((file) => [file.path, sha256(file.source)]),
		]),
	);
	return { key, root, name: basename(root), files, trusted, loaded };
}

function compile(inputs: CompileInputs): { rules: SisterRepositoryRules; ledger: HandbookLedgerEntry[] } {
	const { root, name, files, trusted, loaded } = inputs;
	if (trusted) {
		const sources = loaded.files.map((file) => ({ path: file.path, source: file.source }));
		return {
			ledger: [],
			rules: { root, name, trusted, files, sources, withheld: 0, hash: sha256(JSON.stringify(sources)) },
		};
	}
	const title = `Rules of ${name}, compiled from ${files.join(", ")}`;
	const handbooks = loaded.files.map((file, index) => ({
		file: files[index] ?? file.path,
		path: file.path,
		content: file.source,
	}));
	const { entries, checkerRules } =
		handbooks.length > 0 ? verifyHandbookRules(root, handbooks) : { entries: [], checkerRules: [] };
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
			trusted,
			files,
			sources,
			withheld: entries.filter((entry) => entry.verdict !== "verified").length,
			hash: sha256(JSON.stringify(sources)),
		},
	};
}

function readCache(path: string, key: string): SisterRepositoryRules | null {
	try {
		const cached = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedCompile>;
		return cached.version === CACHE_VERSION && cached.key === key && cached.rules ? cached.rules : null;
	} catch {
		return null;
	}
}

/**
 * The rules a run at `cwd` receives from the repository that owns it, compiled
 * from that repository only and filtered by its handbook trust. Null outside
 * any repository. Recompiled only when the repository's commit, handbook bytes
 * or trust change; a cache that cannot be written only costs the next call a
 * recompile.
 */
export function sisterRepositoryRules(cwd: string): SisterRepositoryRules | null {
	const root = repositoryRoot(cwd);
	if (root === null) return null;
	const inputs = compileInputs(cwd, root);
	const remembered = memo.get(inputs.key);
	if (remembered) return remembered;
	const dir = sisterRepositoryStateDir(root);
	const cachePath = join(dir, `${inputs.key.slice(0, 16)}.json`);
	const cached = readCache(cachePath, inputs.key);
	if (cached) {
		memo.set(inputs.key, cached);
		return cached;
	}
	const result = compile(inputs);
	try {
		mkdirSync(dir, { recursive: true });
		const record: CachedCompile = { version: CACHE_VERSION, key: inputs.key, rules: result.rules, ledger: result.ledger };
		writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		writeFileSync(
			join(dir, "ledger.json"),
			`${JSON.stringify({ version: 1, root, entries: result.ledger }, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// See the doc comment: the cache saves work, it decides nothing.
	}
	memo.set(inputs.key, result.rules);
	return result.rules;
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
