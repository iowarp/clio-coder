import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { clioDataDir } from "../../core/xdg.js";
import { recordClaimRegressions } from "../memory/index.js";
import type { MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimFromVerifyResult, claimsFromHostVerification, type SealedHostCheck } from "./capture.js";
import { claimBackingRefs, claimRegressionNote, overturnedAgreements, regressionRecord } from "./edges.js";
import { type CheckRun, hypothesesFromSlate, isHypothesisSlate, type SlateOrigin } from "./hypotheses.js";
import {
	appendCheckStarts,
	appendClaimRegressions,
	appendClaims,
	appendHypotheses,
	appendHypothesisTests,
	claimsProjectRoot,
	readClaims,
} from "./store.js";
import type { ClaimRecord } from "./types.js";

export const CLAIM_CAPTURE_REGISTRATION_ID = "observer.claims-capture";
const HYPOTHESIS_CAPTURE_REGISTRATION_ID = "observer.hypothesis-capture";

/** A slate past this size is not read; a hypothesis slate is a few KB. */
const SLATE_MAX_BYTES = 1024 * 1024;
/** Verify calls bound but not yet finished; a call another hook blocked never reaches after_tool, so the oldest go. */
const OPEN_VERIFY_BINDINGS_MAX = 64;
/** Files of one accepted worker run read as possible slates. */
const WORKER_SLATE_PATHS_MAX = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The run a verify result records, or null when the check never ran: no declared check, no judgement, or a runner
 * that was unavailable. A run that started is a test of any hypothesis naming the check, judged or not.
 */
function verifyRun(
	details: Readonly<Record<string, unknown>> | undefined,
	bound: { check: string; hypotheses: string[] } | undefined,
	claim: ClaimRecord | null,
	source: CheckRun["source"],
	at: string,
): CheckRun | null {
	if (details === undefined || typeof details.check !== "string" || bound?.check !== details.check) return null;
	const judgement = details.judgement;
	if (!isRecord(judgement) || typeof judgement.execution !== "string" || judgement.execution === "unavailable")
		return null;
	return {
		check: details.check,
		hypotheses: bound.hypotheses,
		execution: judgement.execution,
		...(claim !== null ? { claim } : {}),
		source,
		at,
	};
}

/**
 * Captures the claim a main-thread `verify` result carries (#406). Only the main session registers it, so a worker's
 * own verify call, which judges the worker's tree under the worker's control, never writes the operator's log; a
 * worker run's checks reach the log through host verification instead. The phase is awaited, so a headless run
 * cannot exit before its claim is on disk. The hypotheses a call tests are bound in before_tool, after admission and
 * just before the check starts, so a hypothesis proposed or revised while it ran is not credited with its result.
 */
export function createClaimCaptureRegistration(options: {
	cwd: () => string;
	now?: () => Date;
}): MiddlewareHookRegistration {
	const now = options.now ?? (() => new Date());
	const open = new Map<string, { check: string; hypotheses: string[] }>();
	return {
		id: CLAIM_CAPTURE_REGISTRATION_ID,
		description: "record a judged reproduce or numeric-compare verify result in the project's claims log",
		hooks: ["before_tool", "after_tool"],
		toolNames: [ToolNames.Verify],
		evidence: "typed:verify.report@tool-result",
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(input: MiddlewareHookInput) {
			if (input.toolName !== ToolNames.Verify) return [];
			const callId = input.toolCallId;
			if (input.hook === "before_tool") {
				const check = input.toolArgs?.check;
				if (callId === undefined || typeof check !== "string") return [];
				open.delete(callId);
				const run = { channel: "verify" as const, sessionId: input.sessionId ?? null, toolCallId: callId };
				const started = await appendCheckStarts(claimsProjectRoot(options.cwd()), run, [check], now().toISOString());
				open.set(callId, { check, hypotheses: started.get(check) ?? [] });
				for (const stale of open.keys()) {
					if (open.size <= OPEN_VERIFY_BINDINGS_MAX) break;
					open.delete(stale);
				}
				return [];
			}
			const bound = callId === undefined ? undefined : open.get(callId);
			if (callId !== undefined) open.delete(callId);
			const project = claimsProjectRoot(options.cwd());
			const at = now().toISOString();
			const source = {
				channel: "verify" as const,
				sessionId: input.sessionId ?? null,
				toolCallId: input.toolCallId ?? null,
				requestedBy: input.metadata?.origin === "harness" ? ("harness" as const) : ("model" as const),
			};
			const claim = claimFromVerifyResult({ details: input.toolResultDetails, project, at, source });
			if (claim !== null) await recordClaims([claim], now());
			// After the claim is on disk, so a test record never names a claim the log does not hold yet.
			const run = verifyRun(input.toolResultDetails, bound, claim, source, at);
			if (run !== null) await appendHypothesisTests(project, [run]);
			return [];
		},
	};
}

/**
 * Records the hypotheses of a hypothesis-workflow slate the main session writes or edits (#406), at `proposed`. The
 * slate is read from disk after the tool ran, so what is recorded is the file as it stands, whichever tool shaped it.
 * Like claim capture, only the main session registers it: a worker's slate is the worker's draft until the main
 * session writes it into the project.
 */
