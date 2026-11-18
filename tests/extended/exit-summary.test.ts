import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { makeTelemetryRecord, type TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { countVerifiedOutcomes } from "../../src/domains/evidence/verified-outcomes.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { renderExitSummary } from "../../src/interactive/exit-summary.js";
import { createExitSummaryCollector, exitSpend } from "../../src/interactive/exit-summary-collector.js";
import { createSessionFileRecorder, sessionFileOutcomeForExitCode } from "../../src/interactive/session-file.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

test("the session summary counts no failure for a call the output limit cut off (bt-39 a)", () => {
	const collector = createExitSummaryCollector({
		bus: createTelemetryHub(),
		telemetry: {
			subscribe: () => () => {},
			read: { live: () => telemetryViewOf("session-1", []), subscribe: () => () => {} },
		} as unknown as TelemetryContract,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map([["read", 2]]),
		getModel: () => null,
	});
	for (const [id, notRun] of [
		["cut", "output_limit"],
		["ran", undefined],
	] as const) {
		collector.observeChat({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} } as ChatLoopEvent);
		collector.observeChat({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "read",
			isError: true,
			result: { content: [{ type: "text", text: "failed" }] },
			...(notRun !== undefined ? { notRun } : {}),
		} as unknown as ChatLoopEvent);
	}
	deepStrictEqual(collector.snapshot()?.tools, [{ tool: "read", count: 2, failures: 1 }]);
});

test("the session summary counts what Clio answered while the operator was away (#421)", () => {
	const bus = createTelemetryHub();
	const telemetry = {
		subscribe: () => () => {},
		read: { live: () => telemetryViewOf("session-1", []), subscribe: () => () => {} },
	} as unknown as TelemetryContract;
	const collector = createExitSummaryCollector({
		bus,
		telemetry,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map(),
		getModel: () => null,
	});
	bus.emit("approval.resolved", {
		status: "denied",
		decidedBy: "unattended",
		origin: "main",
		tool: "bash",
		requestId: "apr-1",
	});
	bus.emit("approval.resolved", {
		status: "denied",
		decidedBy: "operator",
		tool: "write",
		requestId: "apr-2",
	});
	collector.observeChat({
		type: "tool_execution_end",
		toolCallId: "ask-1",
		toolName: "ask_user",
		isError: false,
		result: { content: [], details: { unattended: { afterSeconds: 300, autoResolved: 2 } } },
	} as unknown as ChatLoopEvent);
	const snapshot = collector.snapshot();
	deepStrictEqual(snapshot?.unattended, { questions: 2, permissions: 1 });
	for (const style of ["brief", "standard"] as const) {
		match(
			renderExitSummary(snapshot, style, 120, false).join("\n"),
			/Unattended: 2 questions auto-resolved · 1 permission ask timed out and denied/u,
			style,
		);
	}
	ok(snapshot);
	// The card prints the read model's own session cost display for every pricing state, never a re-rendered sum.
	const call = (usd: number | null, pricedBy?: "free" | "catalog" | "target-rates") =>
		telemetryCall("session-1", { usd, ...(pricedBy ? { pricedBy } : {}) });
	for (const calls of [[], call(null), call(0, "free"), call(0.000001), [...call(0.25, "catalog"), ...call(null)]]) {
		const view = telemetryViewOf("session-1", calls);
		const spend = exitSpend(view, "1970-01-01T00:00:00.000Z");
		ok(spend.kind === "ready");
		for (const style of ["brief", "standard", "report"] as const) {
			const text = renderExitSummary({ ...snapshot, spend }, style, 120, false).join("\n");
			ok(text.includes(view.session().totals.usd.display), `${style}: ${view.session().totals.usd.display}`);
		}
	}
	match(
		renderExitSummary({ ...snapshot, spend: { kind: "unavailable" } }, "brief", 120, false).join("\n"),
		/not available/u,
	);
	// The share divides the whole session's spend, so one worker's outcome never reads as that worker's tokens (bt-11 #3).
	const ready = exitSpend(telemetryViewOf("session-1", []), "1970-01-01T00:00:00.000Z");
	ok(ready.kind === "ready");
	const verified = { kind: "counted" as const, count: "1", parts: [], tokens: "172,879", cost: "~$0.05 est" };
	match(
		renderExitSummary({ ...snapshot, spend: { ...ready, verified } }, "standard", 160, false).join("\n"),
		/^Session verified: 1 outcome · 172,879 session tokens per outcome · ~\$0\.05 est per outcome$/mu,
	);
	// Every spend row names the session scope, so none reads as this visit's beside the visit's own counts (drv-tui11).
	for (const style of ["brief", "standard", "report"] as const) {
		const rows = renderExitSummary({ ...snapshot, spend: { ...ready, verified } }, style, 160, false);
		ok(!rows.some((row) => /^Verified:/u.test(row)), style);
		ok(
			rows.some((row) => /^Session verified: 1 outcome/u.test(row)),
			style,
		);
	}
	collector.dispose();
});

