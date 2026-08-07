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
	writeSync,
} from "node:fs";
import { join } from "node:path";
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
import { listWikiPagesInDir, validateWikiLayoutInDir, WIKI_TEMPORARY_PAGE_NAMES, wikiDir } from "./layout.js";
import {
	computeWikiContentHash,
	computeWikiContentHashOfDir,
	currentWikiGitHead,
	readWikiMeta,
	wikiMetaPath,
	writeWikiMeta,
} from "./meta.js";
import { planWikiGeneration, type WikiDepth, type WikiGenerationPlan } from "./plan.js";
import { buildWikiPrompt, type WikiGenerateMode } from "./prompts.js";

export type { WikiDepth, WikiGenerateMode };

export interface WikiGenerateInput {
	cwd: string;
	mode: WikiGenerateMode;
	prompt: string;
	/**
	 * Absolute staging directory the writer must target. The harness validates
	 * the staged pages and atomically promotes them to .clio/wiki; the callback
	 * (and the worker it drives) must write only here, never into .clio/wiki.
	 */
	outputDir: string;
	/** Auto-classified or operator-selected bounded generation strategy. */
	plan: WikiGenerationPlan;
	progress?: BootstrapProgressSink;
}

export type WikiGenerate = (input: WikiGenerateInput) => void | Promise<void>;

export interface RunWikiGenerateInput {
	cwd?: string;
	mode?: WikiGenerateMode;
	/** Repository-detail policy. Auto scales from indexed files and lines. */
	depth?: WikiDepth;
	model: string;
	generate?: WikiGenerate;
	onProgress?: BootstrapProgressSink;
}

export interface RunWikiGenerateResult {
	status: "generated" | "noop" | "failed";
	pages: number;
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

function removeLeftoverStaging(cwd: string): void {
	const dir = clioDir(cwd);
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
			rmSync(join(dir, entry.name), { recursive: true, force: true });
		}
	}
}

function createStagingDir(cwd: string): string {
	const dir = clioDir(cwd);
	mkdirSync(dir, { recursive: true });
	return mkdtempSync(join(dir, STAGING_PREFIX));
}

/**
 * Seed the staging dir with a copy of the current .clio/wiki pages so update
 * runs make surgical edits and an unchanged run stays byte-identical. meta.json
 * is harness-owned and is never copied.
 */
function seedStaging(cwd: string, stagingDir: string): void {
	const source = wikiDir(cwd);
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(source, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			copyFileSync(join(source, entry.name), join(stagingDir, entry.name));
		}
	}
}

function removeDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
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
		const wikiPlan = planWikiGeneration(codewiki, input.depth ?? "auto");
		progress(input, {
			phase: "codewiki",
			status: "running",
			message: `selected ${wikiPlan.depth} wiki strategy`,
			detail: `${wikiPlan.sourceFiles} source files; ${wikiPlan.sourceLines} lines; one documenter pass; ${wikiPlan.minPages}-${wikiPlan.maxPages} pages guided; at least ${wikiPlan.minPageBytes} bytes/page guided`,
		});
		progress(input, {
			phase: "codewiki",
			status: "completed",
			message: `loaded ${indexedSourceFileCount(codewiki)} source file${indexedSourceFileCount(codewiki) === 1 ? "" : "s"}`,
			current: indexedSourceFileCount(codewiki),
			total: indexedSourceFileCount(codewiki),
		});

		// Clear any staging dirs left by crashed runs before seeding a fresh one.
		removeLeftoverStaging(cwd);
		const stagingDir = createStagingDir(cwd);
		seedStaging(cwd, stagingDir);

		const beforeHash = computeWikiContentHash(cwd);
		const prompt = buildWikiPrompt({
			cwd,
			mode,
			codewiki,
			plan: wikiPlan,
			currentPages: listWikiPagesInDir(wikiDir(cwd)).length,
			gitHead: existingMeta?.gitHead ?? null,
			outputDir: stagingDir,
		});

		if (!input.generate) {
			removeDir(stagingDir);
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
				prompt,
				outputDir: stagingDir,
				plan: wikiPlan,
				...(input.onProgress ? { progress: input.onProgress } : {}),
			});
		} catch (err) {
			removeDir(stagingDir);
			const problem = err instanceof Error ? err.message : String(err);
			progress(input, { phase: "generate", status: "failed", message: "wiki generator failed", detail: problem });
			progress(input, { phase: "done", status: "failed", message: "wiki generation failed", detail: problem });
			return failed([problem], listWikiPagesInDir(wikiDir(cwd)).length);
		}
		progress(input, { phase: "generate", status: "completed", message: "wiki generator completed" });
		for (const temporary of WIKI_TEMPORARY_PAGE_NAMES) rmSync(join(stagingDir, temporary), { force: true });

		const validation = validateWikiLayoutInDir(stagingDir, { sourceRoot: cwd });
		if (!validation.ok) {
			removeDir(stagingDir);
			progress(input, {
				phase: "done",
				status: "failed",
				message: "wiki layout validation failed",
				detail: validation.problems.join("; "),
			});
			return failed(validation.problems, listWikiPagesInDir(wikiDir(cwd)).length);
		}

		const afterHash = computeWikiContentHashOfDir(stagingDir);
		const stagedPages = listWikiPagesInDir(stagingDir);

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
					requestedDepth: wikiPlan.requestedDepth,
					depth: wikiPlan.depth,
					sourceFiles: wikiPlan.sourceFiles,
					sourceLines: wikiPlan.sourceLines,
					researchAgents: wikiPlan.researchAgents,
				},
			});
		};

		// The staged content decides the outcome, never whatever raced into
		// .clio/wiki: only what the harness staged and validated is trusted. When
		// the writer left the seed unchanged, the live wiki should still equal the
		// seed; if it does not, something wrote into .clio/wiki during the run, so
		// promote the validated seed to overwrite the untrusted content rather than
		// leaving it live. This keeps the staging layer self-contained even without
		// the write-root rail.
		if (afterHash === beforeHash && existingMeta) {
			const liveHash = computeWikiContentHash(cwd);
			if (liveHash === beforeHash) {
				removeDir(stagingDir);
				progress(input, {
					phase: "state",
					status: "completed",
					message: "wiki unchanged; metadata preserved",
					detail: wikiMetaPath(cwd),
				});
				progress(input, { phase: "done", status: "completed", message: "wiki unchanged" });
				return { status: "noop", pages: stagedPages.length };
			}
			progress(input, { phase: "state", status: "running", message: "restoring wiki from validated seed" });
			const restored = promoteStaging(cwd, stagingDir, writeMeta);
			if (!restored.ok) {
				progress(input, {
					phase: "done",
					status: "failed",
					message: "wiki restore failed",
					detail: restored.problems.join("; "),
				});
				return failed(restored.problems, listWikiPagesInDir(wikiDir(cwd)).length);
			}
			progress(input, { phase: "done", status: "completed", message: "wiki restored from seed" });
			return { status: "generated", pages: stagedPages.length };
		}

		if (afterHash === beforeHash && !existingMeta) {
			// Content is identical to the existing wiki but no metadata exists yet;
			// keep the current pages and write fresh meta.json without a swap.
			removeDir(stagingDir);
			progress(input, { phase: "state", status: "running", message: "writing wiki metadata" });
			writeMeta();
			progress(input, { phase: "state", status: "completed", message: "wiki metadata written" });
			progress(input, { phase: "done", status: "completed", message: "wiki generated" });
			return { status: "generated", pages: stagedPages.length };
		}

		progress(input, { phase: "state", status: "running", message: "promoting wiki" });
		const promoted = promoteStaging(cwd, stagingDir, writeMeta);
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
		progress(input, { phase: "done", status: "completed", message: "wiki generated" });
		return { status: "generated", pages: stagedPages.length };
	} finally {
		lock.release();
	}
}
