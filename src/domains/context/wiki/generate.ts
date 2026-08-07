import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ContextActivityPayload } from "../../../core/bus-events.js";
import { detectProjectType } from "../../session/workspace/project-type.js";
import type { BootstrapProgressSink } from "../bootstrap.js";
import {
	buildCodewiki,
	type Codewiki,
	codewikiNeedsBackfill,
	readCodewiki,
	writeCodewiki,
} from "../codewiki/indexer.js";
import { computeFingerprint, isStale } from "../fingerprint.js";
import { readClioState, writeClioState } from "../state.js";
import { assembleWikiTree, normalizeRepoPath, pageSourceIndex } from "./assemble.js";
import { isGeneratedWikiFile, listWikiPagesInDir, WIKI_PLAN_FILE, wikiDir, wikiMarkdownFilesInDir } from "./layout.js";
import {
	computeWikiContentHash,
	computeWikiContentHashOfDir,
	currentWikiGitHead,
	readWikiMeta,
	wikiMetaPath,
	writeWikiMeta,
} from "./meta.js";
import {
	planWikiGeneration,
	type WikiDepth,
	type WikiGenerationPlan,
	type WikiPlan,
	type WikiPlanPage,
} from "./plan.js";
import { readWikiPlanFile, scopePlanForUpdate, unclaimedCandidates, writeWikiPlanFile } from "./plan-store.js";
import type { WikiGenerateMode } from "./prompts.js";
import { changedPathsSince } from "./staleness.js";

export type { WikiDepth, WikiGenerateMode };

export interface WikiGenerateInput {
	cwd: string;
	mode: WikiGenerateMode;
	/**
	 * Absolute staging directory the writers must target. The harness assembles
	 * and promotes what it finds here; no writer ever touches .clio/wiki.
	 */
	outputDir: string;
	codewiki: Codewiki;
	/** Resolved depth and the candidate skeleton derived from the index. */
	generation: WikiGenerationPlan;
	/**
	 * The plan this run starts from, already scoped: pages marked `written` are
	 * current and must be left alone. The callback records progress by writing
	 * the updated plan back to `_plan.json` in `outputDir` after each page, which
	 * is what makes an interrupted run resumable.
	 */
	plan: WikiPlan;
	/**
	 * True when this run took over a staging tree an earlier run left behind. A
	 * resumed run must not re-plan: its finished pages already link to the plan's
	 * paths.
	 */
	resumed: boolean;
	/** Indexed areas no existing page covers, offered to a planning pass. */
	unclaimedAreas: ReadonlyArray<WikiPlanPage>;
	gitHead?: string | null;
	progress?: BootstrapProgressSink;
}

export type WikiGenerate = (input: WikiGenerateInput) => void | Promise<void>;

export interface RunWikiGenerateInput {
	cwd?: string;
	mode?: WikiGenerateMode;
	/** Repository-detail policy. Auto scales decomposition from indexed files and lines. */
	depth?: WikiDepth;
	model: string;
	generate?: WikiGenerate;
	onProgress?: BootstrapProgressSink;
}

export interface RunWikiGenerateResult {
	status: "generated" | "noop" | "failed";
	pages: number;
	/** Pages the plan still owes. Above zero means a later run has work to finish. */
	pending?: number;
	problems?: string[];
}

type ProgressEvent = Omit<ContextActivityPayload, "kind" | "at">;

function progress(input: RunWikiGenerateInput, event: ProgressEvent): void {
	input.onProgress?.(event);
}

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

async function loadOrBuildCodewiki(cwd: string): Promise<Codewiki> {
	const existing = readCodewiki(cwd);
	const prev = readClioState(cwd);
	// Mirror the code_nav demand-load freshness check: a stale index must never
	// ground the wiki writer prompt, so drift forces a rebuild here too.
	if (existing && !codewikiNeedsBackfill(existing)) {
		const fingerprint = computeFingerprint(cwd, existing);
		if (prev && !isStale(prev.fingerprint, fingerprint)) return existing;
	}
	const generatedAt = new Date().toISOString();
	const projectType = detectProjectType(cwd);
	const rebuilt = await buildCodewiki({ cwd, language: projectType, generatedAt });
	writeCodewiki(cwd, rebuilt);
	writeClioState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? projectType,
		fingerprint: computeFingerprint(cwd, rebuilt),
		codewikiVersion: rebuilt.version,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? generatedAt,
		lastIndexedAt: generatedAt,
	});
	return rebuilt;
}

