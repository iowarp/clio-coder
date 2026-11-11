import { isAbsolute, relative } from "node:path";
import {
	normalizePathBoundaryEntry,
	PATH_BOUNDARY_MAX_ENTRIES,
	resolvePathBoundary,
	writeRootsCover,
} from "../../core/path-boundary.js";
import { ToolNames } from "../../core/tool-names.js";
import type { AutonomyLevel } from "../safety/autonomy.js";
import type { DispatchRequest, MainGrantOutcome } from "./contract.js";
import type { GrantBroker, GrantDecision, GrantRecord } from "./grant-broker.js";
import { withDispatchIntentWriteRoots } from "./intent.js";
import { resolveDispatchPathScope } from "./path-scope.js";

/**
 * A write worker that needs a file outside its write roots records a
 * `limitation` with this reason and the paths it needs, then stops. The write
 * roots are sealed into the attempt's permit, so the request cannot widen the
 * running worker: an approval continues the assignment as a new attempt
 * admitted with the wider roots, and a denial settles it as no work done.
 */
export const WRITE_ROOT_LIMITATION_REASON = "write-root";

/** The `tool` a write-root request carries in the grant broker and its views. */
export const WRITE_ROOTS_GRANT_TOOL = "write_roots";

export interface WriteRootRequest {
	/** Why the worker needs the paths, in its own words. */
	scope: string;
	/** Run-cwd-relative boundary entries the worker asked for. */
	paths: string[];
}

export type WriteRootResolution = { ok: true; request: WriteRootRequest } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The write-root request in a run's tool-call feed, merged across calls, or
 * null. Only a `limitation` call whose result was not an error counts, the
 * same rule the finish contract applies to limitation receipts.
 */
export function writeRootRequestFromEntries(entries: ReadonlyArray<unknown>): WriteRootRequest | null {
	const calls = new Map<string, { scope: string; paths: string[] }>();
	const scopes: string[] = [];
	const paths: string[] = [];
	let found = false;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.kind !== "message" || !isRecord(entry.payload)) continue;
		const payload = entry.payload;
		const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
		if (toolCallId === null) continue;
		if (entry.role === "tool_call") {
			const args = isRecord(payload.args) ? payload.args : {};
			if (payload.name !== ToolNames.Limitation) continue;
			if (typeof args.reason !== "string" || args.reason.trim() !== WRITE_ROOT_LIMITATION_REASON) continue;
			calls.set(toolCallId, {
				scope: typeof args.scope === "string" ? args.scope.trim() : "",
				paths: Array.isArray(args.paths)
					? args.paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
					: [],
			});
			continue;
		}
		if (entry.role !== "tool_result" || payload.isError === true) continue;
		const call = calls.get(toolCallId);
		if (call === undefined) continue;
		calls.delete(toolCallId);
		found = true;
		if (call.scope.length > 0 && !scopes.includes(call.scope)) scopes.push(call.scope);
		for (const path of call.paths) if (!paths.includes(path.trim())) paths.push(path.trim());
	}
	return found ? { scope: scopes.join("; ") || "unspecified", paths } : null;
}

/**
 * Check a request against the run it came from: each path must name a place
 * inside the run's working directory that its write roots do not already
 * cover, and the widened roots must still fit the boundary grammar.
 */
export function resolveWriteRootRequest(
	req: Pick<DispatchRequest, "cwd" | "writeRoots" | "intent" | "task" | "briefing">,
	request: WriteRootRequest,
): WriteRootResolution {
	if (request.paths.length === 0) return { ok: false, reason: "the request named no paths" };
	const cwd = req.cwd ?? process.cwd();
	const current = resolveDispatchPathScope(req as DispatchRequest).writeBoundaries;
	if (current.length === 0) {
		return { ok: false, reason: "this assignment declared no write roots, so there is nothing to widen" };
	}
	const wanted: string[] = [];
	for (const raw of request.paths) {
		const trimmed = raw.trim();
		const candidate = isAbsolute(trimmed)
			? `${relative(cwd, trimmed).split("\\").join("/")}${trimmed.endsWith("/") ? "/" : ""}`
			: trimmed;
		let entry: string;
		try {
			entry = normalizePathBoundaryEntry(candidate);
		} catch (error) {
			const why = error instanceof Error ? error.message.replace(/^write boundary: /u, "") : String(error);
			return { ok: false, reason: `'${raw}' cannot be a write root: ${why}` };
		}
		if (!writeRootsCover(current, resolvePathBoundary(cwd, entry)) && !wanted.includes(entry)) wanted.push(entry);
	}
	if (wanted.length === 0) {
		return { ok: false, reason: `the write roots already cover ${request.paths.join(", ")}` };
	}
	const declared = req.intent?.writeRoots.length ?? req.writeRoots?.length ?? 0;
	if (declared + wanted.length > PATH_BOUNDARY_MAX_ENTRIES) {
		return {
			ok: false,
			reason: `widening would declare more than ${PATH_BOUNDARY_MAX_ENTRIES} write roots`,
		};
	}
	return { ok: true, request: { scope: request.scope, paths: wanted } };
}

