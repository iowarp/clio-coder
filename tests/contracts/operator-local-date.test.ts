import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { operatorCalendar } from "../../src/core/format-time.js";
import { createLocalClockReminderRegistration } from "../../src/domains/middleware/local-clock-reminder.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { type CompiledSessionPrompt, compile, type SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

async function sessionInputs(): Promise<SessionPromptInputs | undefined> {
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
	const compiled: CompiledSessionPrompt = {
		systemPrompt: "prompt",
		systemPromptHash: "prompt",
		tokenEstimate: 1,
		sections: [],
		fragmentManifest: [],
	};
	const context = createTurnContext({
		state: createTurnState("off"),
		getSettings: () => DEFAULT_SETTINGS,
		providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
		middleware: {} as TurnMiddleware,
		prompts: {
			inputEpoch: () => "0",
			compileSessionPrompt: async (input) => {
				captured = input.sessionInputs;
				return compiled;
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

describe("the operator's local date reaches the model (WTF-P 0.8.3 A4)", () => {
	let env: IsolatedClioEnv;
	const zone = process.env.TZ;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-local-date-");
		// The day after the operator's UTC date here, so a UTC-derived date would be caught.
		process.env.TZ = "Pacific/Kiritimati";
	});
	afterEach(() => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
		env.restore();
	});

	it("renders the local date and zone in the compiled system prompt", async () => {
		const inputs = await sessionInputs();
		const today = operatorCalendar();
		strictEqual(inputs?.localDate?.date, today.date);
		ok(inputs?.localDate?.zone.startsWith("Pacific/Kiritimati (UTC+14:00)"), inputs?.localDate?.zone);
		const prompt = compile(loadFragments(), {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: inputs ?? { coordinatorCapabilities: [] },
		}).systemPrompt;
		ok(prompt.includes(`Operator's local date: ${today.date} (${today.weekday}), time zone Pacific/Kiritimati`), prompt);
	});

	it("states the local time at each turn start and once more when the date changes mid-turn", () => {
		let now = Date.parse("2026-11-16T09:58:00Z"); // 23:58 on 2026-11-16 in Kiritimati
		const clock = createLocalClockReminderRegistration({ now: () => now });
		const turnStart = clock.evaluate({ hook: "turn_start" } as MiddlewareHookInput);
		deepStrictEqual(turnStart, [
			{
				kind: "inject_reminder",
				severity: "info",
				message: "[Clock] Operator's local time: 2026-11-16 (Monday) 23:58, Pacific/Kiritimati (UTC+14:00).",
			},
		]);
		const afterTool = { hook: "after_tool", toolName: "bash" } as MiddlewareHookInput;
		deepStrictEqual(clock.evaluate(afterTool), []);
		now += 5 * 60_000;
		const changed = clock.evaluate(afterTool);
		ok(
			changed[0]?.kind === "annotate_tool_result" && changed[0].message.includes("2026-11-17 (Tuesday) 00:03"),
			JSON.stringify(changed),
		);
		deepStrictEqual(clock.evaluate(afterTool), []);
	});
});