function failed(problems: string[], pages: number): RunWikiGenerateResult {
	return { status: "failed", pages, problems };
}

const STAGING_PREFIX = "wiki-staging-";
const WIKI_PREV_DIR = "wiki-prev";
const WIKI_LOCK_FILE = "wiki.lock";

function clioDir(cwd: string): string {
	return join(cwd, ".clio");
}

/**
 * ESRCH means the pid is gone; EPERM means it exists but is owned by another
 * user (still alive). Any other error (including an out-of-range pid) is treated
 * as not alive so a corrupt lock never wedges generation forever.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLockPid(lockPath: string): number | null {
	try {
		const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}

type WikiLock = { ok: true; release: () => void } | { ok: false; problem: string };

/**
 * Single-flight lock at .clio/wiki.lock. The file is created with the O_EXCL
 * `wx` flag and carries the holder's pid. A live holder blocks the run; a lock
 * left by a crashed run (dead pid) is taken over.
 */
function acquireWikiLock(cwd: string): WikiLock {
	const dir = clioDir(cwd);
	mkdirSync(dir, { recursive: true });
	const lockPath = join(dir, WIKI_LOCK_FILE);
	const release = (): void => {
		try {
			rmSync(lockPath, { force: true });
		} catch {
			// best-effort release; a stale lock is later reclaimed by pid liveness
		}
	};
	const create = (): void => {
		const fd = openSync(lockPath, "wx");
		try {
			writeSync(fd, String(process.pid));
		} finally {
			closeSync(fd);
		}
	};
	try {
		create();
		return { ok: true, release };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const holder = readLockPid(lockPath);
	if (holder !== null && isProcessAlive(holder)) {
		return {
			ok: false,
			problem: `wiki generation is already running (lock held by pid ${holder} at ${lockPath})`,
		};
	}
	// Stale lock from a crashed run: reclaim it.
	try {
		rmSync(lockPath, { force: true });
		create();
		return { ok: true, release };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const racer = readLockPid(lockPath);
		return {
			ok: false,
			problem: `wiki generation is already running (lock held by pid ${racer ?? "unknown"} at ${lockPath})`,
		};
	}
}

function removeDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

/**
 * Copy the current wiki into staging so an update revises real pages and an
 * unchanged run stays byte-identical. meta.json is harness-owned and is never
 * copied; generated navigation is rebuilt by the assembly pass, so it is not
 * copied either.
 */
function seedStaging(cwd: string, stagingDir: string): void {
	const source = wikiDir(cwd);
	for (const relPath of wikiMarkdownFilesInDir(source)) {
		const target = join(stagingDir, relPath);
		mkdirSync(dirname(target), { recursive: true });
		try {
			copyFileSync(join(source, relPath), target);
		} catch {
			// A page that cannot be copied is simply regenerated.
		}
	}
}

/**
 * Take over the staging tree a previous run left behind, or make a fresh one.
 *
 * Staging survives a run that ended early. That is the whole resume mechanism:
 * the pages that run finished are still there, and its plan file still records
 * which pages it never reached. Discarding the tree on the way out is what
 * turned a timeout into total loss.
 */
function adoptOrCreateStaging(cwd: string): { dir: string; adopted: boolean } {
	const dir = clioDir(cwd);
	mkdirSync(dir, { recursive: true });
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		entries = [];
	}
	const candidates = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
		.map((entry) => join(dir, entry.name))
		.sort((a, b) => {
			const at = statSync(a).mtimeMs;
			const bt = statSync(b).mtimeMs;
			return bt - at;
		});
	const resumable = candidates.find((candidate) => existsSync(join(candidate, WIKI_PLAN_FILE)));
	for (const candidate of candidates) {
		if (candidate !== resumable) removeDir(candidate);
	}
	if (resumable !== undefined) return { dir: resumable, adopted: true };
	const fresh = mkdtempSync(join(dir, STAGING_PREFIX));
	seedStaging(cwd, fresh);
	return { dir: fresh, adopted: false };
}

