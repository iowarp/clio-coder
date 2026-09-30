/**
 * Durable operator cancel requests for runs owned by another process.
 *
 * `clio-coder fleet cancel` cannot reach a run's in-memory abort handle, which
 * lives in the process that dispatched it. It drops one request file per run
 * under `<state>/cancel-requests/`; the owning dispatch extension's reconciler
 * tick takes the request for any run it holds and aborts through the ordinary
 * path, so the run seals `canceled` with a real receipt.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioStateDir } from "../../core/xdg.js";

export interface RunCancelRequest {
	version: 1;
	runId: string;
	requestedAt: string;
	requestedByPid: number;
	reason: string | null;
}

/** Abort detail the owner seals into the receipt, so the receipt names who canceled. */
export const FLEET_CANCEL_DETAIL = "operator cancel via fleet cancel";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REASON_CHARS = 500;

/** Run ids become file names here, so anything outside the id alphabet is refused. */
export function isCancelableRunId(runId: string): boolean {
	return RUN_ID_PATTERN.test(runId);
}

function requestPath(runId: string): string {
	if (!isCancelableRunId(runId)) throw new Error(`invalid run id '${runId}'`);
	return join(clioStateDir(), "cancel-requests", `${runId}.json`);
}

export function writeRunCancelRequest(runId: string, reason: string | null): RunCancelRequest {
	const request: RunCancelRequest = {
		version: 1,
		runId,
		requestedAt: new Date().toISOString(),
		requestedByPid: process.pid,
		reason: reason === null ? null : reason.slice(0, MAX_REASON_CHARS),
	};
	safeResourceWrite(requestPath(runId), `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return request;
}

/**
 * Remove and return the pending request for `runId`. A malformed file is still
 * removed and still counts as a request: it was written to this path only to
 * stop this run, and leaving it would retry the parse on every tick.
 */
export function takeRunCancelRequest(runId: string): RunCancelRequest | null {
	if (!isCancelableRunId(runId)) return null;
	const path = requestPath(runId);
	if (!existsSync(path)) return null;
	let request: RunCancelRequest = { version: 1, runId, requestedAt: "", requestedByPid: 0, reason: null };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunCancelRequest>;
		request = {
			...request,
			...(typeof parsed.requestedAt === "string" ? { requestedAt: parsed.requestedAt } : {}),
			...(typeof parsed.requestedByPid === "number" ? { requestedByPid: parsed.requestedByPid } : {}),
			...(typeof parsed.reason === "string" ? { reason: parsed.reason.slice(0, MAX_REASON_CHARS) } : {}),
		};
	} catch {
		// Unreadable content still names this run by its path; see the doc comment.
	}
	clearRunCancelRequest(runId);
	return request;
}

export function clearRunCancelRequest(runId: string): void {
	if (!isCancelableRunId(runId)) return;
	rmSync(requestPath(runId), { force: true });
}

export function cancelDetail(base: string, reason: string | null): string {
	return reason === null || reason.trim().length === 0 ? base : `${base}: ${reason.trim()}`;
}
