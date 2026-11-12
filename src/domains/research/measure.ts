/**
 * Measurement through the verifier's own pieces: the objective check's declared argv runs on the safe-exec spine
 * under the judged-check output ceiling, from the check's declared cwd inside the measured worktree, and its stdout is
 * read with the numeric-compare payload parser. Gate checks run through `runProjectCheck` itself, so their results,
 * judgements and claims are exactly what `verify` would produce in that worktree.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { runCommandVector } from "../../core/safe-exec.js";
import type { MainSandboxPolicy } from "../../core/sandbox/main-session.js";
import type { ToolResult } from "../../tools/registry.js";
import { type DeclaredCheck, resolveProjectVerifierExecutionCwd } from "../../tools/verify/catalog.js";
import { extractNumericPayloadText, parseNumericPayload } from "../../tools/verify/numeric.js";
import { JUDGED_CHECK_MAX_OUTPUT_BYTES, runProjectCheck } from "../../tools/verify/scripts.js";

/** One objective value, or why the run produced none. */
export type ObjectiveValue = { ok: true; value: number } | { ok: false; reason: string };

/** Read `metric` from a check's stdout; a perf-budget check's `wall_ms` falls back to the measured duration. */
export function objectiveFromOutput(
	check: Pick<DeclaredCheck, "kind">,
	metric: string,
	stdout: string,
	durationMs: number,
): ObjectiveValue {
	const payload = parseNumericPayload(extractNumericPayloadText(stdout), "objective output");
	if (!(payload instanceof Error)) {
		const value = payload[metric];
		if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
		if (value !== undefined) return { ok: false, reason: `'${metric}' is not one finite number` };
	}
	if (check.kind === "perf-budget" && metric === "wall_ms") return { ok: true, value: durationMs };
	return {
		ok: false,
		reason:
			payload instanceof Error
				? payload.message
				: `the payload has no '${metric}' key (${Object.keys(payload).join(", ")})`,
	};
}

export async function runObjective(
	check: DeclaredCheck,
	metric: string,
	worktree: string,
	signal?: AbortSignal,
	shellSandbox?: MainSandboxPolicy,
): Promise<ObjectiveValue> {
	const [file, ...args] = check.command;
	if (file === undefined) return { ok: false, reason: `check '${check.id}' has an empty argv` };
	const cwd = resolveProjectVerifierExecutionCwd(check.cwd, worktree);
	if (cwd instanceof Error) return { ok: false, reason: cwd.message };
	const result = await runCommandVector(file, args, {
		cwd,
		workspaceRoot: worktree,
		timeoutMs: check.timeoutMs,
		maxOutputBytes: JUDGED_CHECK_MAX_OUTPUT_BYTES,
		...(signal !== undefined ? { signal } : {}),
		...(shellSandbox !== undefined ? { shellSandbox } : {}),
	});
	if (result.aborted) return { ok: false, reason: "aborted" };
	if (result.timedOut) return { ok: false, reason: `timed out after ${check.timeoutMs}ms` };
	if (result.outputCapped) return { ok: false, reason: "output exceeded the judged-check ceiling" };
	if (result.exitCode !== 0) {
		const tail = `${result.stdout}${result.stderr}`.trim().slice(-400);
		return { ok: false, reason: `exited with code ${result.exitCode ?? "?"}${tail.length > 0 ? `: ${tail}` : ""}` };
	}
	return objectiveFromOutput(check, metric, result.stdout, result.durationMs);
}

/**
 * Interleaved pairs: base then candidate, `trials` times, so drift in the machine falls on both sides alike. Stops at
 * the first run that produced no value and returns its reason.
 */
export async function measurePairs(
	trials: number,
	measure: (side: "base" | "candidate") => Promise<ObjectiveValue>,
	/** Checked before every run: true ends the measurement there (an operator stop or the wall deadline). */
	stop: () => boolean = () => false,
): Promise<{ ok: true; pairs: Array<{ base: number; candidate: number }> } | { ok: false; reason: string }> {
	const pairs: Array<{ base: number; candidate: number }> = [];
	for (let trial = 0; trial < trials; trial++) {
		if (stop()) return { ok: false, reason: `stopped before base run ${trial + 1}` };
		const base = await measure("base");
		if (!base.ok) return { ok: false, reason: `base run ${trial + 1}: ${base.reason}` };
		if (stop()) return { ok: false, reason: `stopped before candidate run ${trial + 1}` };
		const candidate = await measure("candidate");
		if (!candidate.ok) return { ok: false, reason: `candidate run ${trial + 1}: ${candidate.reason}` };
		pairs.push({ base: base.value, candidate: candidate.value });
	}
	return { ok: true, pairs };
}

/**
 * Run a declared check as `verify` would from `worktree`. `runProjectCheck` resolves the check's cwd and any
 * reference file against the process working directory, so the process enters the worktree for the call. The
 * research loop is the only work in its process while this runs.
 */
export async function runGateIn(
	worktree: string,
	check: DeclaredCheck,
	signal?: AbortSignal,
	shellSandbox?: MainSandboxPolicy,
): Promise<ToolResult> {
	const previous = process.cwd();
	process.chdir(worktree);
	try {
		return await runProjectCheck(check, {
			...(signal !== undefined ? { signal } : {}),
			...(shellSandbox !== undefined ? { shellSandbox } : {}),
		});
	} finally {
		process.chdir(previous);
	}
}

