import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { compile, type SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { toolPromptHintsForNames } from "../../src/tools/bootstrap.js";
import { codeNavToolSurface } from "../../src/tools/codewiki/code-nav-surface.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// Clio answers questions about herself from live settings, bundled docs and a
// shipped code map. These pin that the prompt points at each one whenever the
// tool that reaches it is on the surface, independent of unrelated switches
// such as skill discovery, and never at a route that no longer exists.
function compileSession(safety: string, sessionInputs: Partial<SessionPromptInputs> = {}) {
	const toolNames = sessionInputs.toolNames ?? [ToolNames.Context, ToolNames.Gateway];
	return compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety,
		sessionInputs: {
			provider: "local",
			model: "stable-model",
			contextWindow: 32_768,
			providerSupportsTools: true,
			toolPromptHints: [...toolPromptHintsForNames([ToolNames.Context, ToolNames.Gateway], "session")],
			...sessionInputs,
			toolNames,
		},
	}).systemPrompt;
}

const SETTINGS_ROUTE = 'context(scope="settings")';

describe("self-knowledge in the session prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-self-knowledge-");
	});
	afterEach(() => env.restore());

	it("points settings questions at the live snapshot whenever context is on the surface", () => {
		for (const inputs of [
			{},
			{ skillDiscoveryEnabled: false },
			{ readySkillCount: 0 },
			{ turnConstraints: { mode: "answer" as const } },
		]) {
			ok(compileSession("safety.auto-edit", inputs).includes(SETTINGS_ROUTE), JSON.stringify(inputs));
		}
		ok(!compileSession("safety.auto-edit", { toolNames: [ToolNames.Gateway] }).includes(SETTINGS_ROUTE));
	});

	it("teaches the configure_clio preview only where the tool is registered and autonomy lets it run", () => {
		const configure = /capability="configure_clio"/;
		match(compileSession("safety.auto-edit", { canConfigureClio: true }), configure);
		match(compileSession("safety.full-auto", { canConfigureClio: true }), configure);
		for (const [safety, inputs] of [
			["safety.suggest", { canConfigureClio: true }],
			["safety.read-only", { canConfigureClio: true }],
			["safety.auto-edit", {}],
			["safety.auto-edit", { canConfigureClio: true, toolNames: [ToolNames.Context] }],
		] as const) {
			const prompt = compileSession(safety, inputs);
			doesNotMatch(prompt, configure, `${safety} ${JSON.stringify(inputs)}`);
			if (prompt.includes(SETTINGS_ROUTE)) match(prompt, /\/settings/);
		}
	});

	it("names the shipped code map and never routes to the removed docs scope", () => {
		const prompt = compileSession("safety.auto-edit");
		match(prompt, /dist[/\\]assets[/\\]codewiki\.json/);
		doesNotMatch(prompt, /\{CLIO_[A-Z_]+\}/);
		doesNotMatch(codeNavToolSurface.description, /scope=docs/);
		match(codeNavToolSurface.description, /clio_docs/);
	});
});

describe("code_nav source=clio", () => {
	it("routes a wiki request to clio_docs", async () => {
		const { codeNavTool } = await import("../../src/tools/codewiki/code-nav.js");
		const result = await codeNavTool.run({ source: "clio", mode: "wiki" });
		strictEqual(result.kind, "error");
		ok(result.kind === "error" && result.message.includes("clio_docs"), JSON.stringify(result));
		ok(result.kind === "error" && !result.message.includes("scope=docs"), JSON.stringify(result));
	});
});
