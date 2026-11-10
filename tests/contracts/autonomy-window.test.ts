import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { journalDefinition, validPayload } from "../../src/core/telemetry/events.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	type AutonomousCaps,
	type AutonomyHalt,
	type AutonomyStatus,
	autonomousCaps,
	autonomyHaltNotice,
	createAutonomyWindow,
	describeOpenDecision,
	headlessHaltNotice,
	OPEN_DECISION_LIMIT,
	settledCallTokens,
} from "../../src/domains/safety/autonomy-window.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import type { SafetyJudgeNote } from "../../src/domains/safety/safety-judge.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createSafetyJudgeHost } from "../../src/entry/safety-judge-host.js";
import { renderExitSummary } from "../../src/interactive/exit-summary.js";
import { createExitSummaryCollector } from "../../src/interactive/exit-summary-collector.js";
import { renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { footerState } from "../harness/footer-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function windowFixture(initial: AutonomousCaps | null) {
	let caps = initial;
	let clock = 0;
	let session = "s1";
	const halts: AutonomyHalt[] = [];
	const window = createAutonomyWindow({
		caps: () => caps,
		onHalt: (halt) => halts.push(halt),
		session: () => session,
		now: () => clock,
	});
	return {
		window,
		halts,
		advance: (ms: number) => {
			clock += ms;
		},
		setCaps: (next: AutonomousCaps | null) => {
			caps = next;
		},
		setSession: (next: string) => {
			session = next;
		},
	};
}

test("the autonomous window counts across continuations, latches once and reopens when the operator speaks", () => {
	const fx = windowFixture({ toolCalls: 3, minutes: 0, tokens: 0 });
	fx.window.turnStarted();
	fx.window.toolCall();
	fx.window.toolCall();
	fx.window.turnSettled();
	// A continuation is a new turn in the same window.
	fx.window.turnStarted();
	strictEqual(fx.window.halted(), null);
	fx.window.toolCall();
	strictEqual(fx.halts.length, 1);
	deepStrictEqual(
		{ kind: fx.halts[0]?.kind, limit: fx.halts[0]?.limit, calls: fx.halts[0]?.usage.toolCalls },
		{ kind: "calls", limit: 3, calls: 3 },
	);
	fx.window.toolCall();
	strictEqual(fx.halts.length, 1, "a halt latches once");
	fx.window.turnSettled();
	strictEqual(fx.window.reopen()?.kind, "calls");
	strictEqual(fx.window.halted(), null);
	strictEqual(fx.window.usage().toolCalls, 0);
	strictEqual(fx.window.reopen(), null);
});

test("token and minute caps trip on the next call event, never between turns", () => {
	const tokens = windowFixture({ toolCalls: 0, minutes: 0, tokens: 1000 });
	tokens.window.tokens(600);
	tokens.window.tokens(Number.NaN);
	strictEqual(tokens.halts.length, 0);
	tokens.window.tokens(400);
	strictEqual(tokens.halts[0]?.kind, "tokens");

	const minutes = windowFixture({ toolCalls: 0, minutes: 1, tokens: 0 });
	minutes.window.turnStarted();
	minutes.advance(61_000);
	minutes.window.turnSettled();
	strictEqual(minutes.halts.length, 0, "a settled turn only accrues time");
	minutes.window.turnStarted();
	minutes.window.toolCall();
	strictEqual(minutes.halts[0]?.kind, "minutes");
	ok((minutes.halts[0]?.usage.activeMs ?? 0) >= 61_000);
});

