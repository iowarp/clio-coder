import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

const collections = ["Agents", "Skills", "Prompts", "Fleets", "Plugins", "Extensions", "Verifiers"] as const;
type Collection = (typeof collections)[number];
type Entry = { id: string; name: string; description: string; state: string; detail: unknown };
const purpose: Record<Collection, string> = {
	Agents: "Specialists Clio can assign work to. Their specifications describe the tools, skills and limits they use.",
	Skills: "Reusable instructions that guide Clio through a task.",
	Prompts: "Saved starting points for conversations and common tasks.",
	Fleets: "Saved workflows that coordinate several steps or specialists.",
	Plugins: "Packages that provide recipes. Being listed in the catalog does not mean a package is installed.",
	Extensions: "Installed packages that add executable capabilities. Admission state shows whether Clio can load them.",
	Verifiers: "Checks Clio discovered for this workspace. Viewing this list does not run them.",
};
export function LibraryPage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client),
		{ id } = selection;
	const [active, setActive] = useState<Collection>("Skills"),
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
			}));
	const entries: Record<Collection, Entry[]> = {
		Agents: (agents.data?.agents ?? []).map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			state: `${row.category} · ${row.source}`,
			detail: row,
		})),
		Skills: resourceEntries("skill"),
		Prompts: resourceEntries("prompt"),
		Fleets: resourceEntries("fleet"),
		Plugins: (inventory.data?.packages ?? [])
			.filter((row) => row.kind === "plugin")
			.map((row) => ({
				id: row.ref,
				name: row.name,
				description: row.description,
				state: row.copies.length ? `${row.copies.length} installed copies` : "Available in catalog",
				detail: { ...row, installedCopies: inventory.data?.copies.filter((copy) => copy.ref === row.ref) },
			})),
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
	const visible = entries[active].filter((row) =>
		`${row.name} ${row.description}`.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	return (
		<section>
			<p className="eyebrow">Capabilities / Your library</p>
			<h1>Library</h1>
			<WorkspacePicker selection={selection} />
			<p>Explore the capabilities available to Clio in this workspace, and see where they come from.</p>
			<nav className="settings-tabs" aria-label="Library collections">
				{collections.map((name) => (
					<button
						type="button"
						key={name}
						aria-pressed={active === name}
						onClick={() => {
							setActive(name);
							setFilter("");
							setLimit(40);
						}}
					>
						{name} · {entries[name].length}
					</button>
				))}
			</nav>
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
				<p>The runtime reached an inventory limit. The available records are shown; further entries may exist.</p>
			)}
			{active === "Verifiers" && verifiers.data && (
				<>
					{verifiers.data.discovery === "blocked" && (
						<p role="status">
							Check discovery is blocked: {verifiers.data.blockedBy}. {verifiers.data.rejection} {verifiers.data.rejectedAt}
						</p>
					)}
					{verifiers.data.checksTruncated && <p>Only the runtime’s first 64 checks are shown.</p>}
					{!!verifiers.data.diagnosticCount && <p>{verifiers.data.diagnosticCount} discovery diagnostics were reported.</p>}
				</>
			)}
			{source.data && !visible.length && (
				<p>{filter ? "No matches. Try a different search." : `No ${active.toLowerCase()} reported for this workspace.`}</p>
			)}
			<div className="config-entries">
				{visible.slice(0, limit).map((row) => (
					<article className="trace-panel" key={row.id}>
						<h3>{row.name}</h3>
						<p>{row.description}</p>
						<p>{row.state}</p>
						<details>
							<summary>Source and configuration</summary>
							<pre className="fleet-receipt">{JSON.stringify(row.detail, null, 2)}</pre>
						</details>
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
		</section>
	);
}
