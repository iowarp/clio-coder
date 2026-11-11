// How any part of the app asks the shell to open the report dialog: the palette's `report` action, the help
// dialog and a failed turn's "Report this". The shell owns the one dialog and the active project.

const EVENT = "clio:report-problem";

export interface ReportRequest {
	/** The session a failed card reports on; its recorded observations fill the draft on the host. */
	sessionId?: string;
}

export function requestReport(request: ReportRequest = {}): void {
	window.dispatchEvent(new CustomEvent<ReportRequest>(EVENT, { detail: request }));
}

export function onReportRequest(listener: (request: ReportRequest) => void): () => void {
	const handle = (event: Event) => listener((event as CustomEvent<ReportRequest>).detail ?? {});
	window.addEventListener(EVENT, handle);
	return () => window.removeEventListener(EVENT, handle);
}
