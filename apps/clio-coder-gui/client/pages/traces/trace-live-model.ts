import type { TraceRunStatus } from "../../../contracts/traces.js";
import { runIsLive } from "./trace-model.js";

/**
 * A live run's journal and timeline are re-read on an interval: the journal is the record, so there is no separate
 * event tail to merge, and a settled run stops refreshing (#434).
 */
export const LIVE_REFETCH_MS = 2_000;

export function liveRefetchMs(status: TraceRunStatus | undefined): number | false {
	return runIsLive(status) ? LIVE_REFETCH_MS : false;
}

export function liveLabel(status: TraceRunStatus | undefined): string | null {
	return runIsLive(status) ? "Live · re-reading the run journal" : null;
}
