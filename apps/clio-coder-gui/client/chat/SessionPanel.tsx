import { useQuery } from "@tanstack/react-query";
import { memo, useId, useState } from "react";
import { Link } from "react-router";
import { EMPTY_CAPABILITIES } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { useWorkspaceChrome } from "../design/workspace-chrome.js";
import { SessionControls } from "../pages/session-controls.js";
import { countRender } from "../render/render-probe.js";
import { AsidePanel } from "./AsidePanel.js";
import { BranchPanel } from "./BranchPanel.js";
import { CommandPanel } from "./CommandPanel.js";
import { ContextPanel } from "./ContextPanel.js";
import { ExtensionsPanel } from "./ExtensionsPanel.js";
import { HandoffPanel } from "./HandoffPanel.js";
import { PanelTabs } from "./PanelTabs.js";
import { SessionBoardPanel } from "./SessionBoard.js";
import { UsagePanel } from "./UsagePanel.js";

const sessionTabs = [
	{ id: "configuration", label: "Configuration" },
	{ id: "tasks", label: "Tasks" },
	{ id: "context", label: "Context" },
	{ id: "usage", label: "Usage" },
] as const;
const toolTabs = [
	{ id: "commands", label: "Commands" },
	{ id: "branches", label: "Branches" },
	{ id: "handoff", label: "Handoff" },
	{ id: "aside", label: "Side questions" },
	{ id: "extensions", label: "Extensions" },
] as const;

/** Each view mounts on demand. Visited forms remain mounted while switching, preserving their drafts. */
export const SessionPanel = memo(function SessionPanel({
	client,
	session,
	workspaceRoot,
	tools,
	onCloseSession,
	closing,
}: {
	client: Client;
	session: SessionSnapshot;
	workspaceRoot?: string | undefined;
	tools: boolean;
	onCloseSession: () => void;
	closing: boolean;
}) {
	countRender("session-panel");
	const id = useId();
	const chrome = useWorkspaceChrome();
	const [sessionTab, setSessionTab] = useState<(typeof sessionTabs)[number]["id"]>("configuration");
	const [toolTab, setToolTab] = useState<(typeof toolTabs)[number]["id"]>("commands");
	const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(["configuration", "commands"]));
	const capabilities = useQuery({
		queryKey: ["session-capabilities", session.id],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: session.id }, query: {}, body: {} }),
		enabled: session.state === "open",
		staleTime: Number.POSITIVE_INFINITY,
	});
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const facts = {
		client,
		sessionId: session.id,
		sessionOpen: session.state === "open",
		capabilities: capabilities.data,
	};
	const settledTurns = session.turns.filter((turn) => turn.status !== "running").length;
	const running = session.turns.at(-1)?.status === "running";
	const active = tools ? toolTab : sessionTab;
	const select = (next: typeof active) => {
		setVisited((previous) => new Set([...previous, next]));
		if (tools) setToolTab(next as typeof toolTab);
		else setSessionTab(next as typeof sessionTab);
	};
	return (
		<div className="session-panel">
			{tools ? (
				<PanelTabs id={id} tabs={toolTabs} value={toolTab} onChange={select} label="Session tools" />
			) : (
				<PanelTabs id={id} tabs={sessionTabs} value={sessionTab} onChange={select} label="Session views" />
			)}
			<div className="session-panel__panels">
				{(!tools ? sessionTabs : toolTabs).map((tab) => (
					<div
						key={tab.id}
						id={`${id}-panel-${tab.id}`}
						hidden={active !== tab.id}
						role="tabpanel"
						aria-labelledby={`${id}-${tab.id}`}
					>
						{visited.has(tab.id) ? (
							tab.id === "configuration" ? (
								<>
									<section className="session-panel-project">
										<p className="eyebrow">Project folder</p>
										<code title={workspaceRoot}>{workspaceRoot ?? "Reading project…"}</code>
										<Link
											to={`/settings?workspace=${session.workspaceId}`}
											onClick={(event) => {
												if (chrome && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
													event.preventDefault();
													chrome.openArea("settings");
												}
											}}
										>
											Project settings <span aria-hidden="true">→</span>
										</Link>
									</section>
									{(sessions.data?.filter((row) => row.state === "open").length ?? 0) > 1 ? (
										<nav aria-label="Open conversations" className="session-panel-sessions">
											<p className="eyebrow">Open conversations</p>
											{sessions.data
												?.filter((row) => row.state === "open")
												.map((row) => (
													<Link key={row.id} to={`/sessions/${row.id}`} aria-current={row.id === session.id ? "page" : undefined}>
														{row.label ?? row.turns[0]?.prompt.slice(0, 80) ?? "New conversation"}
													</Link>
												))}
										</nav>
									) : null}
									{capabilities.data || session.state !== "open" ? (
										<SessionControls client={client} session={session} capabilities={capabilities.data ?? EMPTY_CAPABILITIES} />
									) : (
										<p role={capabilities.error ? "alert" : "status"}>
											{capabilities.error?.message ?? "Checking session controls…"}
										</p>
									)}
									<div className="conversation__close">
										<p>Closing ends this session. Its conversation stays in project history.</p>
										<button type="button" onClick={onCloseSession} disabled={closing || session.state !== "open"}>
											{closing ? "Closing…" : "Close session"}
										</button>
									</div>
								</>
							) : tab.id === "tasks" ? (
								<SessionBoardPanel {...facts} settledTurns={settledTurns} running={running} />
							) : tab.id === "context" ? (
								<ContextPanel {...facts} settledTurns={settledTurns} />
							) : tab.id === "usage" ? (
								<UsagePanel {...facts} settledTurns={settledTurns} />
							) : tab.id === "commands" ? (
								<CommandPanel {...facts} />
							) : tab.id === "branches" ? (
								<BranchPanel {...facts} settledTurns={settledTurns} running={running} />
							) : tab.id === "handoff" ? (
								<HandoffPanel {...facts} running={running} />
							) : tab.id === "aside" ? (
								<AsidePanel {...facts} running={running} />
							) : (
								<ExtensionsPanel {...facts} running={running} />
							)
						) : null}
					</div>
				))}
			</div>
		</div>
	);
});
