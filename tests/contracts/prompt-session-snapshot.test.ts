import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { type ContextContract, renderPromptContext, serializeClioMd } from "../../src/domains/context/index.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import type { PromptsContract } from "../../src/domains/prompts/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

function writePromptSources(root: string, version: "ONE" | "TWO" | "THREE", clioRepo: boolean): void {
	writeFileSync(
		join(root, "CLIO-CODER.md"),
		serializeClioMd({
			projectName: `Snapshot ${version}`,
			identity: `HANDBOOK_${version}`,
			conventions: [`CONTEXT_${version}`],
			invariants: [`INVARIANT_${version}`],
		}),
	);
	mkdirSync(join(root, ".clio-coder", "rules"), { recursive: true });
	writeFileSync(join(root, ".clio-coder", "rules", "base.md"), `RULE_${version}\n`);
	writeFileSync(join(root, ".clio-coder", "rules", "scoped.md"), `---\npaths:\n  - src/**\n---\nSCOPED_${version}\n`);
	writeFileSync(
		join(root, ".clio-coder", "profile.yaml"),
		`responsePosture: ${version === "ONE" ? "concise" : version === "TWO" ? "balanced" : "thorough"}\n`,
	);

	const clioMarker = join(root, "src", "worker", "entry.ts");
	if (clioRepo) {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@iowarp/clio-coder", repository: "https://github.com/iowarp/clio-coder" }),
		);
		mkdirSync(join(root, ".git"), { recursive: true });
		for (const path of [
			join(root, "src", "entry", "orchestrator.ts"),
			clioMarker,
			join(root, "src", "domains", "prompts", "fragments", "identity", "clio.md"),
		]) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "// marker\n");
		}
	} else {
		rmSync(clioMarker, { force: true });
	}
}

function runtime(): AgentRuntime {
	return {
		targetId: "local",
		runtimeId: "llama.cpp",
		wireModelId: "model-one",
		runtimeResolution: {
			capabilityDecisions: { tools: true },
			contextWindowDetails: { effectiveContextWindow: 32_768, contextWindowSource: "loaded" },
		},
		agent: {
			state: {
				systemPrompt: "",
				thinkingLevel: "off",
				messages: [],
				tools: [],
			},
		},
	} as unknown as AgentRuntime;
}

describe("session prompt source snapshot", { concurrency: false }, () => {
	it("freezes real bundle disk inputs across production cache misses and refreshes at explicit boundaries", async () => {
		const originalCwd = process.cwd();
		const scratch = mkdtempSync(join(tmpdir(), "clio-prompt-snapshot-"));
		const bus = createSafeEventBus();
		let sessionId = "snapshot-session-one";
		let compileCalls = 0;
		writePromptSources(scratch, "ONE", true);
		process.chdir(scratch);

		const config: ConfigContract = {
			get: () => structuredClone(DEFAULT_SETTINGS),
			onChange: () => () => {},
		};
		const agents = {
			revision: () => 1,
			listSpecs: () => [],
		} as unknown as AgentsContract;
		const context = { renderPromptContext } as unknown as ContextContract;
		const domainContext: DomainContext = {
			bus,
			getContract(name) {
				if (name === "config") return config as never;
				if (name === "agents") return agents as never;
				if (name === "context") return context as never;
				return undefined;
			},
		};
		const bundle = createPromptsBundle(domainContext);
		await bundle.extension.start();
		const prompts: PromptsContract = {
			...bundle.contract,
			async compileSessionPrompt(input) {
				compileCalls += 1;
				return bundle.contract.compileSessionPrompt(input);
			},
		};
		const turn = createTurnContext({
			state: createTurnState("off"),
			getSettings: () => structuredClone(DEFAULT_SETTINGS),
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			prompts,
			session: {
				current: () => ({
					id: sessionId,
					cwd: scratch,
					cwdHash: "snapshot",
					createdAt: "2026-09-01T00:00:00.000Z",
					endedAt: null,
					model: "model-one",
					target: "local",
					clioCoderVersion: "0.4.2",
					piMonoVersion: "0.84.0",
					platform: "test",
					nodeVersion: process.version,
				}),
				appendEntry: (entry: unknown) => entry,
			} as never,
			middleware: {} as TurnMiddleware,
			emitNotice: () => {},
		});
		const agentRuntime = runtime();

		try {
			const first = await turn.ensureSessionPrompt(agentRuntime);
			await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 1, "an unchanged production identity must reuse the compile");
			match(first?.systemPrompt ?? "", /HANDBOOK_ONE/u);
			match(first?.systemPrompt ?? "", /RULE_ONE/u);
			match(first?.systemPrompt ?? "", /Response posture: concise/u);
			match(first?.systemPrompt ?? "", /# Clio Source Tree/u);

			writePromptSources(scratch, "TWO", false);
			turn.addWorkingContextPaths(["src/feature.ts"]);
			const workingContextMiss = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 2, "working-context membership must recompile");
			match(workingContextMiss?.systemPrompt ?? "", /SCOPED_ONE/u);
			strictEqual(workingContextMiss?.systemPrompt.includes("SCOPED_TWO"), false);

			agentRuntime.wireModelId = "model-two";
			const unrelatedMiss = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 3, "a wire-model change must re-enter the real compiler");
			match(unrelatedMiss?.systemPrompt ?? "", /Model: model-two/u);
			match(unrelatedMiss?.systemPrompt ?? "", /HANDBOOK_ONE/u);
			match(unrelatedMiss?.systemPrompt ?? "", /RULE_ONE/u);
			match(unrelatedMiss?.systemPrompt ?? "", /Response posture: concise/u);
			match(unrelatedMiss?.systemPrompt ?? "", /# Clio Source Tree/u);
			strictEqual(unrelatedMiss?.systemPrompt.includes("HANDBOOK_TWO"), false);

			const beforeInvalidation = prompts.inputEpoch();
			bus.emit(BusChannels.ConfigHotReload, {
				diff: { hotReload: ["context.prompt"], nextTurn: [], restartRequired: [] },
				settings: structuredClone(DEFAULT_SETTINGS),
			});
			const afterInvalidation = prompts.inputEpoch();
			strictEqual(beforeInvalidation === afterInvalidation, false, "config invalidation must advance the real epoch");
			const invalidated = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 4);
			match(invalidated?.systemPrompt ?? "", /HANDBOOK_TWO/u);
			match(invalidated?.systemPrompt ?? "", /RULE_TWO/u);
			match(invalidated?.systemPrompt ?? "", /SCOPED_TWO/u);
			match(invalidated?.systemPrompt ?? "", /Response posture: balanced/u);
			strictEqual(invalidated?.systemPrompt.includes("# Clio Source Tree"), false);

			writePromptSources(scratch, "THREE", false);
			sessionId = "snapshot-session-two";
			const nextSession = await turn.ensureSessionPrompt(agentRuntime);
			strictEqual(compileCalls, 5, "a new session identity must capture a new source snapshot");
			match(nextSession?.systemPrompt ?? "", /HANDBOOK_THREE/u);
			match(nextSession?.systemPrompt ?? "", /RULE_THREE/u);
			match(nextSession?.systemPrompt ?? "", /SCOPED_THREE/u);
			match(nextSession?.systemPrompt ?? "", /Response posture: thorough/u);
		} finally {
			turn.dispose();
			await bundle.extension.stop?.();
			process.chdir(originalCwd);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