export function createHypothesisCaptureRegistration(options: {
	cwd: () => string;
	now?: () => Date;
}): MiddlewareHookRegistration {
	const now = options.now ?? (() => new Date());
	return {
		id: HYPOTHESIS_CAPTURE_REGISTRATION_ID,
		description: "record the hypotheses of a written hypothesis slate in the project's claims log as proposed",
		hooks: ["after_tool"],
		toolNames: [ToolNames.Write, ToolNames.Edit],
		evidence: "typed:hypothesis-slate@tool-args",
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(input: MiddlewareHookInput) {
			const path = input.toolArgs?.path;
			if (typeof path !== "string") return [];
			const cwd = options.cwd();
			const snapshot = snapshotSlate(resolve(cwd, path));
			if (snapshot === null) return [];
			// A capture that finds the file rewritten by the time it holds the log's lock records nothing: the
			// newer write's own capture records the bytes the file holds.
			await recordSlate({
				snapshot,
				project: claimsProjectRoot(cwd),
				at: now().toISOString(),
				source: { channel: "slate", sessionId: input.sessionId ?? null, toolCallId: input.toolCallId ?? null },
			});
			return [];
		},
	};
}

/** A file's bytes as read at one moment, and their sha256. */
interface SlateSnapshot {
	readonly path: string;
	readonly text: string;
	readonly sha256: string;
}

/** The slates of a worker run's accepted paths, with their bytes as the host accepted them. */
export type AcceptedWorkerSlates = ReadonlyArray<SlateSnapshot>;

/** A `.json` file's bytes as they stand, or null when it is absent, unreadable or past the slate bound. */
function slateBytes(absolute: string): Buffer | null {
	if (!absolute.endsWith(".json")) return null;
	try {
		if (statSync(absolute).size > SLATE_MAX_BYTES) return null;
		const bytes = readFileSync(absolute);
		return bytes.length <= SLATE_MAX_BYTES ? bytes : null;
	} catch {
		// A write that failed or a file removed since leaves no slate to record.
		return null;
	}
}

function bytesSha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function snapshotSlate(absolute: string): SlateSnapshot | null {
	const bytes = slateBytes(absolute);
	return bytes === null ? null : { path: absolute, text: bytes.toString("utf8"), sha256: bytesSha256(bytes) };
}

/**
 * Record the hypotheses a slate snapshot holds. The file is read again once the log's lock is held, and nothing is
 * written unless it still holds the snapshot's bytes: a capture that waited on the lock behind a newer write of the
 * same slate would otherwise revise the newer record back to bytes the file no longer holds. Returns the number of
 * records written, or null when the file changed after the snapshot.
 */
async function recordSlate(input: {
	snapshot: SlateSnapshot;
	project: string;
	at: string;
	source: SlateOrigin;
}): Promise<number | null> {
	const { snapshot } = input;
	const drafts = hypothesesFromSlate({
		text: snapshot.text,
		slateSha256: snapshot.sha256,
		path: snapshot.path,
		project: input.project,
		at: input.at,
		source: input.source,
	});
	if (drafts === null || drafts.length === 0) return 0;
	const written = await appendHypotheses(input.project, drafts, () => {
		const bytes = slateBytes(snapshot.path);
		return bytes !== null && bytesSha256(bytes) === snapshot.sha256;
	});
	return written === null ? null : written.length;
}

/**
 * Bind each declared check of a worker run to the hypotheses it tests (#406), just before host verification starts
 * them: a check-start record per bound check is appended to the project's log, and the returned bindings are carried
 * to `recordHostVerificationClaims`, so a slate written while the checks ran is not credited.
 */
export async function bindHostVerificationHypotheses(
	projectCwd: string,
	runId: string,
	checks: ReadonlyArray<string>,
	now: Date = new Date(),
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
	return appendCheckStarts(
		claimsProjectRoot(projectCwd),
		{ channel: "host-verification", runId },
		checks,
		now.toISOString(),
	);
}

/**
 * The slates among the paths the host just accepted from a worker run (#406), with their bytes as accepted: the paths
 * are the host's own account of what landed (a merged task worktree's changed paths, or the writes it observed a run
 * in the checkout make). The caller reads them in the same synchronous step that accepted the run, so a file replaced
 * while the receipt is sealed is not credited to the run. A path that is not absolute, not `.json`, outside the
 * project or not a hypothesis slate is dropped.
 */
export function snapshotAcceptedWorkerSlates(input: {
	projectCwd: string;
	paths: ReadonlyArray<string>;
}): AcceptedWorkerSlates {
	const project = claimsProjectRoot(input.projectCwd);
	const physical = (path: string): string => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	};
	const absolutes = [...new Set(input.paths.filter((path) => isAbsolute(path)).map(physical))]
		.filter((absolute) => {
			if (!isAbsolute(absolute) || !absolute.endsWith(".json")) return false;
			const inside = relative(project, absolute);
			return inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside);
		})
		.slice(0, WORKER_SLATE_PATHS_MAX);
	const slates: SlateSnapshot[] = [];
	for (const absolute of absolutes) {
		const snapshot = snapshotSlate(absolute);
		if (snapshot !== null && isHypothesisSlate(snapshot.text)) slates.push(snapshot);
	}
	return slates;
}