type PromoteResult = { ok: true } | { ok: false; problems: string[] };

/**
 * Atomically swap staging into place: move the current wiki aside to
 * .clio/wiki-prev, rename staging to .clio/wiki, then write meta.json. On any
 * failure after the old wiki is moved aside, restore it; if the restore fails,
 * the recovered content is left at wiki-prev and its path is surfaced.
 */
function promoteStaging(cwd: string, stagingDir: string, writeMeta: () => void): PromoteResult {
	const wiki = wikiDir(cwd);
	const prev = join(clioDir(cwd), WIKI_PREV_DIR);
	removeDir(prev);
	const hadWiki = existsSync(wiki);
	if (hadWiki) renameSync(wiki, prev);
	try {
		renameSync(stagingDir, wiki);
		writeMeta();
	} catch (err) {
		const problems = [`wiki promotion failed: ${err instanceof Error ? err.message : String(err)}`];
		removeDir(stagingDir);
		if (hadWiki) {
			removeDir(wiki);
			try {
				renameSync(prev, wiki);
			} catch {
				problems.push(`previous wiki could not be restored and remains at ${prev}`);
				return { ok: false, problems };
			}
		}
		return { ok: false, problems };
	}
	if (hadWiki) removeDir(prev);
	return { ok: true };
}

/**
 * Decide what this run owes, in precedence order: a staging tree left by an
 * interrupted run, then the plan the last promoted wiki recorded, then the
 * candidate skeleton the index just produced.
 *
 * A resumed plan is used exactly as it was left. It was settled when the wiki
 * was planned, and the pages already written link to its paths, so changing it
 * mid-flight would strand those links. Areas the index has since found that no
 * page covers are carried separately and offered to a planning pass, which is
 * the only thing allowed to change a plan's shape.
 */
function resolvePlan(input: {
	cwd: string;
	stagingDir: string;
	adopted: boolean;
	mode: WikiGenerateMode;
	candidate: WikiPlan;
	previousPlan: WikiPlan | undefined;
	gitHead: string | null;
}): { plan: WikiPlan; resumed: boolean; unclaimedAreas: WikiPlanPage[] } {
	const staged = input.adopted ? readWikiPlanFile(input.stagingDir) : null;
	if (staged !== null) return { plan: staged, resumed: true, unclaimedAreas: [] };
	if (input.mode === "update" && input.previousPlan !== undefined) {
		const pageSources = pageSourceIndex(input.stagingDir, input.cwd);
		const changed = new Set(
			changedPathsSince(input.cwd, input.gitHead).map((path) => normalizeRepoPath(input.cwd, path)),
		);
		return {
			plan: scopePlanForUpdate({
				plan: input.previousPlan,
				changedPaths: changed,
				existingPages: new Set(wikiMarkdownFilesInDir(input.stagingDir)),
				pageSources,
			}),
			resumed: false,
			unclaimedAreas: unclaimedCandidates(input.previousPlan, input.candidate, pageSources),
		};
	}
	return { plan: input.candidate, resumed: false, unclaimedAreas: [] };
}

/**
 * Reconcile the plan against the tree that actually exists. A page whose file
 * the assembly pass dropped, or that was never written, is owed again; a page
 * on disk is recorded as written whatever the writer reported. A page that
 * exists without a plan entry is adopted, because a page on disk is a page: the
 * alternative is a plan that keeps re-dispatching a subject already covered.
 */
function reconcilePlan(plan: WikiPlan, stagingDir: string): WikiPlan {
	const contentFiles = wikiMarkdownFilesInDir(stagingDir).filter((relPath) => !isGeneratedWikiFile(relPath));
	const onDisk = new Set(contentFiles);
	const planned = new Set(plan.pages.map((page) => page.path));
	const adopted = contentFiles
		.filter((relPath) => !planned.has(relPath))
		.map((relPath) => ({
			path: relPath,
			title: relPath.replace(/\.md$/, ""),
			intent: "",
			sources: [],
			status: "written" as const,
			attempts: 1,
		}));
	return {
		...plan,
		pages: [
			...plan.pages.map((page) =>
				onDisk.has(page.path) ? { ...page, status: "written" as const } : { ...page, status: "pending" as const },
			),
			...adopted,
		],
	};
}