test("the activity row names its visit scope and a worker whose writes went unrecorded (bt-11)", () => {
	const bus = createTelemetryHub();
	const collector = createExitSummaryCollector({
		bus,
		telemetry: { subscribe: () => () => {} } as unknown as TelemetryContract,
		dispatch: { observedRunWrites: () => null },
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map(),
		getModel: () => null,
	});
	for (const runId of ["run-a", "run-b"]) {
		bus.emit("run.started", { runId, agentId: "coder", targetId: "local", wireModelId: "m" } as never);
		bus.emit("run.completed", { runId, agentId: "coder", outcome: "completed" } as never);
	}
	match(renderExitSummary(collector.snapshot(), "standard", 160, false).join("\n"), /^Workers: 2 completed$/mu);
	// run-b's receipt names its checkout changes, so only run-a stays unrecorded. Its refused call reaches the
	// Workers row in the collected block's words (bt-11 s).
	collector.observeRunResult("run-b", { changedPaths: [], refusedCalls: 1 } as never);
	const text = renderExitSummary(collector.snapshot(), "standard", 160, false).join("\n");
	match(
		text,
		/^This visit, workers included: 0 turns · 0 files changed \(1 worker kept no write record\) · 2 workers$/mu,
	);
	match(text, /^Workers: 2 completed · 1 call refused$/mu);
	collector.dispose();
});

