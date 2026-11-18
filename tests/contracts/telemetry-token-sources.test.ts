import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { renderTokenSources } from "../../src/cli/telemetry-tokens.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
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
import { goldenSessionJournal, telemetryCall } from "../harness/telemetry-view.js";

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

it("the default tokens table counts unmeasured calls and prints a span with no measured call as unknown (Astra r5-1)", () => {
	const input = { cached: 0, fresh: 0, total: 0 };
	const turn = (index: number, calls: number, unmeasuredCalls: number, total: number) => ({
		index,
		turnId: `t${index}`,
		at: `2026-01-01T00:00:0${index}Z`,
		calls,
		unmeasuredCalls,
		input: { cached: 0, fresh: total, total },
		output: calls > 0 ? 5 : 0,
		coldReasons: [],
		rows: [],
		roles: [],
	});
	const text = renderTokenSources(
		{
			version: 1,
			sessionId: "s",
			basis: { usage: "ledger", systemSide: "residual", split: "estimated", note: "n", freshIsCacheWriteCalls: 0 },
			turns: [turn(1, 0, 1, 0), turn(2, 2, 1, 40)],
			totals: { calls: 2, unmeasuredCalls: 2, input: { ...input, fresh: 40, total: 40 }, output: 5, rows: [], roles: [] },
		},
		false,
	);
	const cells = (label: string) =>
		text
			.split("\n")
			.find((line) => line.trimStart().startsWith(label))
			?.trim()
			.split(/\s{2,}/u);
	strictEqual(cells("1 ")?.slice(2).join("|"), "1 (1 unmeasured)|unknown|unknown|unknown|unknown", text);
	strictEqual(cells("2 ")?.slice(2).join("|"), "3 (1 unmeasured)|0|40|40|5", text);
	strictEqual(cells("all")?.slice(1).join("|"), "4 (2 unmeasured)|0|40|40|5", text);
});

