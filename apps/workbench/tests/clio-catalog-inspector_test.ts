import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	ClioCliCatalogInspector,
	projectAgentCatalog,
	projectExtensionCatalog,
	projectLibraryCatalog,
	projectSkillCatalog,
} from "../clio-catalog-inspector.ts";

const FIXTURE = new URL("./catalog-inspect-child-fixture.ts", import.meta.url).pathname;

function fixtureInspector(scenario: "valid" | "partial" = "valid"): ClioCliCatalogInspector {
	return new ClioCliCatalogInspector({
		executable: Deno.execPath(),
		prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, `--scenario=${scenario}`, "--"],
		now: () => Date.parse("2026-08-29T13:00:00.000Z"),
	});
}

function agentFixture(): Record<string, unknown> {
	return {
		id: "researcher",
		name: "Researcher",
		description: "Finds and synthesizes evidence.",
		version: 1,
		source: "builtin",
		audience: "base",
		category: "research",
		capabilityClass: "read-only",
		latencyClass: "deep",
		projectContextTier: "none",
		tags: ["evidence"],
		skills: ["literature"],
		tools: ["read", "web_fetch"],
		budget: { toolCalls: 24, readReserve: 4, synthesis: true },
		resultContract: { kind: "research-report", path: "/home/operator/private.md" },
		filepath: "/home/operator/agents/researcher.md",
		body: "private agent body sk-agent-secret",
	};
}

Deno.test("catalog projections retain useful inventory while dropping bodies, paths, URLs, hashes, and diagnostics", () => {
	const agents = projectAgentCatalog([agentFixture()]);
	const skills = projectSkillCatalog({
		skills: [{
			name: "literature",
			description: "Find papers.",
			scope: "user",
			source: "claude",
			trusted: true,
			precedence: 20,
			disableModelInvocation: false,
			diagnostics: [{ type: "warning", message: "private /home/operator/SKILL.md" }],
			content: "private skill body sk-skill-secret",
			filePath: "/home/operator/SKILL.md",
			hash: "private-hash",
		}],
		diagnostics: [{ type: "warning", message: "private global diagnostic" }],
	});
	const library = projectLibraryCatalog({
		entries: [{
			kind: "skill",
			name: "installable",
			description: "Available from the catalog.",
			version: "1.0.0",
			category: "research",
			origin: "index",
			audit: "warn",
			sourceUrl: "https://token@example.invalid/private.git",
			requires: ["skill:secret"],
		}],
		diagnostics: ["private /home/operator/library.yaml"],
	});
	const extensions = projectExtensionCatalog({
		extensions: [{
			id: "lab-pack",
			name: "Lab Pack",
			version: "2.1.0",
			description: "Adds research workflows.",
			scope: "user",
			enabled: true,
			effective: false,
			overriddenBy: "project",
			resources: { skills: "/home/operator/extensions/lab/skills", agents: "agents" },
			diagnostics: [{ type: "warning", message: "private extension diagnostic sk-extension-secret" }],
			rootPath: "/home/operator/extensions/lab",
			manifestPath: "/home/operator/extensions/lab/clio-coder-extension.yaml",
		}],
	});

	equal(agents.items[0]?.budget.toolCalls, 24);
	equal(agents.items[0]?.resultKind, "research-report");
	equal(skills.items[0]?.issueCount, 1);
	equal(skills.issueCount, 1);
	equal(library.items[0]?.audit, "warn");
	equal(extensions.items[0]?.effective, false);
	deepStrictEqual(extensions.items[0]?.resources, ["skills", "agents"]);
	equal(extensions.items[0]?.issueCount, 1);
	const frame = JSON.stringify({ agents, skills, library, extensions });
	for (
		const forbidden of [
			"/home/operator",
			"sk-agent-secret",
			"sk-skill-secret",
			"private-hash",
			"token@example",
			"skill:secret",
			"sk-extension-secret",
		]
	) ok(!frame.includes(forbidden), `catalog projection leaked ${forbidden}`);
});

Deno.test("an agent with more labels than the wire can name is omitted instead of silently shortened", () => {
	const agent = agentFixture();
	agent.tools = Array.from({ length: 33 }, (_, index) => `tool-${index}`);
	const collection = projectAgentCatalog([agent]);
	deepStrictEqual(collection.items, []);
	equal(collection.truncated, true);
});

Deno.test("the catalog adapter invokes only the four fixed JSON listings", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-catalog-inspect-" });
	try {
		const inspection = await fixtureInspector().inspect(root);
		equal(inspection.inspectedAt, "2026-08-29T13:00:00.000Z");
		equal(inspection.agents.availability, "available");
		equal(inspection.agents.items[0]?.id, "fixture-agent");
		equal(inspection.skills.availability, "available");
		equal(inspection.skills.items[0]?.name, "fixture-skill");
		equal(inspection.skills.truncated, true);
		equal(inspection.library.items[0]?.name, "fixture-market-skill");
		equal(inspection.extensions.availability, "available");
		equal(inspection.extensions.items[0]?.id, "fixture-lab-pack");
		deepStrictEqual(inspection.extensions.items[0]?.resources, ["skills", "prompts", "agents"]);
		deepStrictEqual(inspection.verifiers, { availability: "typed-interface-required" });
		const frame = JSON.stringify(inspection);
		for (const forbidden of ["/home/operator", "sk-secret", "raw private", "sourceUrl", "private-hash"]) {
			ok(!frame.includes(forbidden), `adapter leaked ${forbidden}`);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("one catalog command can fail without hiding the other typed collections", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-catalog-partial-" });
	try {
		const inspection = await fixtureInspector("partial").inspect(root);
		equal(inspection.agents.availability, "available");
		equal(inspection.skills.availability, "failed");
		deepStrictEqual(inspection.skills.items, []);
		equal(inspection.library.availability, "available");
		equal(inspection.extensions.availability, "available");
		ok(!JSON.stringify(inspection).includes("private diagnostic"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
