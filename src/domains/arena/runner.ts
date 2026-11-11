import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { internalGitArgv, withoutRepositoryEnv } from "../../core/internal-git.js";
import { ensureProjectIgnore } from "../../core/project-root.js";
import { runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import {
	type CandidateWorktree,
	type CompeteGroupOwnership,
	claimCompeteGroup,
	cleanupCompeteGroup,
	createCandidateWorktreeMapped,
	isGitRepository,
	markCompeteGroupCleanupReady,
	registerCompeteGroupRun,
	settleCompeteGroupRun,
} from "../../tools/compete-worktrees.js";
import { type DeclaredCheck, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "../../tools/verify/catalog.js";
import { resolveVerifyCall, type VerifyResolution } from "../../tools/verify/resolve.js";
import { withContainedYoloPin } from "../safety/autonomy.js";
import { blindOrder, labelForContender, newArenaSeed } from "./blind.js";
import { type ArenaEnvPolicy, arenaContenderEnv } from "./contender-env.js";
import { contenderWrites, readArenaStream, readNumstat } from "./facts.js";
import { arenaRoot, contenderDiffPath, contenderStreamPath, matchDir, newArenaMatchId, writeMatch } from "./store.js";
import {
	ARENA_MAX_CONTENDERS,
	ARENA_MIN_CONTENDERS,
	ARENA_SCHEMA_VERSION,
	type ArenaAutonomy,
	type ArenaCheckFact,
	type ArenaContender,
	type ArenaContenderSpec,
	type ArenaDiffStat,
	type ArenaFacts,
	type ArenaMatch,
} from "./types.js";

export interface ArenaRunInput {
	cwd: string;
	prompt: string;
	contenders: ArenaContenderSpec[];
	seed?: number;
	suite?: string | null;
	timeoutSeconds: number;
	maxCostUsd?: number | null;
	/** A verifier id to dry-run in each contender's worktree once it finishes. */
	check?: string | null;
	/** Run every contender read-only even inside a Git repository. */
	readOnly?: boolean;
	/** Every contender's autonomy; absent is default. Yolo is contained: the caller refuses unconfined. */
	autonomy?: ArenaAutonomy;
	/** How to start this same Clio Coder: the executable and the arguments before the subcommand. */
	clio: { file: string; args: ReadonlyArray<string> };
	/**
	 * The parent's environment. A contender is the operator's own `clio-coder run`, so it needs the CLIO_CODER_* homes
	 * and its target's credentials, which the safe-exec allowlist alone would strip; `envPolicy` decides which of these
	 * variables each contender is given (contender-env.ts).
	 */
	env: Record<string, string>;
	/** The targets and the operator's pass list that scope `env` per contender; absent passes no target's credentials. */
	envPolicy?: ArenaEnvPolicy;
	signal?: AbortSignal;
	onStarted?: (match: ArenaMatch) => void;
	onProgress?: (line: string) => void;
}

/** Seconds a contender gets beyond its own `--timeout` to write its final frames before the arena stops it. */
const TIMEOUT_GRACE_SECONDS = 30;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const CHECK_TAIL_BYTES = 2000;
const NO_ENV_POLICY: ArenaEnvPolicy = { targets: [], passEnv: [] };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", internalGitArgv(["-C", cwd, ...args]), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		timeout: 60_000,
		env: withoutRepositoryEnv(),
	});
}

