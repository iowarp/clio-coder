import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { isOrchestratorEligibleRuntime, isTargetEligibleRuntime } from "../../src/domains/providers/eligibility.js";
import antigravityCodeRuntime from "../../src/domains/providers/runtimes/antigravity/antigravity-code.js";
import { BUILTIN_RUNTIMES } from "../../src/domains/providers/runtimes/builtins.js";
import {
	antigravitySubprocessConfigForAutonomy,
	buildAgyArgs,
	buildAntigravityPrompt,
} from "../../src/engine/antigravity/subprocess-runtime.js";

describe("contracts/antigravity runtime registration", () => {
	it("registers antigravity-code as a subprocess subscription runtime", () => {
		strictEqual(antigravityCodeRuntime.id, "antigravity-code");
		strictEqual(antigravityCodeRuntime.kind, "subprocess");
		strictEqual(antigravityCodeRuntime.tier, "subscription");
		strictEqual(antigravityCodeRuntime.binaryName, "agy");
		ok(BUILTIN_RUNTIMES.some((runtime) => runtime.id === "antigravity-code"));
	});

	it("is a worker/dispatch target but never an orchestrator", () => {
		strictEqual(isTargetEligibleRuntime(antigravityCodeRuntime), true);
		strictEqual(isOrchestratorEligibleRuntime(antigravityCodeRuntime), false);
	});

	it("advertises the large-context profile", () => {
		strictEqual(antigravityCodeRuntime.defaultCapabilities.contextWindow, 1_000_000);
		strictEqual(antigravityCodeRuntime.knownModels?.[0], "Gemini 3.5 Flash (High)");
	});
});

describe("contracts/antigravity subprocess permission gate", () => {
	it("only opens the dangerous bypass under full-auto plus the explicit environment gate", () => {
		for (const autonomy of ["read-only", "suggest", "auto-edit", "full-auto"] as const) {
			const config = antigravitySubprocessConfigForAutonomy(autonomy, {});
			strictEqual(config.dangerousBypass, false, `${autonomy} must not bypass by default`);
			ok(
				!config.extraArgs.includes("--dangerously-skip-permissions"),
				`${autonomy} must not pass the bypass flag by default`,
			);
		}

		strictEqual(antigravitySubprocessConfigForAutonomy("read-only", {}).extraArgs.includes("--sandbox"), true);
		strictEqual(antigravitySubprocessConfigForAutonomy("suggest", {}).extraArgs.includes("--sandbox"), true);
		strictEqual(antigravitySubprocessConfigForAutonomy("auto-edit", {}).extraArgs.length, 0);

		const suggestWithEnv = antigravitySubprocessConfigForAutonomy("suggest", { CLIO_ALLOW_EXTERNAL_FULL_ACCESS: "1" });
		strictEqual(suggestWithEnv.dangerousBypass, false);
		ok(!suggestWithEnv.extraArgs.includes("--dangerously-skip-permissions"));

		const fullAutoWithEnv = antigravitySubprocessConfigForAutonomy("full-auto", { CLIO_ALLOW_EXTERNAL_FULL_ACCESS: "1" });
		strictEqual(fullAutoWithEnv.dangerousBypass, true);
		ok(fullAutoWithEnv.extraArgs.includes("--dangerously-skip-permissions"));
	});

	it("builds agy --print args with the prompt last and no bypass flag at default autonomy", () => {
		const base = {
			systemPrompt: "",
			agentId: "contract",
			task: "Summarize the repository.",
			target: { id: "contract", runtime: "antigravity-code" },
			runtime: antigravityCodeRuntime,
			wireModelId: "Gemini 3.5 Flash (High)",
			allowedTools: [],
			autonomy: "auto-edit" as const,
		};
		const args = buildAgyArgs(base);
		strictEqual(args[0], "--print");
		ok(!args.includes("--dangerously-skip-permissions"));
		const modelIndex = args.indexOf("--model");
		ok(modelIndex >= 0);
		strictEqual(args[modelIndex + 1], "Gemini 3.5 Flash (High)");
		strictEqual(args[args.length - 1], "Summarize the repository.");
	});

	it("omits --model when no wire model id is supplied", () => {
		const args = buildAgyArgs({
			systemPrompt: "",
			agentId: "contract",
			task: "read",
			target: { id: "contract", runtime: "antigravity-code" },
			runtime: antigravityCodeRuntime,
			wireModelId: "   ",
			allowedTools: [],
		});
		ok(!args.includes("--model"));
		strictEqual(args[args.length - 1], "read");
	});

	it("joins system prompt, dynamic messages, and task into one prompt", () => {
		const prompt = buildAntigravityPrompt({
			systemPrompt: "You read code.",
			dynamicPromptMessages: [{ body: "Focus on src/." }] as never,
			agentId: "contract",
			task: "List the entry points.",
			target: { id: "contract", runtime: "antigravity-code" },
			runtime: antigravityCodeRuntime,
			wireModelId: "Gemini 3.5 Flash (High)",
			allowedTools: [],
		});
		strictEqual(prompt, "You read code.\n\nFocus on src/.\n\nList the entry points.");
	});
});