test("below yolo nothing counts; at yolo with every cap off a judge escalation still halts", () => {
	strictEqual(autonomousCaps("default", DEFAULT_SETTINGS.safety.limits), null);
	deepStrictEqual(autonomousCaps("yolo", DEFAULT_SETTINGS.safety.limits), {
		toolCalls: DEFAULT_SETTINGS.safety.limits.autonomousToolCalls,
		minutes: DEFAULT_SETTINGS.safety.limits.autonomousMinutes,
		tokens: DEFAULT_SETTINGS.safety.limits.autonomousTokens,
	});
	const off = windowFixture(null);
	off.window.toolCall();
	off.window.haltFor("judge", "3 blocks in a row");
	strictEqual(off.halts.length, 0);
	strictEqual(off.window.usage().toolCalls, 0);

	const zero = windowFixture({ toolCalls: 0, minutes: 0, tokens: 0 });
	for (let i = 0; i < 50; i += 1) zero.window.toolCall();
	strictEqual(zero.halts.length, 0);
	zero.window.haltFor("judge", "3 blocks in a row");
	strictEqual(zero.window.halted()?.kind, "judge");
	// Leaving yolo hides the latch; nothing below yolo is paused.
	zero.setCaps(null);
	strictEqual(zero.window.halted(), null);
});

test("a new session starts a fresh window", () => {
	const fx = windowFixture({ toolCalls: 2, minutes: 0, tokens: 0 });
	fx.window.toolCall();
	fx.window.toolCall();
	strictEqual(fx.window.halted()?.kind, "calls");
	fx.setSession("s2");
	strictEqual(fx.window.halted(), null);
	fx.window.toolCall();
	strictEqual(fx.window.usage().toolCalls, 1);
});

test("settled call tokens prefer the provider total and the notices name the way back", () => {
	strictEqual(settledCallTokens({ total: { value: 90 }, input: { value: 10 } }), 90);
	strictEqual(
		settledCallTokens({ input: { value: 10 }, cacheRead: { value: 5 }, output: { value: 3 }, cacheWrite: {} }),
		18,
	);
	strictEqual(settledCallTokens(null), 0);
	const halt: AutonomyHalt = {
		kind: "calls",
		limit: 600,
		detail: "600-call cap",
		usage: { toolCalls: 600, activeMs: 38 * 60_000, tokens: 1_900_000 },
	};
	match(autonomyHaltNotice(halt), /600-call cap.*Enter on an empty prompt continues for another 600 calls/u);
	match(autonomyHaltNotice(halt, "headless"), /^autonomous-cap: .*clio-coder run --continue/u);
	match(
		autonomyHaltNotice({ kind: "judge", detail: "3 blocks in a row", usage: halt.usage }, "headless"),
		/^judge-streak: /u,
	);
});

test("yolo journals entering, open decisions without their command, the halt, the resume and the end", () => {
	let caps: AutonomousCaps | null = { toolCalls: 2, minutes: 0, tokens: 0 };
	const events: Array<{ name: string; payload: Record<string, unknown>; session: string | null }> = [];
	const window = createAutonomyWindow({
		caps: () => caps,
		onHalt: () => {},
		session: () => "s1",
		now: () => 0,
		confinement: () => "contained",
		emit: (name, payload, session) => {
			const project = journalDefinition(name).project as ((p: unknown) => unknown) | undefined;
			ok(validPayload(name, project?.(payload) ?? payload), name);
			events.push({ name, payload: payload as Record<string, unknown>, session });
		},
	});
	window.turnStarted();
	window.openDecision({ tool: "bash", command: "git push origin main", kind: "operator-only", rule: "git-push" });
	window.toolCall();
	window.toolCall();
	window.reopen();
	window.end();
	deepStrictEqual(
		events.map((e) => e.name),
		["autonomy.entered", "autonomy.open_decision", "autonomy.cap_reached", "autonomy.resumed", "autonomy.ended"],
	);
	ok(events.every((e) => e.session === "s1"));
	deepStrictEqual(events[0]?.payload, { confinement: "contained", capToolCalls: 2, capMinutes: 0, capTokens: 0 });
	const project = journalDefinition("autonomy.open_decision").project as (p: unknown) => unknown;
	deepStrictEqual(project(events[1]?.payload), { tool: "bash", kind: "operator-only", rule: "git-push", seq: 1 });
	strictEqual(events[2]?.payload.openDecisions, 1);
	deepStrictEqual(events[4]?.payload, { reason: "shutdown", toolCalls: 0, tokens: 0, activeMs: 0, openDecisions: 1 });
	// Leaving yolo ends the stretch once; below yolo nothing is recorded.
	const later = createAutonomyWindow({
		caps: () => caps,
		onHalt: () => {},
		session: () => "s1",
		now: () => 0,
		emit: (name, payload, session) => events.push({ name, payload: payload as Record<string, unknown>, session }),
	});
	later.turnStarted();
	later.openDecision({ tool: "bash", command: "git push", kind: "operator-only" });
	caps = null;
	later.turnStarted();
	later.openDecision({ tool: "bash", command: "ls", kind: "operator-only" });
	later.end();
	deepStrictEqual(
		events.slice(5).map((e) => [e.name, e.payload.reason]),
		[
			["autonomy.entered", undefined],
			["autonomy.open_decision", undefined],
			["autonomy.ended", "left-yolo"],
		],
	);
	strictEqual(later.report()?.openDecisions.length, 1);
});

