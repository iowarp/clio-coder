/**
 * The operator-facing half of a dispatched run: what `/run` and `/delegate` put
 * in the transcript, and what they deliberately keep out of the model's context.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

interface Recorder {
	ctx: SlashCommandContext;
	echoed: string[];
	submitted: string[];
	notices: string[];
	requests: unknown[];
	settled: Promise<void>;
}

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "r1",
		agentId: "coder",
		outcome: "succeeded",
		exitCode: 0,
		output: { text: "Hello! I'm the coder worker." },
		...overrides,
	} as unknown as RunReceipt;
}

function recorder(options: { receipt?: RunReceipt } = {}): Recorder {
	const echoed: string[] = [];
	const submitted: string[] = [];
	const notices: string[] = [];
	const requests: unknown[] = [];
	let settle: () => void = () => {};
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (request: unknown) => {
			requests.push(request);
			return {
				runId: "r1",
				// eslint-disable-next-line require-yield
				events: (async function* () {})(),
				finalPromise: Promise.resolve(options.receipt ?? receipt()).finally(() => queueMicrotask(settle)),
			};
		},
	} as unknown as DispatchContract;

	const ctx: SlashCommandContext = {
		io: { stdout: () => undefined, stderr: () => undefined },
		notice: (level, text) => notices.push(`${level}:${text}`),
		dispatch,
		bus: createSafeEventBus(),
		echoOperatorCommand: (text) => echoed.push(text),
		shutdown: () => undefined,
		runInit: () => undefined,
		runContextClear: () => undefined,
		listPrompts: () => ({ items: [], diagnostics: [] }),
		listExtensions: () => [],
		listAgents: () => [],
		listDelegationAgents: () => [],
		openCost: () => undefined,
		openContextView: () => undefined,
		openTasks: () => undefined,
		openMemory: () => undefined,
		openView: () => undefined,
		openModel: () => undefined,
		providers: {} as ProvidersContract,
		applyModelRef: () => undefined,
		openSettings: () => undefined,
		openResume: () => undefined,
		startNewSession: () => undefined,
		openTree: () => undefined,
		openMessagePicker: () => undefined,
		openHelp: () => undefined,
		openAgents: () => undefined,
		openPrompts: () => undefined,
		openExtensions: () => undefined,
		runCompact: () => undefined,
		exportTranscript: () => undefined,
		verifyReceipt: () => ({ ok: false, reason: "missing" }),
		submitChat: (text) => submitted.push(text),
		render: () => undefined,
	};
	return { ctx, echoed, submitted, notices, requests, settled };
}

describe("contracts/worker run commands", () => {
	it("echoes the typed line above the block the run draws", async () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run coder say hello"), r.ctx);
		await r.settled;
		deepStrictEqual(r.echoed, ["/run coder say hello"]);
	});

	it("echoes the whole line, flags included, for /run and /delegate alike", async () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run --target mini coder say hello"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/delegate codex refactor the header"), r.ctx);
		await r.settled;
		deepStrictEqual(r.echoed, ["/run --target mini coder say hello", "/delegate codex refactor the header"]);
	});

	it("never echoes a command that did not run", () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/delegate"), r.ctx);
		deepStrictEqual(r.echoed, []);
		ok(
			r.notices.every((notice) => notice.startsWith("info:")),
			`usage notices only:\n${r.notices.join("\n")}`,
		);
	});

	it("keeps a successful run out of the notice bar and out of the model's context", async () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run coder say hello"), r.ctx);
		await r.settled;
		deepStrictEqual(r.notices, [], "the transcript block is the success signal");
		deepStrictEqual(r.submitted, [], "a worker answer never reaches the model on its own");
		strictEqual((r.requests[0] as { requestOrigin?: string }).requestOrigin, "user");
	});
});
