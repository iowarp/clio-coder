import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Agent,
	agentCard,
	budgetRange,
	matchesQuery,
	type Resource,
	reachSentence,
	skillCard,
	tabAfterKey,
} from "../client/pages/library-model.js";

const agent = (configuration: Record<string, unknown>): Agent => ({
	id: "architect",
	name: "Architect",
	description: "Designs a change.",
	source: "builtin",
	audience: "base",
	category: "plan",
	skills: ["cut-it"],
	tools: ["read", "grep"],
	configuration,
});
const skill = (over: Partial<Resource>): Resource => ({
	key: "skill:fixture@config#fixture/SKILL.md",
	kind: "skill",
	name: "fixture",
	description: "A fixture.",
	path: "/home/x/skills/fixture/SKILL.md",
	source: { class: "user", id: "config", scope: "user" },
	origin: { kind: "local", path: "/home/x/skills" },
	availability: "available",
	trusted: true,
	modelInvocable: true,
	diagnostics: [],
	...over,
});

test("an agent card leads with capability, context tier, tool-call budget and read reserve, in that order", () => {
	const card = agentCard(
		agent({
			capabilityClass: "artifact-write",
			projectContextTier: "bounded",
			resultContract: { kind: "architect-plan", path: ".clio-coder/artifacts/PLAN.md" },
			budget: { toolCalls: 32, readReserve: 5, synthesis: true, maximum: { toolCalls: 150, readReserve: 16 } },
		}),
	);
	assert.deepEqual(
		card.facts.map((fact) => [fact.label, fact.value]),
		[
			["Capability", "Artifact write"],
			["Project context", "Bounded"],
			["Tool-call budget", "32–150"],
			["Read reserve", "5–16"],
		],
	);
	assert.deepEqual(card.skills, ["cut-it"]);
	assert.deepEqual(card.tools, ["read", "grep"]);
	assert.deepEqual(card.footer, ["Architect plan result contract", "Text synthesis at boundary"]);
});

test("a budget with no higher ceiling is a bare number, and an undeclared one is not zero", () => {
	assert.equal(budgetRange(1, null), "1");
	assert.equal(budgetRange(8, 8), "8");
	assert.equal(budgetRange(1200, 15000), "1,200–15,000");
	assert.equal(budgetRange(null, 9), null);
	const bare = agentCard(agent({ budget: { toolCalls: 1, readReserve: 0, synthesis: false } }));
	assert.deepEqual(
		bare.facts.map((fact) => [fact.value, fact.absent ?? false]),
		[
			["Not declared", true],
			["Not declared", true],
			["1", false],
			["0", false],
		],
	);
	assert.deepEqual(bare.footer, ["No result contract declared", "Stops at boundary"]);
	assert.deepEqual(agentCard(agent({})).footer, ["No result contract declared"]);
});

test("a skill card leads with whether the model can reach it", () => {
	assert.equal(reachSentence(skill({})), "The model can load this by name");
	assert.equal(
		reachSentence(skill({ availability: "untrusted", trusted: false, modelInvocable: false })),
		"Its root is not trusted, so the model never sees it",
	);
	assert.equal(reachSentence(skill({ modelInvocable: false })), "Its frontmatter reserves it for you");
	assert.match(reachSentence(skill({ availability: "shadowed", trusted: false })), /outranks it/u);
	assert.match(reachSentence(skill({ availability: "invalid" })), /did not load/u);
	const reserved = skillCard(
		skill({ modelInvocable: false, diagnostics: ["a", "b"], origin: { kind: "remote", url: "x" } }),
	);
	assert.equal(reserved.reachable, false);
	assert.deepEqual([reserved.mark, reserved.reach], ["Operator only", "Its frontmatter reserves it for you."]);
	assert.equal(skillCard(skill({ availability: "untrusted", trusted: false })).mark, "Out of reach");
	assert.equal(skillCard(skill({})).mark, "Model reachable");
	assert.deepEqual(
		reserved.facts.map((fact) => [fact.label, fact.value]),
		[
			["Precedence", "Your user root"],
			["Root trust", "Trusted"],
			["Model invocation", "Reserved for you"],
		],
	);
	assert.deepEqual(reserved.footer, ["2 issues", "Has an upstream"]);
	const open = skillCard(skill({}));
	assert.equal(open.reachable, true);
	assert.equal(open.facts[2]?.value, "By name");
	assert.deepEqual(open.footer, ["No issues"]);
	assert.equal(skillCard(skill({ availability: "untrusted", trusted: false })).facts[2]?.value, "Never");
});

test("the free-text filter folds case and reaches every string field at any depth", () => {
	const row = skill({ origin: { kind: "imported", agent: "Claude-Code", path: "/p" } });
	assert.equal(matchesQuery(row, "  claude-code "), true);
	assert.equal(matchesQuery(row, "SKILL.MD"), true);
	assert.equal(matchesQuery(row, ""), true);
	assert.equal(matchesQuery(row, "absent-word"), false);
});

test("arrow keys wrap across tabs, Home and End jump, and every other key is left alone", () => {
	const tabs = ["Catalog", "Agents", "Skills"] as const;
	assert.equal(tabAfterKey(tabs, "Catalog", "ArrowRight"), "Agents");
	assert.equal(tabAfterKey(tabs, "Skills", "ArrowRight"), "Catalog");
	assert.equal(tabAfterKey(tabs, "Catalog", "ArrowLeft"), "Skills");
	assert.equal(tabAfterKey(tabs, "Agents", "Home"), "Catalog");
	assert.equal(tabAfterKey(tabs, "Agents", "End"), "Skills");
	assert.equal(tabAfterKey(tabs, "Agents", "Enter"), null);
	assert.equal(tabAfterKey(tabs, "Agents", "ArrowDown"), null);
});
