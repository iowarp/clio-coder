import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";

// A headless `clio-coder run` has no operator, so its session prompt must not
// promise a pause for one. Which sections that flag gates is pinned in
// prompt-section-matrix.test.ts; this pins that the entry threads it through.
describe("headless flag threading into the compiled session inputs", () => {
	function compiled(systemPrompt: string): CompiledSessionPrompt {
		return { systemPrompt, systemPromptHash: systemPrompt, tokenEstimate: 1, sections: [], fragmentManifest: [] };
	}

	async function capturedInputs(headless: boolean | undefined): Promise<SessionPromptInputs | undefined> {
		let captured: SessionPromptInputs | undefined;
		const runtime = {
			targetId: "target",
			runtimeId: "runtime",
			wireModelId: "model",
			runtimeResolution: {
				capabilityDecisions: { tools: true },
				contextWindowDetails: { effectiveContextWindow: 32768, contextWindowSource: "loaded" },
			},
			agent: { state: { messages: [], tools: [], systemPrompt: "", model: {} } },
		} as unknown as AgentRuntime;
		const context = createTurnContext({
			...(headless !== undefined ? { headless } : {}),
			state: createTurnState("off"),
			getSettings: () => DEFAULT_SETTINGS,
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			middleware: {} as TurnMiddleware,
			prompts: {
				inputEpoch: () => "0",
				compileSessionPrompt: async (input) => {
					captured = input.sessionInputs;
					return compiled("prompt");
				},
				compileWorkerPrompt: async () => {
					throw new Error("not used");
				},
				reload() {},
			} as PromptsContract,
			emitNotice: () => {},
		});
		try {
			await context.ensureSessionPrompt(runtime);
		} finally {
			context.dispose();
		}
		return captured;
	}

	it("marks the session inputs headless only when the entry says so", async () => {
		strictEqual((await capturedInputs(true))?.headless, true);
		for (const headless of [false, undefined]) {
			const inputs = await capturedInputs(headless);
			ok(inputs !== undefined);
			deepStrictEqual(Object.hasOwn(inputs, "headless"), false);
		}
	});
});