/**
 * The request fields that carry the wider roots. Both the typed intent and the
 * legacy field are widened together, so they keep naming the same tree.
 */
function widenedWriteRootFields(
	req: Pick<DispatchRequest, "cwd" | "writeRoots" | "intent">,
	paths: ReadonlyArray<string>,
): Pick<DispatchRequest, "writeRoots" | "intent"> {
	const cwd = req.cwd ?? process.cwd();
	return {
		...(req.intent !== undefined
			? { intent: withDispatchIntentWriteRoots(req.intent, [...req.intent.writeRoots, ...paths]) }
			: {}),
		...(req.writeRoots !== undefined
			? { writeRoots: [...req.writeRoots, ...paths.map((path) => resolvePathBoundary(cwd, path))] }
			: {}),
	};
}

/** The note the continuation attempt reads after its parent's briefing. */
function writeRootContinuationBriefing(
	briefing: string | undefined,
	input: { previousRunId: string; request: WriteRootRequest },
): string {
	const note = [
		`Continuation of attempt ${input.previousRunId}, which stopped before editing because it needed paths outside its write roots (${input.request.scope}).`,
		`The coordinator widened your write roots to include ${input.request.paths.join(", ")}. Continue the assignment; that attempt changed no files.`,
	].join("\n");
	return briefing === undefined || briefing.trim().length === 0 ? note : `${briefing}\n\n${note}`;
}

/** The receipt detail for a run that stopped to ask for write roots. */
export function writeRootRequestDetail(
	request: WriteRootRequest,
	resolution: WriteRootResolution,
	routable: boolean,
): string {
	const asked = `worker stopped to ask for write roots ${request.paths.join(", ") || "(none named)"} (${request.scope}) and changed nothing`;
	if (!resolution.ok) return `${asked}; the request cannot be granted: ${resolution.reason}`;
	if (routable) return `${asked}; an approved request continues the assignment as a new attempt with the wider roots`;
	return `${asked}; this dispatch cannot pause for a decision, so re-dispatch with intent.write_roots including ${resolution.request.paths.join(", ")}`;
}

/** The assignment's settlement detail when a parked request ends without an approval. */
function writeRootUnansweredDetail(
	request: WriteRootRequest,
	state: string,
	decidedBy: string | null,
	reason: string,
): string {
	const outcome =
		state === "denied"
			? `was denied by the ${decidedBy === "operator" ? "operator" : "main agent"}`
			: state === "expired"
				? "expired before anyone answered"
				: `was withdrawn: ${reason}`;
	return `the worker's request for write roots ${request.paths.join(", ")} ${outcome}, so it changed nothing and the assignment was not done`;
}

export type WriteRootGrantVerdict =
	| { kind: "grant" }
	| { kind: "ask-operator"; reason: string }
	| { kind: "deny"; reason: string };

/**
 * Who may widen a write root. At yolo the main agent's approval stands; below
 * yolo an attended operator decides, and with nobody to ask it is denied.
 */
export function evaluateWriteRootGrant(input: { autonomy: AutonomyLevel; attended: boolean }): WriteRootGrantVerdict {
	if (input.autonomy === "yolo") return { kind: "grant" };
	return input.attended
		? { kind: "ask-operator", reason: `the main agent runs at autonomy ${input.autonomy}, so the operator decides` }
		: {
				kind: "deny",
				reason: `the main agent runs at autonomy ${input.autonomy} with no operator to ask; only --autonomy yolo lets it widen write roots`,
			};
}

/**
 * A main-agent decision on a write-root request, worded for what it does: an
 * approval starts the next attempt, and any refusal settles the assignment.
 */
export function writeRootOutcomeMessage(outcome: MainGrantOutcome): MainGrantOutcome {
	if (!outcome.ok) {
		return {
			...outcome,
			message: outcome.message.replace(/the worker continues without the call$/u, "the assignment settles as not done"),
		};
	}
	const id = outcome.view.requestId;
	const by = outcome.decidedBy === "operator" ? "the operator" : "the main agent";
	return {
		...outcome,
		message:
			outcome.decision === "approved"
				? `${by} approved request ${id}: the assignment continues as a new attempt with write roots widened to ${outcome.view.target ?? "the requested paths"}`
				: `${by} denied request ${id}; the assignment settles as not done`,
	};
}

/** What the park needs of a finished attempt. */
export interface ParkableRun {
	runId: string;
	agentId: string;
	req: DispatchRequest;
	lineage: { rootRunId: string; attempt: number };
}

