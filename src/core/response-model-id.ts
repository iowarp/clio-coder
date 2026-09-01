/** What Clio directly observed about a provider response model id. */
export type ResponseModelIdObservation =
	| { state: "reported"; reportedModelId: string }
	| { state: "not-reported" }
	| { state: "not-observed" }
	| { state: "legacy-difference-only"; differingModelId: string | null };

export type MissingResponseModelIdObservation = "not-observed" | "legacy-difference-only";

/** Call counts grouped by the exact response model-id observation state. */
export interface ResponseModelIdObservationCounts {
	reportedCalls: number;
	notReportedCalls: number;
	notObservedCalls: number;
	legacyDifferenceOnlyCalls: number;
}

export function emptyResponseModelIdObservationCounts(): ResponseModelIdObservationCounts {
	return { reportedCalls: 0, notReportedCalls: 0, notObservedCalls: 0, legacyDifferenceOnlyCalls: 0 };
}

export function addResponseModelIdObservationCount(
	counts: ResponseModelIdObservationCounts,
	observation: ResponseModelIdObservation,
	calls = 1,
): void {
	switch (observation.state) {
		case "reported":
			counts.reportedCalls += calls;
			break;
		case "not-reported":
			counts.notReportedCalls += calls;
			break;
		case "not-observed":
			counts.notObservedCalls += calls;
			break;
		case "legacy-difference-only":
			counts.legacyDifferenceOnlyCalls += calls;
			break;
	}
}

export function addResponseModelIdObservationCounts(
	counts: ResponseModelIdObservationCounts,
	additional: Readonly<ResponseModelIdObservationCounts>,
): void {
	counts.reportedCalls += additional.reportedCalls;
	counts.notReportedCalls += additional.notReportedCalls;
	counts.notObservedCalls += additional.notObservedCalls;
	counts.legacyDifferenceOnlyCalls += additional.legacyDifferenceOnlyCalls;
}

export function responseModelIdObservationCountsLabel(counts: ResponseModelIdObservationCounts): string {
	const parts: string[] = [];
	if (counts.reportedCalls > 0) parts.push(`reported ${counts.reportedCalls}`);
	if (counts.notReportedCalls > 0) parts.push(`not reported ${counts.notReportedCalls}`);
	if (counts.notObservedCalls > 0) parts.push(`not observed ${counts.notObservedCalls}`);
	if (counts.legacyDifferenceOnlyCalls > 0) parts.push(`legacy difference-only ${counts.legacyDifferenceOnlyCalls}`);
	return parts.join(", ");
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsedObservation(value: unknown): ResponseModelIdObservation | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	switch (record.state) {
		case "reported": {
			const reportedModelId = nonEmptyString(record.reportedModelId);
			return reportedModelId === null ? null : { state: "reported", reportedModelId };
		}
		case "not-reported":
			return { state: "not-reported" };
		case "not-observed":
			return { state: "not-observed" };
		case "legacy-difference-only":
			return { state: "legacy-difference-only", differingModelId: nonEmptyString(record.differingModelId) };
		default:
			return null;
	}
}

/**
 * Read the current observation shape and the short-lived #193 shape. A caller
 * chooses how to label a missing field because a live message is not historical,
 * while a persisted row without either shape predates model-id presence capture.
 */
export function responseModelIdObservationFromRecord(
	record: Readonly<Record<string, unknown>>,
	missing: MissingResponseModelIdObservation,
): ResponseModelIdObservation {
	const current = parsedObservation(record.responseModelIdObservation);
	if (current !== null) return current;
	if (Object.hasOwn(record, "servedModel")) {
		const reportedModelId = nonEmptyString(record.servedModel);
		return reportedModelId === null ? { state: "not-reported" } : { state: "reported", reportedModelId };
	}
	if (missing === "not-observed") return { state: "not-observed" };
	return { state: "legacy-difference-only", differingModelId: nonEmptyString(record.responseModel) };
}

/** Model id used for accounting without claiming more than the observation supports. */
export function attributedModelId(
	observation: ResponseModelIdObservation,
	requestedModelId: string,
	differingResponseModelId: string | null,
): string {
	switch (observation.state) {
		case "reported":
			return observation.reportedModelId;
		case "not-reported":
			return "unknown";
		case "not-observed":
			return differingResponseModelId ?? requestedModelId;
		case "legacy-difference-only":
			return observation.differingModelId ?? requestedModelId;
	}
}
