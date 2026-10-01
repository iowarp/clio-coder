// The setup wizard: a full-window, graphical front for `clio-coder configure`. The child process owns
// every question and what each answer means; this component draws them (wizard-model.ts), sends the
// answers (use-setup.ts) and never keeps a credential. It loads lazily, so none of it, including the
// films, is part of the main bundle.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { announce, setPageTitle } from "../interaction/announcer.js";
import { EndStep, SavedStep, WorkingStep, WorkspaceStep } from "./phases.js";
import { Stage } from "./Stage.js";
import {
	CategoryStep,
	CredentialKeyStep,
	CredentialSourceStep,
	DetailsStep,
	DetectedStep,
	GenericStep,
	LoginMethodStep,
	ModelMissingStep,
	ModelStep,
	ProviderStep,
	ReviewStep,
	SignInStep,
	TextStep,
	WelcomeStep,
} from "./steps.js";
import { useSetupSession } from "./use-setup.js";
import {
	backAnswer,
	readMessages,
	STAGE_LABELS,
	type StageId,
	type StepView,
	selectAnswer,
	stagesFor,
	viewFor,
	type WizardMode,
	type WizardView,
} from "./wizard-model.js";
import "./wizard.css";

export type WizardExit = "home" | "back";

const CAPTIONS: Readonly<Record<StageId | "welcome" | "saved", string>> = {
	welcome: "A coding agent that works in your folders and asks before it changes anything.",
	provider: "Choose what you already use.",
	connect: "Credentials stay with the Clio command-line tool, never in this page.",
	model: "Clio starts on the model marked default.",
	test: "Nothing here sends a prompt.",
	workspace: "Clio works inside the folder you choose.",
	saved: "Connected.",
};

const CAPTION_NO_MODELS = "Clio only checks the address. It never sends a prompt.";

/** A delay before the working screen replaces a step, so an answer the CLI takes a moment to accept does not flash. */
const WORKING_DELAY_MS = 350;

function Stepper({ stages, current, done }: { stages: readonly StageId[]; current: StageId | null; done: boolean }) {
	const at = current === null ? -1 : stages.indexOf(current);
	return (
		<ol className="wizard-stepper" aria-label="Setup progress">
			{stages.map((stage, index) => {
				const state = done || index < at ? "done" : index === at ? "current" : "next";
				return (
					<li key={stage} data-state={state} {...(state === "current" ? { "aria-current": "step" as const } : {})}>
						<span className="wizard-stepper__mark" aria-hidden="true">
							{state === "done" ? <Icon name="check" /> : index + 1}
						</span>
						<span className="wizard-stepper__label">{STAGE_LABELS[stage]}</span>
						{state === "done" ? <span className="sr-only"> done</span> : null}
					</li>
				);
			})}
		</ol>
	);
}

function titleOf(view: WizardView): string {
	if (view.kind === "welcome") return "Welcome to Clio Coder";
	if (view.kind === "working") return view.label;
	if (view.kind === "saved") return "Connection saved";
	if (view.kind === "failed") return "Setup stopped";
	if (view.kind === "cancelled") return "Setup cancelled";
	return view.prompt.heading[0] || "Continue setup";
}

