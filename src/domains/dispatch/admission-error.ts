/** A queued assignment was intentionally canceled before it acquired capacity. */
export class AdmissionCanceledError extends Error {
	readonly code = "admission_canceled" as const;

	constructor(message = "dispatch: admission canceled before a capacity slot opened") {
		super(message);
		this.name = "AdmissionCanceledError";
	}
}
