/** A queued assignment was intentionally canceled before it acquired capacity. */
export class AdmissionCanceledError extends Error {
	readonly code = "admission_canceled" as const;

	constructor(message = "dispatch: admission canceled before a capacity slot opened") {
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