function baselineOf(cwd: string): { root: string; sha: string } | null {
	try {
		return {
			root: resolve(git(cwd, ["rev-parse", "--show-toplevel"]).trim()),
			sha: git(cwd, ["rev-parse", "HEAD"]).trim(),
		};
	} catch {
		return null;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function validateArenaRunInput(input: Pick<ArenaRunInput, "contenders" | "prompt" | "timeoutSeconds">): void {
	if (input.prompt.trim().length === 0) throw new Error("arena run needs a prompt");
	const count = input.contenders.length;
	if (count < ARENA_MIN_CONTENDERS || count > ARENA_MAX_CONTENDERS) {
		throw new Error(`arena run takes ${ARENA_MIN_CONTENDERS} to ${ARENA_MAX_CONTENDERS} contenders, got ${count}`);
	}
	if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
		throw new Error("arena run --timeout must be a positive whole number of seconds");
	}
}

/** A file the harness copied into a worktree for `--check`: its repository-relative path and the bytes written. */
interface CopiedFile {
	path: string;
	bytes: Buffer;
}

/** Bounds on the uncommitted files a `--check` names; past them the match is refused and the files must be committed. */
const CHECK_INPUT_MAX_FILES = 256;
const CHECK_INPUT_MAX_BYTES = 64 * 1024 * 1024;

interface ArenaPlace {
	cwd: string;
	workspaceRoot: string;
	worktree: string | null;
	copied: CopiedFile[];
	/** The uncommitted files the `--check` names, copied in with the catalog. */
	inputs: ReadonlyArray<string>;
}

/**
 * Stage everything the contender left, then diff it against the shared baseline, outside the repository's
 * `.clio-coder/`. The catalog and check inputs the harness copied in are left out too while each still holds exactly
 * what the harness wrote; a contender's edit to one stays in the diff.
 */
function captureDiff(worktree: string, baseline: string, diffPath: string, copied: CopiedFile[]): ArenaDiffStat {
	const pathspec = ["--", ".", ":(exclude).clio-coder"];
	for (const file of copied) {
		const target = join(worktree, file.path);
		const stat = lstatSync(target, { throwIfNoEntry: false });
		if (stat?.isFile() === true && readFileSync(target).equals(file.bytes))
			pathspec.push(`:(exclude,literal)${file.path}`);
	}
	// Staging takes no exclude: git refuses an exclude that names an ignored path, and a project that ignores
	// `.clio-coder/` still gets the catalog copied in. The exclusions apply only to the diffs read below.
	git(worktree, ["add", "-A", "--", "."]);
	const patch = git(worktree, ["diff", "--cached", "--no-color", "--no-ext-diff", baseline, ...pathspec]);
	safeResourceWrite(diffPath, patch);
	return readNumstat(git(worktree, ["diff", "--cached", "--numstat", baseline, ...pathspec]));
}

/** A `--check` id the source project does not declare, refused before any contender starts. */
export class ArenaCheckError extends Error {}

function refuseUndeclaredCheck(cwd: string, id: string): VerifyResolution {
	const resolution = resolveVerifyCall(cwd, { check: id });
	if (resolution.kind === "unresolved") throw new ArenaCheckError(`arena --check ${id}: ${resolution.message}`);
	return resolution;
}

/**
 * Paths a declared check names, relative to the project: each argv entry (from the check's cwd, and as written), the
 * reference and baseline files, and a reproduce check's pinned inputs. A sweep run's directory is on the argv.
 */
function pathsNamedByCheck(check: DeclaredCheck): string[] {
	const base = check.cwd === "." ? "" : check.cwd;
	const named = new Set<string>();
	const add = (path: string): void => {
		const normalized = posix.normalize(path);
		if (normalized === "." || normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) return;
		named.add(normalized);
	};
	for (const arg of check.command) {
		if (arg.length === 0 || arg.startsWith("-") || arg.includes("\0")) continue;
		add(posix.join(base, arg));
		add(arg);
	}
	if (check.numeric?.reference !== undefined) add(check.numeric.reference);
	if (check.perf?.baseline !== undefined) add(check.perf.baseline);
	for (const pin of check.reproduce?.inputs ?? []) add(pin.path);
	if (check.reproduce?.compare.mode === "reference") add(check.reproduce.compare.reference);
	return [...named];
}

/**
 * The files under the paths a catalog check names that a worktree cut from HEAD would not hold as the project does:
 * untracked (not ignored) or changed since HEAD. Only regular files count; a link is never followed or copied.
 */
function uncommittedCheckInputs(cwd: string, id: string, check: DeclaredCheck): string[] {
	const named = pathsNamedByCheck(check);
	if (named.length === 0) return [];
	const listed = git(cwd, [
		"ls-files",
		"-z",
		"--others",
		"--modified",
		"--exclude-standard",
		"--",
		...named.map((path) => `:(literal)${path}`),
	]);
	const inputs = new Set<string>();
	let bytes = 0;
	for (const path of listed.split("\0")) {
		if (path.length === 0 || path.startsWith("../") || path === PROJECT_VERIFIER_CATALOG_RELATIVE_PATH) continue;
		if (inputs.has(path)) continue;
		const stat = lstatSync(join(cwd, path), { throwIfNoEntry: false });
		if (stat?.isFile() !== true) continue;
		inputs.add(path);
		bytes += stat.size;
		if (inputs.size > CHECK_INPUT_MAX_FILES || bytes > CHECK_INPUT_MAX_BYTES)
			throw new ArenaCheckError(
				`arena --check ${id}: the files it names hold more than ${CHECK_INPUT_MAX_FILES} uncommitted files or ${CHECK_INPUT_MAX_BYTES / (1024 * 1024)} MiB; commit them`,
			);
	}
	return [...inputs].sort();
}

/**
 * Write `bytes` at `path` (relative to the contender's cwd) in a worktree. This runs outside the sandbox, so it never
 * follows a link the worktree holds: a directory on the way that is a link (committed or planted) refuses the copy,
 * and whatever sits at the path, a link included, is removed and the file created fresh.
 */
function writeIntoWorktree(worktree: string, contenderCwd: string, path: string, bytes: Buffer): CopiedFile {
	const parts = relative(worktree, join(contenderCwd, path))
		.split(sep)
		.filter((part) => part.length > 0);
	const name = parts.pop();
	const label = path === PROJECT_VERIFIER_CATALOG_RELATIVE_PATH ? "the verifier catalog" : path;
	if (name === undefined || parts.includes("..")) throw new Error(`${label} is outside the worktree`);
	let dir = realpathSync(worktree);
	for (const part of parts) {
		dir = join(dir, part);
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (stat === undefined) mkdirSync(dir);
		else if (!stat.isDirectory())
			throw new Error(`refusing to copy ${label}: ${relative(worktree, dir)} is not a directory in the worktree`);
	}
	const target = join(dir, name);
	if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) unlinkSync(target);
	writeFileSync(target, bytes, { flag: "wx" });
	return { path: [...parts, name].join("/"), bytes };
}

