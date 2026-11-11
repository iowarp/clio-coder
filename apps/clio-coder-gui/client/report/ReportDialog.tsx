// The desktop report dialog (R-24): Review, Attach and Send, over the host's plan. Every decision is in
// `report-model.ts`; the text shown is the host's `plan.rendered`, exactly what sending posts.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ProblemReportEdits, ProblemReportView } from "../../contracts/problem-reports.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { Client } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import type { ReportRequest } from "./report-events.js";
import {
	attachView,
	hasUnplannedEdits,
	INITIAL_REPORT_STATE,
	type ReportFields,
	reportControls,
	reportReducer,
	sendChoices,
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
					body: {
						kind: "bug",
						...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
						...(request.summary !== undefined ? { summary: request.summary } : {}),
					},
				},
				crypto.randomUUID(),
			)
			.then((view) => live && dispatch({ type: "planned", view }))
			.catch((error) => live && failed(error));
		return () => {
			live = false;
		};
	}, [client, workspaceId, request.sessionId, request.summary, failed]);

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
	const buildBundle = (transcript: boolean) => {
		if (view === null) return;
		dispatch({ type: "busy", busy: "bundle" });
		client
			.call(
				routes.problemReportBundle,
				{ params: { id: workspaceId, draft: view.draftId }, query: {}, body: { transcript } },
				crypto.randomUUID(),
			)
			.then((bundle) => dispatch({ type: "bundled", bundle }))
			.catch(failed);
	};
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
						...sendChoices(state),
						...(duplicate !== undefined ? { duplicate } : {}),
					},
				},
				crypto.randomUUID(),
			)
			.then((outcome) => dispatch({ type: "sent", outcome }))
			.catch(failed);
	};
	const controls = reportControls(state);
	const attach = attachView(state);
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
								<p>
									A diagnostic bundle is attached only if you choose it on the Send step. Review what it would carry here first.
								</p>
								<label className="report-dialog__tick">
									<input
										type="checkbox"
										checked={state.choices.transcript}
										disabled={view === null || state.busy !== null}
										onChange={(event) => dispatch({ type: "transcript", value: event.target.checked })}
									/>
									Include the conversation excerpt
								</label>
								{state.bundle && state.choices.transcript ? <p>{state.bundle.consent.transcript}</p> : null}
								<ul className="report-dialog__ticks" aria-label="Bundle">
									{attach.ticks.map((tick) => (
										<li key={tick}>{tick}</li>
									))}
								</ul>
								{attach.readable.length > 0 ? (
									<>
										<p className="report-dialog__label">Left readable:</p>
										<ul>
											{attach.readable.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
									</>
								) : null}
								{attach.anonymized.length > 0 ? (
									<>
										<p className="report-dialog__label">Replaced by anonymous names:</p>
										<ul>
											{attach.anonymized.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
									</>
								) : null}
								{attach.kept.length > 0 ? (
									<>
										<p className="report-dialog__label">A bundle keeps:</p>
										<ul>
											{attach.kept.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
										<p className="report-dialog__label">It never keeps:</p>
										<ul>
											{attach.neverKept.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
									</>
								) : null}
								{state.viewer && state.bundle ? (
									<section className="report-dialog__viewer" aria-label="Bundle members, read-only">
										{state.bundle.members.map((member) => (
											<details key={member.name}>
												<summary>{member.name}</summary>
												<pre className="report-dialog__preview">{member.text}</pre>
											</details>
										))}
									</section>
								) : null}
								<div className="actions">
									<button
										type="button"
										disabled={view === null || state.busy !== null}
										onClick={() => buildBundle(state.choices.transcript)}
									>
										{state.bundle ? "Rebuild bundle" : "Build bundle"}
									</button>
									<button
										type="button"
										disabled={!attach.viewEnabled}
										aria-pressed={state.viewer}
										onClick={() => dispatch({ type: "viewer", open: !state.viewer })}
									>
										View bundle
									</button>
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
								<fieldset className="report-dialog__consent">
									<legend>Diagnostic bundle</legend>
									<label className="report-dialog__tick">
										<input
											type="radio"
											name="report-bundle"
											checked={state.choices.attach === "none"}
											onChange={() => dispatch({ type: "attach", value: "none" })}
										/>
										Do not attach a bundle; send only the text
									</label>
									<label className="report-dialog__tick">
										<input
											type="radio"
											name="report-bundle"
											checked={state.choices.attach === "debug"}
											disabled={!attach.attachOffered}
											onChange={() => dispatch({ type: "attach", value: "debug" })}
										/>
										{state.bundle
											? `Attach the bundle I reviewed. ${state.bundle.consent.debug}`
											: "Attach a bundle (build and review it on the Attach step first)"}
									</label>
								</fieldset>
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
