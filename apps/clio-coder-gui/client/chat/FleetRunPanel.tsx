import { useMutation } from "@tanstack/react-query";
import { memo, useId, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { FleetPreview } from "../../contracts/fleet-run.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { notify } from "../design/notifications.js";
import { fleetPlanView, parseFleetVars } from "./fleet-run-model.js";
import "./agents.css";

type Ready = Extract<FleetPreview, { status: "ready" }>;

/**
 * The terminal's `/fleet run <name>`. Preview compiles the contract and dispatches nothing; Run
 * starts the plan only if it still hashes to the one shown, so a contract edited in between is
 * shown again instead of run. Its runs join the agent tree above this panel.
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
					detail: `${result.stepCount} steps under ${result.fleetRootId}. Their runs appear under Agents in the task pane.`,
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
		<details className="agents-section fleet-run-panel">
			<summary>
				<h3 className="agents-eyebrow">Run a fleet contract</h3>
				<Icon name="chevronDown" />
			</summary>
			{!sessionOpen ? <p className="agents-note">This session is not open. Load it to run a fleet contract.</p> : null}
			{sessionOpen && !supported ? (
				<p className="agents-note">This Clio Coder session cannot preview fleet contracts.</p>
			) : null}
			{sessionOpen && supported ? (
				<form
					className="agents-form"
					onSubmit={(event) => {
						event.preventDefault();
						if ("error" in parsed) return;
						setNote(null);
						setFailure(null);
						preview.mutate({ name: name.trim(), vars: parsed.vars });
					}}
				>
					<p className="agents-note">
						A named plan in this project's <code className="agents-mono">.clio-coder/fleets</code>. Previewing compiles it and
						starts nothing.
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
					<button
						type="submit"
						className="agents-form__submit"
						disabled={preview.isPending || !name.trim() || "error" in parsed}
					>
						{preview.isPending ? "Compiling…" : "Preview the plan"}
					</button>
				</form>
			) : null}
			{failure ? (
				<p role="alert" className="agents-alert">
					{failure}
				</p>
			) : null}
			{note ? (
				<p role="status" className="agents-note">
					{note}
				</p>
			) : null}
			{shown?.preview.status === "refused" ? (
				<div role="alert" className="agents-alert">
					<strong>Fleet {shown.preview.name} cannot run.</strong>
					<ul>
						{shown.preview.diagnostics.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</div>
			) : null}
			{ready && view ? (
				<section className="agents-plan" aria-labelledby={`${fieldId}-plan`}>
					<h4 id={`${fieldId}-plan`}>
						Fleet {ready.name}: {view.heading}
					</h4>
					{view.waves.map((wave) => (
						<div className="agents-plan__wave" key={wave.label}>
							<p className="agents-eyebrow">{wave.label}</p>
							<ol>
								{wave.rows.map((row) => (
									<li key={row.key}>
										<span className="agents-mono">{row.step}</span>
										<span>
											{row.who}
											<small>{[row.where, ...row.notes].filter(Boolean).join(" · ")}</small>
										</span>
									</li>
								))}
							</ol>
						</div>
					))}
					{view.truncated ? (
						<p className="agents-note">
							This preview omits steps or details. Review the full plan in the terminal before starting.
						</p>
					) : null}
					<p className="agents-note">{view.budget}</p>
					<p className="agents-note">
						Starting it runs plan{" "}
						<span className="agents-mono" title={view.hash.full}>
							{view.hash.short}
						</span>{" "}
						exactly; a changed contract is shown again instead.
					</p>
					<span className="agents-plan__actions">
						<button
							type="button"
							className="agents-plan__start"
							disabled={run.isPending || running}
							onClick={() => shown && run.mutate({ preview: ready, vars: shown.vars })}
						>
							{run.isPending ? "Starting…" : "Run this plan"}
						</button>
						<button type="button" disabled={run.isPending} onClick={() => setShown(null)}>
							Discard
						</button>
					</span>
					{running ? <p className="agents-note">Wait for the current turn to finish before starting it.</p> : null}
				</section>
			) : null}
			{preview.error || run.error ? (
				<p role="alert" className="agents-alert">
					{(preview.error ?? run.error)?.message}
				</p>
			) : null}
		</details>
	);
});