test("open decisions are bounded, scrubbed and clipped, and a judge-streak end lists them", () => {
	const fx = windowFixture({ toolCalls: 0, minutes: 0, tokens: 0 });
	for (let i = 0; i < OPEN_DECISION_LIMIT + 3; i += 1) {
		fx.window.openDecision({ tool: "bash", command: `echo ${i}`, kind: "no-verdict" });
	}
	const report = fx.window.report();
	strictEqual(report?.openDecisions.length, OPEN_DECISION_LIMIT);
	strictEqual(report?.openDecisionsOmitted, 3);
	strictEqual(report?.openDecisions[0]?.seq, 4);
	strictEqual(fx.window.openDecisions(true).length, OPEN_DECISION_LIMIT);
	fx.window.reopen();
	strictEqual(fx.window.openDecisions(true).length, 0, "the operator spoke since");

	const ask = {
		kind: "ask",
		classification: { actionClass: "execute", reasons: [] },
		rejection: { short: "", detail: "" },
	} as unknown as SafetyDecision;
	const secret = ["sk-ant-api03", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"].join("-");
	const long = describeOpenDecision(
		{ tool: "bash", args: { command: `OPENAI_API_KEY=${secret} curl https://example.com/${"a".repeat(400)}` } },
		ask,
		"judge-block",
		"exfil",
	);
	ok(!long.command.includes(secret), long.command);
	ok(long.command.length <= 201);
	deepStrictEqual(
		{ tool: long.tool, kind: long.kind, rule: long.rule },
		{ tool: "bash", kind: "judge-block", rule: "exfil" },
	);

	const usage = { toolCalls: 4, activeMs: 0, tokens: 0 };
	const open = Array.from({ length: 12 }, (_, i) => ({
		seq: i + 1,
		tool: "bash",
		command: `rm -rf /tmp/x${i}`,
		kind: "judge-block" as const,
	}));
	const judge = autonomyHaltNotice({ kind: "judge", detail: "3 blocks in a row", usage }, "headless", open);
	match(judge, /Left for you \(12 open decisions\): 3\) bash `rm -rf \/tmp\/x2` \(judge-block\);.*12\) .*; 2 more\.$/u);
	match(
		autonomyHaltNotice({ kind: "calls", limit: 4, detail: "4-call cap", usage }, "interactive", open),
		/12 open decisions left for you\.$/u,
	);
	match(autonomyHaltNotice({ kind: "calls", limit: 4, detail: "4-call cap", usage }, "headless"), /fresh window$/u);
});

