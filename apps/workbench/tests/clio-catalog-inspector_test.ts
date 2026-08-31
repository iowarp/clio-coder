import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	ClioCliCatalogInspector,
	projectAgentCatalog,
	projectExtensionCatalog,
	projectLibraryCatalog,
	projectSkillCatalog,
	projectVerifierCatalog,
} from "../clio-catalog-inspector.ts";

const FIXTURE = new URL("./catalog-inspect-child-fixture.ts", import.meta.url).pathname;

function fixtureInspector(
	scenario: "valid" | "partial" | "verifiers-blocked" = "valid",
): ClioCliCatalogInspector {
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

Deno.test("the catalog adapter invokes only the five fixed JSON listings", async () => {
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
		equal(inspection.verifiers.availability, "available");
		equal(inspection.verifiers.items.length, 2);
		equal(inspection.verifiers.items[1]?.runner, "cargo");
		equal(inspection.verifiers.catalogValid, true);
		equal(inspection.verifiers.issueCount, 1);
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

/**
 * The check plane's shape crosses; the vector that would run it does not.
 *
 * A catalog check's `command` entries may be absolute paths by schema, so the
 * projection classifies the executable and counts the rest. This is the same
 * call trace payloads and process command lines got: count instead of narrow.
 */
Deno.test("the verifier projection carries the check plane's shape and never its argv", () => {
	const collection = projectVerifierCatalog({
		version: 1,
		generatedAt: "2026-08-31T12:00:00.000Z",
		catalogPresent: true,
		catalogValid: true,
		rejection: null,
		rejectedAt: null,
		discovery: "complete",
		blockedBy: null,
		checks: [{
			id: "contract",
			description: "Run the declared contract suite.",
			origin: "catalog",
			signal: "project-catalog",
			authority: "project-declared",
			runner: "python",
			argumentCount: 3,
			runsAtRepositoryRoot: false,
			argvFixed: true,
			timeoutMs: 300000,
			tags: ["contract"],
		}],
		checksTruncated: false,
		diagnosticCount: 2,
	});
	equal(collection.availability, "available");
	equal(collection.items[0]?.runner, "python");
	equal(collection.items[0]?.argumentCount, 3);
	equal(collection.issueCount, 2);
	ok(!JSON.stringify(collection).includes("command"));
});

Deno.test("a verifier check whose origin and argv binding disagree fails the whole snapshot", () => {
	// The alternative is dropping the row, which would leave a check plane that
	// looks complete while a check it names was refused.
	const snapshot = (check: Record<string, unknown>): unknown => ({
		version: 1,
		generatedAt: "2026-08-31T12:00:00.000Z",
		catalogPresent: false,
		catalogValid: null,
		rejection: null,
		rejectedAt: null,
		discovery: "complete",
		blockedBy: null,
		checks: [check],
		checksTruncated: false,
		diagnosticCount: 0,
	});
	const base = {
		id: "test",
		description: "Run package.json script 'test'.",
		origin: "package-script",
		signal: "package-script",
		authority: "project-declared",
		runner: "npm",
		argumentCount: 2,
		runsAtRepositoryRoot: true,
		argvFixed: false,
		timeoutMs: 120000,
		tags: ["test"],
	};
	for (
		const broken of [
			{ ...base, argvFixed: true },
			{ ...base, signal: "project-catalog" },
			{ ...base, signal: "manual-entry", origin: "proposed", authority: "toolchain-defined" },
			{ ...base, id: "Has Spaces" },
			{ ...base, tags: ["Not A Tag"] },
			{ ...base, timeoutMs: 900001 },
		]
	) {
		let threw = false;
		try {
			projectVerifierCatalog(snapshot(broken));
		} catch {
			threw = true;
		}
		ok(threw, `the projection admitted ${JSON.stringify(broken)}`);
	}
});

Deno.test("a refused catalog blocks the check plane and names its schema location, not its text", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-catalog-verifiers-" });
	try {
		const inspection = await fixtureInspector("verifiers-blocked").inspect(root);
		equal(inspection.verifiers.availability, "available");
		equal(inspection.verifiers.discovery, "blocked");
		equal(inspection.verifiers.blockedBy, "catalog-rejected");
		equal(inspection.verifiers.catalogValid, false);
		equal(inspection.verifiers.rejection, "shell-command");
		equal(inspection.verifiers.rejectedAt, "checks[1].command[0]");
		deepStrictEqual(inspection.verifiers.items, []);
		// The other four collections read independently and are unaffected.
		equal(inspection.agents.availability, "available");
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
