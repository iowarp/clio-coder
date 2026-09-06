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
import type { DecisionLedgerEntry } from "../../session/entries.js";
import { detectProjectType } from "../../session/workspace/project-type.js";
import type { BootstrapProgressSink } from "../bootstrap.js";
import { coordinateCodewikiWrite } from "../codewiki/coordinator.js";
import type { Codewiki } from "../codewiki/schema.js";
import type { Fingerprint } from "../fingerprint.js";
import { readClioState, writeClioState } from "../state.js";
import { assembleWikiTree, pageSourceIndex } from "./assemble.js";
import { inspectWikiPageEvidence } from "./evidence.js";
import { isGeneratedWikiFile, listWikiPagesInDir, WIKI_PLAN_FILE, wikiDir, wikiMarkdownFilesInDir } from "./layout.js";
import {
	computeWikiContentHash,
	computeWikiContentHashOfDir,
	currentWikiGitHead,
	readWikiMeta,
	readWikiMetaInDir,
	type WikiMeta,
	wikiMetaPath,
	writeWikiMeta,
	writeWikiMetaInDir,
} from "./meta.js";
import {
	planWikiGeneration,
	type WikiDepth,
	type WikiGenerationPlan,
	type WikiPlan,
	type WikiPlanPage,
} from "./plan.js";
import { readWikiPlanFile, unclaimedCandidates, writeWikiPlanFile } from "./plan-store.js";
import type { WikiGenerateMode } from "./prompts.js";
import { captureWikiSourceContent, type WikiSourceContent, wikiSourcesMatch } from "./source-content.js";
import { changedPathsSince } from "./staleness.js";

export type { WikiDepth, WikiGenerateMode };

export interface WikiGenerateInput {
	/** The current session board, already scoped to its active branch. */
	decisions?: ReadonlyArray<DecisionLedgerEntry>;
	cwd: string;
	mode: WikiGenerateMode;
	/**
	 * Absolute staging directory the writers must target. The harness assembles
	 * and promotes what it finds here; no writer ever touches .clio-coder/wiki.
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
	/** Operator-requested retry of pending work, including exhausted writers, once this run. */
	retryPending?: boolean;
	/** Indexed areas no existing page covers, offered to a planning pass. */
	unclaimedAreas: ReadonlyArray<WikiPlanPage>;
	gitHead?: string | null;
	progress?: BootstrapProgressSink;
}

export type WikiGenerate = (input: WikiGenerateInput) => void | Promise<void>;