export type WriteRootContinuation = Pick<DispatchRequest, "writeRoots" | "intent" | "briefing">;

export interface WriteRootParkDeps<Run extends ParkableRun, Receipt> {
	broker: Pick<GrantBroker, "open" | "markExecution" | "revokeRun">;
	now(): number;
	/** How long a request may wait for a decision. */
	deadlineMs(): number;
	/** False once the assignment was cancelled or the dispatcher drains. */
	isLive(run: Run): boolean;
	/** Keeps the assignment's member work open until the request is answered. */
	hold(run: Run, settled: Promise<void>): void;
	settle(run: Run, receipt: Receipt, status: "failed" | "canceled", detail: string): void;
	/** Starts the next attempt of the assignment through full admission. */
	continueAttempt(run: Run, reason: string, continuation: WriteRootContinuation): Promise<void>;
}

/**
 * Holds assignments open on write-root requests. A finished attempt's request
 * is staged at settlement, parked as a main-authority grant when the
 * assignment would otherwise settle, and answered through the broker's
 * deliver hook: an approval continues the assignment, anything else settles it.
 */
export function createWriteRootPark<Run extends ParkableRun, Receipt>(deps: WriteRootParkDeps<Run, Receipt>) {
	const staged = new Map<string, WriteRootRequest>();
	const parked = new Map<string, { run: Run; receipt: Receipt; request: WriteRootRequest; release: () => void }>();

	async function continueWithWiderRoots(run: Run, receipt: Receipt, request: WriteRootRequest): Promise<void> {
		if (!deps.isLive(run)) {
			deps.broker.markExecution(run.runId, WRITE_ROOTS_GRANT_TOOL, "not_executed", "the assignment ended first");
			deps.settle(run, receipt, "canceled", "the assignment ended before the wider write roots were used");
			return;
		}
		deps.broker.markExecution(run.runId, WRITE_ROOTS_GRANT_TOOL, "start");
		await deps.continueAttempt(run, `write roots widened to ${request.paths.join(", ")}`, {
			...widenedWriteRootFields(run.req, request.paths),
			briefing: writeRootContinuationBriefing(run.req.briefing, { previousRunId: run.runId, request }),
		});
		deps.broker.markExecution(run.runId, WRITE_ROOTS_GRANT_TOOL, "end");
	}

	return {
		stage(runId: string, request: WriteRootRequest): void {
			staged.set(runId, request);
		},
		isStaged(runId: string): boolean {
			return staged.has(runId);
		},
		/** True when the assignment now waits on a decision instead of settling. */
		park(run: Run, receipt: Receipt): boolean {
			const request = staged.get(run.runId);
			if (request === undefined) return false;
			staged.delete(run.runId);
			if (!deps.isLive(run)) return false;
			const opened = deps.broker.open({
				workerRequestId: WRITE_ROOTS_GRANT_TOOL,
				runId: run.runId,
				rootRunId: run.lineage.rootRunId,
				attempt: run.lineage.attempt,
				attemptToken: "",
				ownerSessionId: run.req.ownerSessionId ?? null,
				agentId: run.agentId,
				tool: WRITE_ROOTS_GRANT_TOOL,
				actionClass: "write",
				approvalAuthority: "main",
				argDigest: "",
				effect: null,
				cwd: run.req.cwd ?? process.cwd(),
				permitTools: [],
				summary: `widen write roots to ${request.paths.join(", ")}`,
				target: request.paths.join(", "),
				reasons: [request.scope],
				deadlineAt: deps.now() + deps.deadlineMs(),
			});
			if (!opened.ok) return false;
			let release!: () => void;
			deps.hold(
				run,
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			);
			parked.set(opened.record.requestId, { run, receipt, request, release });
			return true;
		},
		/** The broker's deliver hook for a parked request; null when the record is not one. */
		deliver(record: GrantRecord, decision: GrantDecision, reason: string): boolean | null {
			const entry = parked.get(record.requestId);
			if (entry === undefined) return null;
			parked.delete(record.requestId);
			if (decision === "approve") {
				void continueWithWiderRoots(entry.run, entry.receipt, entry.request).finally(entry.release);
				return true;
			}
			deps.settle(
				entry.run,
				entry.receipt,
				record.state === "canceled" ? "canceled" : "failed",
				writeRootUnansweredDetail(entry.request, record.state, record.issuer ?? null, reason),
			);
			entry.release();
			return true;
		},
		/** Withdraws the parked requests of the matching runs; each settles through `deliver`. */
		revoke(matches: (run: Run) => boolean, reason: string): void {
			for (const entry of [...parked.values()]) if (matches(entry.run)) deps.broker.revokeRun(entry.run.runId, reason);
		},
	};
}
