import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadDomains } from "../../src/core/domain-loader.js";
import { getSharedBus } from "../../src/core/shared-bus.js";
import { type AgentsContract, AgentsDomainModule } from "../../src/domains/agents/index.js";
import { type ConfigContract, ConfigDomainModule } from "../../src/domains/config/index.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { createPromptsDomainModule, type PromptsContract } from "../../src/domains/prompts/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { ResourcesDomainModule } from "../../src/domains/resources/index.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("external-agent settings reach the session prompt cache", { concurrency: false }, () => {
	let scratch: IsolatedClioEnv;
	let originalCwd: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-external-agent-prompt-");
		originalCwd = process.cwd();
		const cwd = join(scratch.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		ensureClioState();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		scratch.restore();
	});

	it("reflects additions, command edits, and removals without invalidating for unrelated settings", async () => {
		const loaded = await loadDomains([
			ConfigDomainModule,
			ResourcesDomainModule,
			AgentsDomainModule,
			createPromptsDomainModule({ noContextFiles: true }),
		]);
		try {
			const config = loaded.getContract<ConfigContract>("config");
			const agents = loaded.getContract<AgentsContract>("agents");
			const prompts = loaded.getContract<PromptsContract>("prompts");
			ok(config?.update && agents && prompts);
			const turn = createTurnContext({
				state: createTurnState("off"),
				getSettings: config.get,
				prompts,
				// Runtime metadata suffices: this path compiles prompts without a model request.
				providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
				middleware: {} as TurnMiddleware,
				emitNotice: () => {},
			});
			const runtime = {
				targetId: "local",
				runtimeId: "llama.cpp",
				wireModelId: "model",
				runtimeResolution: {
					capabilityDecisions: { tools: true },
					contextWindowDetails: { effectiveContextWindow: 32_768, contextWindowSource: "loaded" },
				},
				agent: {
					state: {
						systemPrompt: "",
						thinkingLevel: "off",
						messages: [],
						tools: [{ name: "dispatch", description: "Dispatch", parameters: { type: "object", properties: {} } }],
					},
				},
			} as unknown as AgentRuntime;
			try {
				const first = await turn.ensureSessionPrompt(runtime);
				ok(first);
				const epoch = prompts.inputEpoch();
				config.update((settings) => {
					settings.fleet.history.maxRuns = 50;
				});
				strictEqual(prompts.inputEpoch(), epoch);
				strictEqual(await turn.ensureSessionPrompt(runtime), first, "unrelated settings preserve the cached object");

				config.update((settings) => {
					settings.integrations.externalAgents.entries = [{ id: "catalog-fixture", command: "fixture-one", args: [] }];
				});
				ok(agents.getSpec("catalog-fixture"));
				const added = await turn.ensureSessionPrompt(runtime);
				match(added?.systemPrompt ?? "", /catalog-fixture.*fixture-one/u);
				notStrictEqual(prompts.inputEpoch(), epoch);
				strictEqual(await turn.ensureSessionPrompt(runtime), added);

				config.update((settings) => {
					const agent = settings.integrations.externalAgents.entries[0];
					ok(agent);
					agent.command = "fixture-two";
				});
				const edited = await turn.ensureSessionPrompt(runtime);
				match(edited?.systemPrompt ?? "", /catalog-fixture.*fixture-two/u);
				doesNotMatch(edited?.systemPrompt ?? "", /fixture-one/u);

				config.update((settings) => {
					settings.integrations.externalAgents.entries = [];
				});
				strictEqual(agents.getSpec("catalog-fixture"), null);
				const removed = await turn.ensureSessionPrompt(runtime);
				ok(removed);
				doesNotMatch(removed.systemPrompt, /catalog-fixture/u);
				strictEqual(removed.systemPrompt, first.systemPrompt);
			} finally {
				turn.dispose();
			}
		} finally {
			await loaded.stop();
		}
	});

	it("stops observing config when the agents lifecycle ends", async () => {
		const loaded = await loadDomains([ConfigDomainModule]);
		try {
			const config = loaded.getContract<ConfigContract>("config");
			ok(config?.update);
			const agents = await AgentsDomainModule.createExtension({ bus: getSharedBus(), getContract: loaded.getContract });
			const contract = agents.contract as AgentsContract;
			try {
				await agents.extension.start();
				const initial = contract.revision();
				config.update((settings) => {
					settings.integrations.externalAgents.entries = [{ id: "catalog-fixture", command: "fixture", args: [] }];
				});
				notStrictEqual(contract.revision(), initial);
			} finally {
				await agents.extension.stop?.();
			}
			const stopped = contract.revision();
			config.update((settings) => {
				settings.integrations.externalAgents.entries = [];
			});
			strictEqual(contract.revision(), stopped);
		} finally {
			await loaded.stop();
		}
	});
});