test("the exit card reads a settled worker's receipt that no card handed over, as /usage's Changes does (bt-11 e)", () => {
	const bus = createTelemetryHub();
	const receipts: Record<string, { changedPaths: string[] }> = { "run-a": { changedPaths: ["textutil/slug.py"] } };
	const reads: string[] = [];
	const collector = createExitSummaryCollector({
		bus,
		telemetry: { subscribe: () => () => {} } as unknown as TelemetryContract,
		dispatch: { observedRunWrites: () => null },
		session: { current: () => ({ id: "fork-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map(),
		getModel: () => null,
		readRunResult: (runId) => {
			reads.push(runId);
			return (receipts[runId] ?? null) as never;
		},
	});
	// A /fork while the runs worked replaced their cards, so no card hands their receipts over when they settle.
	for (const runId of ["run-a", "run-b"]) {
		bus.emit("run.started", { runId, agentId: "coder", targetId: "local", wireModelId: "m" } as never);
		bus.emit("run.completed", { runId, agentId: "coder", outcome: "completed" } as never);
	}
	receipts["run-b"] = { changedPaths: [] };
	match(
		renderExitSummary(collector.snapshot(), "standard", 160, false).join("\n"),
		/^This visit, workers included: 0 turns · 1 file changed · 2 workers$/mu,
	);
	collector.snapshot();
	deepStrictEqual(reads, ["run-a", "run-b"]);
	collector.dispose();
});

test("a /resume mid-visit keeps the visit's turns, files and workers on the exit card (bt-11)", () => {
	const bus = createTelemetryHub();
	let current = { id: "session-1", hasModelTurn: true };
	let turns = 0;
	const footerTools = new Map<string, number>();
	const collector = createExitSummaryCollector({
		bus,
		telemetry: { subscribe: () => () => {} } as unknown as TelemetryContract,
		dispatch: { observedRunWrites: () => null },
		session: { current: () => current } as unknown as Pick<SessionContract, "current">,
		getTurns: () => turns,
		getToolCounts: () => footerTools,
		getModel: () => null,
	});
	turns = 3;
	footerTools.set("bash", 2);
	bus.emit("run.started", { runId: "run-a", agentId: "coder", targetId: "local", wireModelId: "m" } as never);
	bus.emit("run.completed", { runId: "run-a", agentId: "coder", outcome: "completed" } as never);
	collector.observeRunResult("run-a", {
		changedPaths: ["a.txt", "b.txt"],
		toolCounts: [
			{ tool: "read", count: 4 },
			{ tool: "verify", count: 0 },
		],
	} as never);
	// /resume parks the current session, reattaches the chosen one and adopts its transcript.
	bus.emit("session.parked", { sessionId: "session-1", reason: "resume_other", at: 0 });
	current = { id: "session-2", hasModelTurn: true };
	turns = 7;
	bus.emit("session.reattached", { sessionId: "session-2", via: "resume" } as never);
	footerTools.clear();
	collector.sessionChanged();
	turns = 8;
	footerTools.set("bash", 1);
	const snapshot = collector.snapshot();
	strictEqual(snapshot?.sessionId, "session-2");
	const card = renderExitSummary(snapshot, "standard", 160, false).join("\n");
	match(card, /^This visit, workers included: 4 turns · 2 files changed · 1 worker · 2 sessions$/mu);
	// Tools are the named session's own calls, so the parked one's `bash 2` stays out (bt-11 h), and a tool no call ran
	// is no `verify 0` row.
	match(card, /^Tools: bash 1 · read 4$/mu);
	// Resumed back, a session keeps the calls it made before it was parked.
	bus.emit("session.parked", { sessionId: "session-2", reason: "resume_other", at: 0 });
	current = { id: "session-1", hasModelTurn: true };
	bus.emit("session.reattached", { sessionId: "session-1", via: "resume" } as never);
	footerTools.clear();
	collector.sessionChanged();
	footerTools.set("bash", 1);
	match(renderExitSummary(collector.snapshot(), "standard", 160, false).join("\n"), /^Tools: bash 3 · read 4$/mu);
	collector.dispose();
});

test("a fork's exit card counts only the compactions the fork ran, not its parent's (bt-47 D3)", () => {
	const bus = createTelemetryHub();
	let current = { id: "parent", hasModelTurn: true };
	const collector = createExitSummaryCollector({
		bus,
		telemetry: { subscribe: () => () => {} } as unknown as TelemetryContract,
		dispatch: {},
		session: { current: () => current } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 0,
		getToolCounts: () => new Map(),
		getModel: () => null,
	});
	const pruned = { stage: "llm_summary", tokensBefore: 2, tokensAfter: 1, at: 0 } as never;
	for (let i = 0; i < 3; i += 1) bus.emit("context.pruned", pruned, { sessionId: "parent" } as never);
	strictEqual(collector.snapshot()?.compactions, 3);
	bus.emit("session.parked", { sessionId: "parent", reason: "fork", at: 0 });
	current = { id: "fork", hasModelTurn: true };
	collector.sessionChanged();
	strictEqual(collector.snapshot()?.compactions, 0);
	doesNotMatch(renderExitSummary(collector.snapshot(), "standard", 160, false).join("\n"), /Compactions/u);
	// An event that names no session counts for the current one.
	bus.emit("context.pruned", pruned);
	match(renderExitSummary(collector.snapshot(), "standard", 160, false).join("\n"), /^Compactions: 1$/mu);
	collector.dispose();
});

test("the session report states the cached share of the prompt, for the session and its last turn", () => {
	const view = telemetryViewOf("session-1", [
		...telemetryCall("session-1", { turnId: "t1", usage: { input: 1000, output: 10 } }),
		...telemetryCall("session-1", { turnId: "t2", usage: { input: 100, output: 10, cacheRead: 900 } }),
	]);
	const collector = createExitSummaryCollector({
		bus: createTelemetryHub(),
		telemetry: {
			subscribe: () => () => {},
			read: { live: () => view, subscribe: () => () => {} },
		} as unknown as TelemetryContract,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 2,
		getToolCounts: () => new Map(),
		getModel: () => null,
	});
	const base = collector.snapshot();
	ok(base);
	const snapshot = { ...base, spend: exitSpend(view, "1970-01-01T00:00:00.000Z") };
	const card = (style: "standard" | "report") => renderExitSummary(snapshot, style, 120, false).join("\n");
	match(card("report"), /^Cache: 45\.0% of prompt tokens read from cache · last turn 90\.0%$/mu);
	strictEqual(card("standard").includes("read from cache"), false);
	// `in` is the uncached input as /usage and the turn receipt say it, the cache read beside it, not the 2,000 prompt (bt-11).
	ok(snapshot.spend.kind === "ready");
	match(snapshot.spend.breakdown, /^in 1,100 · out 20 · cache read 900\b/u);
	collector.dispose();
});

test("the session report names where a resumed transcript's replay broke the cache", () => {
	let second = 0;
	const d = (c: string) => c.repeat(16);
	const head = { system: d("a"), tools: d("b") };
	const call = (entries: string[], base?: number) =>
		telemetryCall("session-1", {
			at: new Date(Date.UTC(2026, 10, 6, 12, 0, second++)).toISOString(),
			usage: { input: 9_000, output: 10, cacheRead: 0 },
			cache: {
				verdict: "cold",
				rePrefilledTokens: { kind: "measured", value: 9_000, source: "local-count" },
				structure: { ...head, ...(base !== undefined ? { base } : {}), entries },
			},
		});
	const view = telemetryViewOf("session-1", [
		...call([`user:${d("1")}`]),
		...call([`assistant:${d("2")}`, `toolResult:${d("3")}`], 1),
		// A later process resends the whole transcript, and its second message differs from the one sent before.
		...call([`user:${d("1")}`, `assistant:${d("9")}`, `toolResult:${d("3")}`, `user:${d("4")}`]),
	]);
	const collector = createExitSummaryCollector({
		bus: createTelemetryHub(),
		telemetry: {
			subscribe: () => () => {},
			read: { live: () => view, subscribe: () => () => {} },
		} as unknown as TelemetryContract,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 3,
		getToolCounts: () => new Map(),
		getModel: () => null,
	});
	const base = collector.snapshot();
	ok(base);
	const snapshot = { ...base, spend: exitSpend(view, "1970-01-01T00:00:00.000Z") };
	match(
		renderExitSummary(snapshot, "report", 160, false).join("\n"),
		/^Cache: .* · resumed transcript differed at message\[1\]:assistant \(1 break, 9,000 re-prefilled\)$/mu,
	);
	collector.dispose();
});

test("the exit card divides the session's spend over its distinct verified outcomes, and never by zero", () => {
	const passed = (kind: string, check: string, sha256: string, validation = "passed") => ({
		kind: "message",
		role: "tool_result",
		payload: {
			toolName: "verify",
			isError: validation !== "passed",
			result: {
				details: {
					check,
					kind,
					report: { kind, passed: validation === "passed", actual: { sha256 } },
					judgement: { execution: "succeeded", validation },
				},
			},
		},
	});
	const entries = [
		passed("reproduce", "repro", "a"),
		// The same check on the same payload is the same result; a command pass and a failed comparison are not outcomes.
		passed("reproduce", "repro", "a"),
		passed("numeric-compare", "fit", "b"),
		passed("command", "test", "c"),
		passed("numeric-compare", "fit", "d", "failed"),
	];
	const card = (calls: ReturnType<typeof telemetryCall>, ledger: unknown[]) => {
		const spend = exitSpend(telemetryViewOf("session-1", calls), "1970-01-01T00:00:00.000Z", ledger);
		ok(spend.kind === "ready");
		return spend.verified;
	};
	const call = (usd: number | null, pricedBy?: "target-rates") =>
		telemetryCall("session-1", { usage: { input: 1000, output: 200 }, usd, ...(pricedBy ? { pricedBy } : {}) });
	deepStrictEqual(card(call(null), []), {
		kind: "none",
		words: "no judged outcome this session; command checks such as unit tests are not counted",
	});
	const unpriced = card(call(null), entries);
	ok(unpriced.kind === "counted");
	deepStrictEqual(
		[unpriced.count, unpriced.parts, unpriced.tokens, unpriced.cost],
		["2", ["2 reproduce or numeric-compare passes"], "600", "not measured"],
	);
	const priced = card(call(0.5, "target-rates"), entries);
	ok(priced.kind === "counted");
	deepStrictEqual(priced.cost, "$0.25");
	// A done task checked by a pass already counted is that pass; one checked by a pass of its own counts once.
	const at = "2026-11-06T00:00:00.000Z";
	const row = (task: string, observedAt: string) => ({
		id: `${task}.observed.0`,
		description: "check",
		command: "check",
		status: "passed",
		observedAt,
	});
	const ledger = {
		kind: "taskLedger",
		turnId: "turn-1",
		parentTurnId: null,
		boardId: "board-1",
		activeRunIds: [],
		timestamp: "2026-11-06T00:01:00.000Z",
		goals: [{ id: "board", title: "Board", status: "completed" }],
		subgoals: ["t1", "t2"].map((id) => ({ id, title: id, status: "completed", parentGoalId: "board" })),
		requiredValidationEvidence: [row("t1", at), row("t2", "2026-11-06T00:00:30.000Z")],
	};
	const tasks = card(call(null), [{ ...passed("reproduce", "repro", "a"), timestamp: at }, ledger]);
	ok(tasks.kind === "counted");
	deepStrictEqual(
		[tasks.count, tasks.parts],
		["2", ["1 reproduce or numeric-compare pass", "1 task done with a passing check"]],
	);
	// A host-verified worker whose check judged a payload already counted folds into that pass; a new payload counts.
	const dispatched = (runId: string, sha256: string, second: number) => ({
		kind: "message",
		role: "tool_result",
		timestamp: `2026-11-06T00:02:0${second}.000Z`,
		payload: {
			toolName: "dispatch",
			isError: false,
			result: {
				details: {
					runs: [
						{
							runId,
							hostVerification: {
								status: "verified",
								checks: [{ check: "fit", report: { kind: "numeric-compare", passed: true, actual: { sha256 } } }],
							},
						},
					],
				},
			},
		},
	});
	const ledgerWithRuns = [...entries, dispatched("run-a", "b", 1), dispatched("run-b", "z", 2)];
	deepStrictEqual(countVerifiedOutcomes(ledgerWithRuns, new Set(["run-a", "run-b"])), {
		total: 3,
		checks: 2,
		workers: 1,
		tasks: 0,
	});
	// A run whose checks the ledger does not show counts only when there is no counted pass it could repeat.
	deepStrictEqual(countVerifiedOutcomes(entries, new Set(["run-hidden"])).workers, 0);
	deepStrictEqual(countVerifiedOutcomes([], new Set(["run-hidden"])).workers, 1);
	// A fork's ledger copied its parent's passes and done tasks; it counts only what it recorded after it forked (D3b).
	// The copied rows end at the turn it branched at, and position decides, so a parent clock running ahead and a fork
	// clock running behind cannot move a pass across the cut (bt-fork-verified limit).
	const forkPoint = { kind: "message", role: "user", turnId: "turn-1", parentTurnId: null, payload: { content: "go" } };
	const copied = [
		...entries.map((entry, i) => ({ ...entry, turnId: `parent-${i}`, timestamp: `2026-11-06T00:0${i + 6}:00.000Z` })),
		{ ...ledger, turnId: "parent-board" },
		{ ...forkPoint, timestamp: "2026-11-06T00:04:00.000Z" },
	];
	const forkedAt = "2026-11-06T00:05:00.000Z";
	const forkedRow = makeTelemetryRecord(
		"session.forked",
		{ parentSessionId: "session-1", parentCwdHash: "cwd", parentTurnId: "turn-1", parentTurnAt: at },
		{ sessionId: "fork-1", agent: { role: "main", id: "fork-1" } },
		{ t: forkedAt, mono: 0 },
	);
	const forkCard = (ledgerRows: unknown[]) => {
		const forkCall = telemetryCall("fork-1", { usage: { input: 1000, output: 200 }, usd: null, at: forkedAt });
		const parent = { sessionId: "session-1", records: call(null), turnId: "turn-1", at };
		const spend = exitSpend(telemetryViewOf("fork-1", [forkedRow, ...forkCall], new Map(), parent), at, ledgerRows);
		ok(spend.kind === "ready");
		return spend.verified;
	};
	strictEqual(forkCard(copied).kind, "none");
	const own = forkCard([
		...copied,
		{ ...passed("reproduce", "repro", "e"), turnId: "fork-1", timestamp: "2026-11-06T00:03:00.000Z" },
	]);
	ok(own.kind === "counted");
	deepStrictEqual([own.count, own.parts], ["1", ["1 reproduce or numeric-compare pass"]]);
});

test("--session-file writes one atomic 0600 record from the exit snapshot, whichever exit path arrives first", () => {
	strictEqual(extractGlobalFlags(["--session-file", "out/rec.json"]).sessionFile, resolve("out/rec.json"));
	strictEqual(extractGlobalFlags(["--session-file"]).error, "--session-file requires a path");
	strictEqual(extractGlobalFlags(["--session-file", "--with-panes"]).error, "--session-file requires a path");
	deepStrictEqual([0, 130, 143, 129, 1].map(sessionFileOutcomeForExitCode), [
		"quit",
		"interrupted",
		"interrupted",
		"interrupted",
		"crashed",
	]);
	const dir = mkdtempSync(join(tmpdir(), "clio-session-file-"));
	try {
		const view = telemetryViewOf(
			"session-1",
			telemetryCall("session-1", { usage: { input: 1000, output: 200 }, usd: 0.5, pricedBy: "target-rates" }),
		);
		const spend = exitSpend(view, "1970-01-01T00:00:00.000Z");
		ok(spend.kind === "ready");
		const path = join(dir, "nested", "record.json");
		const recorder = createSessionFileRecorder({
			path,
			cwd: "/work",
			now: () => new Date("2026-11-06T00:00:00.000Z"),
			snapshot: () =>
				({
					sessionId: "session-1",
					sessionName: null,
					turns: 2,
					models: [
						{ target: "a", model: "m1" },
						{ target: "b", model: "m2" },
					],
					spend,
				}) as never,
		});
		strictEqual(recorder.record("interrupted", 0), true);
		strictEqual(recorder.record("crashed", 1), false);
		strictEqual(statSync(path).mode & 0o777, 0o600);
		deepStrictEqual(readdirSync(join(dir, "nested")), ["record.json"]);
		const record = JSON.parse(readFileSync(path, "utf8"));
		const { tokens, usd } = view.session().totals;
		deepStrictEqual(record, {
			version: 1,
			sessionId: "session-1",
			sessionName: null,
			outcome: "interrupted",
			exitCode: 0,
			usage: { tokens: { display: tokens.display, fact: tokens.fact }, cost: { display: usd.display, fact: usd.fact } },
			model: { target: "b", model: "m2" },
			models: [
				{ target: "a", model: "m1" },
				{ target: "b", model: "m2" },
			],
			turns: 2,
			cwd: "/work",
			endedAt: "2026-11-06T00:00:00.000Z",
			state: "ended",
		});
		// No conversation still leaves an outcome on record; an unwritable path warns instead of throwing at exit.
		const empty = join(dir, "empty.json");
		createSessionFileRecorder({ path: empty, cwd: "/work", snapshot: () => null }).record("quit", 0);
		const bare = JSON.parse(readFileSync(empty, "utf8"));
		deepStrictEqual([bare.sessionId, bare.outcome, bare.usage, bare.model], [null, "quit", null, null]);
		const warnings: string[] = [];
		const blocked = createSessionFileRecorder({
			path: join(empty, "under-a-file.json"),
			cwd: "/work",
			snapshot: () => null,
			warn: (line) => warnings.push(line),
		});
		strictEqual(blocked.record("quit", 0), false);
		match(warnings.join("\n"), /could not write the session record/u);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--session-file keeps a live lane state at turn ends and permission cards until the exit record", () => {
	const dir = mkdtempSync(join(tmpdir(), "clio-session-live-"));
	try {
		const path = join(dir, "live.json");
		const recorder = createSessionFileRecorder({
			path,
			cwd: "/work",
			now: () => new Date("2026-11-06T00:00:00.000Z"),
			snapshot: () => ({ sessionId: "session-1", sessionName: null, turns: 1, models: [] }) as never,
		});
		const read = () => JSON.parse(readFileSync(path, "utf8"));
		recorder.observeChat({ type: "agent_start" } as ChatLoopEvent);
		strictEqual(read().state, "working");
		recorder.observeChat({ type: "message_end", message: { role: "assistant", stopReason: "stop" } } as never);
		recorder.observeChat({ type: "agent_end", messages: [] } as never);
		const idle = read();
		deepStrictEqual([idle.state, idle.turns, idle.lastTurn.stopReason, idle.waitingOn], ["idle", 1, "stop", undefined]);
		ok("build" in idle);
		recorder.observeChat({ type: "agent_start" } as ChatLoopEvent);
		recorder.observeChat({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "curl https://user:hunter2@example.com" },
		} as never);
		recorder.observeApprovalRequested({ tool: "bash", actionClass: "execute" });
		const parked = read();
		deepStrictEqual([parked.state, parked.waitingOn.tool], ["awaiting-approval", "bash"]);
		ok(!parked.waitingOn.text.includes("hunter2"));
		recorder.observeApprovalResolved();
		deepStrictEqual([read().state, read().waitingOn], ["working", undefined]);
		recorder.record("quit", 0);
		deepStrictEqual([read().state, read().outcome], ["ended", "quit"]);
		deepStrictEqual(readdirSync(dir), ["live.json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the exit card's model-call time covers the worker calls its count covers (Astra r5-5)", () => {
	const timed = (records: TelemetryRecord[], settle: number, runId?: string) =>
		records.map((record) => {
			const ctx = runId ? { ...record.ctx, runId, agent: { role: "worker" as const, id: runId } } : record.ctx;
			return (
				record.k === "call.settled"
					? { ...record, ctx, data: { ...record.data, stages: { ...record.data.stages, settle } } }
					: { ...record, ctx }
			) as TelemetryRecord;
		});
	const main = [
		...timed(telemetryCall("session-1", { usage: { input: 10, output: 1 } }), 1_000),
		...timed(telemetryCall("session-1", { usage: { input: 10, output: 1 } }), 1_000),
	];
	const worker = timed(telemetryCall("session-1", { role: "worker", usage: { input: 10, output: 1 } }), 60_000, "run-w");
	const [first] = main;
	ok(first);
	const linked = makeTelemetryRecord("run.linked", { runId: "run-w" }, first.ctx, { t: first.t, mono: 0 });
	const spend = exitSpend(
		telemetryViewOf("session-1", [...main, linked], new Map([["run-w", worker]])),
		"1970-01-01T00:00:00.000Z",
	);
	ok(spend.kind === "ready");
	strictEqual(spend.visitCalls, 3);
	strictEqual(spend.callTime, "1m02s");
	strictEqual(spend.callTimeCoverage, null);
});