/**
 * A contender's worktree is cut from HEAD, so a catalog or check input the project keeps untracked is not in it, and
 * a tracked one may be stale beside the operator's edits. The check is judged by the source project's files: the
 * catalog and the uncommitted inputs the check names are copied in before the contender starts and again before the
 * check runs, over anything the contender left there. A source input that is no longer a regular file is skipped.
 */
function copyCheckFiles(
	sourceCwd: string,
	worktree: string,
	contenderCwd: string,
	inputs: ReadonlyArray<string>,
): CopiedFile[] {
	const copied: CopiedFile[] = [];
	for (const path of [PROJECT_VERIFIER_CATALOG_RELATIVE_PATH, ...inputs]) {
		const source = join(sourceCwd, path);
		if (
			path === PROJECT_VERIFIER_CATALOG_RELATIVE_PATH
				? !existsSync(source)
				: lstatSync(source, { throwIfNoEntry: false })?.isFile() !== true
		)
			continue;
		copied.push(writeIntoWorktree(worktree, contenderCwd, path, readFileSync(source)));
	}
	return copied;
}

async function runCheck(input: ArenaRunInput, cwd: string, id: string): Promise<ArenaCheckFact> {
	const result = await runCommandVector(input.clio.file, [...input.clio.args, "verifiers", "dry-run", id], {
		cwd,
		workspaceRoot: cwd,
		env: arenaContenderEnv(input.env, input.envPolicy ?? NO_ENV_POLICY, null),
		timeoutMs: CHECK_TIMEOUT_MS,
		...(input.signal ? { signal: input.signal } : {}),
	});
	const text = `${result.stdout}${result.stderr.length > 0 ? `\n${result.stderr}` : ""}`.trim();
	return { id, exitCode: result.exitCode, tail: text.slice(-CHECK_TAIL_BYTES) };
}

function contenderArgs(input: ArenaRunInput, spec: ArenaContenderSpec, cwd: string, readOnly: boolean): string[] {
	return [
		...input.clio.args,
		"run",
		"--cwd",
		cwd,
		"--target",
		spec.target,
		"--model",
		spec.model,
		"--timeout",
		String(input.timeoutSeconds),
		...(input.maxCostUsd != null ? ["--max-cost-usd", String(input.maxCostUsd)] : []),
		...(readOnly ? ["--read-only"] : []),
		...(input.autonomy === "yolo" ? ["--autonomy", "yolo"] : []),
		"--json-events",
		"full",
		"--",
		input.prompt,
	];
}