export interface RunWikiGenerateInput {
	/** The current session board, already scoped to its active branch. */
	decisions?: ReadonlyArray<DecisionLedgerEntry>;
	cwd?: string;
	mode?: WikiGenerateMode;
	/** Repository-detail policy. Auto scales decomposition from indexed files and lines. */
	depth?: WikiDepth;
	/** Resume the existing plan, allowing exhausted pending writers one more attempt. */
	retryPending?: boolean;
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

async function loadOrBuildCodewiki(cwd: string): Promise<{
	codewiki: Codewiki;
	fingerprint: Fingerprint;
}> {
	const generatedAt = new Date().toISOString();
	const projectType = detectProjectType(cwd);
	const coordinated = await coordinateCodewikiWrite(
		cwd,
		(current, workspace) => ({
			kind: "ensure",
			cwd: workspace,
			language: projectType,
			current,
			previous: readClioState(workspace)?.fingerprint ?? null,
		}),
		{
			afterCommit: ({ codewiki, fingerprint, changed }, workspace) => {
				const prev = readClioState(workspace);
				if (!changed && prev) return;
				writeClioState(workspace, {
					version: 1,
					projectType: prev?.projectType ?? projectType,
					fingerprint,
					codewikiVersion: codewiki.version,
					...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
					...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
					...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
					...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
					lastSessionAt: prev?.lastSessionAt ?? generatedAt,
					lastIndexedAt: generatedAt,
				});
			},
		},
	);
	if (!coordinated) throw new Error("codewiki wiki transaction did not commit");
	return { codewiki: coordinated.codewiki, fingerprint: coordinated.worker.fingerprint };
}

function failed(problems: string[], pages: number): RunWikiGenerateResult {
	return { status: "failed", pages, problems };
}

const STAGING_PREFIX = "wiki-staging-";
const WIKI_PREV_DIR = "wiki-prev";
const WIKI_LOCK_FILE = "wiki.lock";

function clioDir(cwd: string): string {
	return join(cwd, ".clio-coder");
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
 * Single-flight lock at .clio-coder/wiki.lock. The file is created with the O_EXCL
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

/** Resolve a previous process crash before reading metadata or cleaning staging. */
function recoverPublication(cwd: string): void {
	const wiki = wikiDir(cwd);
	const prev = join(clioDir(cwd), WIKI_PREV_DIR);
	if (!existsSync(prev)) return;
	const valid = (dir: string): boolean => {
		const meta = readWikiMetaInDir(dir);
		return meta !== null && meta.contentHash === computeWikiContentHashOfDir(dir);
	};
	if (valid(wiki)) {
		removeDir(prev);
		return;
	}
	if (!valid(prev)) throw new Error(`wiki recovery requires a valid publication; preserved ${wiki} and ${prev}`);
	if (existsSync(wiki)) {
		const interrupted = mkdtempSync(join(clioDir(cwd), "wiki-interrupted-"));
		renameSync(wiki, join(interrupted, "wiki"));
	}
	renameSync(prev, wiki);
}

/** Promote a prepared content/metadata pair; restore the old pair on rename failure. */
function promoteStaging(cwd: string, stagingDir: string): PromoteResult {
	const wiki = wikiDir(cwd);
	const prev = join(clioDir(cwd), WIKI_PREV_DIR);
	removeDir(prev);
	const hadWiki = existsSync(wiki);
	if (hadWiki) renameSync(wiki, prev);
	try {
		renameSync(stagingDir, wiki);
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
 * A resumed plan retains its structure because finished pages link to its
 * paths. Completed dispatches are reusable only when the checkpoint source
 * content matches; missing or changed evidence requeues the pages. Areas the index has since found that no
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
	sourceContent: WikiSourceContent;
	gitHead: string | null;
}): { plan: WikiPlan; resumed: boolean; unclaimedAreas: WikiPlanPage[] } {
	const staged = input.adopted ? readWikiPlanFile(input.stagingDir) : null;
	const previous = staged ?? (input.mode === "update" ? input.previousPlan : undefined);
	if (previous) {
		const pageSources = pageSourceIndex(input.stagingDir, input.cwd);
		// A partial first publication has no whole-wiki Git certification yet.
		// Its completed pages still have the harness-captured plan baseline.
		const partialHead =
			input.gitHead === null && previous.pages.some((page) => page.status !== "written")
				? previous.sourceGitHead
				: undefined;
		const gitAvailable = changedPathsSince(input.cwd, staged?.sourceGitHead ?? partialHead ?? input.gitHead) !== null;
		const existing = new Set(wikiMarkdownFilesInDir(input.stagingDir));
		const plan = {
			...previous,
			pages: previous.pages.map((page) => {
				if (page.status !== "written") return page;
				const evidence = inspectWikiPageEvidence({
					pagePath: page.path,
					outputDir: input.stagingDir,
					sourceRoot: input.cwd,
				});
				const sources = [
					...page.sources,
					...(page.dependencies ?? []),
					...(pageSources.get(page.path) ?? []),
					...(evidence.dependencies ?? []),
				];
				return gitAvailable &&
					existing.has(page.path) &&
					evidence.ok &&
					wikiSourcesMatch(previous.sourceContent, input.sourceContent, sources)
					? { ...page, dependencies: evidence.dependencies ?? [] }
					: {
							...page,
							status: "pending" as const,
							attempts: 0,
							...(!evidence.ok
								? {
										lastFailure: {
											phase: "validation" as const,
											detail: `saved page evidence check failed: ${evidence.reasons.join("; ")}`.slice(0, 500),
										},
									}
								: {}),
						};
			}),
		};
		return {
			plan,
			resumed: staged !== null,
			unclaimedAreas: staged ? [] : unclaimedCandidates(previous, input.candidate, pageSources),
		};
	}
	return { plan: input.candidate, resumed: false, unclaimedAreas: [] };
}

/**
 * Reconcile the plan against the tree that actually exists. A page whose file
 * the assembly pass dropped, or that was never written, is owed again; a page
 * on disk retains its recorded dispatch outcome. A page
 * created by a writer without a plan entry remains available and is adopted
 * pending: its own completed dispatch has not yet been recorded.
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
			status: "pending" as const,
			attempts: 0,
		}));
	return {
		...plan,
		pages: [
			...plan.pages.map((page) => (onDisk.has(page.path) ? page : { ...page, status: "pending" as const })),
			...adopted,
		],
	};
}

export async function runWikiGenerate(
	input: RunWikiGenerateInput = { model: "configured-clio-target" },
): Promise<RunWikiGenerateResult> {
	const cwd = input.cwd ?? process.cwd();

	const lock = acquireWikiLock(cwd);
	if (!lock.ok) {
		progress(input, { phase: "generate", status: "failed", message: lock.problem });
		progress(input, { phase: "done", status: "failed", message: "wiki generation failed", detail: lock.problem });
		return failed([lock.problem], listWikiPagesInDir(wikiDir(cwd)).length);
	}

	try {
		recoverPublication(cwd);
		const existingMeta = readWikiMeta(cwd);
		const mode = input.mode ?? (existingMeta ? "update" : "init");
		progress(input, { phase: "codewiki", status: "started", message: "loading codewiki for wiki generation" });
		const { codewiki, fingerprint } = await loadOrBuildCodewiki(cwd);
		const sourceTreeHash = fingerprint.treeHash;
		progress(input, {
			phase: "codewiki",
			status: "completed",
			message: `loaded ${indexedSourceFileCount(codewiki)} source file${indexedSourceFileCount(codewiki) === 1 ? "" : "s"}`,
			current: indexedSourceFileCount(codewiki),
			total: indexedSourceFileCount(codewiki),
		});

		const staging = adoptOrCreateStaging(cwd);
		const stagedPlan = staging.adopted ? readWikiPlanFile(staging.dir) : null;
		const savedPlan = stagedPlan ?? (mode === "update" ? existingMeta?.plan : undefined);
		const savedDepth = savedPlan?.depth ?? existingMeta?.generation?.depth;
		const continuing = Boolean(
			stagedPlan || input.retryPending || savedPlan?.pages.some((page) => page.status !== "written"),
		);
		const requestedDepth = input.depth ?? savedPlan?.requestedDepth ?? existingMeta?.generation?.requestedDepth ?? "auto";
		const generation = planWikiGeneration(
			codewiki,
			continuing && (input.depth === undefined || input.depth === "auto") && savedDepth ? savedDepth : requestedDepth,
		);
		// Keep the policy separate from its resolved coverage so a completed auto wiki can grow.
		generation.requestedDepth =
			continuing && (input.depth === undefined || input.depth === "auto")
				? (savedPlan?.requestedDepth ?? existingMeta?.generation?.requestedDepth ?? savedDepth ?? requestedDepth)
				: requestedDepth;
		const depthChanged = Boolean(
			savedPlan && (savedDepth ? savedDepth !== generation.depth : input.depth !== undefined && input.depth !== "auto"),
		);
		const sourceGitHead = currentWikiGitHead(cwd) ?? undefined;
		const sourceContent = captureWikiSourceContent(cwd);
		const resolved = resolvePlan({
			cwd,
			stagingDir: staging.dir,
			adopted: staging.adopted,
			mode,
			candidate: generation.plan,
			previousPlan: existingMeta?.plan,
			sourceContent,
			gitHead: existingMeta?.gitHead ?? null,
		});
		if (input.retryPending && !resolved.resumed && !existingMeta?.plan) {
			if (!staging.adopted) removeDir(staging.dir);
			return failed(
				["no saved wiki plan to retry; run `clio-coder context wiki` first"],
				listWikiPagesInDir(wikiDir(cwd)).length,
			);
		}
		if (depthChanged) {
			resolved.plan = {
				...resolved.plan,
				pages: resolved.plan.pages.map((page) => ({ ...page, status: "pending", attempts: 0 })),
			};
			resolved.resumed = false;
		}
		resolved.plan.depth = generation.depth;
		resolved.plan.requestedDepth = generation.requestedDepth;
		const owed = resolved.plan.pages.filter((page) => page.status !== "written").length;
		progress(input, {
			phase: "codewiki",
			status: "running",
			message: `selected ${generation.depth} wiki strategy`,
			detail:
				`${generation.sourceFiles} source files; ${generation.sourceLines} lines; ` +
				`${resolved.plan.pages.length} pages planned; ${owed} to write` +
				(resolved.resumed ? "; resuming an interrupted run" : "") +
				(depthChanged
					? `; coverage changed from ${savedDepth ?? "legacy unspecified"} to ${generation.depth}; prior pages requeued with prose retained`
					: ""),
		});
		resolved.plan = { ...resolved.plan, sourceTreeHash, sourceContent };
		if (sourceGitHead) resolved.plan.sourceGitHead = sourceGitHead;
		else delete resolved.plan.sourceGitHead;
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
				resumed: resolved.resumed || (input.retryPending === true && !depthChanged),
				...(input.retryPending ? { retryPending: true } : {}),
				unclaimedAreas: resolved.unclaimedAreas,
				...(input.decisions ? { decisions: input.decisions } : {}),
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

		const checkpoint = readWikiPlanFile(staging.dir) ?? resolved.plan;
		// Replanning explicitly retires old planned publications. Other writer
		// additions remain available, including pages linked by completed work.
		for (const path of checkpoint.retiredPages ?? []) rmSync(join(staging.dir, path), { force: true });
		// Capture citation evidence before assembly removes missing paths from
		// routing metadata. Failed refreshes and no-op runs must retain it.
		const citedSources = pageSourceIndex(staging.dir, cwd);
		const currentContent = captureWikiSourceContent(cwd);
		const workedPlan: WikiPlan = {
			...checkpoint,
			sourceTreeHash,
			sourceContent,
			pages: checkpoint.pages.map((page) => {
				const dependencies = [...new Set([...(page.dependencies ?? []), ...(citedSources.get(page.path) ?? [])])];
				const stable = wikiSourcesMatch(sourceContent, currentContent, [...page.sources, ...dependencies]);
				return {
					...page,
					dependencies,
					...(page.status === "written" && !stable ? { status: "pending" as const, attempts: 0 } : {}),
				};
			}),
		};
		if (sourceGitHead) workedPlan.sourceGitHead = sourceGitHead;
		else delete workedPlan.sourceGitHead;
		const report = assembleWikiTree({ dir: staging.dir, sourceRoot: cwd, plan: workedPlan });
		const finalPlan = reconcilePlan(workedPlan, staging.dir);
		delete finalPlan.retiredPages;
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

		const afterHash = computeWikiContentHashOfDir(staging.dir);
		const stagedPages = listWikiPagesInDir(staging.dir);
		// Unresolved references are reported, not fatal. They are repaired in the
		// pages' marker comments and dropped from the routing metadata, so they
		// reach the operator and the next update run without costing this one.
		const problems = report.issues.map((issue) => `${issue.page} has an unresolved ${issue.kind}: ${issue.reference}`);

		const unchanged = afterHash === beforeHash && existingMeta !== null;
		const pendingPublishedPage = finalPlan.pages.some(
			(page) => page.status !== "written" && stagedPages.some((available) => available.path === page.path),
		);
		const meta: WikiMeta = {
			version: 1,
			updatedAt: unchanged ? existingMeta.updatedAt : new Date().toISOString(),
			gitHead: pendingPublishedPage ? (existingMeta?.gitHead ?? null) : currentWikiGitHead(cwd),
			...(pendingPublishedPage
				? existingMeta?.sourceTreeHash
					? { sourceTreeHash: existingMeta.sourceTreeHash }
					: {}
				: { sourceTreeHash }),
			model: unchanged ? existingMeta.model : input.model,
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
		};

		const done = (status: "generated" | "noop"): RunWikiGenerateResult => ({
			status,
			pages: stagedPages.length,
			pending: pendingCount,
			...(problems.length > 0 ? { problems } : {}),
		});

		// The staged content decides the outcome, never whatever raced into
		// .clio-coder/wiki: only what the harness staged and assembled is trusted. When
		// the assembled tree matches the live wiki byte for byte there is nothing
		// to swap, so metadata is refreshed in place.
		if (afterHash === beforeHash && computeWikiContentHash(cwd) === beforeHash && existingMeta) {
			writeWikiMeta(cwd, meta);
			rmSync(join(wikiDir(cwd), WIKI_PLAN_FILE), { force: true });
			removeDir(staging.dir);
			progress(input, {
				phase: "state",
				status: "completed",
				message: "wiki unchanged; progress recorded",
				detail: wikiMetaPath(cwd),
			});
			progress(input, { phase: "done", status: "completed", message: "wiki unchanged" });
			return done("noop");
		}

		// Keep the checkpoint until the complete publication is prepared. A crash
		// during either rename can then recover the last good content/metadata pair.
		writeWikiPlanFile(staging.dir, finalPlan);
		writeWikiMetaInDir(staging.dir, meta);
		progress(input, { phase: "state", status: "running", message: "promoting wiki" });
		const promoted = promoteStaging(cwd, staging.dir);
		if (!promoted.ok) {
			progress(input, {
				phase: "done",
				status: "failed",
				message: "wiki promotion failed",
				detail: promoted.problems.join("; "),
			});
			return failed(promoted.problems, listWikiPagesInDir(wikiDir(cwd)).length);
		}
		rmSync(join(wikiDir(cwd), WIKI_PLAN_FILE), { force: true });
		progress(input, { phase: "state", status: "completed", message: "wiki metadata written" });
		progress(input, {
			phase: "done",
			status: "completed",
			message: pendingCount > 0 ? "wiki partially generated" : "wiki generated",
			...(pendingCount > 0
				? {
						detail: `${pendingCount} page${pendingCount === 1 ? "" : "s"} remain; run \`clio-coder context wiki --update\` to finish`,
					}
				: {}),
		});
		return done("generated");
	} finally {
		lock.release();
	}
}
