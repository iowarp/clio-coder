// The parts of the wizard that are not a prompt: waiting on the child, a finished connection, the
// workspace step, and the ends that are not success.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { WorkspaceBrowser } from "../pages/workspace-browser.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { rememberWorkspace } from "../shell/tasks.js";
import type { SignIn, WizardView } from "./wizard-model.js";

function useHeadingFocus() {
	const root = useRef<HTMLElement>(null);
	useEffect(() => {
		const node = root.current;
		(node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>("h1"))?.focus({
			preventScroll: true,
		});
	}, []);
	return root;
}

export function WorkingStep({
	label,
	signIn,
	onCancel,
	cancelling,
}: {
	label: string;
	signIn: SignIn | null;
	onCancel: () => void;
	cancelling: boolean;
}) {
	const root = useHeadingFocus();
	const id = useId();
	return (
		<section className="wizard-step wizard-step--working" ref={root} aria-labelledby={id} aria-busy="true">
			<h1 id={id} tabIndex={-1}>
				{signIn ? "Finish signing in" : "One moment."}
			</h1>
			<p className="wizard-working">
				<ClioPulse size={PULSE_SIZE.stage} />
				<span role="status">{label}</span>
			</p>
			{signIn ? (
				<div className="wizard-signin">
					{signIn.url ? (
						<a
							className="wizard-link-button primary"
							data-autofocus
							href={signIn.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							Open sign-in in your browser <Icon name="external" />
						</a>
					) : null}
					{signIn.code ? (
						<p>
							Enter this code on the page that opens: <code className="wizard-code">{signIn.code}</code>
						</p>
					) : null}
					<p className="wizard-hint">
						Clio waits for the browser to finish and carries on by itself. If the browser cannot reach back, a field for the
						verification code appears here.
					</p>
				</div>
			) : null}
			<div className="wizard-step__actions">
				<button type="button" className="wizard-quiet" disabled={cancelling} onClick={onCancel}>
					Cancel setup
				</button>
			</div>
		</section>
	);
}

export function SavedStep({
	view,
	onContinue,
	continueLabel,
}: {
	view: Extract<WizardView, { kind: "saved" }>;
	onContinue: () => void;
	continueLabel: string;
}) {
	const root = useHeadingFocus();
	const id = useId();
	return (
		<section className="wizard-step wizard-step--saved" ref={root} aria-labelledby={id}>
			<h1 id={id} tabIndex={-1}>
				{view.verified ? "You’re connected." : "Connection saved."}
			</h1>
			<p className="wizard-step__lede">
				{view.verified
					? "Clio reached the connection and has the model it will start on."
					: "Clio could not reach it just now. The settings are saved, and Settings can check it again."}
			</p>
			{view.summary.length > 0 ? (
				<ul className="wizard-checks" aria-label="What was saved">
					{view.summary.map((line) => (
						<li className="wizard-check" data-tone="ok" key={line}>
							<span className="wizard-check__mark" aria-hidden="true">
								<Icon name="check" />
							</span>
							<span className="wizard-check__text">{line}</span>
						</li>
					))}
				</ul>
			) : null}
			{view.warnings.map((warning) => (
				<p className="wizard-problem" data-tone="warn" key={warning}>
					{warning}
				</p>
			))}
			<div className="wizard-step__actions">
				<button type="button" className="primary wizard-button" data-autofocus onClick={onContinue}>
					{continueLabel}
				</button>
			</div>
		</section>
	);
}

/** The last step of a first run: a folder on this machine to work in. It lands on the blank task screen. */
export function WorkspaceStep({ client, onOpened }: { client: Client; onOpened: () => void }) {
	const queries = useQueryClient();
	const root = useHeadingFocus();
	const id = useId();
	const field = useId();
	const [path, setPath] = useState("");
	const open = useMutation({
		mutationFn: (target: string) => client.call(routes.openWorkspace, { ...emptyInput, body: { path: target } }),
		onSuccess: (workspace) => {
			rememberWorkspace(workspace.id);
			void queries.invalidateQueries({ queryKey: ["workspaces"] });
			onOpened();
		},
	});
	const submit = (target: string) => {
		if (target.trim() !== "" && !open.isPending) open.mutate(target.trim());
	};
	return (
		<section className="wizard-step" data-wide="yes" ref={root} aria-labelledby={id}>
			<h1 id={id} tabIndex={-1}>
				Open your first workspace.
			</h1>
			<p className="wizard-step__lede">
				A folder on this machine. Clio reads and edits files inside it, and asks before it changes anything.
			</p>
			<form
				className="wizard-field"
				onSubmit={(event) => {
					event.preventDefault();
					submit(path);
				}}
			>
				<label htmlFor={field}>Project folder</label>
				<div className="wizard-field__row">
					<input
						id={field}
						data-autofocus
						className="wizard-mono"
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="/absolute/path/to/project"
						autoComplete="off"
						spellCheck={false}
					/>
					<button type="submit" className="primary wizard-button" disabled={open.isPending || path.trim() === ""}>
						{open.isPending ? (
							<>
								<ClioPulse size={PULSE_SIZE.row} />
								Opening
							</>
						) : (
							"Open"
						)}
					</button>
				</div>
				{open.error ? (
					<p className="wizard-problem" role="alert">
						{open.error.message}
					</p>
				) : null}
			</form>
			<WorkspaceBrowser
				client={client}
				embedded
				initialPath={path}
				onChoose={setPath}
				onStart={(selected) => submit(selected)}
				onClose={() => undefined}
			/>
		</section>
	);
}

export function EndStep({
	kind,
	problem,
	onRetry,
}: {
	kind: "failed" | "cancelled";
	problem: string;
	onRetry: () => void;
}) {
	const root = useHeadingFocus();
	const id = useId();
	return (
		<section className="wizard-step" ref={root} aria-labelledby={id}>
			<h1 id={id} tabIndex={-1}>
				{kind === "failed" ? "Setup stopped." : "Setup cancelled."}
			</h1>
			<p className="wizard-step__lede" role={kind === "failed" ? "alert" : undefined}>
				{kind === "failed" ? problem : "Nothing was saved, except a browser sign-in you had already finished."}
			</p>
			<div className="wizard-step__actions">
				<button type="button" className="primary wizard-button" data-autofocus onClick={onRetry}>
					{kind === "failed" ? "Try again" : "Start over"}
				</button>
			</div>
		</section>
	);
}