/** `target` as a repository-relative posix path under `rootReal`, or null when it lies outside. */
function insideRoot(rootReal: string, target: string): string | null {
	const rel = relative(rootReal, target);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

/** How many links one path's resolution may follow, as a kernel bounds it; a longer chain is a loop. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Every symlink inside the repository that resolving `path` passes through, repository-relative: links on the path's
 * own components and, recursively, links on the components of each link's target. Retargeting any of them would
 * redirect the path, so each is protected. Resolution stops after `MAX_SYMLINK_HOPS` links.
 */
function symlinksResolving(rootReal: string, path: string): string[] {
	const links = new Set<string>();
	const pending = path.split("/");
	let current = rootReal;
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift() as string;
		if (part === "" || part === ".") continue;
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		const next = join(current, part);
		let link: string;
		try {
			if (!lstatSync(next).isSymbolicLink()) {
				current = next;
				continue;
			}
			link = readlinkSync(next);
		} catch {
			break;
		}
		if (++hops > MAX_SYMLINK_HOPS) break;
		const rel = insideRoot(rootReal, next);
		if (rel !== null && rel.length > 0) links.add(rel);
		if (isAbsolute(link)) current = sep;
		pending.unshift(...link.split(sep));
	}
	return [...links];
}

/**
 * Repository-relative files a check's argv names, as they exist in `root`: those are protected from the agent. Every
 * argv entry counts, the executable included, so a repo-local `./bench.py` is protected as much as `python3 bench.py`.
 * Every symlink that resolving a named path passes through (its own components, and recursively the components of each
 * link's target) is protected as a link, and the path's
 * resolved target inside the repository is protected too, so neither the link nor what it reaches can be swapped.
 */
export function filesNamedByCheck(check: DeclaredCheck, root: string): string[] {
	const named = new Set<string>();
	const rootReal = realpathSync(root);
	const base = check.cwd === "." || check.cwd.length === 0 ? "" : check.cwd;
	const candidates = [...check.command];
	if (check.numeric?.reference !== undefined) candidates.push(check.numeric.reference);
	if (check.perf?.baseline !== undefined) candidates.push(check.perf.baseline);
	for (const arg of candidates) {
		if (arg.startsWith("-") || arg.includes("\0")) continue;
		for (const relative of [posix.normalize(posix.join(base, arg)), posix.normalize(arg)]) {
			if (relative.startsWith("../") || posix.isAbsolute(relative) || relative === ".") continue;
			const full = join(root, relative);
			if (!existsSync(full)) continue;
			named.add(relative);
			for (const link of symlinksResolving(rootReal, relative)) named.add(link);
			const resolved = insideRoot(rootReal, realpathSync(full));
			if (resolved !== null && resolved.length > 0) named.add(resolved);
		}
	}
	return [...named].sort();
}

/** Whether `path`, normalized, is or lies under a protected path. */
export function touchesProtected(path: string, protectedPaths: ReadonlyArray<string>): boolean {
	const normalized = posix.normalize(path);
	return protectedPaths.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

/**
 * Whether a changed path reaches a protected file. `path` comes from the diff of the base tree against the candidate
 * with renames split, so a deletion, replacement or rename of a protected path shows up under its base name. It
 * reaches one when it is or lies under a protected path, when it is a parent component of one (a directory or link
 * replaced on the way to it), or when in `worktree` it is a symlink whose target (as written, and as resolved) is,
 * contains or lies under a protected path, or leaves the worktree.
 */
export function changeReachesProtected(worktree: string, path: string, protectedPaths: ReadonlyArray<string>): boolean {
	if (touchesProtected(path, protectedPaths)) return true;
	const normalized = posix.normalize(path);
	if (protectedPaths.some((entry) => entry.startsWith(`${normalized}/`))) return true;
	const full = join(worktree, posix.normalize(path));
	let link: string;
	try {
		if (!lstatSync(full).isSymbolicLink()) return false;
		link = readlinkSync(full);
	} catch {
		return false;
	}
	const rootReal = realpathSync(worktree);
	const targets = [resolve(realpathSync(dirname(full)), link)];
	try {
		targets.push(realpathSync(full));
	} catch {
		// A dangling link is judged by what it names.
	}
	return targets.some((target) => {
		const rel = insideRoot(rootReal, target);
		if (rel === null || rel.length === 0) return true;
		return touchesProtected(rel, protectedPaths) || protectedPaths.some((entry) => entry.startsWith(`${rel}/`));
	});
}

// posix.matchesGlob is minimatch without a dot option, so * and ** skipped .github/ and .env. Same matcher and
// options as Node's, plus dot.
const SCOPE_GLOB_OPTIONS = {
	dot: true,
	nonegate: true,
	nocomment: true,
	optimizationLevel: 2,
	windowsPathsNoEscape: true,
} as const;

export function inScope(path: string, scope: ReadonlyArray<string>): boolean {
	return scope.length === 0 || scope.some((pattern) => path === pattern || minimatch(path, pattern, SCOPE_GLOB_OPTIONS));
}
