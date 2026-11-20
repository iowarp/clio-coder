import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { renderTokenSources } from "../../src/cli/telemetry-tokens.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SurfaceId } from "../../src/core/side-surfaces.js";
import { withTelemetryContext } from "../../src/core/telemetry/context.js";
import type { AgentRole } from "../../src/core/telemetry/enums.js";
import { makeTelemetryRecord, type TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { CallSettled, CallStarted } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SafetyJudgementInput } from "../../src/domains/safety/decision-events.js";
import { safetyJudgedPayload } from "../../src/domains/safety/decision-events.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { compact } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { loadTokenSourcesReport } from "../../src/domains/session/token-sources.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { CallJournalOptions } from "../../src/domains/telemetry/call-scope.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetryRunDirectory, telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { foldSideSurfaces } from "../../src/domains/telemetry/read-model.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createSafetyJudgeHost } from "../../src/entry/safety-judge-host.js";
import { createSideRequestAdmission, withSidePurpose } from "../../src/entry/side-request-admission.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";
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
		// in turn 1; the turn they were journaled under, the prompt's reserved id, puts them in turn 2.
		const compaction = [
			telemetryCall(sessionId, {
				role: "compaction",
				at: at(4),
				turnId: "u2",
				usage: { input: 3, cacheWrite: 13874, output: 1351 },
			}),
			telemetryCall(sessionId, {
				role: "compaction",
				at: at(5),
				turnId: "u2",
				usage: { input: 3, cacheWrite: 1201, output: 424 },
			}),
		];
		const callIds = compaction.map((records) => (records[0]?.k === "call.started" ? records[0].data.callId : ""));
		// CTX-15: a /compact between turns is journaled under the turn before it, and a discarded compaction ahead of a prompt
		// under that prompt's turn; ledger order would charge the first to turn 3 and time the second to turn 2.
		const manual = telemetryCall(sessionId, {
			role: "compaction",
			at: at(10),
			turnId: "u2",
			usage: { input: 5, output: 100 },
		});
		const discarded = telemetryCall(sessionId, {
			role: "compaction",
			at: at(12),
			turnId: "u3",
			usage: { input: 7, output: 200 },
		});
		const manualId = manual[0]?.k === "call.started" ? manual[0].data.callId : "";
		const header = scanTelemetrySegment(goldenSessionJournal(sessionId)).rows.find((row) => row.kind === "header");
		ok(header?.kind === "header");
		const journalDirectory = telemetrySessionDirectory(clioStateDir(), sessionId);
		mkdirSync(journalDirectory, { recursive: true });
		writeFileSync(
			join(journalDirectory, "journal.jsonl"),
			Buffer.concat([header.header, ...memory, ...compaction.flat(), ...manual, ...discarded].map(encodeTelemetryLine)),
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
			{
				kind: "compactionSummary",
				callIds: [manualId],
				trigger: "force",
				turnId: "c2",
				parentTurnId: "a2",
				timestamp: at(11),
				summary: "more work",
				tokensBefore: 30000,
				firstKeptTurnId: "a2",
			},
			user("u3", 13),
			assistant("a3", 14),
		];
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", sessionId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const report = loadTokenSourcesReport(clioStateDir(), sessionId);
		ok(report, "the session ledger loads");
		const [first, second, third] = report.turns;
		const roles = (turn: typeof first) => turn?.roles.map((role) => `${role.role}:${role.calls}:${role.output}`);
		strictEqual(roles(first)?.join(","), "main:1:20,memory:1:50", JSON.stringify(first));
		strictEqual(roles(second)?.join(","), "main:1:20,compaction:3:1875", JSON.stringify(second));
		strictEqual(roles(third)?.join(","), "main:1:20,compaction:1:200", JSON.stringify(third));
		strictEqual(second?.input.total, 400 + 3 + 13874 + 3 + 1201 + 5);
		strictEqual(third?.input.total, 400 + 7);
		strictEqual(second?.rows.find((row) => row.source === "role:compaction")?.label, "compaction calls");
		strictEqual(report.totals.calls, 8);
		strictEqual(report.totals.output, 20 + 50 + 20 + 1775 + 100 + 20 + 200);
		ok(
			renderTokenSources(report, false).includes("4 (1 without split, compaction 3)"),
			renderTokenSources(report, false),
		);
		ok(renderTokenSources(report, true).includes("output 1895 (compaction 1875)"), renderTokenSources(report, true));
	} finally {
		env.restore();
	}
});

