import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	acceptInteropAgents,
	declineInteropAgents,
	foreignAgentDirs,
	INTEROP_AGENT_KINDS,
	interopProposals,
	readInteropReport,
} from "../../src/domains/interop/index.js";
import type { InteropReport } from "../../src/domains/interop/types.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function report(): InteropReport {
	return {
		version: 1,
		detectedAt: "2026-08-31T12:00:00.000Z",
		agents: [
			{
				kind: "codex",
				presence: "present",
				binary: "/usr/local/bin/codex",
				version: "0.9.1",
				adapter: "absent",
				skillCount: 0,
				projectArtifacts: 0,
				fingerprint: "sha256:codex",
			},
			{
				kind: "opencode",
				presence: "present",
				binary: "/usr/local/bin/opencode",
				version: "1.2.3",
				adapter: "present",
				skillCount: 0,
				projectArtifacts: 0,
				fingerprint: "sha256:opencode",
			},
		],
	};
}

function writePrompt(root: string, relative: string, body: string): void {
	const file = join(root, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, body, "utf8");
}

describe("contracts/interop boundary", () => {
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-interop-boundary-");
		initializeClioHome();
	});

	afterEach(() => isolated.restore());

	it("persists explicit consent and keeps accepted and declined decisions independent", () => {
		const detected = report();
		acceptInteropAgents(["codex"], detected);
		declineInteropAgents(["opencode"], detected);

		const configured = readSettings().integrations.externalAgents.entries;
		strictEqual(configured.length, 1);
		strictEqual(configured[0]?.id, "codex");
		strictEqual(configured[0]?.toolGovernance, "clio-coder-policy");
		const stored = readInteropReport();
		strictEqual(stored?.agents.find((agent) => agent.kind === "codex")?.decision, "accepted");
		strictEqual(stored?.agents.find((agent) => agent.kind === "opencode")?.decision, "declined");
		strictEqual(interopProposals(stored as InteropReport, readSettings()).length, 0);
	});

	it("allows inspection of foreign project roots but blocks their mutation at every posture", () => {
		const cwd = join(isolated.dir, "project");
		mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
		const policy = createSafetyPolicyEngine({ cwd });

		for (const posture of [undefined, "confirmed"]) {
			const write = policy.evaluate(
				{ tool: ToolNames.Write, args: { path: ".claude/settings.json", content: "{}" } },
				posture,
			);
			strictEqual(write.kind, "block");
			strictEqual(write.reasonCode, "path-policy:noWritePaths");
		}
		strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: ".claude/skills/x/SKILL.md" } }).kind, "allow");
		strictEqual(
			policy.evaluate({ tool: ToolNames.Write, args: { path: ".clio-coder/settings.json", content: "{}" } }).kind,
			"allow",
		);
	});

	it("keeps registry ownership complete and state isolated under the configured Clio root", () => {
		for (const provider of ["claude-code", "agents", "codex", "gemini", "cursor", "copilot", "opencode"]) {
			strictEqual(INTEROP_AGENT_KINDS.filter((kind) => kind.adoptionProvider === provider).length, 1);
		}
		for (const root of [
			"~/.claude/",
			"~/.codex/",
			"~/.gemini/",
			"~/.gemini/antigravity-cli/",
			".gemini/antigravity-cli/",
			"~/.antigravitycli/",
			".antigravitycli/",
			"~/.cursor/",
			"~/.config/opencode/",
		]) {
			ok(foreignAgentDirs().includes(root), `${root} is not protected`);
		}
		strictEqual(readInteropReport(), null);
		declineInteropAgents(["codex"], report());
		strictEqual(readInteropReport()?.agents.find((agent) => agent.kind === "codex")?.decision, "declined");
	});

	it("refuses untrusted project prompts while allowing trusted user-scope compatibility prompts", () => {
		const cwd = join(isolated.dir, "project-prompts");
		const home = join(isolated.dir, "user-prompts");
		writePrompt(cwd, join(".claude", "commands", "demo.md"), "Run the project demo.\n");
		writePrompt(home, join(".codex", "prompts", "review.md"), "Review the change.\n");

		const templates = loadPromptTemplates({ cwd, home });
		const project = templates.items.find((item) => item.name === "demo");
		const user = templates.items.find((item) => item.name === "review");
		strictEqual(project?.trusted, false);
		strictEqual(user?.trusted, true);
		const refused = expandPromptTemplateInput("/demo", templates);
		strictEqual(refused.expanded, false);
		if (refused.expanded) throw new Error("expected project prompt refusal");
		strictEqual(refused.refusal?.template.name, "demo");
		const expanded = expandPromptTemplateInput("/review", templates);
		strictEqual(expanded.expanded, true);
		if (!expanded.expanded) throw new Error("expected user prompt expansion");
		strictEqual(expanded.text, "Review the change.");
		strictEqual(expanded.template, user);
		strictEqual(expanded.diagnostics.length, 0);
	});
});
