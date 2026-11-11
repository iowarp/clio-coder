/**
 * The desktop report dialog, decided without React (R-24). The host plans every report: this model only
 * decides which step shows, which controls are enabled and what their lines read. It never composes text that
 * is sent; the dialog shows `view.plan.rendered`, the exact text the host's transport posts.
 *
 * Nothing here imports React, a stylesheet or the API client, so it runs under plain node:test.
 */

import type {
	ProblemReportBundle,
	ProblemReportChoices,
	ProblemReportOffer,
	ProblemReportSent,
	ProblemReportView,
} from "../../contracts/problem-reports.js";

export type ReportStep = "review" | "attach" | "send" | "duplicates" | "sent";
export type ReportBusy = "plan" | "update" | "bundle" | "send" | null;
/** The send step's consent radio: no bundle, or the bundle the Attach step showed, for debugging. */
export type ReportAttach = "none" | "debug";
export type ReportFields = ProblemReportView["fields"];

export interface ReportDialogState {
	readonly step: ReportStep;
	readonly view: ProblemReportView | null;
	/** The reporter's edits not yet re-planned by the host; Send waits until they are. */
	readonly edits: Partial<ReportFields>;
	readonly choices: {
		readonly credit: boolean;
		readonly replyCheck: boolean;
		/** Include the conversation excerpt in the bundle; a change rebuilds it and withdraws consent. */
		readonly transcript: boolean;
		readonly attach: ReportAttach;
	};
	readonly busy: ReportBusy;
	readonly error: string | null;
	readonly outcome: ProblemReportSent | null;
	/** The bundle as the host built it for this draft, unwritten; null until the Attach step builds it. */
	readonly bundle: ProblemReportBundle | null;
	/** The read-only member viewer is open. */
	readonly viewer: boolean;
}

export type ReportEvent =
	| { type: "busy"; busy: Exclude<ReportBusy, null> }
	| { type: "planned"; view: ProblemReportView }
	| { type: "edit"; field: keyof ReportFields; value: string }
	| { type: "credit"; value: boolean }
	| { type: "reply-check"; value: boolean }
	| { type: "go"; step: "review" | "attach" | "send" }
	| { type: "bundled"; bundle: ProblemReportBundle }
	| { type: "transcript"; value: boolean }
	| { type: "attach"; value: ReportAttach }
	| { type: "viewer"; open: boolean }
	| { type: "sent"; outcome: ProblemReportSent }
	| { type: "failed"; message: string };

export const INITIAL_REPORT_STATE: ReportDialogState = {
	step: "review",
	view: null,
	edits: {},
	choices: { credit: false, replyCheck: false, transcript: false, attach: "none" },
	busy: "plan",
	error: null,
	outcome: null,
	bundle: null,
	viewer: false,
};

export function reportReducer(state: ReportDialogState, event: ReportEvent): ReportDialogState {
	switch (event.type) {
		case "busy":
			return { ...state, busy: event.busy, error: null };
		case "planned": {
			// Edits typed while the host re-planned stay; the ones it has now seen are dropped.
			const edits: Partial<ReportFields> = {};
			for (const [field, value] of Object.entries(state.edits) as Array<[keyof ReportFields, string]>)
				if (event.view.fields[field] !== value) edits[field] = value;
			return {
				...state,
				view: event.view,
				edits: state.busy === "update" ? edits : {},
				choices: { ...state.choices, credit: event.view.plan.credit },
				busy: null,
				error: null,
			};
		}
		case "edit":
			return { ...state, edits: { ...state.edits, [event.field]: event.value } };
		case "credit":
			return { ...state, choices: { ...state.choices, credit: event.value } };
		case "reply-check":
			return { ...state, choices: { ...state.choices, replyCheck: event.value } };
		case "go":
			return { ...state, step: event.step, error: null, viewer: false };
		case "bundled":
			return { ...state, bundle: event.bundle, busy: null, error: null };
		case "transcript":
			// What was agreed to is no longer what would be attached: the bundle is rebuilt and consent asked again.
			return {
				...state,
				bundle: null,
				viewer: false,
				choices: { ...state.choices, transcript: event.value, attach: "none" },
			};
		case "attach":
			return { ...state, choices: { ...state.choices, attach: event.value } };
		case "viewer":
			return { ...state, viewer: event.open && state.bundle !== null };
		case "sent": {
			const step: ReportStep =
				event.outcome.status === "sent" ? "sent" : event.outcome.status === "duplicates" ? "duplicates" : "send";
			return { ...state, busy: null, outcome: event.outcome, step };
		}
		case "failed":
			return { ...state, busy: null, error: event.message };
	}
}

/** True while the reporter has typed something the host has not planned yet. */
export function hasUnplannedEdits(state: ReportDialogState): boolean {
	const view = state.view;
	if (view === null) return false;
	return (
		(Object.entries(state.edits) as Array<[keyof ReportFields, string]>).some(
			([field, value]) => view.fields[field] !== value,
		) || state.choices.credit !== view.plan.credit
	);
}

export interface ReportControls {
	/** "Public, posted from your gh account to github.com/iowarp/clio-coder; nothing sent yet" */
	readonly destination: string;
	readonly sendEnabled: boolean;
	/** Why Send is off, in the dialog's words; null when it may be pressed. */
	readonly sendBlocked: string | null;
	readonly actions: readonly string[];
	readonly gates: readonly string[];
	/** The credit checkbox label, naming what the current choice sends. */
	readonly creditLabel: string;
}

