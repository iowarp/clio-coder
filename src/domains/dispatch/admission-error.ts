/** A queued assignment was intentionally canceled before it acquired capacity. */
export class AdmissionCanceledError extends Error {
	readonly code = "admission_canceled" as const;

	constructor(message = "dispatch: cancelled before a worker slot opened") {
		super(message);
		this.name = "AdmissionCanceledError";
	}
}

/**
 * A queued assignment's caller deadline passed before it acquired capacity,
 * including a deadline that had already passed when it reached the queue.
 * Waits without a caller deadline are advisory and never end this way.
 */
export class AdmissionTimedOutError extends Error {
	readonly code = "admission_timed_out" as const;

	constructor(message: string) {
		super(message);
		this.name = "AdmissionTimedOutError";
	}
}

/**
 * Admission waited its bounded budget for the shared admission store lock while another process held it (M-35). The
 * message names the holder and says to wait for it or stop it; the dispatch is refused, the process carries on.
 */
export class AdmissionLockBusyError extends Error {
	readonly code = "admission_lock_busy" as const;

	constructor(detail: string) {
		super(`dispatch: admission denied: the shared admission store is busy; ${detail}`);
		this.name = "AdmissionLockBusyError";
	}
}
