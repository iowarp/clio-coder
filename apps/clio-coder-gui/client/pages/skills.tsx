import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Link, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { useShell } from "../shell/shell-context.js";
import { TopBar } from "../shell/TopBar.js";
import {
	discoverSkills,
	type Resource,
	SKILL_ACCESS,
	SKILL_ACCESS_LABELS,
	SKILL_ORIGINS,
	skillCard,
} from "./library-model.js";
import "./skills.css";

function SkillRow({ skill }: { skill: Resource }) {
	const card = skillCard(skill);
	return (
		<li className="skill" data-reachable={card.reachable}>
			<div className="skill__head">
				<strong className="skill__name">{skill.name}</strong>
				<StatusMark tone={card.reachable ? "success" : "neutral"} label={card.reachable ? "Available" : card.mark} />
			</div>
			{skill.description ? <p className="skill__text">{skill.description}</p> : null}
			<p className="skill__meta">
				<span>{SKILL_ORIGINS[skill.source.class] ?? skill.source.class}</span>
				{skill.invocation ? <code>{skill.invocation}</code> : null}
				{card.reachable ? null : <span>{card.reach}</span>}
			</p>
			<details className="skill__details">
				<summary>How to use {skill.name}</summary>
				<p>{card.reach}</p>
				{skill.reason && <p className="skills__note">{skill.reason}</p>}
				{card.reachable && (
					<p>
						Ask Clio to use <strong>{skill.name}</strong> in your task. It can also choose this skill when the task fits.
					</p>
				)}
				<dl className="skill__facts">
					{card.facts.map((fact) => (
						<div key={fact.label}>
							<dt>{fact.label}</dt>
							<dd>{fact.value}</dd>
						</div>
					))}
					<div>
						<dt>Invocation</dt>
						<dd>{skill.invocation || "No explicit invocation reported"}</dd>
					</div>
					<div>
						<dt>Source file</dt>
						<dd>
							<code>{skill.path}</code>
						</dd>
					</div>
				</dl>
				{!!skill.diagnostics.length && (
					<ul>
						{skill.diagnostics.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
				)}
				<Link to={`/library?collection=skills&q=${encodeURIComponent(skill.name)}`}>Inspect in Library</Link>
			</details>
		</li>
	);
}

/**
 * The skills Clio can use in the current workspace, and nothing else. Installing packages, agents,
 * extensions and verifiers is Settings > Advanced > Library, which this page links to.
 */
export function SkillsPage({ client }: { client: Client }) {
	const shell = useShell();
	const id = shell?.activeWorkspaceId ?? "";
	const searchId = useId();
	const [search, setSearch] = useSearchParams();
	const filter = search.get("q") ?? "";
	const access = SKILL_ACCESS.find((value) => value === search.get("access")) ?? "all";
	const origin = search.get("origin") ?? "";
	const discover = (key: string, value: string) =>
		setSearch(
			(current) => {
				const next = new URLSearchParams(current);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true },
		);
	const clear = () =>
		setSearch((current) => {
			const next = new URLSearchParams(current);
			for (const key of ["q", "access", "origin"]) next.delete(key);
			return next;
		});
	const inventory = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["library", id],
		enabled: id !== "",
		queryFn: () => client.call(routes.library, { ...emptyInput, params: { id } }),
	});
	const { skills, shown, origins, counts } = discoverSkills(inventory.data?.resources ?? [], filter, access, origin);

	return (
		<>
			<TopBar title="Skills" />
			<div className="skills">
				<div className="skills__inner">
					<p className="skills__lede">
						A skill is a set of instructions Clio follows when a task fits it. Clio picks one by name on its own, and you can
						ask for one in a message.
					</p>
					{id === "" ? <p className="skills__note">Open a workspace to see the skills available in it.</p> : null}
					{inventory.error ? (
						<p role="alert">
							{inventory.error.message}{" "}
							<button type="button" className="wb-link" onClick={() => void inventory.refetch()}>
								Try again
							</button>
						</p>
					) : null}
					{inventory.isPending && id !== "" ? (
						<p className="skills__note" role="status">
							Reading skills…
						</p>
					) : null}
					{skills.length > 0 ? (
						<div className="skills__discovery">
							<label className="sr-only" htmlFor={searchId}>
								Find a skill
							</label>
							<input
								id={searchId}
								type="search"
								value={filter}
								onChange={(event) => discover("q", event.target.value)}
								placeholder="Search names, capabilities or source files"
							/>
							<div className="skills__source">
								<label htmlFor={`${searchId}-source`}>Source</label>
								<select id={`${searchId}-source`} value={origin} onChange={(event) => discover("origin", event.target.value)}>
									<option value="">Every source</option>
									{origins.map((value) => (
										<option value={value} key={value}>
											{SKILL_ORIGINS[value] ?? value}
										</option>
									))}
								</select>
							</div>
							<fieldset className="skills__facets">
								<legend>Availability</legend>
								{SKILL_ACCESS.map((value) => (
									<button
										key={value}
										type="button"
										aria-pressed={access === value}
										onClick={() => discover("access", value === "all" ? "" : value)}
									>
										{SKILL_ACCESS_LABELS[value]} · {counts[value]}
									</button>
								))}
							</fieldset>
							<div className="skills__results">
								<span role="status">
									{shown.length} of {skills.length} skills
								</span>
								{(filter || origin || access !== "all") && (
									<button type="button" onClick={clear}>
										Clear filters
									</button>
								)}
							</div>
						</div>
					) : null}
					{shown.length > 0 ? (
						<ul className="skills__list">
							{shown.map((skill) => (
								<SkillRow key={skill.key} skill={skill} />
							))}
						</ul>
					) : null}
					{inventory.data && skills.length === 0 ? (
						<p className="skills__note">
							No skills were discovered in this workspace. Inspect package sources in the Library.
						</p>
					) : null}
					{skills.length > 0 && shown.length === 0 ? (
						<p className="skills__note">
							No skills match these filters. Clear filters to explore all sources and availability states.
						</p>
					) : null}
					{inventory.data?.truncated.resources ? (
						<p className="skills__note">
							This inventory is incomplete. Search and filters cover only the skills returned by the server.
						</p>
					) : null}
					<p className="skills__foot">
						Install or remove packages, agents, extensions and verifiers in the <Link to="/library">Library</Link>.
					</p>
				</div>
			</div>
		</>
	);
}
