import { match, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";

import type { DomainContext } from "../../src/core/domain-loader.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type {
	CompileSessionPromptInput,
	CompileWorkerPromptInput,
	PromptsContract,
} from "../../src/domains/prompts/contract.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { fastReproducibility, isolateDispatchState, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function mainRuntime(): AgentRuntime {
	return {
		targetId: "local",
		runtimeId: "llama.cpp",
		wireModelId: "role-model",
		runtimeResolution: {
			capabilityDecisions: { tools: true },
			contextWindowDetails: { effectiveContextWindow: 32_768, contextWindowSource: "loaded" },
		},
		agent: {
			state: {
				systemPrompt: "",
				thinkingLevel: "off",
				messages: [],
				tools: [
					{
						name: ToolNames.Context,
						description: "Return context.",
						parameters: Type.Object({ scope: Type.String() }),
					},
				],
			},
		},
	} as unknown as AgentRuntime;
}

describe("production prompt role routing", { concurrency: false }, () => {
	it("selects session, ordinary-worker, and bound-worker hints through turn and dispatch paths", async () => {
		await isolateDispatchState();
		const base = dispatchStubContext();
		const promptBundle = createPromptsBundle(base, { noContextFiles: true });
		await promptBundle.extension.start();
		const mainInputs: CompileSessionPromptInput[] = [];
		const workerInputs: CompileWorkerPromptInput[] = [];
		const prompts: PromptsContract = {
			...promptBundle.contract,
			async compileSessionPrompt(input) {
				mainInputs.push(input);
				return promptBundle.contract.compileSessionPrompt(input);
			},
			async compileWorkerPrompt(input) {
				workerInputs.push(input);
				return promptBundle.contract.compileWorkerPrompt(input);
			},
		};
		const context: DomainContext = {
			bus: base.bus,
			getContract(name) {
				if (name === "prompts") return prompts as never;
				return base.getContract(name);
			},
		};
		const turn = createTurnContext({
			state: createTurnState("off"),
			getSettings: () => base.getContract<{ get(): unknown }>("config")?.get() as never,
			providers: base.getContract("providers") as ProvidersContract,
			prompts,
			toolRegistry: {
				get: () => ({
					metadata: {
						promptHint: {
							session: "SESSION_ROLE_HINT",
							worker: "ORDINARY_WORKER_ROLE_HINT",
							boundWorker: "BOUND_WORKER_ROLE_HINT",
						},
					},
				}),
			} as unknown as ToolRegistry,
			middleware: {} as TurnMiddleware,
			emitNotice: () => {},
		});
		const dispatch = createDispatchBundle(context, {
			collectReproducibility: fastReproducibility,
			spawnWorker: () => {
				throw new Error("role prompt captured");
			},
		});
		await dispatch.extension.start();

		try {
			const main = await turn.ensureSessionPrompt(mainRuntime());
			match(main?.systemPrompt ?? "", /SESSION_ROLE_HINT/u);
			strictEqual(main?.systemPrompt.includes("ORDINARY_WORKER_ROLE_HINT"), false);
			strictEqual(main?.systemPrompt.includes("BOUND_WORKER_ROLE_HINT"), false);
			strictEqual(mainInputs[0]?.sessionInputs.toolPromptHints?.[0]?.hint, "SESSION_ROLE_HINT");

			const request = {
				agentId: "coder",
				task: "Fix the implementation in src/example.ts and report validation.",
				executionRole: "builder" as const,
				requestOrigin: "internal" as const,
			};
			await rejects(dispatch.contract.dispatch({ ...request, noSkills: true }), /role prompt captured/u);
			await rejects(dispatch.contract.dispatch(request), /role prompt captured/u);

			strictEqual(workerInputs.length, 2);
			const ordinary = workerInputs[0];
			const bound = workerInputs[1];
			strictEqual(ordinary?.hasBoundSkills, false);
			strictEqual(bound?.hasBoundSkills, true);
			const ordinaryHint = ordinary?.toolPromptHints.find((entry) => entry.tool === ToolNames.Context)?.hint ?? "";
			const boundHint = bound?.toolPromptHints.find((entry) => entry.tool === ToolNames.Context)?.hint ?? "";
			match(ordinaryHint, /no operator skill-activation channel/u);
			strictEqual(ordinaryHint.includes("harness-activated recipe-bound"), false);
			match(boundHint, /harness-activated recipe-bound skills/u);
			strictEqual(boundHint.includes("explicit pending skill request"), false);
		} finally {
			turn.dispose();
			await dispatch.extension.stop?.();
			await promptBundle.extension.stop?.();
			restoreDispatchState();
		}
	});
});
