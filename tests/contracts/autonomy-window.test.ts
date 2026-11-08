import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
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
	settledCallTokens,
} from "../../src/domains/safety/autonomy-window.js";
import type { SafetyJudgeNote } from "../../src/domains/safety/safety-judge.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createSafetyJudgeHost } from "../../src/entry/safety-judge-host.js";
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
