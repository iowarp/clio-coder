import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	type CompiledSessionPrompt,
	compile,
	HEADLESS_SESSION_APPROVAL_SEMANTICS,
	SESSION_APPROVAL_SEMANTICS,
	type SessionPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { AUTONOMY_LEVELS } from "../../src/domains/safety/autonomy.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// A headless `clio-coder run` has no operator: its permission listener denies
// every approval ask at both autonomy levels, a yolo damage-control confirm
// included. The session prompt must say so instead of promising a pause for an
// operator who is not there.
function safetySection(level: string, sessionInputs: Partial<SessionPromptInputs>): string {
	const compiled = compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${level}`,
		sessionInputs: {
			provider: "local",
			model: "stable-model",
			providerSupportsTools: true,
			toolNames: [ToolNames.Bash, ToolNames.Read],
			...sessionInputs,
		},
	});
	const start = compiled.systemPrompt.indexOf(`Autonomy: ${level}.`);
	ok(start >= 0, "the safety section renders");
	return compiled.systemPrompt.slice(start);
}

describe("headless approval wording in the session prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-headless-approval-");
	});
	afterEach(() => env.restore());

	for (const level of AUTONOMY_LEVELS) {
		it(`tells a headless session at ${level} that approval-required calls are denied`, () => {
			const headless = safetySection(level, { headless: true });
			ok(headless.includes(HEADLESS_SESSION_APPROVAL_SEMANTICS), headless);
			ok(!headless.includes(SESSION_APPROVAL_SEMANTICS), headless);
			ok(!/pause for one operator confirmation/.test(headless), headless);
			match(headless, /No operator is attached to this headless run, so approval-required calls are denied/);
			match(headless, /use recognized commands and typed checks, and report what could not run\./);
		});

		it(`keeps the operator-confirmation sentence for an attached session at ${level}`, () => {
			for (const inputs of [{}, { headless: false }]) {
				const interactive = safetySection(level, inputs);
				ok(interactive.includes(SESSION_APPROVAL_SEMANTICS), interactive);
				ok(!interactive.includes(HEADLESS_SESSION_APPROVAL_SEMANTICS), interactive);
			}
		});
	}
});

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