it("charges a dispatched worker's calls from its linked run journal to the turn they ran in, and heads the table with cache read and prompt (CLI-7)", async () => {
	const env = await isolateClioEnv("clio-coder-token-sources-worker-");
	try {
		const sessionId = "token-sources-worker";
		const runId = "token-sources-run";
		const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
		const [first] = telemetryCall(sessionId, { at: at(3) });
		ok(first);
		const worker = telemetryCall(sessionId, {
			role: "worker",
			at: at(3),
			usage: { input: 700, cacheRead: 300, output: 60 },
		}).map(
			(record) => ({ ...record, ctx: { ...record.ctx, runId, agent: { role: "worker", id: runId } } }) as TelemetryRecord,
		);
		const linked = makeTelemetryRecord("run.linked", { runId }, first.ctx, { t: at(3), mono: 0 });
		const header = scanTelemetrySegment(goldenSessionJournal(sessionId)).rows.find((row) => row.kind === "header");
		ok(header?.kind === "header");
		for (const [directory, records] of [
			[telemetrySessionDirectory(clioStateDir(), sessionId), [linked]],
			[telemetryRunDirectory(clioStateDir(), runId), worker],
		] as const) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "journal.jsonl"), Buffer.concat([header.header, ...records].map(encodeTelemetryLine)));
		}
		const message = (turnId: string, second: number, role: string, payload: Record<string, unknown>) => ({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: at(second),
			role,
			payload,
		});
		const assistant = (turnId: string, second: number) =>
			message(turnId, second, "assistant", {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { input: 100, cacheRead: 900, output: 20 },
			});
		const lines = [
			{ type: "session", version: 6, id: sessionId, timestamp: at(0), cwd: env.dir },
			message("u1", 1, "user", { text: "dispatch it" }),
			assistant("a1", 2),
			message("u2", 5, "user", { text: "again" }),
			assistant("a2", 6),
		];
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", sessionId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const report = loadTokenSourcesReport(clioStateDir(), sessionId);
		ok(report, "the session ledger loads");
		const roles = report.turns.map((turn) => turn.roles.map((role) => `${role.role}:${role.calls}:${role.output}`));
		strictEqual(roles.join(" / "), "main:1:20,worker:1:60 / main:1:20", JSON.stringify(report.turns));
		const row = report.turns[0]?.rows.find((item) => item.source === "role:worker");
		strictEqual(`${row?.label}:${row?.cached}:${row?.fresh}:${row?.total}`, "worker calls:300:700:1000");
		strictEqual(report.totals.calls, 3);
		strictEqual(report.totals.input.total, 1000 + 1000 + 1000);
		const text = renderTokenSources(report, false);
		ok(text.includes("2 (worker 1)"), text);
		ok(
			text.split("\n").some((line) => /^turn\s+at\s+calls\s+cache read\s+fresh\s+prompt\s+output$/u.test(line.trim())),
			text,
		);
		ok(/source\s+cache read\s+fresh\s+total/u.test(renderTokenSources(report, true)), renderTokenSources(report, true));
	} finally {
		env.restore();
	}
});