async function runContender(
	input: ArenaRunInput,
	match: ArenaMatch,
	contender: ArenaContender,
	dir: string,
	place: ArenaPlace,
	save: () => void,
): Promise<void> {
	const streamPath = contenderStreamPath(dir, contender.index);
	contender.status = "running";
	save();
	const env = arenaContenderEnv(input.env, input.envPolicy ?? NO_ENV_POLICY, contender.target);
	const fd = openSync(streamPath, "w");
	let result: SafeCommandResult | null = null;
	let error: string | null = null;
	try {
		result = await runCommandVector(
			input.clio.file,
			contenderArgs(input, contender, place.cwd, match.isolation === "read-only"),
			{
				cwd: place.cwd,
				workspaceRoot: place.workspaceRoot,
				env: input.autonomy === "yolo" ? withContainedYoloPin(env) : env,
				timeoutMs: (input.timeoutSeconds + TIMEOUT_GRACE_SECONDS) * 1000,
				output: { onStdout: (chunk) => void writeSync(fd, chunk), retainTailBytes: 4096 },
				...(input.signal ? { signal: input.signal } : {}),
			},
		);
	} catch (caught) {
		error = errorText(caught);
	} finally {
		closeSync(fd);
	}
	const stream = readArenaStream(readFileSync(streamPath, "utf8"));
	let diff: ArenaDiffStat | null = null;
	let check: ArenaCheckFact | null = null;
	if (place.worktree !== null && match.baselineSha !== null) {
		try {
			diff = captureDiff(place.worktree, match.baselineSha, contenderDiffPath(dir, contender.index), place.copied);
		} catch (caught) {
			error = error ?? `diff: ${errorText(caught)}`;
		}
	}
	if (input.check) {
		try {
			if (place.worktree !== null) copyCheckFiles(resolve(input.cwd), place.worktree, place.cwd, place.inputs);
			check = await runCheck(input, place.cwd, input.check);
		} catch (caught) {
			check = { id: input.check, exitCode: null, tail: errorText(caught) };
		}
	}
	// Exit 124 is `run --timeout`; the arena's own backstop shows as timedOut.
	const timedOut = result?.timedOut === true || result?.exitCode === 124;
	const stderrTail = result?.stderr.trim().split("\n").slice(-3).join("\n") ?? "";
	const facts: ArenaFacts = {
		exitCode: result?.exitCode ?? null,
		timedOut,
		durationMs: result?.durationMs ?? 0,
		sessionId: stream.sessionId,
		turns: stream.turns,
		toolCalls: stream.toolCalls,
		toolErrors: stream.toolErrors,
		writes: contenderWrites(stream.writes, diff),
		blocks: stream.blocks,
		totalTokens: stream.totalTokens,
		cost: stream.cost,
		finalText: stream.finalText,
		diff,
		check,
		...(stream.autonomy !== null ? { autonomy: stream.autonomy } : {}),
		error: error ?? (result !== null && result.exitCode !== 0 && stderrTail.length > 0 ? stderrTail : null),
	};
	contender.facts = facts;
	contender.status = timedOut ? "timed-out" : result?.exitCode === 0 ? "done" : "failed";
	save();
	// The input position would map labels to the --contender order; only the blind label is safe before a vote.
	input.onProgress?.(`contender ${labelForContender(match, contender.index)} ${contender.status}`);
}

function blindSlot(match: ArenaMatch, index: number): number {
	return match.order.indexOf(index) + 1;
}

/**
 * Run one match: every contender gets the same prompt, the same baseline and
 * the same limits, at the same time. Inside Git each works in its own compete
 * worktree, so their edits never meet and each leaves a diff; outside Git they
 * run read-only. `match.json` is written first and after every step, so a
 * reader can list a match that is still running.
 */
