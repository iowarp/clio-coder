import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Workspace } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import { STARTER_PROMPTS } from "../chat/chat-turn.js";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { ClioLogo, ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { withRoom } from "../shell/capacity.js";
import { useShell } from "../shell/shell-context.js";
import { isUntouched } from "../shell/shell-model.js";
import { TopBar } from "../shell/TopBar.js";
import { rememberWorkspace } from "../shell/tasks.js";
import "./home.css";
import { ConnectionSetup, useSetupStatus } from "./target-onboarding.js";

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
			<div className="ws-menu__panel" role="menu">
				{workspaces.map((workspace) => (
					<button
						key={workspace.id}
						type="button"
						role="menuitemradio"
						aria-checked={workspace.id === value}
						onClick={() => {
							onChange(workspace.id);
							if (menu.current) menu.current.open = false;
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
					role="menuitem"
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
			</div>
		</details>
	);
}

/** The two things a first run needs, in order. Each step marks itself done and the composer takes over. */
function Onboarding({
	client,
	ready,
	summary,
	targetId,
	hasWorkspace,
	onOpenWorkspace,
}: {
	client: Client;
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
					{ready ? null : <ConnectionSetup client={client} bare {...(targetId ? { targetId } : {})} />}
				</div>
			</li>
			<li data-done={hasWorkspace}>
				<span className="onboard__mark" aria-hidden="true">
					{hasWorkspace ? <Icon name="check" /> : "2"}
				</span>
				<div>
					<h2>Open a workspace</h2>
					<p>A folder on this machine. Clio reads and edits files inside it, and asks before it changes anything.</p>
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
	const navigate = useNavigate();
	const queries = useQueryClient();
	const setup = useSetupStatus(client);
	const fieldId = useId();
	const field = useRef<HTMLTextAreaElement>(null);
	const key = useRef<string>(crypto.randomUUID());
	const [text, setText] = useState("");
	const [chosen, setChosen] = useState<string | null>(null);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const list = workspaces.data ?? [];
	const workspaceId = chosen && list.some((item) => item.id === chosen) ? chosen : (shell?.activeWorkspaceId ?? null);
	const ready = setup.data?.state === "ready";
	const send = useMutation({
		mutationFn: async ({ workspace, request }: { workspace: string; request: string }) => {
			const sessions = await queries.fetchQuery({
				queryKey: ["sessions"],
				queryFn: () => client.call(routes.sessions, emptyInput),
				staleTime: 0,
			});
			const draft = sessions.find((session) => session.workspaceId === workspace && isUntouched(session));
			const session =
				draft ??
				(await withRoom(client, queries, () =>
					client.call(routes.newSession, { params: { id: workspace }, query: {}, body: {} }),
				));
			await client.call(routes.turn, { params: { id: session.id }, query: {}, body: { text: request } }, key.current);
			return session;
		},
		onSuccess: (session, { workspace }) => {
			key.current = crypto.randomUUID();
			rememberWorkspace(workspace);
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/sessions/${session.id}`);
		},
	});
	const canSend = ready && workspaceId !== null && text.trim() !== "" && !send.isPending;
	const submit = () => {
		if (canSend && workspaceId) send.mutate({ workspace: workspaceId, request: text.trim() });
	};
	useEffect(() => {
		if (window.matchMedia("(pointer: fine)").matches) field.current?.focus();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is the resize trigger; the DOM read happens in the callback.
	useEffect(() => {
		const node = field.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
	}, [text]);
	const needsSetup = setup.isSuccess && !ready;
	const needsWorkspace = workspaces.isSuccess && list.length === 0;
	const onboarding = needsSetup || needsWorkspace;
	const summary = setup.data?.targetId
		? ready
			? `${setup.data.targetId}${setup.data.model ? ` · ${setup.data.model}` : ""}`
			: `${setup.data.targetId}: ${setup.data.message}`
		: ready
			? null
			: (setup.data?.message ?? null);
	return (
		<>
			<TopBar />
			<div className="newtask">
				<div className="newtask__inner">
					<ClioLogo size={46} />
					<h1 className="newtask__title">
						{onboarding ? (
							<>
								Let’s get you <em>started</em>.
							</>
						) : (
							<>
								What are we <em>working on</em>?
							</>
						)}
					</h1>
					{setup.error ? (
						<div role="alert" className="newtask__notice">
							<p>{setup.error.message}</p>
							<button type="button" onClick={() => void setup.refetch()}>
								Check setup again
							</button>
						</div>
					) : null}
					{onboarding ? (
						<Onboarding
							client={client}
							ready={ready}
							summary={summary}
							targetId={setup.data?.targetId ?? undefined}
							hasWorkspace={!needsWorkspace}
							onOpenWorkspace={() => shell?.openWorkspace()}
						/>
					) : (
						<>
							<form
								className="newtask__composer"
								onSubmit={(event) => {
									event.preventDefault();
									submit();
								}}
							>
								<label className="sr-only" htmlFor={fieldId}>
									Message Clio Coder
								</label>
								<textarea
									id={fieldId}
									ref={field}
									rows={2}
									value={text}
									placeholder="Describe a task or ask a question"
									onChange={(event) => setText(event.target.value)}
									onKeyDown={(event) => {
										if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
										if (event.ctrlKey || event.metaKey || window.matchMedia("(pointer: fine)").matches) {
											event.preventDefault();
											submit();
										}
									}}
								/>
								<div className="newtask__row">
									<WorkspaceMenu
										workspaces={list}
										value={workspaceId}
										onChange={setChosen}
										onOpen={() => shell?.openWorkspace()}
									/>
									<span className="newtask__spacer" />
									<button
										className="newtask__send"
										type="submit"
										disabled={!canSend}
										aria-label={send.isPending ? "Starting task…" : "Start task"}
									>
										{send.isPending ? <ClioPulse size={PULSE_SIZE.row} /> : <Icon name="arrowUp" />}
									</button>
								</div>
							</form>
							{send.error ? (
								<p className="newtask__error" role="alert">
									{send.error.message}
								</p>
							) : null}
							{workspaceId ? (
								<ul className="newtask__starters" aria-label="Ways to start">
									{STARTER_PROMPTS.map((prompt) => (
										<li key={prompt}>
											<button
												type="button"
												onClick={() => {
													setText(prompt);
													field.current?.focus();
												}}
											>
												{prompt}
											</button>
										</li>
									))}
								</ul>
							) : null}
						</>
					)}
				</div>
			</div>
		</>
	);
}
