export { isFixedPoint, parseReportBlock, type RenderedReport, renderReport, renderReportBlock } from "./body.js";
export type { ReportCommandResult, ReportCommandRunner } from "./command.js";
export {
	applyVerdict,
	changelogFixedIn,
	findRelated,
	type RelatedIssue,
	type RelatedResult,
	type RelatedVerdict,
	relatedSearchUrl,
	renderComment,
	titleQuery,
	titleTokens,
} from "./dedup.js";
export {
	newReportId,
	REPORT_BODY_MAX,
	REPORT_ID,
	type ReportDraft,
	titleCore,
	validateDraft,
} from "./draft.js";
export { type ReportEnvironment, type ReportSessionFacts, reportEnvironment } from "./environment.js";
export { crashFrames, minorVersion, reportFingerprint } from "./fingerprint.js";
export { observeSession, type ReportObservation, renderObservation } from "./observe.js";
export {
	type OutboxEntry,
	type OutboxState,
	outboxEntry,
	REPORT_RATE_LIMITS,
	type RecentSends,
	readOutbox,
	recentSends,
	reportOutboxPath,
	updateOutbox,
} from "./outbox.js";
export {
	type IdentitySettings,
	type LocalIdentity,
	localIdentity,
	type MaskKind,
	mergeMasks,
	type ReportMask,
	type ScrubResult,
	SECRET_MASK_ID,
	scrubText,
} from "./scrub.js";
export {
	deleteReportDraft,
	listReportDrafts,
	readReportDraft,
	reportDraftPath,
	reportDraftsDirectory,
	reportMarkdownPath,
	reportsDirectory,
	saveReportDraft,
	writeReportMarkdown,
} from "./store.js";
export {
	detectTransport,
	ghEnvironment,
	newReportLink,
	prefillLink,
	REPORT_URL_BUDGET,
	type ReportAction,
	type ReportRoute,
	type ReportTransport,
	routeFor,
	type SendResult,
	sendReport,
} from "./transport.js";
export * from "./vocabulary.js";