test("an open decision's command hides Authorization headers and bare provider tokens", () => {
	const ask = {
		kind: "ask",
		classification: { actionClass: "execute", reasons: [] },
		rejection: { short: "", detail: "" },
	} as unknown as SafetyDecision;
	const github = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
	const anthropic = ["sk-ant-api03", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"].join("-");
	const opaque = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA";
	const entry = describeOpenDecision(
		{
			tool: "bash",
			args: {
				command: `curl -H 'Authorization: Bearer ${opaque}' -H "X-Token: ${github}" https://api.example.com && echo ${anthropic}`,
			},
		},
		ask,
		"judge-block",
	);
	for (const secret of [github, anthropic, opaque]) ok(!entry.command.includes(secret), entry.command);
	match(entry.command, /^curl -H 'Authorization: Bearer /u);
});

test("an open decision's command hides whole quoted credentials that hold spaces", () => {
	const ask = {
		kind: "ask",
		classification: { actionClass: "execute", reasons: [] },
		rejection: { short: "", detail: "" },
	} as unknown as SafetyDecision;
	const command = (text: string): string =>
		describeOpenDecision({ tool: "bash", args: { command: text } }, ask, "judge-block").command;
	for (const quote of [`"`, `'`]) {
		const cases = [
			`PASSWORD=${quote}firstpart secondpart${quote} ./scripts/sync-assets`,
			`deploy --password ${quote}firstpart secondpart${quote} --token=${quote}firstpart secondpart${quote} now`,
			`curl -H ${quote}X-Api-Key: firstpart secondpart${quote} -H ${quote}Authorization: Basic firstpart secondpart${quote} x`,
		];
		for (const text of cases) {
			const shown = command(text);
			ok(!shown.includes("firstpart") && !shown.includes("secondpart"), shown);
		}
		match(command(cases[0] ?? ""), /\.\/scripts\/sync-assets$/u);
	}
});

test("an ended yolo audit stays ended: late settlements never reopen it", () => {
	const names: string[] = [];
	let ended: Record<string, unknown> | undefined;
	const window = createAutonomyWindow({
		caps: () => ({ toolCalls: 0, minutes: 0, tokens: 0 }),
		onHalt: () => {},
		session: () => "s1",
		now: () => 0,
		emit: (name, payload) => {
			names.push(name);
			if (name === "autonomy.ended") ended = payload as Record<string, unknown>;
		},
	});
	window.turnStarted();
	window.toolCall();
	window.end();
	window.toolCall();
	window.tokens(10);
	window.turnStarted();
	window.openDecision({ tool: "bash", command: "ls", kind: "operator-only" });
	window.end();
	deepStrictEqual(names, ["autonomy.entered", "autonomy.ended"]);
	strictEqual(ended?.toolCalls, 1);
});

test("a pending judge halt is dropped when its turn settles, the operator speaks or the session changes", () => {
	const fx = windowFixture({ toolCalls: 0, minutes: 0, tokens: 0 });
	const block = { tool: "bash", command: "git push", kind: "judge-block" as const };
	fx.window.turnStarted();
	fx.window.haltFor("judge", "3 blocks in a row", true);
	strictEqual(fx.halts.length, 0, "nothing halts before the crossing block is recorded");
	fx.window.turnSettled();
	fx.window.reopen();
	fx.window.turnStarted();
	fx.window.openDecision(block);
	fx.window.toolCall();
	strictEqual(fx.halts.length, 0, "a settled turn's escalation never cancels the operator's next prompt");

	fx.window.haltFor("judge", "3 blocks in a row", true);
	fx.window.reopen();
	fx.window.openDecision(block);
	strictEqual(fx.halts.length, 0);

	fx.window.haltFor("judge", "3 blocks in a row", true);
	fx.setSession("s2");
	fx.window.openDecision(block);
	strictEqual(fx.halts.length, 0);

	fx.window.haltFor("judge", "3 blocks in a row", true);
	fx.window.toolCall();
	strictEqual(fx.halts.length, 1, "a block the registry never recorded still halts at the call's settlement");
	fx.window.reopen();
	fx.window.haltFor("judge", "4 blocks this session");
	strictEqual(fx.halts.length, 2, "a worker's escalation halts at once");
});

test("the headless halt notice counts the call that crossed the line, as the report does", () => {
	const fx = windowFixture({ toolCalls: 0, minutes: 0, tokens: 0 });
	fx.window.turnStarted();
	fx.window.toolCall();
	fx.window.toolCall();
	fx.window.haltFor("judge", "3 blocks in a row", true);
	fx.window.openDecision({ tool: "bash", command: "git push", kind: "judge-block" });
	fx.window.toolCall();
	const [halt] = fx.halts;
	ok(halt !== undefined);
	const report = fx.window.report(true);
	strictEqual(report?.usage.toolCalls, 3);
	match(headlessHaltNotice(halt, report), /after 3 tool calls,/u);
	match(headlessHaltNotice(halt, null), /after 2 tool calls,/u);
});

test("the exit summary closes a yolo session with its window, its halt and the decisions it left", () => {
	const fx = windowFixture({ toolCalls: 3, minutes: 0, tokens: 0 });
	fx.window.openDecision({ tool: "bash", command: "git push origin main", kind: "operator-only", rule: "git-push" });
	for (let i = 0; i < 3; i += 1) fx.window.toolCall();
	const collector = createExitSummaryCollector({
		bus: createTelemetryHub(),
		telemetry: { subscribe: () => () => {} } as unknown as TelemetryContract,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map(),
		getModel: () => null,
		autonomy: () => fx.window.report(),
	});
	const brief = renderExitSummary(collector.snapshot(), "brief", 200, false).join("\n");
	match(brief, /Autonomy: contained yolo · 3 tool calls, .* tokens · paused at the 3-call cap · 1 open decision$/mu);
	const standard = renderExitSummary(collector.snapshot(), "standard", 200, false).join("\n");
	match(standard, /Autonomy: .*1 open decision · 1\) bash `git push origin main` \(operator-only, rule git-push\)/u);
	collector.dispose();
});

test("a project may tighten an autonomous cap but never loosen or disable it", async (t) => {
	const home = await isolateClioEnv("clio-autonomy-caps-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	const projectDir = join(workspace, ".clio-coder");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		"version: 2\nsafety:\n  limits:\n    autonomousToolCalls: 100\n    autonomousTokens: 0\n",
	);
	writeFileSync(
		join(projectDir, "settings.yaml"),
		"safety:\n  limits:\n    autonomousToolCalls: 50\n    autonomousMinutes: 0\n    autonomousTokens: 9000000\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	const limits = layered.settings.safety.limits;
	strictEqual(limits.autonomousToolCalls, 50, "tightening is kept");
	strictEqual(limits.autonomousMinutes, DEFAULT_SETTINGS.safety.limits.autonomousMinutes, "0 would disable it");
	// The operator turned the token cap off; a project may still set one.
	strictEqual(limits.autonomousTokens, 9_000_000);
	const flagged = layered.issues.filter((issue) => issue.origin === "project").map((issue) => issue.path);
	deepStrictEqual(flagged, ["safety.limits.autonomousMinutes"]);
});

test("a project may tighten any safety or fleet limit and switch review on, never loosen or switch them off", async (t) => {
	const home = await isolateClioEnv("clio-project-limits-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	const projectDir = join(workspace, ".clio-coder");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		[
			"version: 2",
			"safety:",
			"  limits:",
			"    sessionCostUsd: 2",
			"    chatToolCallsPerTurn: 40",
			"  review:",
			"    enabled: true",
			"    cadenceToolCalls: 20",
			"fleet:",
			"  limits:",
			"    toolCallsPerRun: 50",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(projectDir, "settings.yaml"),
		[
			"safety:",
			"  limits:",
			"    sessionCostUsd: 0",
			"    chatToolCallsPerTurn: 100000",
			"    readBytesPerCall: 1024",
			"  review:",
			"    enabled: false",
			"    cadenceToolCalls: 500",
			"fleet:",
			"  limits:",
			"    toolCallsPerRun: 100000",
			"    internalRunTimeoutMs: 1000",
			"",
		].join("\n"),
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	const { safety, fleet } = layered.settings;
	strictEqual(safety.limits.sessionCostUsd, 2, "0 would switch the cost ceiling off");
	strictEqual(safety.limits.chatToolCallsPerTurn, 40);
	strictEqual(safety.limits.readBytesPerCall, 1024, "tightening is kept");
	strictEqual(safety.review.enabled, true);
	strictEqual(safety.review.cadenceToolCalls, 20);
	strictEqual(fleet.limits.toolCallsPerRun, 50);
	strictEqual(fleet.limits.internalRunTimeoutMs, 1000, "tightening is kept");
	const flagged = layered.issues.filter((issue) => issue.origin === "project").map((issue) => issue.path);
	deepStrictEqual(flagged.sort(), [
		"fleet.limits.toolCallsPerRun",
		"safety.limits.chatToolCallsPerTurn",
		"safety.limits.sessionCostUsd",
		"safety.review.cadenceToolCalls",
		"safety.review.enabled",
	]);

	// With the operator's ceiling and review off, a project may still switch both on.
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\nsafety:\n  limits:\n    sessionCostUsd: 0\n");
	writeFileSync(
		join(projectDir, "settings.yaml"),
		"safety:\n  limits:\n    sessionCostUsd: 3\n  review:\n    enabled: true\n",
	);
	const next = captureProjectSurface(workspace, "settings");
	if (!next.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", next.contentHash);
	const tightened = readLayeredSettings(workspace).settings.safety;
	strictEqual(tightened.limits.sessionCostUsd, 3);
	strictEqual(tightened.review.enabled, true);
});

function footerAt(status: AutonomyStatus, width: number): string {
	const state = footerState();
	state.session.autonomy = "yolo";
	state.session.yoloConfinement = "contained";
	state.session.autonomyWindow = status;
	return renderCompactDashboard(state, width).map(stripTerminalSequences).join("\n");
}

test("the footer shows the window's caps, the nearest alone when narrow, and a paused window's way back", () => {
	const status: AutonomyStatus = {
		usage: { toolCalls: 412, activeMs: 38 * 60_000, tokens: 1_900_000 },
		caps: { toolCalls: 600, minutes: 120, tokens: 5_000_000 },
		halted: null,
		osSandbox: true,
	};
	for (const width of [160, 100]) {
		const text = footerAt(status, width);
		match(text, /412\/600 calls · 38\/120 min · 1\.9M\/5M tok/u);
		match(text, /YOLO · contained/u);
		for (const line of text.split("\n")) ok(visibleWidth(line) <= width);
	}
	const narrow = footerAt(status, 50);
	match(narrow, /412\/600 calls/u);
	ok(!narrow.includes("min ·"));
	for (const line of narrow.split("\n")) ok(visibleWidth(line) <= 50);

	match(footerAt({ ...status, osSandbox: false }, 160), /YOLO · contained \(no OS sandbox\)/u);
	const paused = footerAt(
		{ ...status, halted: { kind: "calls", limit: 600, detail: "600-call cap", usage: status.usage } },
		160,
	);
	match(paused, /yolo paused · Enter continues/u);
});

function gatedLoop(halt: { current: AutonomyHalt | null }) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	if (!target) throw new Error("fixture target missing");
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	const entries: SessionEntry[] = [];
	const session = {
		current: () => ({ id: "autonomy-session", cwd: process.cwd(), cwdHash: "autonomy-repo" }),
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
	const prompts: string[] = [];
	const spoke: number[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		readSessionEntries: () => entries,
		autonomy: {
			halted: () => halt.current,
			operatorSpoke: () => {
				spoke.push(prompts.length);
				halt.current = null;
			},
			turnStarted: () => {},
			turnSettled: () => {},
		},
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...options?.initialState, messages: [] as AgentMessage[] };
			return {
				requestCorrelationId: () => undefined,
				agent: {
					state,
					subscribe: (next: typeof listener) => {
						listener = next;
						return () => {};
					},
					abort() {},
					async prompt(input: unknown) {
						prompts.push(typeof input === "string" ? input : JSON.stringify(input));
						await listener({ type: "agent_start" });
						await listener({ type: "turn_start" });
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							stopReason: "stop",
							timestamp: Date.now(),
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						} as AgentMessage;
						state.messages.push(message);
						await listener({ type: "message_end", message });
						await listener({ type: "agent_end", messages: [message] });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	return { loop, prompts, spoke };
}

test("a paused window refuses Clio's own continuations until the operator speaks or resumes", async (t) => {
	const home = await isolateClioEnv("clio-autonomy-gate-");
	t.after(() => home.restore());
	const halt: { current: AutonomyHalt | null } = {
		current: { kind: "calls", limit: 5, detail: "5-call cap", usage: { toolCalls: 5, activeMs: 0, tokens: 0 } },
	};
	const { loop, prompts, spoke } = gatedLoop(halt);
	try {
		await loop.submit("continue the work", { yoloContinuation: true, origin: "yolo continuation" });
		await loop.submit("continue the work", { requestContinuation: true });
		await loop.whenSettled();
		strictEqual(prompts.length, 0, "no continuation runs while paused");
		ok(halt.current !== null);

		strictEqual(loop.resumeAutonomy(), true);
		// The resume submits on its own; wait for its prompt to land.
		for (let i = 0; i < 200 && prompts.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		await loop.whenSettled();
		strictEqual(prompts.length, 1);
		deepStrictEqual(spoke, [0]);
		strictEqual(halt.current, null);
		strictEqual(loop.resumeAutonomy(), false, "nothing to resume once open");

		// An operator message reopens a paused window by itself.
		halt.current = { kind: "judge", detail: "3 blocks in a row", usage: { toolCalls: 0, activeMs: 0, tokens: 0 } };
		await loop.submit("please carry on");
		await loop.whenSettled();
		strictEqual(prompts.length, 2);
		strictEqual(halt.current, null);
	} finally {
		loop.dispose?.();
	}
});

test("the judge host reports its escalation, which a paused yolo window latches as a judge halt", async () => {
	const session = {
		current: () => ({ id: "session-1" }),
		readEntries: () => [],
		tree: () => ({ leafId: null }),
		leafId: () => null,
		appendEntry: (input: unknown) => input,
	} as unknown as SessionContract;
	const escalations: SafetyJudgeNote[] = [];
	const fx = windowFixture({ toolCalls: 0, minutes: 0, tokens: 0 });
	const seat = createSafetyJudgeHost({
		settings: () =>
			({ ...DEFAULT_SETTINGS, chat: { ...DEFAULT_SETTINGS.chat, target: "local", model: "m" } }) as ClioSettings,
		complete: async () => ({ text: JSON.stringify({ verdict: "block", rule: "remote-code", reason: "Not asked for." }) }),
		session: () => session,
		safety: undefined,
		onEscalation: (note) => {
			escalations.push(note);
			fx.window.haltFor("judge", `${note.consecutiveBlocks} blocks in a row`);
		},
	});
	const decision = {
		kind: "ask",
		classification: { actionClass: "execute", reasons: [] },
		confirmationRuleId: "bash-unrecognized",
		rejection: { short: "asks", detail: "asks", hints: [] },
	} as const;
	for (let i = 0; i < 4; i += 1) {
		await seat.review({
			tool: ToolNames.Bash,
			args: { command: `./scripts/sync-assets --all ${i}` },
			decision,
			approvalAuthority: "operator",
			turnId: `u${i}`,
		});
	}
	strictEqual(escalations.length, 1);
	strictEqual(fx.window.halted()?.kind, "judge");
	strictEqual(fx.halts.length, 1);
});