export async function runWikiGenerate(
	input: RunWikiGenerateInput = { model: "configured-clio-target" },
): Promise<RunWikiGenerateResult> {
	const cwd = input.cwd ?? process.cwd();
	const existingMeta = readWikiMeta(cwd);
	const mode = input.mode ?? (existingMeta ? "update" : "init");

	const lock = acquireWikiLock(cwd);
	if (!lock.ok) {
		progress(input, { phase: "generate", status: "failed", message: lock.problem });
		progress(input, { phase: "done", status: "failed", message: "wiki generation failed", detail: lock.problem });
		return failed([lock.problem], listWikiPagesInDir(wikiDir(cwd)).length);
	}

	try {
		progress(input, { phase: "codewiki", status: "started", message: "loading codewiki for wiki generation" });
		const codewiki = await loadOrBuildCodewiki(cwd);
		const sourceTreeHash = computeFingerprint(cwd, codewiki).treeHash;
		const generation = planWikiGeneration(codewiki, input.depth ?? "auto");
		progress(input, {
			phase: "codewiki",
			status: "completed",
			message: `loaded ${indexedSourceFileCount(codewiki)} source file${indexedSourceFileCount(codewiki) === 1 ? "" : "s"}`,
			current: indexedSourceFileCount(codewiki),
			total: indexedSourceFileCount(codewiki),
		});

		const staging = adoptOrCreateStaging(cwd);
		const resolved = resolvePlan({
			cwd,
			stagingDir: staging.dir,
			adopted: staging.adopted,
			mode,
			candidate: generation.plan,
			previousPlan: existingMeta?.plan,
			gitHead: existingMeta?.gitHead ?? null,
		});
		const owed = resolved.plan.pages.filter((page) => page.status !== "written").length;
		progress(input, {
			phase: "codewiki",
			status: "running",
			message: `selected ${generation.depth} wiki strategy`,
			detail:
				`${generation.sourceFiles} source files; ${generation.sourceLines} lines; ` +
				`${resolved.plan.pages.length} pages planned; ${owed} to write` +
				(resolved.resumed ? "; resuming an interrupted run" : ""),
		});
		writeWikiPlanFile(staging.dir, resolved.plan);

		const beforeHash = computeWikiContentHash(cwd);

		if (!input.generate) {
			const problem = "wiki generation requires a model runtime";
			progress(input, { phase: "generate", status: "failed", message: problem });
			progress(input, { phase: "done", status: "failed", message: "wiki generation failed" });
			return failed([problem], listWikiPagesInDir(wikiDir(cwd)).length);
		}

		progress(input, {
			phase: "generate",
			status: "started",
			message: mode === "init" ? "drafting project wiki" : "updating project wiki",
		});
		try {
			await input.generate({
				cwd,
				mode,
				outputDir: staging.dir,
				codewiki,
				generation,
				plan: resolved.plan,
				resumed: resolved.resumed,
				unclaimedAreas: resolved.unclaimedAreas,
				gitHead: existingMeta?.gitHead ?? null,
				...(input.onProgress ? { progress: input.onProgress } : {}),
			});
		} catch (err) {
			// A page dispatch that times out or fails never reaches here: the
			// dispatch layer records it in the plan and moves to the next page. A
			// throw is therefore genuinely unexpected, and the state of the staged
			// tree is unknown. So the live wiki is left exactly as it was, and the
			// staging tree is kept rather than deleted: its finished pages and its
			// plan are what the next run resumes from instead of restarting.
			const problem = err instanceof Error ? err.message : String(err);
			progress(input, { phase: "generate", status: "failed", message: "wiki generator failed", detail: problem });
			progress(input, {
				phase: "done",
				status: "failed",
				message: "wiki generation failed",
				detail: `staged work kept at ${staging.dir}; rerun to resume`,
			});
			return failed([problem], listWikiPagesInDir(wikiDir(cwd)).length);
		}
		progress(input, { phase: "generate", status: "completed", message: "wiki generator completed" });

		const workedPlan = readWikiPlanFile(staging.dir, resolved.plan) ?? resolved.plan;
		const report = assembleWikiTree({ dir: staging.dir, sourceRoot: cwd, plan: workedPlan });
		const finalPlan = reconcilePlan(workedPlan, staging.dir);
		const pendingCount = finalPlan.pages.filter((page) => page.status !== "written").length;
		progress(input, {
			phase: "state",
			status: "running",
			message: `assembled ${report.pages.length} page${report.pages.length === 1 ? "" : "s"}`,
			detail:
				`${report.repaired} repaired; ${report.issues.length} unresolved reference${report.issues.length === 1 ? "" : "s"}` +
				(report.dropped.length > 0 ? `; ${report.dropped.length} empty page dropped` : "") +
				(pendingCount > 0 ? `; ${pendingCount} page${pendingCount === 1 ? "" : "s"} still to write` : ""),
		});

		// The plan lives on in meta.json, so the staged working copy must not be
		// promoted into the wiki tree alongside the pages.
		rmSync(join(staging.dir, WIKI_PLAN_FILE), { force: true });
		const afterHash = computeWikiContentHashOfDir(staging.dir);
		const stagedPages = listWikiPagesInDir(staging.dir);
		// Unresolved references are reported, not fatal. They are repaired in the
		// pages' marker comments and dropped from the routing metadata, so they
		// reach the operator and the next update run without costing this one.
		const problems = report.issues.map((issue) => `${issue.page} has an unresolved ${issue.kind}: ${issue.reference}`);

		const writeMeta = (): void => {
			writeWikiMeta(cwd, {
				version: 1,
				updatedAt: new Date().toISOString(),
				gitHead: currentWikiGitHead(cwd),
				sourceTreeHash,
				model: input.model,
				contentHash: afterHash,
				pages: stagedPages,
				generation: {
					requestedDepth: generation.requestedDepth,
					depth: generation.depth,
					sourceFiles: generation.sourceFiles,
					sourceLines: generation.sourceLines,
					pagesPlanned: finalPlan.pages.length,
					pagesWritten: finalPlan.pages.length - pendingCount,
				},
				plan: finalPlan,
			});
		};

		const done = (status: "generated" | "noop"): RunWikiGenerateResult => ({
			status,
			pages: stagedPages.length,
			pending: pendingCount,
			...(problems.length > 0 ? { problems } : {}),
		});

		// The staged content decides the outcome, never whatever raced into
		// .clio/wiki: only what the harness staged and assembled is trusted. When
		// the assembled tree matches the live wiki byte for byte there is nothing
		// to swap, so metadata is refreshed in place.
		if (afterHash === beforeHash && computeWikiContentHash(cwd) === beforeHash && existingMeta) {
			removeDir(staging.dir);
			// Metadata is left exactly as it was. Rewriting it would churn
			// `updatedAt` and `model` on a run that changed nothing, which makes
			// every no-op look like a regeneration to anything reading the file.
			progress(input, {
				phase: "state",
				status: "completed",
				message: "wiki unchanged; metadata preserved",
				detail: wikiMetaPath(cwd),
			});
			progress(input, { phase: "done", status: "completed", message: "wiki unchanged" });
			return done("noop");
		}

		progress(input, { phase: "state", status: "running", message: "promoting wiki" });
		const promoted = promoteStaging(cwd, staging.dir, writeMeta);
		if (!promoted.ok) {
			progress(input, {
				phase: "done",
				status: "failed",
				message: "wiki promotion failed",
				detail: promoted.problems.join("; "),
			});
			return failed(promoted.problems, listWikiPagesInDir(wikiDir(cwd)).length);
		}
		progress(input, { phase: "state", status: "completed", message: "wiki metadata written" });
		progress(input, {
			phase: "done",
			status: "completed",
			message: pendingCount > 0 ? "wiki partially generated" : "wiki generated",
			...(pendingCount > 0
				? {
						detail: `${pendingCount} page${pendingCount === 1 ? "" : "s"} remain; run \`clio context wiki --update\` to finish`,
					}
				: {}),
		});
		return done("generated");
	} finally {
		lock.release();
	}
}
