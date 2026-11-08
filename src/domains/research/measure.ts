/**
 * Measurement through the verifier's own pieces: the objective check's declared argv runs on the safe-exec spine
 * under the judged-check output ceiling, from the check's declared cwd inside the measured worktree, and its stdout is
 * read with the numeric-compare payload parser. Gate checks run through `runProjectCheck` itself, so their results,
 * judgements and claims are exactly what `verify` would produce in that worktree.
 */
import { posix } from "node:path";
import { runCommandVector } from "../../core/safe-exec.js";
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
): Promise<{ ok: true; pairs: Array<{ base: number; candidate: number }> } | { ok: false; reason: string }> {
	const pairs: Array<{ base: number; candidate: number }> = [];
	for (let trial = 0; trial < trials; trial++) {
		const base = await measure("base");
		if (!base.ok) return { ok: false, reason: `base run ${trial + 1}: ${base.reason}` };
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
export async function runGateIn(worktree: string, check: DeclaredCheck, signal?: AbortSignal): Promise<ToolResult> {
	const previous = process.cwd();
	process.chdir(worktree);
	try {
		return await runProjectCheck(check, signal !== undefined ? { signal } : undefined);
	} finally {
		process.chdir(previous);
	}
}

/** Repository-relative files a check's argv names, as they exist in `root`: those are protected from the agent. */
export function filesNamedByCheck(check: DeclaredCheck, exists: (relative: string) => boolean): string[] {
	const named = new Set<string>();
	const base = check.cwd === "." || check.cwd.length === 0 ? "" : check.cwd;
	const candidates = [...check.command.slice(1)];
	if (check.numeric?.reference !== undefined) candidates.push(check.numeric.reference);
	if (check.perf?.baseline !== undefined) candidates.push(check.perf.baseline);
	for (const arg of candidates) {
		if (arg.startsWith("-") || arg.includes("\0")) continue;
		for (const relative of [posix.normalize(posix.join(base, arg)), posix.normalize(arg)]) {
			if (relative.startsWith("../") || posix.isAbsolute(relative) || relative === ".") continue;
			if (exists(relative)) named.add(relative);
		}
	}
	return [...named].sort();
}

/** Whether `path` is or lies under a protected path. */
export function touchesProtected(path: string, protectedPaths: ReadonlyArray<string>): boolean {
	return protectedPaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

export function inScope(path: string, scope: ReadonlyArray<string>): boolean {
	return scope.length === 0 || scope.some((pattern) => path === pattern || posix.matchesGlob(path, pattern));
}