it("names every side producer by purpose: one row per purpose under its role, unknown never-sent and unsettled usage, an unpurposed residual, and the judge's own call beside its parent (memory MD1)", async () => {
	const env = await isolateClioEnv("clio-coder-token-sources-purpose-");
	const started: CallStarted[] = [];
	const unsubscribe = telemetryHub().subscribe("call.started", (payload) => {
		started.push(payload);
	});
	try {
		const sessionId = "token-sources-purpose";
		const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
		const call = (
			role: AgentRole,
			purpose: SurfaceId | undefined,
			usage: { input: number | null; output: number | null },
			disposition?: CallSettled["disposition"],
		) =>
			telemetryCall(sessionId, { role, at: at(3), usage, ...(disposition ? { disposition } : {}) }).map((record) =>
				purpose !== undefined && (record.k === "call.started" || record.k === "call.settled")
					? ({ ...record, data: { ...record.data, purpose } } as TelemetryRecord)
					: record,
			);
		// One known invocation per producer this slice names, as each journals it.
		const producers: Array<[AgentRole, SurfaceId]> = [
			["memory", "memory.observe"],
			["memory", "memory.reflect"],
			["memory", "memory.bank"],
			["memory", "memory.correct"],
			["memory", "memory.lesson"],
			["memory", "memory.retain"],
			["memory", "memory.history"],
			["memory", "memory.classify"],
			["compaction", "compaction.history"],
			["compaction", "compaction.split"],
			["compaction", "compaction.live"],
			["compaction", "compaction.native"],
			["safety-judge", "judge"],
			["system-one", "judge.screen"],
		];
		const records = [
			...producers.flatMap(([role, purpose], index) => call(role, purpose, { input: 100 + index, output: 10 })),
			...call("memory", "memory.bank", { input: null, output: null }, "never_sent"),
			...call("memory", "memory.correct", { input: null, output: null }, "sent_unsettled"),
			...call("helper", undefined, { input: 7, output: 1 }),
		];

		const fold = foldSideSurfaces(records);
		const surface = (id: SurfaceId) => fold.surfaces.find((row) => row.surface === id);
		for (const [role, purpose] of producers) {
			strictEqual(`${surface(purpose)?.role}:${surface(purpose)?.status}`, `${role}:exercised`, purpose);
			strictEqual(surface(purpose)?.totals.usage.input.measured, 100 + producers.findIndex(([, id]) => id === purpose));
		}
		strictEqual(surface("triage")?.status, "unexercised", "a surface that made no call is never a pass");
		const bank = surface("memory.bank")?.totals;
		strictEqual(`${bank?.logicalCalls}/${bank?.neverSent}/${surface("memory.bank")?.exercised}`, "2/1/1");
		// A never-sent sibling is unknown with its reason, never zero or not applicable.
		strictEqual(surface("memory.bank")?.unknownUsage["never-sent"], 1, JSON.stringify(surface("memory.bank")));
		strictEqual(`${bank?.usage.output.unknownCount}/${bank?.usage.output.absentCount}`, "1/0");
		const correct = surface("memory.correct")?.totals;
		strictEqual(correct?.sentUnsettled, 1);
		strictEqual(surface("memory.correct")?.unknownUsage["sent-unsettled"], 1);
		ok((correct?.usage.output.unknownCount ?? 0) > 0, "a sent-unsettled sibling stays unknown, never zero");
		// The fixture's one unpurposed call stands for the triage side round, which MD2 owns; nothing else is residual.
		strictEqual(
			fold.residual.map(({ role, totals }) => `${role}:${totals.logicalCalls}`).join(","),
			"helper:1",
			"only the call that named no purpose is residual",
		);
		// Native compaction exists only on the Codex route: elsewhere it is unsupported, not merely unexercised.
		const status = (runtimeId: string | undefined, id: SurfaceId) =>
			foldSideSurfaces([], runtimeId === undefined ? undefined : { runtimeId }).surfaces.find((row) => row.surface === id)
				?.status;
		strictEqual(status("anthropic", "compaction.native"), "unsupported");
		strictEqual(status("openai-codex", "compaction.native"), "unexercised");
		strictEqual(status("anthropic", "compaction.history"), "unexercised");
		strictEqual(status(undefined, "compaction.native"), "unexercised", "no route named, no capability claimed");

		const header = scanTelemetrySegment(goldenSessionJournal(sessionId)).rows.find((row) => row.kind === "header");
		ok(header?.kind === "header");
		const journalDirectory = telemetrySessionDirectory(clioStateDir(), sessionId);
		mkdirSync(journalDirectory, { recursive: true });
		writeFileSync(
			join(journalDirectory, "journal.jsonl"),
			Buffer.concat([header.header, ...records].map(encodeTelemetryLine)),
		);
		const message = (turnId: string, second: number, role: string, payload: Record<string, unknown>) => ({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: at(second),
			role,
			payload,
		});
		const lines = [
			{ type: "session", version: 6, id: sessionId, timestamp: at(0), cwd: env.dir },
			message("u1", 1, "user", { text: "go" }),
			message("a1", 2, "assistant", {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { input: 400, output: 20 },
			}),
		];
		const directory = join(clioStateDir(), "sessions", "token-sources-repo", sessionId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const report = loadTokenSourcesReport(clioStateDir(), sessionId);
		ok(report, "the session ledger loads");
		const [turn] = report.turns;
		const row = turn?.rows.find((item) => item.source === "role:memory/memory.bank");
		strictEqual(`${row?.label}:${row?.total}`, "memory calls (memory.bank):102", JSON.stringify(turn?.rows));
		ok(turn?.rows.some((item) => item.source === "role:safety-judge/judge"));
		ok(
			turn?.rows.some((item) => item.source === "role:helper"),
			"an unpurposed call keeps its role's row",
		);
		ok(!turn?.rows.some((item) => item.source === "role:memory"), "every memory call named its purpose");
		// The split is by purpose inside a role; the role's own tally is unchanged.
		const memory = turn?.roles.find((role) => role.role === "memory");
		strictEqual(`${memory?.calls}/${memory?.unmeasuredCalls}`, "8/1");
		const memoryRows = turn?.rows.filter((item) => item.source.startsWith("role:memory/")) ?? [];
		strictEqual(
			memoryRows.reduce((sum, item) => sum + item.total, 0),
			memory?.input.total,
		);
		ok(renderTokenSources(report, true).includes("memory calls (memory.observe)"), renderTokenSources(report, true));

		// The judge's own call joins its tokens; the parent it judged for stands beside it, and the screen names its own.
		const admit = (role: "safety-judge" | "system-one") =>
			createSideRequestAdmission({
				providers: { getTarget: () => ({ id: "judge-target", runtime: "fixture" }) as never },
				scheduling: { admitPaidRequest: async () => {} } as unknown as SchedulingContract,
				getCeilingUsd: () => 0,
				currentSession: () => sessionId,
				repoIdentity: () => "token-sources-repo",
				telemetry: {
					acquireTelemetrySession: async () => ({
						journaled: true,
						context: { sessionId, agent: { role, id: sessionId } },
						release: async () => {},
					}),
				} as unknown as TelemetryContract,
				role,
			});
		const signal = new AbortController().signal;
		const parent = { callId: newCallId(), attemptId: newAttemptId() };
		// The screen's System One ask names its surface through the host's wrapper.
		(await withSidePurpose("judge.screen", () => admit("system-one")({ targetId: "judge-target", model: "m", signal })))(
			null,
		);
		// The real judge host: its review captures the judge call the completion opens, and its decision row names it.
		const judged: Array<ReturnType<typeof safetyJudgedPayload>> = [];
		const ledger: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: at(1),
				role: "user",
				payload: { text: "Push main to origin." },
			} as SessionEntry,
		];
		const seat = createSafetyJudgeHost({
			settings: () =>
				({ ...DEFAULT_SETTINGS, chat: { ...DEFAULT_SETTINGS.chat, target: "judge-target", model: "m" } }) as ClioSettings,
			complete: async (request) => {
				(await admit("safety-judge")({ targetId: request.targetId, model: request.model ?? "m", signal }))(null);
				return { text: JSON.stringify({ verdict: "allow", rule: "operator-named", reason: "Asked for." }) };
			},
			session: () =>
				({
					current: () => ({ id: sessionId }),
					readEntries: () => ledger,
					leafId: () => "u1",
					appendEntry: (input: unknown) => input,
				}) as unknown as SessionContract,
			safety: {
				decisions: { recordSafetyJudge: (input: SafetyJudgementInput) => judged.push(safetyJudgedPayload(input)) },
			} as never,
		});
		await withTelemetryContext({ sessionId, agent: { role: "main", id: sessionId }, ...parent }, () =>
			seat.review({
				tool: ToolNames.Bash,
				args: { command: "git push origin main" },
				decision: {
					kind: "ask",
					classification: { actionClass: "execute", reasons: [] },
					confirmationRuleId: "bash-unrecognized",
					rejection: { short: "asks", detail: "asks", hints: [] },
				},
				approvalAuthority: "operator",
				turnId: "u1",
			}),
		);
		const judgeCall = started.find((item) => item.purpose === "judge");
		ok(judgeCall, JSON.stringify(started));
		ok(
			started.some((item) => item.purpose === "judge.screen"),
			JSON.stringify(started),
		);
		strictEqual(judged.length, 1, JSON.stringify(judged));
		strictEqual(judged[0]?.verdict, "allow");
		strictEqual(judged[0]?.judgeCallId, judgeCall.callId);
		strictEqual(judged[0]?.parentCallId, parent.callId);

		// A real producer names its own purpose: the history summary of a compaction opens its call scope as such.
		const faux = registerEngineFauxProvider({
			api: "token-sources-compaction",
			models: [{ id: "summary" }],
			tokensPerSecond: 0,
		});
		try {
			faux.setResponses([
				(_context, _options, _state, resolved) => ({
					role: "assistant",
					content: [{ type: "text", text: syntheticCompactionSummary("Push main to origin") }],
					api: resolved.api,
					provider: resolved.provider,
					model: resolved.id,
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			]);
			const summaryModel = faux.getModel("summary");
			ok(summaryModel);
			const entry = (turnId: string, role: "user" | "assistant", payload: unknown, parentTurnId: string | null) =>
				({ kind: "message", turnId, parentTurnId, timestamp: at(1), role, payload }) as SessionEntry;
			const before = started.length;
			const result = await compact({
				entries: [
					entry("u1", "user", { text: "Push main to origin and report the result." }, null),
					entry("a1", "assistant", { content: [{ type: "text", text: "Pushed main. ".repeat(40) }] }, "u1"),
					entry("u2", "user", { text: "Now tag it." }, "a1"),
				],
				model: { ...summaryModel, contextWindow: 32768, maxTokens: 4096 },
				keepRecentTokens: 10,
				cwd: env.dir,
				telemetry: {
					origin: { id: sessionId, cwdHash: "token-sources-repo" },
					acquire: async () => ({
						journaled: true,
						context: { sessionId, agent: { role: "compaction", id: sessionId } },
						release: async () => {},
					}),
					role: "compaction",
					targetId: "fixture",
					runtimeId: "fixture",
					pricedBy: "catalog",
				} as unknown as CallJournalOptions,
			});
			ok(result.summary.length > 0);
			strictEqual(
				started
					.slice(before)
					.map((item) => item.purpose)
					.join(","),
				"compaction.history",
			);
		} finally {
			faux.unregister();
		}
	} finally {
		unsubscribe();
		env.restore();
	}
});
