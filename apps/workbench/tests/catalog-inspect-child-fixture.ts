const scenarioArgument = Deno.args.find((argument) => argument.startsWith("--scenario="));
const scenario = scenarioArgument?.slice("--scenario=".length) ?? "valid";
const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? [] : Deno.args.slice(separator + 1);
const command = commandArgs.join(" ");

if (scenario === "partial" && command === "skills list --json") {
	await Deno.stderr.write(new TextEncoder().encode("private diagnostic /home/operator/skill.md sk-secret"));
	Deno.exit(19);
}

let payload: unknown;
if (command === "agents --json") {
	payload = [{
		id: "fixture-agent",
		name: "Fixture Agent",
		description: "Examines a bounded fixture without exposing its source file.",
		version: 1,
		source: "project",
		audience: "custom",
		category: "quality",
		capabilityClass: "verification",
		latencyClass: "fast",
		projectContextTier: "bounded",
		tags: ["fixture", "verification"],
		skills: ["fixture-skill"],
		tools: ["read", "verify"],
		budget: { toolCalls: 8, readReserve: 2, synthesis: true, maximum: { toolCalls: 16, readReserve: 4 } },
		resultContract: { kind: "fixture-report", path: ".private/result.md" },
		filepath: "/home/operator/.clio-coder/agents/fixture.md",
		body: "raw private agent instructions",
	}];
} else if (command === "skills list --json") {
	payload = {
		skills: [{
			name: "fixture-skill",
			description: "A trusted project skill used only by the fixture.",
			scope: "project",
			source: "clio",
			trusted: true,
			precedence: 30,
			disableModelInvocation: false,
			diagnostics: [{ type: "warning", message: "private /home/operator/path" }],
			filePath: "/home/operator/project/.clio-coder/skills/fixture/SKILL.md",
			baseDir: "/home/operator/project/.clio-coder/skills/fixture",
			content: "raw private skill body sk-secret",
			hash: "private-hash",
			normalizedHash: "private-normalized-hash",
			sourceInfo: { path: "/home/operator/project/.clio-coder/skills", scope: "project" },
		}, { malformed: true }],
		diagnostics: [{ type: "warning", message: "private global diagnostic sk-secret" }],
	};
} else if (command === "library list --json") {
	payload = {
		entries: [{
			kind: "skill",
			name: "fixture-market-skill",
			description: "An audited skill available from the local catalog.",
			version: "1.2.3",
			category: "research",
			origin: "catalog",
			audit: "pass",
			sourceUrl: "https://user:secret@example.invalid/private.git",
			requires: ["skill:private-requirement"],
		}],
		diagnostics: ["private catalog path /home/operator/library.yaml"],
	};
} else if (command === "extensions list --all --json") {
	payload = {
		extensions: [{
			id: "fixture-lab-pack",
			name: "Fixture Lab Pack",
			version: "2.1.0",
			description: "Contributes research agents, prompts, and skills to Clio Coder.",
			scope: "project",
			rootPath: "/home/operator/project/.clio-coder/extensions/fixture-lab-pack",
			manifestPath: "/home/operator/project/.clio-coder/extensions/fixture-lab-pack/clio-coder-extension.yaml",
			enabled: true,
			effective: true,
			resources: { skills: "skills", prompts: "prompts", agents: "agents" },
			diagnostics: [{ type: "warning", message: "private extension diagnostic sk-secret" }],
		}],
	};
} else {
	Deno.exit(23);
}

await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(payload)));
