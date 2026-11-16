import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { renderTokenSources } from "../../src/cli/telemetry-tokens.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { loadTokenSourcesReport } from "../../src/domains/session/token-sources.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SESSION_ID = "token-sources-session";

it("a recorded faux session splits each turn's input by source, summing to the call totals with cached and fresh apart (WTF-P 0.8.3 C2)", async () => {
	const env = await isolateClioEnv("clio-coder-token-sources-");
	const faux = registerEngineFauxProvider({
		api: "token-sources-fixture",
		models: [{ id: "chat" }],
		tokensPerSecond: 0,
	});
	// The faux provider reports usage from the prompt it was sent, with a simulated prefix cache, whatever a reply declares.
	const reply = (text: string) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: faux.api,
		provider: "fixture",
		model: "chat",
		stopReason: "stop" as const,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	faux.setResponses([reply("first answer ".repeat(40)), reply("second answer")]);
	const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
	} as unknown as RuntimeDescriptor;
	const target = {
		id: "chat-target",
		runtime: "fixture",
		url: "https://chat.invalid/v1",
		defaultModel: "chat",
		capabilities: { contextWindow: 131072 },
	};
	const providers = {
		list: () => [
			{ target, runtime, available: true, capabilities, discoveredModels: ["chat"], discoveredModelsSource: "probe" },
		],
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
	} as unknown as ProvidersContract;
	const entries: SessionEntry[] = [];
	const session = {
		current: () => ({ id: SESSION_ID, cwd: env.dir, cwdHash: "token-sources-repo" }),
		tree: () => ({ leafId: entries.at(-1)?.turnId ?? null }),
		leafId: () => entries.at(-1)?.turnId ?? null,
		append(turn: TurnInput) {
			const id = `turn-${entries.length + 1}`;
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: new Date().toISOString(),
				role: turn.kind,
				payload: turn.payload,
			} as SessionEntry);
			return { id };
		},
		appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
			const row = { ...entry, turnId: `entry-${entries.length + 1}`, timestamp: new Date().toISOString() };
			entries.push(row as SessionEntry);
			return row;
		},
	} as unknown as SessionContract;
	const journals = createSessionJournals(clioStateDir(), () => {
		throw new Error("fixture journal unavailable");
	});
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = target.id;
	settings.chat.model = "chat";
	settings.chat.thinkingLevel = "off";
	settings.chat.prewarm = false;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		session,
		readSessionEntries: () => entries,
		middleware: {
			registerHook: () => {},
			runHook: (input: MiddlewareHookInput) => ({
				effects:
					input.hook === "turn_end"
						? [{ kind: "inject_reminder", message: "Extension reminder: cite the section.", audience: "model" }]
						: [],
				ruleIds: [],
			}),
		} as unknown as MiddlewareContract,
		knownTargets: () => new Set([target.id]),
		createAgent: (options) => createEngineAgent(options),
		telemetry: { acquireTelemetrySession: journals.acquire } as unknown as TelemetryContract,
		prompts: {
			inputEpoch: () => 0,
			compileSessionPrompt: async () => ({
				systemPrompt: `fixture prompt ${"policy ".repeat(200)}`,
				systemPromptHash: "fixture",
				tokenEstimate: 350,
				sections: [{ id: "identity", tokenEstimate: 350, contentHash: "identity" }],
				fragmentManifest: [],
			}),
		} as unknown as PromptsContract,
	});
	try {
		await loop.submit("summarize the outline");
		await loop.submit("now draft the introduction");
		await journals.flush();
		const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), SESSION_ID));
		const calls = journal.records.flatMap(({ record }) => (record.k === "call.settled" ? [record.data] : []));
		strictEqual(calls.length, 2, JSON.stringify(journal.records.map(({ record }) => record.k)));

		// The ledger as a session store holds it on disk: a header line, then the entries in append order.
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", SESSION_ID);
		mkdirSync(directory, { recursive: true });
		const header = { type: "session", version: 6, id: SESSION_ID, timestamp: new Date().toISOString(), cwd: env.dir };
		writeFileSync(
			join(directory, "current.jsonl"),
			`${[header, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`,
		);

		const report = loadTokenSourcesReport(clioStateDir(), SESSION_ID);
		ok(report, "the session ledger loads");
		strictEqual(report.basis.split, "estimated");
		strictEqual(report.basis.usage, "journal");
		strictEqual(report.turns.length, 2, JSON.stringify(report.turns));
		const measured = (fact: { kind: string; value?: unknown } | undefined) =>
			fact?.kind === "measured" ? Number(fact.value) : Number.NaN;
		for (const [index, turn] of report.turns.entries()) {
			const call = calls[index] as CallSettled;
			const input = measured(call.usage?.input);
			const cacheRead = measured(call.usage?.cacheRead);
			const cacheWrite = measured(call.usage?.cacheWrite);
			strictEqual(turn.calls, 1);
			strictEqual(turn.input.total, input + cacheRead + cacheWrite, `turn ${turn.index} total is the call's input`);
			strictEqual(turn.input.cached, cacheRead, `turn ${turn.index} cached is the call's cache read`);
			strictEqual(turn.input.fresh, input + cacheWrite, `turn ${turn.index} fresh is input plus cache write`);
			const sum = (pick: (row: (typeof turn.rows)[number]) => number | null) =>
				turn.rows.reduce((total, row) => total + (pick(row) ?? Number.NaN), 0);
			strictEqual(
				sum((row) => row.total),
				turn.input.total,
				JSON.stringify(turn.rows),
			);
			strictEqual(
				sum((row) => row.cached),
				turn.input.cached,
			);
			strictEqual(
				sum((row) => row.fresh),
				turn.input.fresh,
			);
			for (const row of turn.rows) strictEqual((row.cached ?? 0) + (row.fresh ?? 0), row.total, row.source);
			ok(
				turn.rows.some((row) => row.source === "system-prompt"),
				JSON.stringify(turn.rows),
			);
			ok(
				turn.rows.some((row) => row.source === "history"),
				JSON.stringify(turn.rows),
			);
		}
		strictEqual(report.turns[0]?.output, measured(calls[0]?.usage?.output));
		// The second request carries the first exchange; the prefix the provider read from cache covers the system side
		// first, and the extension's turn_end reminder rides the second user message as its own source.
		const second = report.turns[1];
		const system = second?.rows.find((row) => row.source === "system-prompt");
		ok(system && system.fresh === 0 && (system.cached ?? 0) > 0, JSON.stringify(second?.rows));
		ok(
			second?.rows.some((row) => row.source === "reminders" && row.total > 0),
			JSON.stringify(second?.rows),
		);
		const callTotal = (call: CallSettled | undefined) =>
			measured(call?.usage?.input) + measured(call?.usage?.cacheRead) + measured(call?.usage?.cacheWrite);
		strictEqual(report.totals.input.total, callTotal(calls[0]) + callTotal(calls[1]));
		strictEqual(report.totals.input.cached, measured(calls[0]?.usage?.cacheRead) + measured(calls[1]?.usage?.cacheRead));

		const text = renderTokenSources(report, true);
		ok(text.includes("the split by source is estimated"), text);
		ok(text.includes("turn 2"), text);
		ok(text.includes("system prompt"), text);
	} finally {
		loop.dispose();
		faux.unregister();
		await journals.flush();
		env.restore();
	}
});
