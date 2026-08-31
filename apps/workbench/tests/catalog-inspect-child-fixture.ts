const scenarioArgument = Deno.args.find((argument) => argument.startsWith("--scenario="));
const scenario = scenarioArgument?.slice("--scenario=".length) ?? "valid";
const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? [] : Deno.args.slice(separator + 1);
const command = commandArgs.join(" ");

if (scenario === "partial" && command === "skills inventory --json") {
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
} else if (command === "skills inventory --json") {
	payload = {
		version: 1,
		generatedAt: "2026-08-31T12:00:00.000Z",
		valid: false,
		invalidReason: "unloadable-file",
		total: 2,
		modelVisible: 1,
		diagnostics: { errors: 0, warnings: 2, collisions: 0 },
		skills: [{
			name: "fixture-skill",
			description: "A trusted project skill used only by the fixture.",
			scope: "project",
			source: "clio",
			trusted: true,
			modelInvocable: true,
			modelVisible: true,
			precedence: 30,
			diagnostics: { errors: 0, warnings: 1, collisions: 0 },
			allowedTools: ["read"],
			disallowedTools: ["bash"],
			installedByWorker: true,
			updatable: true,
			audit: "unknown",
			installedAt: "2026-08-01T10:00:00.000Z",
			updatedAt: null,
		}, {
			// Untrusted, so the model never sees it. The old listing could not have
			// reported this row at all.
			name: "fixture-compat-skill",
			description: "A skill under a compatibility root the model may not load.",
			scope: "project",
			source: "codex",
			trusted: false,
			modelInvocable: true,
			modelVisible: false,
			precedence: 10,
			diagnostics: { errors: 0, warnings: 0, collisions: 0 },
			allowedTools: [],
			disallowedTools: [],
			installedByWorker: false,
			updatable: false,
			audit: "not-reported",
			installedAt: null,
			updatedAt: null,
		}],
		skillsTruncated: false,
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
} else if (command === "verifiers inspect --json") {
	payload = scenario === "verifiers-blocked"
		? {
			version: 1,
			generatedAt: "2026-08-31T12:00:00.000Z",
			catalogPresent: true,
			catalogValid: false,
			rejection: "shell-command",
			rejectedAt: "checks[1].command[0]",
			discovery: "blocked",
			blockedBy: "catalog-rejected",
			checks: [],
			checksTruncated: false,
			diagnosticCount: 0,
		}
		: {
			version: 1,
			generatedAt: "2026-08-31T12:00:00.000Z",
			catalogPresent: true,
			catalogValid: true,
			rejection: null,
			rejectedAt: null,
			discovery: "complete",
			blockedBy: null,
			checks: [{
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
			}, {
				id: "lint.rust",
				description: "Lint the workspace with clippy.",
				origin: "catalog",
				signal: "project-catalog",
				authority: "project-declared",
				runner: "cargo",
				argumentCount: 3,
				runsAtRepositoryRoot: false,
				argvFixed: true,
				timeoutMs: 300000,
				tags: ["lint", "rust"],
			}],
			checksTruncated: false,
			diagnosticCount: 1,
		};
} else {
	Deno.exit(23);
}

await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(payload)));