/**
 * Record the slates `snapshotAcceptedWorkerSlates` read when the host accepted a worker run, keyed by its sealed
 * receipt. Each is recorded from its accepted bytes and only while the file still holds them; a slate that changed
 * since is not recorded and is returned in `drifted`. A status the worker wrote is never read as evidence: only
 * entries still at proposed are recorded, as for a main-session slate.
 */
export async function recordAcceptedWorkerSlates(input: {
	runId: string;
	receiptDigest: string;
	projectCwd: string;
	slates: AcceptedWorkerSlates;
	now?: Date;
}): Promise<{ recorded: number; drifted: string[] }> {
	const project = claimsProjectRoot(input.projectCwd);
	const at = (input.now ?? new Date()).toISOString();
	const source: SlateOrigin = { channel: "worker-slate", runId: input.runId, receiptDigest: input.receiptDigest };
	let recorded = 0;
	const drifted: string[] = [];
	for (const snapshot of input.slates) {
		const written = await recordSlate({ snapshot, project, at, source });
		if (written === null) drifted.push(snapshot.path);
		else recorded += written;
	}
	return { recorded, drifted };
}

/**
 * Record the claims a settled worker run's host verification yields. `projectCwd` is the operator's checkout the run
 * belongs to, never a task worktree, so a worktree run's claims land in its project's log.
 */
export async function recordHostVerificationClaims(input: {
	runId: string;
	receiptDigest: string;
	checks: ReadonlyArray<SealedHostCheck>;
	projectCwd: string;
	/** The hypotheses each check was bound to when host verification started it; a check absent here tests none. */
	hypotheses?: ReadonlyMap<string, ReadonlyArray<string>>;
	now?: Date;
}): Promise<number> {
	const project = claimsProjectRoot(input.projectCwd);
	const at = (input.now ?? new Date()).toISOString();
	const claims = claimsFromHostVerification({
		runId: input.runId,
		receiptDigest: input.receiptDigest,
		checks: input.checks,
		project,
		at,
	});
	if (claims.length > 0) await recordClaims(claims, input.now ?? new Date());
	// Each check this run started itself tests the hypotheses bound to it; a memo hit or a batch member's shared check is
	// the other run's evidence and tested them there, and a check that never started tested nothing.
	const source = { channel: "host-verification" as const, runId: input.runId, receiptDigest: input.receiptDigest };
	const runs = input.checks
		.filter((check) => !check.memo && check.evidenceRunId === undefined && check.notRun === undefined)
		.map((check): CheckRun => {
			const claim = claims.find((candidate) => candidate.keys.check === check.check);
			return {
				check: check.check,
				hypotheses: [...(input.hypotheses?.get(check.check) ?? [])],
				execution: check.exitCode === 0 ? "succeeded" : "failed",
				...(claim !== undefined ? { claim } : {}),
				source,
				at,
			};
		});
	await appendHypothesisTests(project, runs);
	return claims.length;
}

/**
 * Append claims, then carry each contradiction that overturned an agreement into memory (#406): every memory record
 * citing one of the overturned agreeing claims gets a regression naming both claims, written through memory's own
 * locked mutation, and a `regression` line in the claims log names the records it reached, none included.
 */
async function recordClaims(claims: ReadonlyArray<ClaimRecord>, now: Date): Promise<void> {
	const edges = await appendClaims(claims);
	// Every project this append touched, so a contradiction whose regression did not land earlier is retried here.
	const projects = new Set([...claims.map((claim) => claim.project), ...edges.map((edge) => edge.project)]);
	for (const project of projects) {
		const log = readClaims(project);
		const regressed = new Set(log.regressions.map((regression) => regression.edge));
		const group = log.edges.filter((edge) => edge.kind === "contradicts" && !regressed.has(edge.id));
		if (group.length === 0) continue;
		const claimsById = new Map(log.records.map((claim) => [claim.id, claim]));
		const overturned = group.flatMap((edge) => {
			const later = claimsById.get(edge.from);
			const backing = overturnedAgreements(edge, log.records, log.edges);
			return later === undefined || backing.length === 0 ? [] : [{ edge, later, backing }];
		});
		if (overturned.length === 0) continue;
		const inputs = overturned.flatMap(({ later, backing }) =>
			backing.map((claim) => ({ refs: claimBackingRefs(claim), note: claimRegressionNote(later, claim) })),
		);
		let reached: Awaited<ReturnType<typeof recordClaimRegressions>>;
		try {
			reached = await recordClaimRegressions(clioDataDir(), inputs);
		} catch {
			// No regression line is written, so the contradiction stays pending and the next append retries it.
			continue;
		}
		let index = 0;
		const records = overturned.map(({ edge, backing }) => {
			const memory = new Set<string>();
			for (const _claim of backing) for (const id of reached[index++] ?? []) memory.add(id);
			return regressionRecord({ edge, backing, memory: [...memory], at: now.toISOString() });
		});
		await appendClaimRegressions(records);
	}
}
