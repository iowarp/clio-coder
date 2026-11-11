import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { countVerifiedOutcomes } from "../../src/domains/evidence/verified-outcomes.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { renderExitSummary } from "../../src/interactive/exit-summary.js";
import { createExitSummaryCollector, exitSpend } from "../../src/interactive/exit-summary-collector.js";
import { createSessionFileRecorder, sessionFileOutcomeForExitCode } from "../../src/interactive/session-file.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

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
	deepStrictEqual(card(call(null), []), { kind: "none", words: "none this session, so no per-outcome figure" });
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