function creditLabel(state: ReportDialogState): string {
	return `Credit me in the release notes (credit: ${state.choices.credit ? "yes" : "no"})`;
}

export function reportControls(state: ReportDialogState): ReportControls {
	const view = state.view;
	if (view === null)
		return {
			destination: "Preparing the report; nothing sent yet",
			sendEnabled: false,
			sendBlocked: "Preparing",
			actions: [],
			gates: [],
			creditLabel: creditLabel(state),
		};
	const sent = state.outcome?.status === "sent";
	const blocked = sent
		? "Already sent"
		: state.busy !== null
			? state.busy === "send"
				? "Sending"
				: "Updating the preview"
			: !view.sendable
				? "An agent's draft is sent from a terminal review"
				: hasUnplannedEdits(state)
					? "Update the preview to see the exact text before sending"
					: view.plan.gates.length > 0
						? "Fix what is listed under Cannot send yet"
						: state.choices.attach === "debug" && state.bundle === null
							? "Build the bundle on the Attach step, or choose not to attach one"
							: null;
	return {
		destination: `${view.headline}; ${sent ? "sent" : "nothing sent yet"}`,
		sendEnabled: blocked === null,
		sendBlocked: blocked,
		actions: view.plan.actions.map((action, index) => `${index + 1}. ${action}`),
		gates: view.plan.gates,
		creditLabel: creditLabel(state),
	};
}

/** The Send body: consent from the button, and a bundle only when the radio chose it and the host built it. */
export function sendChoices(state: ReportDialogState): ProblemReportChoices {
	return {
		consent: true,
		replyCheck: state.choices.replyCheck,
		bundle: state.choices.attach === "debug" && state.bundle !== null ? "debug" : "none",
	};
}

export interface AttachView {
	/** The bundle's ticks, one line each: what it would carry and how large it is. */
	readonly ticks: readonly string[];
	readonly readable: readonly string[];
	readonly anonymized: readonly string[];
	readonly kept: readonly string[];
	readonly neverKept: readonly string[];
	readonly viewEnabled: boolean;
	/** The consent radio's "attach" choice is offered only once a bundle was built and could be reviewed. */
	readonly attachOffered: boolean;
}

export function attachView(state: ReportDialogState): AttachView {
	const bundle = state.bundle;
	if (bundle === null)
		return {
			ticks: [state.busy === "bundle" ? "Building the bundle…" : "No bundle built yet; nothing is attached."],
			readable: [],
			anonymized: [],
			kept: [],
			neverKept: [],
			viewEnabled: false,
			attachOffered: false,
		};
	const { readable } = bundle;
	const ticks = [
		`Telemetry for this session: ${bundle.bytes} bytes, sha256 ${bundle.sha256.slice(0, 12)}`,
		bundle.transcript === null
			? "Conversation excerpt: not included"
			: `Conversation excerpt: last ${bundle.transcript.turns} of ${bundle.transcript.of} turns`,
		`Withheld values: ${bundle.withheld}`,
	];
	const names = (label: string, values: readonly string[]) =>
		values.length > 0 ? [`${label}: ${values.join(", ")}`] : [];
	return {
		ticks,
		readable: [
			...names("Models", readable.model),
			...names("Runtimes", readable.runtime),
			...names("Tools", readable.tool),
			...names("Tokens", readable.token),
		],
		anonymized: bundle.anonymized.map((entry) => `${entry.kind} × ${entry.count}`),
		kept: bundle.kept,
		neverKept: bundle.neverKept,
		viewEnabled: bundle.members.length > 0,
		attachOffered: true,
	};
}

export interface OfferNotice {
	readonly fingerprint: string;
	readonly text: string;
	readonly link: "Review a report";
}

/**
 * The inline notice for the host's offer answer. The host applied the offer rules and the `report.offers` setting;
 * a refusal, "off" included, shows nothing, and so does an offer the operator dismissed.
 */
export function offerNotice(
	answer: ProblemReportOffer | null | undefined,
	dismissed: ReadonlySet<string>,
): OfferNotice | null {
	const offer = answer?.offer ?? null;
	if (offer === null || answer?.refusal !== null || dismissed.has(offer.fingerprint)) return null;
	return { fingerprint: offer.fingerprint, text: offer.text, link: "Review a report" };
}

/**
 * The report request a failed fleet run's "Report this" opens: the session it ran in, so the host fills the draft from
 * that session's recorded observations, and a title naming the run. Null for a run that did not fail.
 */
export function failedRunReport(
	run: { readonly runId: string; readonly agentId: string; readonly state: string },
	sessionId: string,
): { sessionId: string; summary: string } | null {
	if (run.state !== "failed") return null;
	return { sessionId, summary: `Worker run ${run.agentId} failed (${run.runId})`.slice(0, 120) };
}

/**
 * Whether a key press sends. Only the Send button itself, activated by the reporter, sends: Enter in a title or
 * body field, or anywhere else in the dialog, never does.
 */
export function keySends(key: string, focus: "field" | "send-button" | "other"): boolean {
	return focus === "send-button" && (key === "Enter" || key === " ");
}
