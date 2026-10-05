import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { useShell } from "../shell/shell-context.js";
import { TopBar } from "../shell/TopBar.js";
import { matchesQuery, type Resource, skillCard } from "./library-model.js";
import "./skills.css";

/** The words a person uses for where a skill comes from. */
const ORIGIN_WORDS: Readonly<Record<string, string>> = {
	core: "Built in",
	package: "Installed package",
	user: "Yours",
	project: "This project",
	compat: "Another agent's folder",
};

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
				<span>{ORIGIN_WORDS[skill.source.class] ?? skill.source.class}</span>
				{skill.invocation ? <code>{skill.invocation}</code> : null}
				{card.reachable ? null : <span>{card.reach}</span>}
			</p>
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
	const [filter, setFilter] = useState("");
	const inventory = useQuery({
		queryKey: ["library", id],
		enabled: id !== "",
		queryFn: () => client.call(routes.library, { ...emptyInput, params: { id } }),
	});
	const skills = useMemo(
		() =>
			(inventory.data?.resources ?? [])
				.filter((row) => row.kind === "skill")
				.filter((row) => row.availability !== "shadowed")
				.sort((a, b) => a.name.localeCompare(b.name)),
		[inventory.data],
	);
	const shown = skills.filter((skill) => matchesQuery(skill, filter));
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
					{inventory.isPending && id !== "" ? <p className="skills__note">Reading skills…</p> : null}
					{skills.length > 0 ? (
						<>
							<label className="sr-only" htmlFor={searchId}>
								Find a skill
							</label>
							<input
								id={searchId}
								type="search"
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
								placeholder={`Find among ${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
							/>
						</>
					) : null}
					{shown.length > 0 ? (
						<ul className="skills__list">
							{shown.map((skill) => (
								<SkillRow key={skill.key} skill={skill} />
							))}
						</ul>
					) : null}
					{inventory.data && skills.length === 0 ? (
						<p className="skills__note">No skills are installed in this workspace.</p>
					) : null}
					{skills.length > 0 && shown.length === 0 ? <p className="skills__note">No skill matches that search.</p> : null}
					{inventory.data?.truncated.resources ? (
						<p className="skills__note">The list is longer than what was read. Search narrows it.</p>
					) : null}
					<p className="skills__foot">
						Install or remove packages, agents, extensions and verifiers in the <Link to="/library">Library</Link>.
					</p>
				</div>
			</div>
		</>
	);
}
