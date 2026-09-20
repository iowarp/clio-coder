// The library's recipe collections, in the operator's words: what an agent may spend and where it
// stops, and whether the model can ever reach a skill. The agent's `configuration` is an open record
// on the wire, so every key is read defensively. Pure, so the order and the sentences are testable
// without a browser.

import type { Static } from "typebox";
import type { LibraryAgents, LibraryResource } from "../../contracts/library.js";
import { humanizeKey } from "../design/facts-model.js";

export type Agent = Static<typeof LibraryAgents>["agents"][number];
export type Resource = Static<typeof LibraryResource>;

export interface CardFact {
	label: string;
	value: string;
	absent?: true;
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const word = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const fact = (label: string, value: string | null): CardFact =>
	value === null ? { label, value: "Not declared", absent: true } : { label, value };

/** `32–150` when the recipe declares a ceiling above its default, or the bare default when it does not. */
export function budgetRange(min: number | null, max: number | null): string | null {
	if (min === null) return null;
	const low = min.toLocaleString("en-US");
	return max !== null && max > min ? `${low}–${max.toLocaleString("en-US")}` : low;
}

export interface AgentCard {
	/** Capability, project context tier, tool-call budget, read reserve. Always these four, in this order. */
	facts: CardFact[];
	skills: string[];
	tools: string[];
	/** Result contract, then what happens when the budget runs out. */
	footer: string[];
}

export function agentCard(agent: Agent): AgentCard {
	const budget = record(agent.configuration.budget);
	const maximum = record(budget.maximum);
	const contract = word(record(agent.configuration.resultContract).kind);
	const capability = word(agent.configuration.capabilityClass);
	const tier = word(agent.configuration.projectContextTier);
	const footer = [contract === null ? "No result contract declared" : `${humanizeKey(contract)} result contract`];
	if (typeof budget.synthesis === "boolean")
		footer.push(budget.synthesis ? "Text synthesis at boundary" : "Stops at boundary");
	return {
		facts: [
			fact("Capability", capability === null ? null : humanizeKey(capability)),
			fact("Project context", tier === null ? null : humanizeKey(tier)),
			fact("Tool-call budget", budgetRange(number(budget.toolCalls), number(maximum.toolCalls))),
			fact("Read reserve", budgetRange(number(budget.readReserve), number(maximum.readReserve))),
		],
		skills: agent.skills,
		tools: agent.tools,
		footer,
	};
}

/**
 * Whether the model can ever reach this skill, in one sentence. It leads the card because every
 * other fact about a skill is secondary to it.
 */
export function reachSentence(skill: Pick<Resource, "availability" | "trusted" | "modelInvocable">): string {
	if (skill.availability === "invalid") return "It did not load, so nothing can use it";
	if (skill.availability === "shadowed") return "Another recipe of the same name outranks it, so this copy never loads";
	if (skill.availability === "unavailable") return "Clio Coder reports it as unavailable";
	if (!skill.trusted) return "Its root is not trusted, so the model never sees it";
	if (skill.modelInvocable === false) return "Its frontmatter reserves it for you";
	return "The model can load this by name";
}

const SOURCE_CLASS: Record<string, string> = {
	core: "Clio Coder core",
	package: "An installed package",
	user: "Your user root",
	project: "This project's root",
	compat: "Another agent's folder",
};

export interface SkillCard {
	reach: string;
	reachable: boolean;
	/** The reach in two words, for the status mark. The sentence carries the reason. */
	mark: string;
	/** Precedence, root trust, model invocation. Always these three, in this order. */
	facts: CardFact[];
	footer: string[];
}

export function skillCard(skill: Resource): SkillCard {
	const reachable = skill.availability === "available" && skill.trusted && skill.modelInvocable !== false;
	const issues = skill.diagnostics.length;
	const footer = [issues === 0 ? "No issues" : `${issues.toLocaleString("en-US")} ${issues === 1 ? "issue" : "issues"}`];
	if (record(skill.origin).kind === "remote") footer.push("Has an upstream");
	return {
		reach: `${reachSentence(skill)}.`,
		reachable,
		mark: reachable
			? "Model reachable"
			: skill.trusted && skill.availability === "available"
				? "Operator only"
				: "Out of reach",
		facts: [
			{ label: "Precedence", value: SOURCE_CLASS[skill.source.class] ?? humanizeKey(skill.source.class) },
			{ label: "Root trust", value: skill.trusted ? "Trusted" : "Not trusted" },
			{
				label: "Model invocation",
				value: reachable ? "By name" : skill.modelInvocable === false && skill.trusted ? "Reserved for you" : "Never",
			},
		],
		footer,
	};
}

/** Every string a record carries, at any depth, case-folded for the free-text filter. */
export function searchText(value: unknown, depth = 0): string {
	if (typeof value === "string") return value.toLocaleLowerCase("en-US");
	if (!value || typeof value !== "object" || depth > 4) return "";
	return Object.values(value)
		.map((item) => searchText(item, depth + 1))
		.filter(Boolean)
		.join(" ");
}
export const matchesQuery = (value: unknown, query: string): boolean => {
	const needle = query.trim().toLocaleLowerCase("en-US");
	return !needle || searchText(value).includes(needle);
};

/**
 * Where an arrow key moves a tab selection. Left and right wrap, Home and End jump, and every other
 * key returns null so the caller leaves the event alone.
 */
export function tabAfterKey<T>(tabs: readonly T[], current: T, key: string): T | null {
	const index = tabs.indexOf(current);
	if (index < 0 || !tabs.length) return null;
	const at = (position: number) => tabs[(position + tabs.length) % tabs.length] ?? null;
	if (key === "ArrowRight") return at(index + 1);
	if (key === "ArrowLeft") return at(index - 1);
	if (key === "Home") return at(0);
	if (key === "End") return at(tabs.length - 1);
	return null;
}
