// The desktop report dialog (R-24): Review, Attach and Send, over the host's plan. Every decision is in
// `report-model.ts`; the text shown is the host's `plan.rendered`, exactly what sending posts.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ProblemReportEdits, ProblemReportView } from "../../contracts/problem-reports.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { Client } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import type { ReportRequest } from "./report-events.js";
import {
	hasUnplannedEdits,
	INITIAL_REPORT_STATE,
	type ReportFields,
	reportControls,
	reportReducer,
} from "./report-model.js";
import "./report.css";

const FIELD_LABELS: ReadonlyArray<[keyof ReportFields, string]> = [
	["happened", "What happened"],
	["expected", "What you expected"],
	["reproduce", "How to reproduce"],
];

export function ReportDialog({
	client,
	workspaceId,
	request,
	onClose,
}: {
	client: Client;
	workspaceId: string;
	request: ReportRequest;
	onClose: () => void;
}) {
	const [state, dispatch] = useReducer(reportReducer, INITIAL_REPORT_STATE);
	const titleRef = useRef<HTMLInputElement>(null);
	const failed = useCallback(
		(error: unknown) => dispatch({ type: "failed", message: error instanceof Error ? error.message : String(error) }),
		[],
	);
	useEffect(() => {
		let live = true;
		client
			.call(
				routes.problemReportPlan,
				{
					params: { id: workspaceId },
					query: {},
					body: { kind: "bug", ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}) },
				},
				crypto.randomUUID(),
			)
			.then((view) => live && dispatch({ type: "planned", view }))
			.catch((error) => live && failed(error));
		return () => {
			live = false;
		};
	}, [client, workspaceId, request.sessionId, failed]);

	const view = state.view;
	const update = (edits: ProblemReportEdits) => {
		if (view === null) return;
		dispatch({ type: "busy", busy: "update" });
		client
			.call(
				routes.problemReportUpdate,
				{ params: { id: workspaceId, draft: view.draftId }, query: {}, body: edits },
				crypto.randomUUID(),
			)
			.then((next: ProblemReportView) => dispatch({ type: "planned", view: next }))
			.catch(failed);
	};
	const replan = () => update({ ...state.edits, credit: state.choices.credit });
	const send = (duplicate?: { comment: number } | "new") => {
		if (view === null || (!reportControls(state).sendEnabled && duplicate === undefined)) return;
		dispatch({ type: "busy", busy: "send" });
		client
			.call(
				routes.problemReportSend,
				{
					params: { id: workspaceId, draft: view.draftId },
					query: {},
					body: {
						consent: true,
						replyCheck: state.choices.replyCheck,
						...(duplicate !== undefined ? { duplicate } : {}),
					},
				},
				crypto.randomUUID(),
			)
			.then((outcome) => dispatch({ type: "sent", outcome }))
			.catch(failed);
	};
	const controls = reportControls(state);
	const value = (field: keyof ReportFields) => state.edits[field] ?? view?.fields[field] ?? "";
	const steps = ["review", "attach", "send"] as const;

	return (
		<Dialog title="Report a problem" eyebrow="CLIO CODER" size="wide" initialFocus={titleRef} onClose={onClose}>
			{/* No form element: Enter in a field submits nothing, and only the Send button sends. */}
			<div className="report-dialog">
				<p className="report-dialog__destination" role="status">
					{controls.destination}
				</p>
				{state.error ? (
					<p className="report-dialog__error" role="alert">
						{state.error}
					</p>
				) : null}
				{state.step === "sent" && state.outcome?.status === "sent" ? (
					<div className="report-dialog__pane">
						<p className="report-dialog__line">{state.outcome.line}</p>
						{state.outcome.url ? (
							<p>
								<a href={state.outcome.url} target="_blank" rel="noreferrer">
									{state.outcome.url}
								</a>
							</p>
						) : null}
						<div className="actions">
							<button type="button" onClick={onClose}>
								Close
							</button>
						</div>
					</div>
				) : state.step === "duplicates" && state.outcome?.status === "duplicates" ? (
					<div className="report-dialog__pane">
						<p>This may already be reported:</p>
						<p className="report-dialog__line">{state.outcome.related}</p>
						<p>Nothing was sent. Choose one:</p>
						<div className="actions">
							{state.outcome.comment !== null ? (
								<button
									type="button"
									disabled={state.busy !== null}
									onClick={() => send({ comment: (state.outcome as { comment: number }).comment })}
								>
									Add to #{state.outcome.comment}
								</button>
							) : null}
							{state.outcome.allowNew ? (
								<button type="button" disabled={state.busy !== null} onClick={() => send("new")}>
									File a new report
								</button>
							) : null}
							<button type="button" onClick={onClose}>
								Do nothing
							</button>
						</div>
					</div>
				) : (
					<>
						<div className="report-dialog__steps" role="tablist" aria-label="Report steps">
							{steps.map((step) => (
								<button
									key={step}
									type="button"
									role="tab"
									aria-selected={state.step === step}
									onClick={() => dispatch({ type: "go", step })}
								>
									{step === "review" ? "Review" : step === "attach" ? "Attach" : "Send"}
								</button>
							))}
						</div>
						{state.step === "review" ? (
							<div className="report-dialog__pane" role="tabpanel">
								<label className="report-dialog__field">
									<span>Title</span>
									<input
										ref={titleRef}
										value={value("title")}
										disabled={view === null}
										onChange={(event) => dispatch({ type: "edit", field: "title", value: event.target.value })}
										onBlur={() => hasUnplannedEdits(state) && replan()}
									/>
								</label>
								{FIELD_LABELS.map(([field, label]) => (
									<label key={field} className="report-dialog__field">
										<span>{label}</span>
										<textarea
											rows={field === "happened" ? 5 : 3}
											value={value(field)}
											disabled={view === null}
											onChange={(event) => dispatch({ type: "edit", field, value: event.target.value })}
											onBlur={() => hasUnplannedEdits(state) && replan()}
										/>
									</label>
								))}
								<fieldset className="report-dialog__masks">
									<legend>What Clio masked</legend>
									<span>{view?.plan.maskSummary ?? ""}</span>
									{view?.masks.map((mask) => (
										<button
											key={mask.id}
											type="button"
											className="report-dialog__chip"
											aria-pressed={mask.masked}
											disabled={mask.locked || state.busy !== null}
											title={mask.locked ? "always masked" : mask.masked ? "masked" : "sent as written"}
											onClick={() =>
												update({
													unmasked: view.masks
														.filter((other) => (other.id === mask.id ? other.masked : !other.masked))
														.filter((other) => !other.locked)
														.map((other) => other.id),
												})
											}
										>
											{mask.kind} × {mask.count}: {mask.masked ? "masked" : "sent as written"}
										</button>
									))}
								</fieldset>
								<p className="report-dialog__label">
									Exactly what will be sent{hasUnplannedEdits(state) ? " (update the preview to include your edits)" : ""}:
								</p>
								<pre className="report-dialog__preview">
									{view ? `${view.plan.rendered.title}\n\n${view.plan.rendered.body}` : "Preparing…"}
								</pre>
								<div className="actions">
									<button
										type="button"
										disabled={view === null || state.busy !== null || !hasUnplannedEdits(state)}
										onClick={replan}
									>
										Update preview
									</button>
									<button type="button" onClick={() => dispatch({ type: "go", step: "attach" })}>
										Next
									</button>
								</div>
							</div>
						) : state.step === "attach" ? (
							<div className="report-dialog__pane" role="tabpanel">
								<p>No diagnostic bundle is attached. Only the text on the Review step is sent.</p>
								<div className="actions">
									<button type="button" onClick={() => dispatch({ type: "go", step: "send" })}>
										Next
									</button>
								</div>
							</div>
						) : (
							<div className="report-dialog__pane" role="tabpanel">
								<p>Sending will, in this order:</p>
								<ol className="report-dialog__actions">
									{view?.plan.actions.map((action) => (
										<li key={action}>{action}</li>
									))}
								</ol>
								{view?.plan.rateWarning ? <p>{view.plan.rateWarning}</p> : null}
								<label className="report-dialog__tick">
									<input
										type="checkbox"
										checked={state.choices.credit}
										disabled={view === null || state.busy !== null}
										onChange={(event) => {
											dispatch({ type: "credit", value: event.target.checked });
											update({ credit: event.target.checked });
										}}
									/>
									Credit me in the release notes (credit: yes)
								</label>
								<label className="report-dialog__tick">
									<input
										type="checkbox"
										checked={state.choices.replyCheck}
										onChange={(event) => dispatch({ type: "reply-check", value: event.target.checked })}
									/>
									Check daily for a reply to this report
								</label>
								{controls.gates.length > 0 ? (
									<div role="alert">
										<p>Cannot send yet:</p>
										<ul>
											{controls.gates.map((gate) => (
												<li key={gate}>{gate}</li>
											))}
										</ul>
									</div>
								) : null}
								{state.outcome && state.outcome.status === "failed" ? (
									<p className="report-dialog__error">{state.outcome.line}</p>
								) : null}
								{state.outcome && state.outcome.status === "blocked" ? (
									<p className="report-dialog__error">{state.outcome.reasons.join(" ")}</p>
								) : null}
								<div className="actions">
									<button
										type="button"
										className="primary"
										disabled={!controls.sendEnabled}
										title={controls.sendBlocked ?? undefined}
										onClick={() => send()}
									>
										Send report
									</button>
									{controls.sendBlocked ? <span className="report-dialog__hint">{controls.sendBlocked}</span> : null}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</Dialog>
	);
}
