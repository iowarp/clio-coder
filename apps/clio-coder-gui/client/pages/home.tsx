import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Workspace } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { composerKeyAction, fitComposerField, initialEnterSends } from "../chat/composer-field.js";
import { PROMPT_TEXT_MAX_CHARACTERS } from "../chat/composer-model.js";
import { useFieldAssist } from "../chat/use-field-assist.js";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { ClioStage } from "../shell/ClioStage.js";
import { HomeAside } from "../shell/HomeAside.js";
import { useShell } from "../shell/shell-context.js";
import { TopBar } from "../shell/TopBar.js";
import { rememberWorkspace } from "../shell/tasks.js";
import { firstRequestBusy, homeDraft, subscribeHomeDraft, updateHomeDraft } from "./home-draft.js";
import { EMPTY_HOME_DRAFT, HOME_DRAFT_TEXT_MAX_CHARACTERS } from "./home-draft-model.js";
import { reconcileFirstTask, useFirstTask } from "./use-first-task.js";
import "../chat/composer-box.css";
import "./home.css";
import { setupLink, useSetupStatus } from "./target-onboarding.js";

const TASK_STARTERS = [
	{
		icon: "compose",
		title: "Build something",
		detail: "Make a tool, workflow or experiment",
		prompt: "I'd like to build ",
	},
	{
		icon: "toolchain",
		title: "Fix a problem",
		detail: "Work through something that isn't right",
		prompt: "Help me fix a problem: ",
	},
	{
		icon: "search",
		title: "Explore a project",
		detail: "Understand what's here and how it works",
		prompt: "Give me a friendly overview of this project. Explain what it does, how it works, and where to start.",
	},
] as const;

/** The project the next task lands in, with a way to switch projects or open another folder. */
function WorkspaceMenu({
	workspaces,
	value,
	onChange,
	onOpen,
}: {
	workspaces: readonly Workspace[];
	value: string | null;
	onChange: (id: string) => void;
	onOpen: () => void;
}) {
	const menu = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useDetailsDismiss(menu, open);
	const current = workspaces.find((workspace) => workspace.id === value);
	return (
		<details className="ws-menu" ref={menu} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="wb-chip" title={current?.path}>
				<Icon name="folder" />
				<span>{current?.name ?? "Choose a workspace"}</span>
				<Icon name="chevronDown" />
			</summary>
			<fieldset className="ws-menu__panel" aria-label="Workspaces">
				{workspaces.map((workspace) => (
					<button
						key={workspace.id}
						type="button"
						aria-pressed={workspace.id === value}
						onClick={() => {
							onChange(workspace.id);
							if (menu.current) {
								menu.current.open = false;
								menu.current.querySelector("summary")?.focus();
							}
						}}
					>
						<Icon name={workspace.id === value ? "check" : "folder"} />
						<span>
							<strong>{workspace.name}</strong>
							<small>{workspace.path}</small>
						</span>
					</button>
				))}
				<button
					type="button"
					className="ws-menu__open"
					onClick={() => {
						if (menu.current) menu.current.open = false;
						onOpen();
					}}
				>
					<Icon name="folderOpen" />
					<span>
						<strong>Open workspace…</strong>
					</span>
				</button>
			</fieldset>
		</details>
	);
}

/**
 * What the new-task screen still needs before it can start work: a model connection that works, and a
 * folder. Setting up a connection is the wizard's job, so this only names the problem and links there.
 */
function Onboarding({
	ready,
	summary,
	targetId,
	hasWorkspace,
	onOpenWorkspace,
}: {
	ready: boolean;
	/** What is connected when it is, or what is wrong with the saved connection when it is not. */
	summary: string | null;
	targetId: string | undefined;
	hasWorkspace: boolean;
	onOpenWorkspace: () => void;
}) {
	return (
		<ol className="onboard">
			<li data-done={ready}>
				<span className="onboard__mark" aria-hidden="true">
					{ready ? <Icon name="check" /> : "1"}
				</span>
				<div>
					<h2>Connect a model</h2>
					<p>{summary ?? "Choose the app, subscription, provider or server you already use."}</p>
					{ready ? null : (
						<Link className="primary wb-link-button" to={setupLink(targetId)} state={{ from: "/" }}>
							{targetId ? "Repair the connection" : "Connect a model"}
						</Link>
					)}
				</div>
			</li>
			<li data-done={hasWorkspace}>
				<span className="onboard__mark" aria-hidden="true">
					{hasWorkspace ? <Icon name="check" /> : "2"}
				</span>
				<div>
					<h2>Open a workspace</h2>
					<p>
						A folder on this machine. Clio can read and edit files inside it. Your approval policy controls which actions ask
						first.
					</p>
					{hasWorkspace ? null : (
						<button type="button" className="primary" onClick={onOpenWorkspace}>
							<Icon name="folderOpen" />
							Open workspace
						</button>
					)}
				</div>
			</li>
		</ol>
	);
}

