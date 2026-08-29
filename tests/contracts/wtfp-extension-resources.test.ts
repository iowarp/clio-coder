import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createAgentsBundle } from "../../src/domains/agents/extension.js";
import { listFleetContracts, loadFleetContract } from "../../src/domains/agents/fleet-contract.js";
import { enabledExtensionResourceRoots, installExtension } from "../../src/domains/extensions/index.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";

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
});