it("names the copilot-sdk calls whose fresh input is their cache write (bt-12 #12)", async () => {
	const env = await isolateClioEnv("clio-coder-token-sources-sdk-");
	try {
		const sessionId = "token-sources-sdk";
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", sessionId);
		mkdirSync(directory, { recursive: true });
		const at = new Date().toISOString();
		const assistant = (turnId: string, api: string, usage: Record<string, number>) => ({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: at,
			role: "assistant",
			payload: { role: "assistant", api, content: [{ type: "text", text: "ok" }], usage },
		});
		const lines = [
			{ type: "session", version: 6, id: sessionId, timestamp: at, cwd: env.dir },
			{ kind: "message", turnId: "u1", parentTurnId: null, timestamp: at, role: "user", payload: { text: "hi" } },
			assistant("a1", "copilot-sdk", { input: 3, cacheRead: 9000, cacheWrite: 1200, output: 40 }),
			assistant("a2", "anthropic-messages", { input: 50, cacheRead: 9000, cacheWrite: 0, output: 40 }),
		];
		writeFileSync(join(directory, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const report = loadTokenSourcesReport(clioStateDir(), sessionId);
		ok(report, "the session ledger loads");
		strictEqual(report.totals.calls, 2, JSON.stringify(report.turns));
		strictEqual(report.basis.freshIsCacheWriteCalls, 1);
		strictEqual(report.totals.input.fresh, 3 + 1200 + 50, "fresh keeps its definition, uncached plus cache write");
		ok(
			renderTokenSources(report, false).includes(
				"note: 1 of 2 measured call(s) ran on copilot-sdk, which reports no uncached input; their fresh is cache write",
			),
			renderTokenSources(report, false),
		);
	} finally {
		env.restore();
	}
});

it("a call with no cache-read count keeps the session's cached and fresh over the calls that split, and is named (bt-42)", async () => {
	const env = await isolateClioEnv("clio-coder-token-sources-unsplit-");
	try {
		const sessionId = "token-sources-unsplit";
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", sessionId);
		mkdirSync(directory, { recursive: true });
		const at = new Date().toISOString();
		const message = (turnId: string, role: string, payload: Record<string, unknown>) => ({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: at,
			role,
			payload,
		});
		const assistant = (turnId: string, usage: Record<string, number>) =>
			message(turnId, "assistant", { role: "assistant", content: [{ type: "text", text: "ok" }], usage });
		const lines = [
			{ type: "session", version: 6, id: sessionId, timestamp: at, cwd: env.dir },
			message("u1", "user", { text: "hi" }),
			assistant("a1", { input: 100, cacheRead: 900, cacheWrite: 0, output: 10 }),
			message("u2", "user", { text: "again" }),
			assistant("a2", { input: 500, output: 20 }),
		];
		writeFileSync(join(directory, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const report = loadTokenSourcesReport(clioStateDir(), sessionId);
		ok(report, "the session ledger loads");
		const { cached, fresh, total, unsplitCalls } = report.totals.input;
		strictEqual(`${cached}/${fresh}/${total}/${unsplitCalls}`, "900/100/1500/1", JSON.stringify(report.totals));
		strictEqual(report.turns[0]?.input.unsplitCalls, undefined, "a span whose calls all split names none");
		strictEqual(report.turns[1]?.input.cached, null, "a span no call split stays unknown, never an invented zero");
		ok(renderTokenSources(report, false).includes("2 (1 without split)"), renderTokenSources(report, false));
	} finally {
		env.restore();
	}
});

it("charges compaction and memory calls to the turn they ran in, by role, inside its totals (bt-12 #10)", async () => {
	const env = await isolateClioEnv("clio-coder-token-sources-side-");
	try {
		const sessionId = "token-sources-side";
		const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
		const memory = telemetryCall(sessionId, { role: "memory", at: at(3), usage: { input: 900, output: 50 } });
		// The checkpoint's calls run before the prompt they make room for is written, so by time alone they would land
		// in turn 1; the ledger's call ids put them in turn 2.
		const compaction = [
			telemetryCall(sessionId, { role: "compaction", at: at(4), usage: { input: 3, cacheWrite: 13874, output: 1351 } }),
			telemetryCall(sessionId, { role: "compaction", at: at(5), usage: { input: 3, cacheWrite: 1201, output: 424 } }),
		];
		const callIds = compaction.map((records) => (records[0]?.k === "call.started" ? records[0].data.callId : ""));
		const header = scanTelemetrySegment(goldenSessionJournal(sessionId)).rows.find((row) => row.kind === "header");
		ok(header?.kind === "header");
		const journalDirectory = telemetrySessionDirectory(clioStateDir(), sessionId);
		mkdirSync(journalDirectory, { recursive: true });
		writeFileSync(
			join(journalDirectory, "journal.jsonl"),
			Buffer.concat([header.header, ...memory, ...compaction.flat()].map(encodeTelemetryLine)),
		);
		const assistant = (turnId: string, second: number) => ({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: at(second),
			role: "assistant",
			payload: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 400, output: 20 } },
		});
		const user = (turnId: string, second: number) => ({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: at(second),
			role: "user",
			payload: { text: "go" },
		});
		const lines = [
			{ type: "session", version: 6, id: sessionId, timestamp: at(0), cwd: env.dir },
			user("u1", 1),
			assistant("a1", 2),
			{
				kind: "compactionSummary",
				callIds,
				turnId: "c1",
				parentTurnId: "a1",
				timestamp: at(6),
				summary: "earlier work",
				tokensBefore: 30000,
				firstKeptTurnId: "a1",
			},
			user("u2", 7),
			assistant("a2", 8),
		];
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", sessionId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const report = loadTokenSourcesReport(clioStateDir(), sessionId);
		ok(report, "the session ledger loads");
		const [first, second] = report.turns;
		const roles = (turn: typeof first) => turn?.roles.map((role) => `${role.role}:${role.calls}:${role.output}`);
		strictEqual(roles(first)?.join(","), "main:1:20,memory:1:50", JSON.stringify(first));
		strictEqual(roles(second)?.join(","), "main:1:20,compaction:2:1775", JSON.stringify(second));
		strictEqual(second?.input.total, 400 + 3 + 13874 + 3 + 1201);
		strictEqual(second?.rows.find((row) => row.source === "role:compaction")?.label, "compaction calls");
		strictEqual(report.totals.calls, 5);
		strictEqual(report.totals.output, 20 + 50 + 20 + 1775);
		ok(
			renderTokenSources(report, false).includes("3 (1 without split, compaction 2)"),
			renderTokenSources(report, false),
		);
		ok(renderTokenSources(report, true).includes("output 1795 (compaction 1775)"), renderTokenSources(report, true));
	} finally {
		env.restore();
	}
});
