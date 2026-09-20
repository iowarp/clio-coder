import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Facts } from "../design/facts.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { LibraryCatalog } from "./library-catalog.js";
import { type Agent, agentCard, matchesQuery, type Resource, skillCard, tabAfterKey } from "./library-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

const collections = ["Catalog", "Agents", "Skills", "Prompts", "Fleets", "Extensions", "Verifiers"] as const;
type Collection = (typeof collections)[number];
type Entry = {
	id: string;
	name: string;
	description: string;
	state: string;
	detail: unknown;
	agent?: Agent;
	skill?: Resource;
};

function CardFacts({ facts }: { facts: { label: string; value: string; absent?: true }[] }) {
	return (
		<dl className="facts">
			{facts.map((fact) => (
				<div className="fact" key={fact.label}>
					<dt>{fact.label}</dt>
					<dd data-tone={fact.absent ? "absent" : undefined}>{fact.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Capability, context tier, budget and reserve first; skills as chips; tool surfaces behind their count. */
function AgentBody({ agent }: { agent: Agent }) {
	const card = agentCard(agent);
	return (
		<>
			<CardFacts facts={card.facts} />
			{!!card.skills.length && (
				<div className="library-bound">
					<span>Bound skills</span>
					<ul className="fact__chips">
						{card.skills.map((skill) => (
							<li key={skill}>{skill}</li>
						))}
					</ul>
				</div>
			)}
			<details>
				<summary>Declared tool surfaces · {card.tools.length}</summary>
				{card.tools.length ? (
					<ul className="fact__chips">
						{card.tools.map((tool) => (
							<li key={tool}>{tool}</li>
						))}
					</ul>
				) : (
					<PanelEmpty>This agent declares no tool surface.</PanelEmpty>
				)}
			</details>
			<p className="panel-note">{card.footer.join(" · ")}</p>
			<details>
				<summary>Source and configuration</summary>
				<Facts value={agent} hide={["id", "name", "description", "skills", "tools"]} />
			</details>
		</>
	);
}

/** The reach sentence leads, because whether the model can ever see a skill outranks every other fact. */
function SkillBody({ skill }: { skill: Resource }) {
	const card = skillCard(skill);
	return (
		<>
			<StatusMark tone={card.reachable ? "success" : "neutral"} label={card.mark} />
			<p>{card.reach}</p>
			{skill.reason && <p className="panel-note">{skill.reason}</p>}
			<CardFacts facts={card.facts} />
			<p className="panel-note">{card.footer.join(" · ")}</p>
			<details>
				<summary>Source and configuration</summary>
				<Facts
					value={skill}
					order={["availability", "reason", "source", "owner", "origin", "path"]}
					hide={["key", "name", "description"]}
				/>
			</details>
		</>
	);
}
const purpose: Record<Collection, string> = {
	Catalog:
		"Every package Clio can install, and every copy already installed, for you or for this project. Each change is planned first, shown to you, and only then applied.",
	Agents: "Specialists Clio can assign work to. Their specifications describe the tools, skills and limits they use.",
	Skills: "Reusable instructions that guide Clio through a task.",
	Prompts: "Saved starting points for conversations and common tasks.",
	Fleets: "Saved workflows that coordinate several steps or specialists.",
	Extensions: "Installed packages that add executable capabilities. Admission state shows whether Clio can load them.",
	Verifiers: "Checks Clio discovered for this workspace. Viewing this list does not run them.",
};
export function LibraryPage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client),
		{ id } = selection;
	const [active, setActive] = useState<Collection>("Catalog"),
		[filter, setFilter] = useState(""),
		[limit, setLimit] = useState(40);
	const inventory = useQuery({
		queryKey: ["library", id],
		enabled: !!id,
		queryFn: () => client.call(routes.library, { ...emptyInput, params: { id } }),
	});
	const agents = useQuery({
		queryKey: ["library-agents", id],
		enabled: !!id,
		queryFn: () => client.call(routes.libraryAgents, { ...emptyInput, params: { id } }),
	});
	const extensions = useQuery({
		queryKey: ["library-extensions", id],
		enabled: !!id,
		queryFn: () => client.call(routes.libraryExtensions, { ...emptyInput, params: { id } }),
	});
	const verifiers = useQuery({
		queryKey: ["library-verifiers", id],
		enabled: !!id,
		queryFn: () => client.call(routes.libraryVerifiers, { ...emptyInput, params: { id } }),
	});
	const resourceEntries = (kind: "skill" | "prompt" | "fleet"): Entry[] =>
		(inventory.data?.resources ?? [])
			.filter((row) => row.kind === kind)
			.map((row) => ({
				id: row.key,
				name: row.name,
				description: row.description,
				state: `${row.availability} · ${row.source.class}`,
				detail: row,
				...(kind === "skill" ? { skill: row } : {}),
			}));
	const entries: Record<Exclude<Collection, "Catalog">, Entry[]> = {
		Agents: (agents.data?.agents ?? []).map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			state: `${row.category} · ${row.source}`,
			detail: row,
			agent: row,
		})),
		Skills: resourceEntries("skill"),
		Prompts: resourceEntries("prompt"),
		Fleets: resourceEntries("fleet"),
		Extensions: (extensions.data?.extensions ?? []).map((row) => ({
			id: `${row.id}:${row.scope}`,
			name: row.name,
			description: row.description,
			state: row.loadable
				? "Ready to load"
				: !row.enabled
					? "Disabled"
					: !row.valid
						? "Invalid"
						: !row.compatible
							? "Incompatible"
							: !row.effective
								? "Overridden"
								: "Unavailable",
			detail: row,
		})),
		Verifiers: (verifiers.data?.checks ?? []).map((row) => ({
			id: row.id,
			name: row.id,
			description: row.description,
			state: `${row.origin} · ${row.runner}`,
			detail: row,
		})),
	};
	const source =
		active === "Agents" ? agents : active === "Extensions" ? extensions : active === "Verifiers" ? verifiers : inventory;
	// Free text runs across every string field a row carries, not only its name.
	const visible = (active === "Catalog" ? [] : entries[active]).filter((row) => matchesQuery(row.detail, filter));
	const tabs = useRef(new Map<Collection, HTMLButtonElement>());
	const activate = (name: Collection) => {
		setActive(name);
		setFilter("");
		setLimit(40);
	};
	const onTabKey = (event: KeyboardEvent) => {
		const next = tabAfterKey(collections, active, event.key);
		if (!next) return;
		event.preventDefault();
		activate(next);
		tabs.current.get(next)?.focus();
	};
	const count = (name: Collection) =>
		name === "Catalog" ? (inventory.data?.packages.length ?? 0) : entries[name].length;
	return (
		<section>
			<PanelHeading panel={PANELS.library} level={1} />
			<WorkspacePicker selection={selection} />
			<p>Explore the capabilities available to Clio in this workspace, and see where they come from.</p>
			{!id && !selection.workspaces.isPending && <PanelEmpty>{emptyState.unread("library of a workspace")}</PanelEmpty>}
			<div className="settings-tabs" role="tablist" aria-label="Library collections" onKeyDown={onTabKey}>
				{collections.map((name) => (
					<button
						type="button"
						role="tab"
						key={name}
						id={`library-tab-${name}`}
						aria-selected={active === name}
						aria-controls="library-panel"
						// One tab stop for the whole list; the arrow keys move inside it.
						tabIndex={active === name ? 0 : -1}
						ref={(node) => {
							if (node) tabs.current.set(name, node);
							else tabs.current.delete(name);
						}}
						onClick={() => activate(name)}
					>
						{name} · {count(name)}
					</button>
				))}
			</div>
			<div role="tabpanel" id="library-panel" aria-labelledby={`library-tab-${active}`}>
				<h2>{active}</h2>
				<p>{purpose[active]}</p>
				<label className="settings-filter">
					Search {active.toLowerCase()}
					<input
						value={filter}
						onChange={(event) => {
							setFilter(event.target.value);
							setLimit(40);
						}}
					/>
				</label>
				{source.isPending && id && <p>Reading {active.toLowerCase()}…</p>}
				{source.error && (
					<p role="alert">
						{source.error.message}{" "}
						<button type="button" onClick={() => void source.refetch()}>
							Try again
						</button>
					</p>
				)}
				{inventory.data && Object.values(inventory.data.truncated).some(Boolean) && (
					<PanelEmpty>{emptyState.bounded("library records", "Later")}</PanelEmpty>
				)}
				{active === "Verifiers" && verifiers.data && (
					<>
						{verifiers.data.discovery === "blocked" && (
							<p role="status">
								Check discovery is blocked: {verifiers.data.blockedBy}. {verifiers.data.rejection} {verifiers.data.rejectedAt}
							</p>
						)}
						{verifiers.data.checksTruncated && <PanelEmpty>{emptyState.bounded("checks", "Later")}</PanelEmpty>}
						{!!verifiers.data.diagnosticCount && <p>{verifiers.data.diagnosticCount} discovery diagnostics were reported.</p>}
					</>
				)}
				{active === "Catalog" && inventory.data && (
					<LibraryCatalog client={client} workspaceId={id} packages={inventory.data.packages} filter={filter} />
				)}
				{active !== "Catalog" && source.data && !visible.length && (
					<PanelEmpty>
						{filter
							? "No matches. Try a different search."
							: emptyState.emptyStore(active.toLowerCase().replace(/s$/u, ""), "for this workspace")}
					</PanelEmpty>
				)}
				<div className="config-entries">
					{visible.slice(0, limit).map((row) => (
						<article className="trace-panel" key={row.id}>
							<h3>{row.name}</h3>
							<p>{row.description}</p>
							{row.agent ? (
								<AgentBody agent={row.agent} />
							) : row.skill ? (
								<SkillBody skill={row.skill} />
							) : (
								<>
									<p>{row.state}</p>
									<details>
										<summary>Source and configuration</summary>
										<Facts
											value={row.detail}
											order={["availability", "reason", "source", "owner", "origin", "path"]}
											hide={["key", "name", "description"]}
										/>
									</details>
								</>
							)}
						</article>
					))}
				</div>
				{visible.length > limit && (
					<button type="button" onClick={() => setLimit(limit + 40)}>
						Show more {active.toLowerCase()}
					</button>
				)}
				{!!inventory.data?.diagnostics.length && (
					<details className="trace-panel">
						<summary>Library discovery notes</summary>
						<ul>
							{inventory.data.diagnostics.map((message) => (
								<li key={message}>{message}</li>
							))}
						</ul>
					</details>
				)}
			</div>
			<Boundary panel={PANELS.library} />
		</section>
	);
}
