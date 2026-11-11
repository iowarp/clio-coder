import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { compile, type SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { guidanceForSettings } from "../../src/domains/prompts/runtime-guidance.js";
import { codeNavToolSurface } from "../../src/tools/codewiki/code-nav-surface.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// Clio answers questions about itself from live settings, bundled docs and a
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
			coordinatorCapabilities: [ToolNames.ClioDocs, ToolNames.ClioLibrary],
			...sessionInputs,
			toolNames,
		},
	}).systemPrompt;
}

const SETTINGS_ROUTE = 'gateway(op="call", capability="context", args={scope:"settings"})';

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
			ok(compileSession("safety.default", inputs).includes(SETTINGS_ROUTE), JSON.stringify(inputs));
		}
	});

	it("keeps configure_clio and setup consent procedure out of the prompt and in settings results (S-84)", () => {
		for (const safety of ["safety.default", "safety.yolo"] as const) {
			const prompt = compileSession(safety, { canConfigureClio: true });
			doesNotMatch(prompt, /capability="configure_clio"/);
			doesNotMatch(prompt, /Offer setup once/);
		}
		const guidance = guidanceForSettings()
			.map((block) => block.text)
			.join("\n");
		match(guidance, /yes authorizes those named changes and fleet creation/);
		match(guidance, /Required per-write Apply or policy approval cards still/);
		doesNotMatch(guidance, /Offer setup once/);
	});

	it("never routes to the code map file or the removed docs scope", () => {
		const prompt = compileSession("safety.default");
		doesNotMatch(prompt, /codemap\.json/);
		doesNotMatch(prompt, /\{CLIO_[A-Z_]+\}/);
		doesNotMatch(codeNavToolSurface.description, /scope=docs/);
		match(codeNavToolSurface.description, /clio_docs/);
	});

	it("offers a bounded semantic lookup only when the opt-in tool is reachable", () => {
		const guidance = /try one bounded context\(scope=semantic\) query early/;
		match(compileSession("safety.default", { semanticSearchAvailable: true }), guidance);
		doesNotMatch(compileSession("safety.default"), guidance);
		doesNotMatch(
			compileSession("safety.default", { semanticSearchAvailable: true, toolNames: [ToolNames.Gateway] }),
			guidance,
		);
		doesNotMatch(
			compileSession("safety.default", { semanticSearchAvailable: true, providerSupportsTools: false }),
			guidance,
		);
		doesNotMatch(
			compileSession("safety.default", {
				semanticSearchAvailable: true,
				turnConstraints: { mode: "answer" },
			}),
			guidance,
		);
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