/**
 * A blank task. Nothing starts until the first message is sent: the session is created, the request
 * goes out, and the conversation opens already working. Until then no ACP child exists.
 */
export function Home({ client }: { client: Client }) {
	const shell = useShell();
	const fieldId = useId();
	const field = useRef<HTMLTextAreaElement>(null);
	const draft = useSyncExternalStore(subscribeHomeDraft, homeDraft);
	const busy = useSyncExternalStore(subscribeHomeDraft, firstRequestBusy);
	const { text, pending } = draft;
	const limitId = `${fieldId}-limit`;
	const textIssue =
		draft.textIssue === "too-large"
			? `Drafts can contain up to ${HOME_DRAFT_TEXT_MAX_CHARACTERS.toLocaleString()} characters. This edit was not applied; shorten the text and try again.`
			: draft.textIssue === "restored-too-large"
				? `The saved draft exceeded ${HOME_DRAFT_TEXT_MAX_CHARACTERS.toLocaleString()} characters. Only its first ${HOME_DRAFT_TEXT_MAX_CHARACTERS.toLocaleString()} characters were restored.`
				: draft.textIssue === "invalid"
					? "The saved draft text could not be restored."
					: text.trim().length > PROMPT_TEXT_MAX_CHARACTERS
						? "A request can contain up to 32,000 characters. Shorten the draft before starting a task."
						: null;
	const setText = (value: string) => updateHomeDraft({ text: value });
	const setChosen = (workspaceId: string) => {
		updateHomeDraft({ workspaceId });
		rememberWorkspace(workspaceId);
	};
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const list = workspaces.data ?? [];
	// A missing saved choice stays visible as a recovery state; never send to a fallback project silently.
	const workspaceId = draft.workspaceId ?? shell?.activeWorkspaceId ?? list[0]?.id ?? null;
	const workspace = list.find((item) => item.id === workspaceId) ?? null;
	useEffect(() => {
		if (!draft.workspaceId && workspaceId) updateHomeDraft({ workspaceId });
	}, [draft.workspaceId, workspaceId]);
	const setup = useSetupStatus(client, true, workspaceId);
	const ready = setup.data?.state === "ready";
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
	});
	const send = useFirstTask(client);
	const reconcile = useMutation({
		mutationFn: async () => {
			await meta.refetch({ throwOnError: true });
			return reconcileFirstTask(client);
		},
	});
	const epochChanged = !!pending && !!meta.data && pending.epoch !== meta.data.epoch;
	const missingWorkspace = workspaces.isSuccess && !!workspaceId && !workspace;
	const retryWorkspaces = () => {
		void workspaces.refetch();
		void setup.refetch();
	};
	const discard = () => {
		if (busy) return;
		updateHomeDraft({ ...EMPTY_HOME_DRAFT, workspaceId });
		send.reset();
		reconcile.reset();
		field.current?.focus();
	};
	const canSend =
		(ready || setup.isPending) &&
		workspaces.isSuccess &&
		!!workspace &&
		text.trim() !== "" &&
		text.trim().length <= PROMPT_TEXT_MAX_CHARACTERS &&
		!busy &&
		!pending;
	const submit = () => {
		if (!canSend || !workspaceId) return;
		updateHomeDraft({ workspaceId });
		send.mutate();
	};
	useEffect(() => {
		if (window.matchMedia("(pointer: fine)").matches) field.current?.focus();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is the resize trigger; the DOM read happens in the callback.
	useLayoutEffect(() => fitComposerField(field.current), [text]);
	const assist = useFieldAssist({ client, workspaceId, text, setText, field });
	const needsSetup = setup.isSuccess && !ready;
	const needsWorkspace = workspaces.isSuccess && list.length === 0;
	const onboarding = needsSetup || needsWorkspace;
	const summary = setup.data?.targetId
		? ready
			? `${setup.data.targetId} · ${setup.data.model ?? "Model not reported"}`
			: `${setup.data.targetId}: ${setup.data.message}`
		: ready
			? null
			: (setup.data?.message ?? null);
	return (
		<>
			<HomeAside client={client} workspace={workspace} />
			<TopBar />
			<div className="newtask">
				<div className="newtask__inner">
					<ClioStage
						total={2}
						done={setup.isSuccess && workspaces.isSuccess ? (ready ? 1 : 0) + (needsWorkspace ? 0 : 1) : null}
					/>
					<h1 className="newtask__title">
						{onboarding ? (
							<>
								Let’s get you <em>started</em>.
							</>
						) : (
							<>
								What would you like to <em>do</em>?
							</>
						)}
					</h1>
					{!onboarding ? (
						<p className="newtask__intro">Bring an idea, a question, or a problem. Start with your own words.</p>
					) : null}
					{onboarding ? (
						<Onboarding
							ready={ready}
							summary={summary}
							targetId={setup.data?.targetId ?? undefined}
							hasWorkspace={!!workspace}
							onOpenWorkspace={() => shell?.openWorkspace()}
						/>
					) : null}
					{workspaces.isPending || workspaces.isError || needsWorkspace || missingWorkspace ? (
						<div className="newtask__notice newtask__recovery" role={workspaces.isError ? "alert" : "status"}>
							<p>
								{workspaces.isPending
									? "Loading workspaces. You can keep writing while Clio checks."
									: workspaces.isError
										? "Workspaces could not be loaded. Your draft is kept; retry to check them again."
										: missingWorkspace
											? "Your chosen workspace is no longer listed. Retry, choose another workspace, or reopen its folder."
											: "Open a workspace for this task, or retry to check for recently opened folders."}
							</p>
							<div className="newtask__recovery-actions">
								<button type="button" disabled={workspaces.isFetching} onClick={retryWorkspaces}>
									{workspaces.isFetching ? "Checking…" : "Retry"}
								</button>
								<button type="button" onClick={() => shell?.openWorkspace()}>
									Open workspace…
								</button>
							</div>
						</div>
					) : null}
					{setup.error ? (
						<div role="alert" className="newtask__notice newtask__recovery">
							<p>The model connection could not be checked. Your draft is kept.</p>
							<button type="button" disabled={setup.isFetching} onClick={() => void setup.refetch()}>
								{setup.isFetching ? "Checking…" : "Retry connection check"}
							</button>
						</div>
					) : null}
					{/* The conversation composer's box (chat/composer-box.css) with the one control a task
							    needs before it exists: where it runs. The rest of the row arrives with the session. */}
					<form
						className="composer newtask__composer"
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}
					>
						<label className="sr-only" htmlFor={fieldId}>
							Message Clio Coder
						</label>
						{assist.palette}
						<textarea
							id={fieldId}
							ref={field}
							className="composer__field"
							rows={1}
							value={text}
							aria-describedby={textIssue ? limitId : undefined}
							placeholder="Describe a task or ask a question"
							{...assist.fieldProps}
							onChange={(event) => {
								setText(event.target.value);
								assist.changed(event.target);
							}}
							onKeyDown={(event) => {
								if (assist.keyDown(event)) return;
								if (event.key !== "Enter") return;
								// The same Enter policy and stored preference as the conversation composer.
								const action = composerKeyAction(
									{
										key: event.key,
										altKey: event.altKey,
										ctrlKey: event.ctrlKey,
										metaKey: event.metaKey,
										shiftKey: event.shiftKey,
									},
									{ layerOwned: false, composing: event.nativeEvent.isComposing, plainEnterSends: initialEnterSends() },
								);
								if (action !== "send") return;
								event.preventDefault();
								submit();
							}}
						/>
						<div className="composer__actions">
							<div className="composer__tools">
								<WorkspaceMenu
									workspaces={list}
									value={workspaceId}
									onChange={setChosen}
									onOpen={() => shell?.openWorkspace()}
								/>
							</div>
							<div className="composer__route-actions">
								<button
									className="composer__submit primary"
									type="submit"
									disabled={!canSend}
									aria-label={busy ? "Starting task…" : "Start task"}
								>
									{busy ? <ClioPulse size={PULSE_SIZE.row} /> : <Icon name="arrowUp" />}
									<span>{busy ? "Starting…" : "Start task"}</span>
								</button>
							</div>
						</div>
					</form>
					{textIssue ? (
						<p id={limitId} className="newtask__error" role="status">
							{textIssue}
							{pending ? " The earlier request is preserved unchanged." : null}
						</p>
					) : null}
					<details className="newtask__context">
						<summary>
							<Icon name="models" />
							<span>
								{ready
									? (setup.data?.model ?? setup.data?.targetId ?? "Connected model")
									: setup.isPending
										? "Checking model connection…"
										: "Model connection needs attention"}
							</span>
							<span className="newtask__context-label">
								Task settings <Icon name="chevronDown" />
							</span>
						</summary>
						<dl>
							<dt>Project folder</dt>
							<dd>{workspace?.path ?? "Choose a workspace above"}</dd>
							<dt>Connection</dt>
							<dd>
								{summary ?? "Not reported"} ·{" "}
								<Link to={workspaceId ? `/settings/models?workspace=${encodeURIComponent(workspaceId)}` : "/settings/models"}>
									Change model
								</Link>
							</dd>
							<dt>Approvals</dt>
							<dd>
								Clio may read, edit and run commands. Approval prompts depend on the effective workspace policy.{" "}
								<Link to={workspaceId ? `/settings/safety?workspace=${encodeURIComponent(workspaceId)}` : "/settings/safety"}>
									Review policy
								</Link>
							</dd>
						</dl>
					</details>
					{pending ? (
						<div className="newtask__notice newtask__recovery" role="status">
							<p>
								{busy
									? "Starting your task. Your request is kept until Clio confirms it."
									: epochChanged
										? "Clio Coder restarted. The earlier request may have been accepted. Review the task before making a new request."
										: "The earlier request has no confirmed outcome. Retry sends that original request; edits above stay separate."}
							</p>
							<details>
								<summary>Earlier request</summary>
								<p className="newtask__request">{pending.exactTurnBody.text}</p>
								<p>Workspace: {list.find((item) => item.id === pending.workspaceId)?.name ?? pending.workspaceId}</p>
							</details>
							<div className="newtask__recovery-actions">
								{!epochChanged ? (
									<button type="button" disabled={busy || meta.isError || meta.isPending} onClick={() => send.mutate()}>
										Retry original request
									</button>
								) : null}
								<button type="button" disabled={busy || reconcile.isPending} onClick={() => reconcile.mutate()}>
									{reconcile.isPending ? "Checking…" : "Check status"}
								</button>
								{pending.sessionId ? (
									<Link to={`/sessions/${pending.sessionId}`}>Review task</Link>
								) : (
									<Link to="/sessions">Review tasks</Link>
								)}
							</div>
							{reconcile.isSuccess ? (
								<p>
									{reconcile.data
										? `The task is ${reconcile.data.state}, with ${reconcile.data.turns.length} reported turns. Review it to check the earlier request.`
										: "No session was confirmed in this tab. Review the workspace’s tasks; the earlier creation may have succeeded."}{" "}
									Matching text does not confirm this request’s outcome.
								</p>
							) : null}
							{reconcile.error ? (
								<p>The earlier task could not be checked. Review saved tasks before starting again.</p>
							) : null}
							{!busy && !reconcile.isPending ? (
								<>
									<p>Discarding this record does not stop a task already accepted.</p>
									<button
										type="button"
										onClick={() => {
											updateHomeDraft({ pending: null });
											send.reset();
											reconcile.reset();
										}}
									>
										Discard earlier request; keep draft
									</button>
								</>
							) : null}
						</div>
					) : null}
					{text || pending ? (
						<button className="newtask__discard" type="button" disabled={busy || reconcile.isPending} onClick={discard}>
							Discard draft{pending ? " and earlier request" : ""}
						</button>
					) : null}
					{send.error ? (
						<p className="newtask__error" role="alert">
							{send.error.message}
						</p>
					) : null}
					{workspaceId && !pending && !text ? (
						<ul className="newtask__starters" aria-label="Ways to start">
							{TASK_STARTERS.map((starter) => (
								<li key={starter.title}>
									<button
										type="button"
										onClick={() => {
											setText(starter.prompt);
											requestAnimationFrame(() => {
												field.current?.focus();
												field.current?.setSelectionRange(starter.prompt.length, starter.prompt.length);
											});
										}}
									>
										<Icon name={starter.icon} />
										<strong>{starter.title}</strong>
										<span>{starter.detail}</span>
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			</div>
		</>
	);
}
