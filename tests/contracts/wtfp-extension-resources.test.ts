import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { inspectFleet } from "../../src/cli/fleet-preflight.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createAgentsBundle } from "../../src/domains/agents/extension.js";
import { listFleetContracts, loadFleetContract } from "../../src/domains/agents/fleet-contract.js";
import { enabledExtensionResourceRoots, installExtension } from "../../src/domains/extensions/index.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { runCli } from "../harness/spawn.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-wtfp-extension-"));
	scratchRoots.push(root);
	return root;
}

function write(root: string, relative: string, content: string): void {
	const target = path.join(root, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
}

const SKILL = `---
name: wtfp-plan-section
description: Plan one manuscript section from evidence and project context.
---

# Plan a section

Read the evidence, state assumptions, and produce a bounded section plan.
`;

function agent(name: string, skills: ReadonlyArray<string>): string {
	return `---
version: 1
name: ${name}
description: A WTF-P extension research agent.
tools: {required: [read, context], optional: []}
skills: [${skills.join(", ")}]
audience: custom
category: explore
capabilityClass: read-only
latencyClass: fast
projectContextTier: none
budget: {toolCalls: 8, readReserve: 1, synthesis: true}
resultContract: {kind: provenance-report}
tags: [wtfp, research]
---

# Persona

Follow the bound WTF-P skill and report evidence precisely.
`;
}

const FLEET = `---
version: 3
name: wtfp-plan-section
description: Plan and independently inspect one manuscript section.
steps:
  - kind: agent
    id: plan
    agent: wtfp-planner
    scope: readonly
    dependencies: []
  - kind: agent
    id: inspect
    agent: wtfp-checker
    scope: readonly
    dependencies: [plan]
maxWorkers: 2
onFailure: stop
---

Plan and inspect {{topic}}.
`;

function writeExtension(root: string): void {
	write(root, "state.json", '{"version":1,"private":"extension-manager-bookkeeping"}\n');
	write(
		root,
		"clio-coder-extension.yaml",
		[
			"manifestVersion: 1",
			"id: wtfp",
			"name: WTF-P",
			"version: 2.0.0",
			"description: Portable research workflows for Clio Coder.",
			"resources:",
			"  prompts: prompts",
			"  skills: skills",
			"  agents: agents",
			"  fleets: fleets",
			"",
		].join("\n"),
	);
	write(root, "core/templates/project.md", "# Project template\n");
	write(root, "core/templates/state.json", '{"schema":"wtfp.project.state/v1"}\n');
	write(
		root,
		"prompts/wtfp/new-paper.md",
		`Read @\${extensionRoot}/core/templates/project.md and @\${extensionRoot}/core/templates/state.json, then start a paper about $ARGUMENTS.\n`,
	);
	write(root, "skills/wtfp-plan-section/SKILL.md", SKILL);
	write(root, "agents/wtfp-planner.md", agent("WTF-P Planner", ["wtfp-plan-section"]));
	write(root, "agents/wtfp-checker.md", agent("WTF-P Checker", []));
	write(root, "agents/coder.md", agent("Untrusted Coder Override", []));
	write(root, "fleets/wtfp-plan-section.md", FLEET);
}

function writeMinimalExtension(root: string, fleetAgent = "extension-reader"): void {
	write(
		root,
		"clio-coder-extension.yaml",
		[
			"manifestVersion: 1",
			"id: minimal",
			"name: Minimal Fleet Extension",
			"version: 1.0.0",
			"description: Minimal agent and fleet integration fixture.",
			"resources:",
			"  agents: agents",
			"  fleets: fleets",
			"",
		].join("\n"),
	);
	write(root, "agents/extension-reader.md", agent("Extension Reader", []));
	write(
		root,
		"fleets/minimal.md",
		[
			"---",
			"version: 3",
			"name: minimal",
			"description: Resolve one extension-owned agent.",
			"steps:",
			"  - kind: agent",
			"    id: inspect",
			`    agent: ${fleetAgent}`,
			"    scope: readonly",
			"    dependencies: []",
			"maxWorkers: 1",
			"onFailure: stop",
			"---",
			"",
			"Inspect the supplied fixture without mutation.",
			"",
		].join("\n"),
	);
}

describe("contracts/WTF-P extension resources", () => {
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads namespaced prompts, same-extension skills, agents, and fleets as one bundle", async () => {
		const project = scratchDir();
		const source = scratchDir();
		writeExtension(source);

		const installed = installExtension(source, { cwd: project, scope: "project" });
		deepStrictEqual(
			installed.diagnostics.filter((diagnostic) => diagnostic.type === "error"),
			[],
		);
		const installedRoot = installed.extension?.rootPath;
		ok(installedRoot, "the extension has an installed root");
		strictEqual(existsSync(path.join(installedRoot, "state.json")), false, "root bookkeeping state is excluded");
		strictEqual(
			readFileSync(path.join(installedRoot, "core", "templates", "state.json"), "utf8"),
			'{"schema":"wtfp.project.state/v1"}\n',
			"nested state resources are installed",
		);
		strictEqual(enabledExtensionResourceRoots("agents", project).length, 1);
		strictEqual(enabledExtensionResourceRoots("fleets", project).length, 1);

		const prompts = loadPromptTemplates({ cwd: project, home: scratchDir() });
		const expanded = expandPromptTemplateInput("/wtfp:new-paper durable workflows", prompts);
		strictEqual(expanded.expanded, true);
		if (!expanded.expanded) throw new Error("expected namespaced extension prompt to expand");
		ok(expanded.text.includes(path.join("extensions", "wtfp", "core", "templates", "project.md")));
		ok(expanded.text.includes(path.join("extensions", "wtfp", "core", "templates", "state.json")));
		ok(expanded.text.endsWith("then start a paper about durable workflows."));

		const previousCwd = process.cwd();
		try {
			process.chdir(project);
			const bundle = createAgentsBundle({ getContract: () => undefined } as unknown as DomainContext);
			await bundle.extension.start();
			const planner = bundle.contract.get("wtfp-planner");
			strictEqual(planner?.source, "extension");
			strictEqual(planner?.boundSkillPaths.length, 1);
			ok(planner?.boundSkillPaths[0]?.includes(path.join("extensions", "wtfp", "skills", "wtfp-plan-section")));
			strictEqual(bundle.contract.get("coder")?.source, "builtin", "an extension cannot shadow a shipped agent");
		} finally {
			process.chdir(previousCwd);
		}

		const listing = listFleetContracts(project).find((entry) => entry.name === "wtfp-plan-section");
		strictEqual(listing?.source, "extension");
		strictEqual(listing?.error, null);
		strictEqual(loadFleetContract(project, "wtfp-plan-section").steps.length, 2);

		const preflightCwd = process.cwd();
		try {
			process.chdir(project);
			const preflight = inspectFleet("wtfp-plan-section", { topic: "durable workflows" });
			strictEqual(preflight.checks.find((check) => check.check === "agents")?.summary, "resolved 2 agents");
		} finally {
			process.chdir(preflightCwd);
		}

		const validate = await runCli(["fleet", "validate", "wtfp-plan-section", "--json"], { cwd: project });
		strictEqual(validate.code, 0, validate.stderr || validate.stdout);
		const validation = JSON.parse(validate.stdout) as {
			valid: boolean;
			checks: Array<{ check: string; summary: string }>;
		};
		strictEqual(validation.valid, true);
		strictEqual(validation.checks.find((check) => check.check === "agents")?.summary, "resolved 2 agents");

		const graph = await runCli(["fleet", "graph", "wtfp-plan-section", "--json"], { cwd: project });
		strictEqual(graph.code, 0, graph.stderr || graph.stdout);
		const graphResult = JSON.parse(graph.stdout) as {
			waves: Array<{ steps: Array<{ id: string; agent: string }> }>;
		};
		deepStrictEqual(
			graphResult.waves.flatMap((wave) => wave.steps.map((step) => [step.id, step.agent])),
			[
				["plan", "wtfp-planner"],
				["inspect", "wtfp-checker"],
			],
		);
	});

	it("preflights a minimal extension fleet and refuses an unknown agent", () => {
		const project = scratchDir();
		const source = scratchDir();
		writeMinimalExtension(source);
		strictEqual(
			installExtension(source, { cwd: project, scope: "project" }).diagnostics.some(
				(diagnostic) => diagnostic.type === "error",
			),
			false,
		);

		const originalCwd = process.cwd();
		try {
			process.chdir(project);
			const inspected = inspectFleet("minimal");
			strictEqual(inspected.plan.steps[0]?.kind, "agent");
			strictEqual(inspected.plan.steps[0]?.kind === "agent" ? inspected.plan.steps[0].agentId : null, "extension-reader");
		} finally {
			process.chdir(originalCwd);
		}

		const brokenProject = scratchDir();
		const brokenSource = scratchDir();
		writeMinimalExtension(brokenSource, "missing-extension-agent");
		strictEqual(
			installExtension(brokenSource, { cwd: brokenProject, scope: "project" }).diagnostics.some(
				(diagnostic) => diagnostic.type === "error",
			),
			false,
		);
		try {
			process.chdir(brokenProject);
			throws(
				() => inspectFleet("minimal"),
				/unknown agent 'missing-extension-agent'.*must name a recipe from 'clio-coder agents'/,
			);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("refuses a declared resource root outside the extension package", () => {
		const project = scratchDir();
		const source = scratchDir();
		write(
			source,
			"clio-coder-extension.yaml",
			[
				"manifestVersion: 1",
				"id: escaping",
				"name: Escaping",
				"version: 1.0.0",
				"description: Must be rejected.",
				"resources:",
				"  prompts: ../outside",
				"",
			].join("\n"),
		);

		const result = installExtension(source, { cwd: project, scope: "project" });
		ok(result.diagnostics.some((diagnostic) => diagnostic.type === "error" && diagnostic.message.includes("escapes")));
		strictEqual(result.extension, undefined);
	});

	it("preserves every payload byte after one command delimiter in aggregate prompt arguments", () => {
		const promptsRoot = scratchDir();
		write(
			promptsRoot,
			"wtfp/new-paper.md",
			["<invocation_arguments>", "$ARGUMENTS", "</invocation_arguments>", ""].join("\n"),
		);
		const prompts = loadPromptTemplates({
			roots: [{ path: promptsRoot, scope: "project", source: "wtfp", trusted: true }],
		});
		const invocationArguments = [
			"",
			"  Inspect  this disposable fixture.",
			"",
			'  - Working title: "Adaptive Checkpoint Scheduling".',
			"\t- Keep synthetic labels and exact  spacing.",
			"Trailing spaces remain data.  ",
			"",
		].join("\n");

		// The first newline delimits the command. The second newline and every
		// byte after it, including the final newline, are invocation data.
		const expanded = expandPromptTemplateInput(`/wtfp:new-paper\n${invocationArguments}`, prompts);

		strictEqual(expanded.expanded, true);
		if (!expanded.expanded) throw new Error("expected namespaced extension prompt to expand");
		strictEqual(expanded.text, ["<invocation_arguments>", invocationArguments, "</invocation_arguments>"].join("\n"));
	});
});
