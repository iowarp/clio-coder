import { randomBytes } from "node:crypto";
import type { ReportEnvironment } from "./environment.js";
import type { ReportObservation } from "./observe.js";
import type { ReportArea, ReportKind, ReportTrigger } from "./vocabulary.js";

/**
 * A report before it is sent. What the person said, what the harness recorded and what is not known are separate
 * fields, so the body never mixes them: `observed` comes only from the host's telemetry and has no free text.
 */
export interface ReportDraft {
	/** `rpt_` plus a ULID. */
	id: string;
	createdAt: string;
	kind: ReportKind;
	origin: "operator" | "agent" | "host";
	title: string;
	sections: {
		happened: string;
		/** The operator's own words, quoted as given. */
		operatorWords: string;
		expected: string;
		reproduce: string;
		notKnown: string[];
	};
	observed: ReportObservation[];
	environment: ReportEnvironment;
	/** Whether the environment block names the model. */
	includeModel: boolean;
	area: ReportArea | null;
	trigger: ReportTrigger;
	/** A `FailureCause` value, or null. */
	cause: string | null;
	fingerprint: string | null;
	/** Issue numbers this report refers to. */
	links: number[];
	sessionId: string | null;
	/** Identity mask ids the reporter chose to let through. Secret masks cannot be listed. */
	unmasked: string[];
	/** Set when the dedup step found the fix already shipped in this version. */
	regression?: boolean;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REPORT_ID = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/u;

/** A ULID: 48 bits of milliseconds, then 80 random bits, Crockford base32. */
export function newReportId(now = Date.now()): string {
	let time = "";
	let ms = Math.max(0, Math.floor(now));
	for (let i = 0; i < 10; i += 1) {
		time = CROCKFORD[ms % 32] + time;
		ms = Math.floor(ms / 32);
	}
	const bytes = randomBytes(16);
	let random = "";
	for (let i = 0; i < 16; i += 1) random += CROCKFORD[(bytes[i] ?? 0) % 32];
	return `rpt_${time}${random}`;
}

export const REPORT_TITLE_MIN = 10;
export const REPORT_TITLE_MAX = 120;
export const REPORT_HAPPENED_MIN = 40;
export const REPORT_BODY_MAX = 60_000;

const CONVENTIONAL_PREFIX = /^(?:fix|feat)(?:\([^)\n]{0,40}\))?:\s*/iu;

/** The title without a conventional prefix the writer may already have typed. */
export function titleCore(title: string): string {
	return title.trim().replace(CONVENTIONAL_PREFIX, "").trim();
}

/** The gate failures that keep a draft from being sent; empty when it may go. */
export function validateDraft(draft: ReportDraft, rendered?: { body: string }): string[] {
	const failures: string[] = [];
	const title = draft.title.trim();
	if (title.length < REPORT_TITLE_MIN || title.length > REPORT_TITLE_MAX)
		failures.push(`The title needs ${REPORT_TITLE_MIN} to ${REPORT_TITLE_MAX} characters.`);
	if (titleCore(draft.title).length === 0) failures.push("The title needs more than its prefix.");
	if (draft.sections.happened.trim().length < REPORT_HAPPENED_MIN && draft.observed.length === 0)
		failures.push(`"What happened" needs at least ${REPORT_HAPPENED_MIN} characters.`);
	if (rendered !== undefined && rendered.body.length >= REPORT_BODY_MAX)
		failures.push(`The report is ${rendered.body.length} characters; GitHub takes under ${REPORT_BODY_MAX}.`);
	return failures;
}