export default function Wizard({
	client,
	mode,
	targetId,
	onExit,
}: {
	client: Client;
	mode: WizardMode;
	targetId?: string | undefined;
	onExit: (to: WizardExit) => void;
}) {
	const session = useSetupSession(client);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const [needsWorkspace, setNeedsWorkspace] = useState<boolean | null>(null);
	const [phase, setPhase] = useState<"setup" | "workspace">("setup");
	const [workingShown, setWorkingShown] = useState(false);
	const lastStep = useRef<StepView | null>(null);
	const started = useRef(false);

	// A first run with no folder ends in the workspace step; a machine that already has one does not.
	useEffect(() => {
		if (needsWorkspace === null && workspaces.isSuccess)
			setNeedsWorkspace(mode === "first" && workspaces.data.length === 0);
	}, [needsWorkspace, workspaces.isSuccess, workspaces.data, mode]);

	const raw = useMemo(() => viewFor(session.state, lastStep.current), [session.state]);
	useEffect(() => {
		if ("prompt" in raw) lastStep.current = raw;
	}, [raw]);
	useEffect(() => {
		if (raw.kind !== "working") {
			setWorkingShown(false);
			return;
		}
		const timer = setTimeout(() => setWorkingShown(true), WORKING_DELAY_MS);
		return () => clearTimeout(timer);
	}, [raw.kind]);
	const holding = raw.kind === "working" && !workingShown && lastStep.current !== null;
	const view: WizardView = holding && lastStep.current ? lastStep.current : raw;
	const busy = session.busy || raw.kind === "working";

	// Repair and add start at once. A first run opens on the welcome screen.
	useEffect(() => {
		if (mode !== "first" && !started.current && session.state === null) {
			started.current = true;
			session.start(targetId);
		}
	}, [mode, targetId, session.state, session.start]);
	// Repairing keeps the provider the connection already has, so its first question answers itself once.
	const kept = useRef(false);
	useEffect(() => {
		if (mode !== "repair" || kept.current || view.kind !== "provider" || busy) return;
		const current = view.options.find((option) => option.choice.id === view.prompt.initial);
		if (!current) return;
		kept.current = true;
		session.answer(selectAnswer(view.prompt, current.choice));
	}, [mode, view, busy, session.answer]);
	// A cancelled run ends the wizard where it was opened, or returns a first run to its welcome.
	useEffect(() => {
		if (raw.kind !== "cancelled") return;
		if (mode === "first") session.reset();
		else onExit("back");
	}, [raw.kind, mode, session.reset, onExit]);

	const prompt = "prompt" in view ? view.prompt : null;
	const canBack = phase === "setup" && prompt !== null && !busy;
	const goBack = useCallback(() => {
		if (prompt !== null && !busy) session.answer(backAnswer(prompt));
	}, [prompt, busy, session.answer]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || !canBack) return;
			const target = event.target;
			if (target instanceof HTMLInputElement && target.value !== "") return;
			event.preventDefault();
			goBack();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [canBack, goBack]);

	useEffect(() => {
		setPageTitle("Set up Clio Coder");
		return () => setPageTitle(null);
	}, []);
	const spoken = phase === "workspace" ? "Open your first workspace" : titleOf(view);
	useEffect(() => {
		announce(spoken);
	}, [spoken]);

	const read = useMemo(() => readMessages(session.state?.messages ?? []), [session.state?.messages]);
	const stages = stagesFor(mode, needsWorkspace === true);
	const current: StageId | null =
		phase === "workspace" ? "workspace" : "stage" in view ? view.stage : view.kind === "welcome" ? null : null;
	const saved = raw.kind === "saved";
	const scene = phase === "workspace" ? "read" : "scene" in view ? view.scene : "read";
	const stageKey: StageId | "welcome" | "saved" =
		phase === "workspace" ? "workspace" : view.kind === "welcome" ? "welcome" : saved ? "saved" : (current ?? "provider");
	// While the card shows what is being waited on, the card carries the spinner. The stage carries it only
	// before the first step exists.
	const workingLabel = session.busy && session.state === null ? "Starting setup" : null;

	const send = session.answer;
	const problem = session.state?.problem ?? session.error;
	const common = { busy, problem, send };
	const showProbe =
		read.probe !== null &&
		(view.kind === "model" ||
			view.kind === "model-missing" ||
			view.kind === "detected" ||
			view.kind === "credential-source" ||
			view.kind === "credential-key" ||
			view.kind === "credential-env" ||
			view.kind === "review");

	const finish = () => {
		if (needsWorkspace === true) setPhase("workspace");
		else onExit("home");
	};

	let content: React.ReactNode;
	if (phase === "workspace") content = <WorkspaceStep client={client} onOpened={() => onExit("home")} />;
	else
		switch (view.kind) {
			case "welcome":
				content = (
					<WelcomeStep
						mode={mode}
						busy={session.busy}
						error={session.error}
						onStart={() => session.start(targetId)}
						onLater={mode === "first" ? null : () => onExit("back")}
					/>
				);
				break;
			case "category":
				content = <CategoryStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "provider":
				content = <ProviderStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "signin":
				content = <SignInStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "credential-source":
				content = <CredentialSourceStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "credential-key":
				content = <CredentialKeyStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "credential-env":
				content = (
					<TextStep
						key={view.prompt.id}
						view={view}
						{...common}
						title="Which environment variable?"
						lede={<p>Clio reads it each time it calls the provider, so the key never lands on disk.</p>}
						label="Variable name"
						placeholder="PROVIDER_API_KEY"
						submitLabel="Continue"
						mono
					/>
				);
				break;
			case "oauth-code":
				content = (
					<TextStep
						key={view.prompt.id}
						view={view}
						{...common}
						title="Paste the verification code"
						lede={<p>The browser could not reach back on its own. Paste the code the sign-in page shows.</p>}
						label="Verification code"
						submitLabel="Continue"
						mono
					/>
				);
				break;
			case "server":
				content = (
					<TextStep
						key={view.prompt.id}
						view={view}
						{...common}
						title={view.title || "Where is the server?"}
						lede={view.guidance.map((line) => <p key={line}>{line}</p>)}
						label="Address"
						submitLabel="Check and continue"
						mono
					/>
				);
				break;
			case "detected":
				content = <DetectedStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "login-method":
				content = <LoginMethodStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "model":
				content = <ModelStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "model-missing":
				content = <ModelMissingStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "model-manual":
				content = (
					<TextStep
						key={view.prompt.id}
						view={view}
						{...common}
						title="Enter a model ID"
						lede={<p>{view.warning ?? "Clio sends this exact text. It cannot verify it before saving."}</p>}
						label="Model ID"
						submitLabel="Continue"
						mono
					/>
				);
				break;
			case "review":
				content = <ReviewStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "details":
				content = <DetailsStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "generic":
				content = <GenericStep key={view.prompt.id} view={view} {...common} />;
				break;
			case "working":
				content = (
					<WorkingStep label={view.label} signIn={view.signIn} cancelling={session.busy} onCancel={session.cancel} />
				);
				break;
			case "saved":
				content = (
					<SavedStep
						view={view}
						onContinue={finish}
						continueLabel={needsWorkspace === true ? "Open a workspace" : mode === "first" ? "Start working" : "Done"}
					/>
				);
				break;
			case "failed":
				content = (
					<EndStep
						kind="failed"
						problem={view.problem}
						onRetry={() => {
							session.reset();
							if (mode !== "first") {
								started.current = true;
								session.start(targetId);
							}
						}}
					/>
				);
				break;
			case "cancelled":
				content = <EndStep kind="cancelled" problem="" onRetry={session.reset} />;
				break;
		}

	return (
		<div className="wizard" data-phase={phase}>
			<a className="skip-link" href="#wizard-step">
				Skip to setup
			</a>
			<header className="wizard__bar">
				<div className="wizard__bar-side">
					{canBack ? (
						<button type="button" className="wizard-back" onClick={goBack}>
							<Icon name="arrowLeft" />
							Back
						</button>
					) : null}
				</div>
				<Stepper stages={stages} current={current} done={saved && phase === "setup" && stages.at(-1) === "test"} />
				<div className="wizard__bar-side wizard__bar-side--end">
					{mode !== "first" && phase === "setup" && view.kind !== "saved" ? (
						<button type="button" className="wizard-quiet" onClick={() => onExit("back")}>
							Close
						</button>
					) : null}
				</div>
			</header>
			<div className="wizard__body">
				<aside className="wizard__stage" aria-label="Clio">
					<Stage
						scene={scene}
						caption={view.kind === "model-missing" ? CAPTION_NO_MODELS : CAPTIONS[stageKey]}
						working={workingLabel}
					/>
				</aside>
				<main id="wizard-step" className="wizard__main" tabIndex={-1}>
					{read.recap.length > 0 && phase === "setup" && view.kind !== "saved" ? (
						<dl className="wizard-recap" aria-label="Your choices so far">
							{read.recap.map((row) => (
								<div key={`${row.label}:${row.value}`}>
									<dt>{row.label}</dt>
									<dd>{row.value}</dd>
								</div>
							))}
						</dl>
					) : null}
					{showProbe && read.probe ? (
						<p className="wizard-probe" data-state={read.probe.state} role="status">
							<Icon name={read.probe.state === "reachable" ? "check" : "warn"} />
							<span>{read.probe.text}</span>
						</p>
					) : null}
					<div className="wizard__card" aria-busy={busy}>
						{content}
					</div>
				</main>
			</div>
		</div>
	);
}