export async function runArenaMatch(input: ArenaRunInput): Promise<ArenaMatch> {
	validateArenaRunInput(input);
	const cwd = resolve(input.cwd);
	const resolution = input.check ? refuseUndeclaredCheck(cwd, input.check) : null;
	const base = input.readOnly === true || !isGitRepository(cwd) ? null : baselineOf(cwd);
	const inputs =
		base !== null && input.check && resolution?.kind === "catalog"
			? uncommittedCheckInputs(cwd, input.check, resolution.check)
			: [];
	const projectRoot = base?.root ?? cwd;
	const root = arenaRoot(projectRoot);
	const id = newArenaMatchId();
	const seed = input.seed ?? newArenaSeed();
	const match: ArenaMatch = {
		schemaVersion: ARENA_SCHEMA_VERSION,
		id,
		createdAt: new Date().toISOString(),
		completedAt: null,
		status: "running",
		prompt: input.prompt,
		suite: input.suite ?? null,
		root: projectRoot,
		baselineSha: base?.sha ?? null,
		isolation: base === null ? "read-only" : "worktree",
		autonomy: input.autonomy ?? "default",
		seed,
		order: blindOrder(input.contenders.length, seed),
		timeoutSeconds: input.timeoutSeconds,
		maxCostUsd: input.maxCostUsd ?? null,
		check: input.check ?? null,
		contenders: input.contenders.map((spec, index) => ({ ...spec, index, status: "pending", facts: null })),
		error: null,
	};
	ensureProjectIgnore(projectRoot);
	const dir = matchDir(root, id);
	const save = (): void => writeMatch(root, match);
	save();
	input.onStarted?.(match);

	let ownership: CompeteGroupOwnership | null = null;
	try {
		const places: ArenaPlace[] = [];
		if (base !== null) {
			ownership = claimCompeteGroup(base.root, `arena-${id}`);
			const sub = relative(base.root, cwd);
			for (const contender of match.contenders) {
				// Worktree, branch and run are numbered by blind slot (A is 1), never by --contender
				// position, so a path an agent quotes back says nothing the label does not.
				const slot = blindSlot(match, contender.index);
				const worktree: CandidateWorktree = await createCandidateWorktreeMapped(ownership, slot, base.sha);
				let copied: CopiedFile[] = [];
				if (input.check) {
					try {
						copied = copyCheckFiles(cwd, worktree.path, join(worktree.path, sub), inputs);
					} catch {
						// The copy before the check repeats this and reports a refusal as the check's result.
					}
				}
				places.push({
					cwd: join(worktree.path, sub),
					workspaceRoot: worktree.path,
					worktree: worktree.path,
					copied,
					inputs,
				});
				registerCompeteGroupRun(ownership, { runId: `${id}-${slot}`, pid: null, runtimeKind: "subprocess" });
			}
		} else {
			for (const _ of match.contenders) places.push({ cwd, workspaceRoot: cwd, worktree: null, copied: [], inputs: [] });
		}
		input.onProgress?.(
			`match ${id}: ${match.contenders.length} contenders, ${match.isolation}, autonomy ${match.autonomy === "yolo" ? "yolo (contained)" : "default"}`,
		);
		// One contender failing outright (its stream or a save failing) stops the others, and
		// cleanup waits until every contender has settled, so no worktree is removed under a live run.
		const halt = new AbortController();
		const signal = input.signal ? AbortSignal.any([input.signal, halt.signal]) : halt.signal;
		const contenderInput: ArenaRunInput = { ...input, signal };
		const settled = await Promise.allSettled(
			match.contenders.map(async (contender) => {
				try {
					await runContender(
						contenderInput,
						match,
						contender,
						dir,
						places[contender.index] as (typeof places)[number],
						save,
					);
				} catch (caught) {
					if (contender.status === "pending" || contender.status === "running") contender.status = "failed";
					halt.abort();
					throw caught;
				} finally {
					if (ownership !== null) settleCompeteGroupRun(ownership, `${id}-${blindSlot(match, contender.index)}`);
				}
			}),
		);
		const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		if (failure !== undefined) throw failure.reason;
		if (input.signal?.aborted) {
			match.status = "failed";
			match.error = "canceled before every contender finished";
		} else match.status = "complete";
	} catch (caught) {
		match.status = "failed";
		match.error = errorText(caught);
	} finally {
		if (ownership !== null) {
			try {
				cleanupCompeteGroup(markCompeteGroupCleanupReady(ownership));
			} catch (caught) {
				match.error = match.error ?? `worktree cleanup: ${errorText(caught)}`;
			}
		}
		match.completedAt = new Date().toISOString();
		save();
	}
	return match;
}
