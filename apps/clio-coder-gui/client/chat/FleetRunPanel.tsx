import { useMutation } from "@tanstack/react-query";
import { memo, useId, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { FleetPreview } from "../../contracts/fleet-run.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { notify } from "../design/notifications.js";
import { fleetPlanView, parseFleetVars } from "./fleet-run-model.js";
import "./session-board.css";

type Ready = Extract<FleetPreview, { status: "ready" }>;

/**
 * The terminal's `/fleet run <name>`. Preview compiles the contract and dispatches nothing; Run
 * starts the plan only if it still hashes to the one shown, so a contract edited in between is
 * shown again instead of run. Progress arrives in the fleet history beside this panel.
 */
export const FleetRunPanel = memo(function FleetRunPanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	running,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	running: boolean;
}) {
	const fieldId = useId();
	const [name, setName] = useState("");
	const [varsText, setVarsText] = useState("");
	const [shown, setShown] = useState<{ preview: FleetPreview; vars: Record<string, string> } | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const params = { params: { id: sessionId }, query: {} };
	const parsed = parseFleetVars(varsText);
	const preview = useMutation({
		mutationFn: (input: { name: string; vars: Record<string, string> }) =>
			client
				.call(routes.previewFleetRun, { ...params, body: input })
				.then((result) => ({ preview: result, vars: input.vars })),
		onSuccess: (result) => setShown(result),
	});
	const run = useMutation({
		mutationFn: (input: { preview: Ready; vars: Record<string, string> }) =>
			client.call(
				routes.startFleetRun,
				{ ...params, body: { name: input.preview.name, vars: input.vars, planHash: input.preview.planHash } },
				crypto.randomUUID(),
			),
		onSuccess: (result, input) => {
			if (result.status === "started") {
				setShown(null);
				setNote(null);
				notify({
					tone: "success",
					title: `Fleet ${result.name} started`,
					detail: `${result.stepCount} steps under ${result.fleetRootId}. Their runs appear in the fleet history below.`,
				});
				return;
			}
			if (result.status === "changed") {
				setNote("The plan changed since you reviewed it. Nothing was dispatched; the new plan is shown below.");
				preview.mutate({ name: input.preview.name, vars: input.vars });
				return;
			}
			if (result.status === "failed") {
				setShown(null);
				setNote(null);
				setFailure(`Fleet ${result.name} did not start: ${result.reason}`);
				return;
			}
			setShown({ preview: result, vars: input.vars });
		},
	});
	const supported = !!capabilities?.fleet;
	const ready = shown?.preview.status === "ready" ? shown.preview : null;
	const view = ready ? fleetPlanView(ready) : null;
	return (
		<details className="command-panel session-board fleet-run-panel">
			<summary>Run a fleet contract</summary>
			{!sessionOpen ? <p>This session is not open. Load it to run a fleet contract.</p> : null}
			{sessionOpen && !supported ? <p>This Clio Coder session cannot preview fleet contracts.</p> : null}
			{sessionOpen && supported ? (
				<form
					className="handoff-panel__goal"
					onSubmit={(event) => {
						event.preventDefault();
						if ("error" in parsed) return;
						setNote(null);
						setFailure(null);
						preview.mutate({ name: name.trim(), vars: parsed.vars });
					}}
				>
					<p className="session-board__note">
						A fleet contract is a named plan in this project's <span className="session-board__hash">.clio-coder/fleets</span>
						. Previewing compiles it and starts nothing.
					</p>
					<label htmlFor={`${fieldId}-name`}>Contract name</label>
					<input
						id={`${fieldId}-name`}
						value={name}
						maxLength={128}
						onChange={(event) => {
							setName(event.target.value);
							setShown(null);
						}}
						placeholder="survey"
					/>
					<label htmlFor={`${fieldId}-vars`}>Variables, one name=value per line</label>
					<textarea
						id={`${fieldId}-vars`}
						value={varsText}
						rows={2}
						onChange={(event) => {
							setVarsText(event.target.value);
							setShown(null);
						}}
					/>
					{"error" in parsed ? <small role="alert">{parsed.error}</small> : null}
					<button type="submit" disabled={preview.isPending || !name.trim() || "error" in parsed}>
						{preview.isPending ? "Compiling…" : "Preview the plan"}
					</button>
				</form>
			) : null}
			{failure ? (
				<p role="alert" className="handoff-panel__refusal handoff-panel__refusal--error">
					{failure}
				</p>
			) : null}
			{note ? (
				<p role="status" className="session-board__note">
					{note}
				</p>
			) : null}
			{shown?.preview.status === "refused" ? (
				<div role="alert" className="handoff-panel__refusal handoff-panel__refusal--error">
					<strong>Fleet {shown.preview.name} cannot run.</strong>
					<ul>
						{shown.preview.diagnostics.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</div>
			) : null}
			{ready && view ? (
				<section aria-labelledby={`${fieldId}-plan`}>
					<h3 id={`${fieldId}-plan`}>
						Fleet {ready.name}: {view.heading}
					</h3>
					{view.waves.map((wave) => (
						<div key={wave.label}>
							<p className="session-board__note">{wave.label}</p>
							<ol className="session-board__rows fleet-run-panel__rows">
								{wave.rows.map((row) => (
									<li key={row.key}>
										<span className="session-board__id">{row.step}</span>
										<span className="session-board__title">
											{row.who}
											<small>{[row.where, ...row.notes].filter(Boolean).join(" · ")}</small>
										</span>
									</li>
								))}
							</ol>
						</div>
					))}
					{view.truncated ? (
						<p className="session-board__note">Only the first 64 steps are shown; the terminal shows the whole plan.</p>
					) : null}
					<p className="session-board__note">{view.budget}</p>
					<p className="session-board__note">
						Starting it runs plan{" "}
						<span className="session-board__hash" title={view.hash.full}>
							{view.hash.short}
						</span>{" "}
						exactly; a changed contract is shown again instead.
					</p>
					<span className="session-board__actions">
						<button
							type="button"
							className="handoff-panel__start"
							disabled={run.isPending || running}
							onClick={() => shown && run.mutate({ preview: ready, vars: shown.vars })}
						>
							{run.isPending ? "Starting…" : "Run this plan"}
						</button>
						<button type="button" disabled={run.isPending} onClick={() => setShown(null)}>
							Discard
						</button>
					</span>
					{running ? <p className="session-board__note">Wait for the current turn to finish before starting it.</p> : null}
				</section>
			) : null}
			{preview.error || run.error ? <p role="alert">{(preview.error ?? run.error)?.message}</p> : null}
		</details>
	);
});
