/**
 * The desktop report dialog, decided without React (R-24). The host plans every report: this model only
 * decides which step shows, which controls are enabled and what their lines read. It never composes text that
 * is sent; the dialog shows `view.plan.rendered`, the exact text the host's transport posts.
 *
 * Nothing here imports React, a stylesheet or the API client, so it runs under plain node:test.
 */

import type { ProblemReportSent, ProblemReportView } from "../../contracts/problem-reports.js";

export type ReportStep = "review" | "attach" | "send" | "duplicates" | "sent";
export type ReportBusy = "plan" | "update" | "send" | null;
export type ReportFields = ProblemReportView["fields"];

export interface ReportDialogState {
	readonly step: ReportStep;
	readonly view: ProblemReportView | null;
	/** The reporter's edits not yet re-planned by the host; Send waits until they are. */
	readonly edits: Partial<ReportFields>;
	readonly choices: { readonly credit: boolean; readonly replyCheck: boolean };
	readonly busy: ReportBusy;
	readonly error: string | null;
	readonly outcome: ProblemReportSent | null;
}

export type ReportEvent =
	| { type: "busy"; busy: Exclude<ReportBusy, null> }
	| { type: "planned"; view: ProblemReportView }
	| { type: "edit"; field: keyof ReportFields; value: string }
	| { type: "credit"; value: boolean }
	| { type: "reply-check"; value: boolean }
	| { type: "go"; step: "review" | "attach" | "send" }
	| { type: "sent"; outcome: ProblemReportSent }
	| { type: "failed"; message: string };

export const INITIAL_REPORT_STATE: ReportDialogState = {
	step: "review",
	view: null,
	edits: {},
	choices: { credit: false, replyCheck: false },
	busy: "plan",
	error: null,
	outcome: null,
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
			return { ...state, step: event.step, error: null };
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
						: null;
	return {
		destination: `${view.headline}; ${sent ? "sent" : "nothing sent yet"}`,
		sendEnabled: blocked === null,
		sendBlocked: blocked,
		actions: view.plan.actions.map((action, index) => `${index + 1}. ${action}`),
		gates: view.plan.gates,
	};
}

/**
 * Whether a key press sends. Only the Send button itself, activated by the reporter, sends: Enter in a title or
 * body field, or anywhere else in the dialog, never does.
 */
export function keySends(key: string, focus: "field" | "send-button" | "other"): boolean {
	return focus === "send-button" && (key === "Enter" || key === " ");
}
