import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
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
import { blindOrder, newArenaSeed } from "./blind.js";
import { readArenaStream, readNumstat } from "./facts.js";
import { arenaRoot, contenderDiffPath, contenderStreamPath, matchDir, newArenaMatchId, writeMatch } from "./store.js";
import {
	ARENA_MAX_CONTENDERS,
	ARENA_MIN_CONTENDERS,
	ARENA_SCHEMA_VERSION,
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
	/** How to start this same Clio Coder: the executable and the arguments before the subcommand. */
	clio: { file: string; args: ReadonlyArray<string> };
	/**
	 * The environment each contender inherits. A contender is the operator's own
	 * `clio-coder run`, so it needs the same CLIO_CODER_* homes and provider
	 * credentials the parent holds; the safe-exec allowlist alone would strip them.
	 */
	env: Record<string, string>;
	signal?: AbortSignal;
	onStarted?: (match: ArenaMatch) => void;
	onProgress?: (line: string) => void;
}

/** Seconds a contender gets beyond its own `--timeout` to write its final frames before the arena stops it. */
const TIMEOUT_GRACE_SECONDS = 30;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const CHECK_TAIL_BYTES = 2000;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", internalGitArgv(["-C", cwd, ...args]), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		timeout: 60_000,
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

/** Stage everything the contender left, then diff it against the shared baseline, outside `.clio-coder/`. */
function captureDiff(worktree: string, baseline: string, diffPath: string): ArenaDiffStat {
	git(worktree, ["add", "-A", "--", ".", ":(exclude).clio-coder"]);
	const pathspec = ["--", ".", ":(exclude).clio-coder"];
	const patch = git(worktree, ["diff", "--cached", "--no-color", "--no-ext-diff", baseline, ...pathspec]);
	safeResourceWrite(diffPath, patch);
	return readNumstat(git(worktree, ["diff", "--cached", "--numstat", baseline, ...pathspec]));
}

async function runCheck(input: ArenaRunInput, cwd: string, id: string): Promise<ArenaCheckFact> {
	const result = await runCommandVector(input.clio.file, [...input.clio.args, "verifiers", "dry-run", id], {
		cwd,
		workspaceRoot: cwd,
		env: input.env,
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
		"--json-events",
		"full",
		input.prompt,
	];
}

async function runContender(
	input: ArenaRunInput,
	match: ArenaMatch,
	contender: ArenaContender,
	dir: string,
	place: { cwd: string; workspaceRoot: string; worktree: string | null },
	save: () => void,
): Promise<void> {
	const streamPath = contenderStreamPath(dir, contender.index);
	contender.status = "running";
	save();
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
				env: input.env,
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
			diff = captureDiff(place.worktree, match.baselineSha, contenderDiffPath(dir, contender.index));
		} catch (caught) {
			error = error ?? `diff: ${errorText(caught)}`;
		}
	}
	if (input.check) {
		try {
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
		writes: stream.writes,
		blocks: stream.blocks,
		totalTokens: stream.totalTokens,
		cost: stream.cost,
		finalText: stream.finalText,
		diff,
		check,
		error: error ?? (result !== null && result.exitCode !== 0 && stderrTail.length > 0 ? stderrTail : null),
	};
	contender.facts = facts;
	contender.status = timedOut ? "timed-out" : result?.exitCode === 0 ? "done" : "failed";
	save();
	input.onProgress?.(`contender ${contender.index + 1} ${contender.status}`);
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
	const base = input.readOnly === true || !isGitRepository(cwd) ? null : baselineOf(cwd);
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
		const places: Array<{ cwd: string; workspaceRoot: string; worktree: string | null }> = [];
		if (base !== null) {
			ownership = claimCompeteGroup(base.root, `arena-${id}`);
			const sub = relative(base.root, cwd);
			for (const contender of match.contenders) {
				const worktree: CandidateWorktree = await createCandidateWorktreeMapped(ownership, contender.index + 1, base.sha);
				places.push({ cwd: join(worktree.path, sub), workspaceRoot: worktree.path, worktree: worktree.path });
				registerCompeteGroupRun(ownership, { runId: `${id}-${contender.index + 1}`, pid: null, runtimeKind: "subprocess" });
			}
		} else {
			for (const _ of match.contenders) places.push({ cwd, workspaceRoot: cwd, worktree: null });
		}
		input.onProgress?.(`match ${id}: ${match.contenders.length} contenders, ${match.isolation}`);
		await Promise.all(
			match.contenders.map(async (contender) => {
				await runContender(input, match, contender, dir, places[contender.index] as (typeof places)[number], save);
				if (ownership !== null) settleCompeteGroupRun(ownership, `${id}-${contender.index + 1}`);
			}),
		);
		match.status = "complete";
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
