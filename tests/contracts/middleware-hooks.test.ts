import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newCallId } from "../../src/core/telemetry/ids.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { buildExtensionSnapshot } from "../../src/domains/extensions/snapshot.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createHookBudgetTracker } from "../../src/domains/middleware/budget.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import {
	type HookReceipt,
	normalizeUserHook,
	type UserHookCommandRunner,
	userHookToRegistration,
} from "../../src/domains/middleware/hooks.js";
import { buildUserHookRegistrations, readHookSources } from "../../src/domains/middleware/hooks-io.js";
import { BUILTIN_MIDDLEWARE_RULE_IDS } from "../../src/domains/middleware/rules.js";
import {
	type MiddlewareDiagnostic,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
} from "../../src/domains/middleware/runtime.js";
import { createMiddlewareHostFromSnapshot, createMiddlewareSnapshot } from "../../src/domains/middleware/snapshot.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareRule } from "../../src/domains/middleware/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { foldSideSurfaces } from "../../src/domains/telemetry/read-model.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { capturedHookSourcesFor } from "../../src/entry/extension-hook-sources.js";
import { middlewareHookFailedSessionNotice } from "../../src/interactive/bus-notices.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { runTriageRound, type TriageSystemOne } from "../../src/session-control/steering-triage.js";
import { createTurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { createTurnOutcomeCollector } from "../../src/session-control/turn-outcome-collector.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import type { ToolInvokeOptions } from "../../src/tools/registry.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { middlewareOwner } from "../harness/middleware-owner.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function registration(
	id: string,
	evaluate: MiddlewareHookRegistration["evaluate"],
	overrides: Partial<MiddlewareHookRegistration> = {},
): MiddlewareHookRegistration {
	return { id, description: id, hooks: ["before_tool"], evaluate, ...overrides };
}

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-coder-middleware-extension-"));
	roots.push(root);
	return root;
}

describe("middleware hook boundary", () => {
	it("collects turn facts without effects, separating harness calls and detecting succeeded dispatch repeats", () => {
		const collector = createTurnOutcomeCollector();
		collector.seedClarificationStreak(2);
		const middleware = createMiddlewareBundle({ registrations: [collector] }).contract;
		const hook = (input: MiddlewareHookInput) =>
			deepStrictEqual(middleware.runHook({ sessionId: "session-1", ...input }).effects, []);
		hook({ hook: "turn_start", turnId: "user-1" });
		for (const metadata of [{ nested: true }, { origin: "harness" }]) {
			hook({ hook: "before_tool", turnId: "user-1", toolName: "read", metadata });
			hook({ hook: "after_tool", turnId: "user-1", toolName: "read", metadata });
		}
		hook({ hook: "before_tool", turnId: "user-1", toolName: "read" });
		hook({ hook: "before_tool", turnId: "user-1", toolName: "bash", toolArgs: { command: "rg task src" } });
		const args = { agent: "scout", task: " Inspect   Source " };
		const details = { mode: "detached", runs: [{ runId: "run-1", agentId: "scout" }] };
		hook({ hook: "before_tool", turnId: "user-1", toolName: "dispatch", toolArgs: args });
		hook({
			hook: "after_tool",
			turnId: "user-1",
			toolName: "dispatch",
			toolArgs: args,
			toolResultDetails: details,
			metadata: { resultKind: "ok" },
		});
		hook({ hook: "before_tool", turnId: "user-1", toolName: "read" });
		hook({
			hook: "after_tool",
			turnId: "user-1",
			toolName: "dispatch",
			toolResultDetails: { runs: [{ runId: "harness-1" }] },
			metadata: { origin: "harness", resultKind: "ok" },
		});
		hook({ hook: "turn_end", turnId: "assistant-1", metadata: { userTurnId: "user-1" } });
		collector.recordCompletion("assistant-1", "ok", 0, ["verification"]);
		deepStrictEqual(collector.take("user-1"), {
			control: null,
			toolNames: ["read", "bash", "dispatch", "read"],
			readOnlyCallsBeforeFirstDispatch: 2,
			dispatches: [{ mode: "detached", agentIds: ["scout"], runIds: ["run-1"] }],
			duplicateDispatch: false,
			harness: { runIds: ["harness-1"], reads: 1 },
			previousClarificationStreak: 2,
			completion: { decision: "ok", mutatedPaths: 0, evidenceKinds: ["verification"] },
		});
		hook({ hook: "turn_start", turnId: "user-2" });
		hook({ hook: "before_tool", turnId: "user-2", toolName: "dispatch", toolArgs: args });
		hook({
			hook: "after_tool",
			turnId: "user-2",
			toolName: "dispatch",
			toolArgs: { ...args, task: "inspect source" },
			toolResultDetails: details,
			metadata: { resultKind: "ok" },
		});
		strictEqual(collector.take("user-2").duplicateDispatch, true);
		deepStrictEqual(collector.take("user-2").toolNames, []);
	});

	it("settles each firing once against the request that carried it and the typed fact after it (memory design MD12)", async () => {
		const sessionId = "md12-outcome-ledger";
		const collector = createTurnOutcomeCollector();
		/** What each turn_end nudge fixture emits at the next turn end. */
		let fire: Record<string, "both" | "continue"> = {};
		const nudge = (id: string, text = id): MiddlewareHookRegistration =>
			registration(
				id,
				() => [
					...(fire[id] === "both" ? [{ kind: "inject_reminder" as const, message: `${text} reminder` }] : []),
					...(fire[id] !== undefined ? [{ kind: "request_continuation" as const, message: `${text} continue` }] : []),
				],
				{ hooks: ["turn_end"] },
			);
		const gate = (id: string, effects: MiddlewareEffect[]): MiddlewareHookRegistration =>
			registration(id, () => [], { hooks: ["turn_start"], awaited: true, evaluateAsync: async () => effects });
		const middleware = createMiddlewareBundle({
			registrations: [
				collector,
				nudge("nudge.a"),
				nudge("nudge.b"),
				nudge("nudge.memory", "Memory: recheck"),
				nudge("nudge.bg", "background"),
				registration("reminder.only", () => [{ kind: "inject_reminder", message: "count only" }], {
					hooks: ["turn_end"],
				}),
				registration("guard.fixture", (input) =>
					input.toolCallId?.startsWith("t-loop") === true
						? [{ kind: "block_tool", reason: "repeat", severity: "hard-block" }]
						: [],
				),
				registration("compaction.fixture", () => [{ kind: "request_continuation", message: "fold" }], {
					hooks: ["on_compaction"],
				}),
				gate("gate.lock", [{ kind: "lock_tools" }]),
				gate("gate.continue", [{ kind: "request_continuation", message: "gate only continue" }]),
			],
		}).contract;
		let memoryCurrent = true;
		const state = createTurnState("off");
		const turns = createTurnMiddleware({
			state,
			middleware,
			middlewareToolChoice: createMiddlewareToolChoiceControl(),
			emitNotice: () => {},
			emitFooterNotice: () => {},
			session: { current: () => ({ id: sessionId }) } as unknown as SessionContract,
			memoryContentGuard: () => () => memoryCurrent,
			suppressFirings: (firingIds) => collector.suppressFirings(firingIds),
		});
		const runtime = {
			wireModelId: "faux",
			runtimeResolution: {},
			agent: { state: { tools: [], messages: [] } },
		} as unknown as AgentRuntime;
		const hub = telemetryHub();
		const records: Array<{ k: string; data: object; ctx: object }> = [];
		const fired: Array<{ ruleId: string; firingId?: string }> = [];
		const settled = new Map<string, { surface: string; outcome: string; admittedIn: string | null; fact: string }>();
		const stops = [
			hub.subscribe("middleware.fired", (payload, ctx) => {
				if (ctx?.sessionId !== sessionId) return;
				fired.push(payload);
				records.push({ k: "middleware.fired", data: payload, ctx });
			}),
			hub.subscribe("surface.settled", (payload, ctx) => {
				if (ctx?.sessionId !== sessionId) return;
				ok(validPayload("surface.settled", payload), JSON.stringify(payload));
				ok(!settled.has(payload.firingId), `settled twice: ${payload.firingId}`);
				settled.set(payload.firingId, {
					surface: payload.surface,
					outcome: payload.outcome,
					admittedIn: payload.admittedIn,
					fact: payload.fact.kind,
				});
				records.push({ k: "surface.settled", data: payload, ctx });
			}),
		];
		const detach = collector.attachLedger(
			hub,
			() => sessionId,
			() => turns.heldFirings(),
		);
		const hook = (input: MiddlewareHookInput) => middleware.runHook({ sessionId, ...input });
		const ids = () => fired.flatMap((row) => (row.firingId === undefined ? [] : [row.firingId]));
		let seen = 0;
		const next = (count: number) => {
			const drawn = ids().slice(seen, seen + count);
			seen += count;
			return drawn;
		};
		/** A main request goes out, journaled under `callId` or not: it admits what the middleware held for it. */
		const send = (callId: string | null | undefined) => collector.requestSent(callId ?? null, turns.requestCarried());
		/** An operator prompt is admitted and its turn starts; the returned projection is the request's composition. */
		const start = (turnId: string, awaited?: Parameters<typeof turns.fireTurnStart>[5]) => {
			state.activeUserTurnId = turnId;
			state.continuation.beginPrompt({ requestContinuation: false, yoloContinuation: false });
			turns.fireTurnStart(runtime, "go", 0, false, turnId, awaited);
			return turns.takePendingReminderProjection();
		};
		/** An in-run continuation; a locked request leaves the buffer for the next unlocked one. */
		const continueInRun = (locked: boolean) => {
			turns.fireTurnStart(runtime, "", 0, true);
			if (!locked) turns.flushPendingReminders();
		};
		const end = async (assistantTurnId: string, emits: typeof fire = {}) => {
			fire = emits;
			state.lastTurnId = assistantTurnId;
			await turns.fireTurnEnd(runtime, [
				{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
			] as unknown as Parameters<typeof turns.fireTurnEnd>[1]);
			fire = {};
		};
		const call = (turnId: string, toolName: string, toolCallId: string, toolArgs: Record<string, unknown>) => {
			hook({ hook: "before_tool", turnId, toolName, toolCallId, toolArgs });
			hook({ hook: "after_tool", turnId, toolName, toolCallId, toolArgs, metadata: { resultKind: "ok" } });
		};
		const block = (turnId: string, toolCallId: string, toolArgs: Record<string, unknown> = { path: "loop" }) =>
			hook({ hook: "before_tool", turnId, toolName: "bash", toolCallId, toolArgs });
		const escalate = (disposition: "lockout" | "stop", turnId: string) =>
			hub.emit(
				"safety.loop_blocked",
				{ tool: "bash", repeatCount: 3, blocksThisTurn: 3, budget: 3, interrupted: false, disposition, at: 1 },
				{ sessionId, agent: { role: "main", id: sessionId }, turnId },
			);
		const [c1, c2, cLocked, c3, c4, c5, c6, c7, c8, c10, c11, c12] = Array.from({ length: 12 }, () => newCallId());
		try {
			// Turn 0, before any hook of the session reached the collector: a compaction point's firing is suppressed.
			// A submit returns after the awaited gate and before the turn starts: the gate's firings entered nothing.
			hook({ hook: "on_compaction", metadata: { stage: "superseded" } });
			const [k0] = next(1);
			let holds = turns.beginTurnHolds();
			ok((await turns.awaitTurnStart(runtime, "start", 0, "u0")).refusal === null);
			const [w0, w1] = next(2);
			turns.releaseTurnHolds(holds);
			// Another submit starts its turn with the gate's lock armed, then returns before sending: the lock and the
			// continuation the turn start could not carry are both suppressed, never admitted by turn 1's request.
			holds = turns.beginTurnHolds();
			const gated = await turns.awaitTurnStart(runtime, "start", 0, "u0b");
			const [w2, w3] = next(2);
			start("u0b", gated.refusal === null ? gated : undefined);
			turns.releaseTurnHolds(holds);
			// Turn 1: two nudges ride one in-run continuation; one check credits the later firing and the other is moot.
			// The same rule fires again in the same turn under a new id; a locked continuation does not carry it.
			holds = turns.beginTurnHolds();
			start("u1")();
			send(c1);
			await end("a1", { "nudge.a": "both", "nudge.b": "both" });
			const [a1, b1] = next(2);
			continueInRun(false);
			send(c2);
			call("u1", "verify", "t-check", { check: "test" });
			await end("a2", { "nudge.a": "both" });
			const [a2] = next(1);
			continueInRun(true);
			send(cLocked);
			turns.releaseTurnHolds(holds);
			ok(a1 && b1 && a2 && new Set([a1, b1, a2]).size === 3, `two firings of one rule stay distinct: ${ids()}`);
			// Turn 2: the delayed nudge is carried by this turn's first request; a read states nothing, an edit acts.
			// A block whose turn sees only reads and its own call's success is ignored, never recovered; the call is known
			// by its canonical identity, so its arguments in another key order are still its own.
			holds = turns.beginTurnHolds();
			start("u2")();
			send(c3);
			call("u2", "read", "t-read", { path: "a.ts" });
			call("u2", "edit", "t-edit", { path: "a.ts" });
			block("u2", "t-loop", { path: "loop", reason: "x" });
			const [g1] = next(1);
			send(c4);
			call("u2", "read", "t-read-2", { path: "b.ts" });
			call("u2", "bash", "t-again", { reason: "x", path: "loop" });
			await end("a3");
			turns.releaseTurnHolds(holds);
			// Turn 3: a lockout exhausts the block; a nudge whose continuation is spent and that buffered nothing else is
			// suppressed at once.
			holds = turns.beginTurnHolds();
			start("u3")();
			block("u3", "t-loop-2");
			const [g2] = next(1);
			escalate("lockout", "u3");
			send(c5);
			call("u3", "edit", "t-edit-2", { path: "c.ts" });
			await end("a4", { "nudge.a": "both", "nudge.b": "continue" });
			const [a3, b2] = next(2);
			turns.releaseTurnHolds(holds);
			// Turn 4: the carried nudge meets no receipt, so it is ignored, not moot. Its next firing is flushed into an
			// in-run continuation the run abandons before sending: it entered no request.
			holds = turns.beginTurnHolds();
			start("u4")();
			send(c6);
			await end("a5", { "nudge.a": "both" });
			const [a4] = next(1);
			continueInRun(false);
			turns.releaseTurnHolds(holds);
			// Turn 5: a silently rolled budget crossing and a lockout of no session end nothing, so the block recovers.
			holds = turns.beginTurnHolds();
			start("u5")();
			send(c7);
			hub.emit(
				"safety.tool_budget_exceeded",
				{ tool: "bash", callsThisTurn: 9, softBudget: 8, hardCeiling: 16, interrupted: false, rolled: true, at: 1 },
				{ sessionId, agent: { role: "main", id: sessionId }, turnId: "u5" },
			);
			hub.emit("safety.loop_blocked", {
				tool: "bash",
				repeatCount: 3,
				blocksThisTurn: 3,
				budget: 3,
				interrupted: false,
				disposition: "lockout",
				at: 1,
			});
			block("u5", "t-loop-3");
			const [g3] = next(1);
			send(c8);
			call("u5", "edit", "t-edit-3", { path: "d.ts" });
			await end("a6", { "nudge.a": "both" });
			const [a5] = next(1);
			turns.releaseTurnHolds(holds);
			// Turn 6: a request no journal lease records still carries the buffer, so its firing is admitted, under null.
			// A stop ends the turn before any request carries its block, which settles exhausted there.
			holds = turns.beginTurnHolds();
			start("u6")();
			send(null);
			block("u6", "t-loop-4");
			const [g4] = next(1);
			escalate("stop", "u6");
			await end("a7", { "nudge.memory": "continue" });
			const [m1] = next(1);
			turns.releaseTurnHolds(holds);
			// Turn 7: the gate's lock rides the turn's request. The memory nudge went stale before the request was
			// composed, so the request left it out and its firing is suppressed.
			holds = turns.beginTurnHolds();
			const admitted = await turns.awaitTurnStart(runtime, "start", 0, "u7");
			const [w4, w5] = next(2);
			const composed = start("u7", admitted.refusal === null ? admitted : undefined);
			memoryCurrent = false;
			ok(!composed().includes("Memory: recheck"));
			send(c10);
			await end("a8");
			turns.releaseTurnHolds(holds);
			// Turn 8: a nudge joins a deferred background reminder of the same text, and the tool batch boundary delivers
			// that reminder, so the request after it carries the nudge's firing.
			holds = turns.beginTurnHolds();
			start("u8")();
			send(c11);
			turns.injectDeferredReminder("background continue", "info");
			await end("a9", { "nudge.bg": "continue" });
			const [d1] = next(1);
			ok(await turns.prepareToolContinuation(runtime));
			send(c12);
			await end("a10");
			turns.releaseTurnHolds(holds);
			// Steering triage settles on its typed route: acted when the verdict applied, expired when the queue moved on.
			for (const current of [true, false])
				await runTriageRound({
					triage: { target: null, minQueued: 2, timeoutMs: 1000 },
					systemOne: {
						bound: () => true,
						ask: async () => ({
							value: { picks: [{ id: "q-1", relation: "continue", urgency: "next", mass: 1 }] },
							probabilities: false,
						}),
					} as unknown as TriageSystemOne,
					asked: [{ id: "q-1", text: "also check docs", kind: "steer" }],
					task: () => "",
					previous: () => "",
					current: () => current,
					apply: (verdicts) => collector.settleTriage(sessionId, verdicts, "q-1"),
					expired: (verdicts) => collector.settleTriage(sessionId, verdicts, null),
					side: async () => {},
				});
			const [t1, t2] = [...settled].flatMap(([id, row]) => (row.surface === "triage" ? [id] : []));
			const countOnly = fired.filter((row) => row.ruleId === "reminder.only");
			ok(countOnly.length > 0 && countOnly.every((row) => row.firingId === undefined));
			const expected = [
				[k0, "compaction.fixture", "suppressed", null, "none"],
				[w0, "gate.lock", "suppressed", null, "none"],
				[w1, "gate.continue", "suppressed", null, "none"],
				[w2, "gate.lock", "suppressed", null, "none"],
				[w3, "gate.continue", "suppressed", null, "none"],
				[a1, "nudge.a", "moot", c2, "receipt"],
				[b1, "nudge.b", "acted", c2, "receipt"],
				[a2, "nudge.a", "acted", c3, "receipt"],
				[g1, "guard.fixture", "ignored", c4, "none"],
				[g2, "guard.fixture", "exhausted", c5, "scope-end"],
				[a3, "nudge.a", "ignored", c6, "none"],
				[b2, "nudge.b", "suppressed", null, "none"],
				[a4, "nudge.a", "suppressed", null, "none"],
				[g3, "guard.fixture", "recovered", c8, "receipt"],
				[a5, "nudge.a", "ignored", null, "none"],
				[g4, "guard.fixture", "exhausted", null, "scope-end"],
				[m1, "nudge.memory", "suppressed", null, "none"],
				[w4, "gate.lock", "ignored", c10, "none"],
				[w5, "gate.continue", "suppressed", null, "none"],
				[d1, "nudge.bg", "ignored", c12, "none"],
				[t1, "triage", "acted", null, "receipt"],
				[t2, "triage", "expired", null, "none"],
			];
			deepStrictEqual(
				Object.fromEntries([...settled].sort(([x], [y]) => x.localeCompare(y))),
				Object.fromEntries(
					expected
						.map(([id, surface, outcome, admittedIn, fact]) => [id, { surface, outcome, admittedIn, fact }] as const)
						.sort(([x], [y]) => String(x).localeCompare(String(y))),
				),
			);
			strictEqual(ids().length + 2, settled.size);
			// The fold reads each settlement once, and a firing a worker drew under its run is labelled, not left open.
			records.push({
				k: "middleware.fired",
				data: { firingId: g1, hook: "before_tool", phase: "sync", ruleId: "guard.fixture", effects: ["block_tool"] },
				ctx: { sessionId, runId: "run-worker" },
			});
			const ledger = foldSideSurfaces(records as unknown as Parameters<typeof foldSideSurfaces>[0]).ledger;
			deepStrictEqual(
				ledger.map((row) => [row.surface, row.unsettled, row.duplicates, row.unledgered]),
				ledger.map((row) => [row.surface, 0, 0, row.surface === "guard.fixture" ? 1 : 0]),
			);
			strictEqual(ledger.find((row) => row.surface === "nudge.a")?.admitted, 3);
			// A second process draws from its own sequence: a session resumed there never reuses an id of the first.
			const other = (await import(
				`../../src/domains/middleware/fired-record.js?process=${process.pid}`
			)) as typeof import("../../src/domains/middleware/fired-record.js");
			const resumed = other.nextFiringId();
			ok(!ids().includes(resumed), `a resumed process reuses ${resumed}`);
			// The chat loop settles what a submit held before its turn lease flushes the journal, and what a turn's requests
			// carried when the turn ends without its turn_end hook (a throw before any reply) or the conversation resets mid-turn.
			const loopSession = "md12-chat-loop";
			const scratchEnv = await isolateClioEnv("clio-coder-md12-loop-");
			const loopCollector = createTurnOutcomeCollector();
			let lockAtStart = false;
			const loopMiddleware = createMiddlewareBundle({
				registrations: [
					loopCollector,
					registration("gate.lock", () => (lockAtStart ? [{ kind: "lock_tools" }] : []), { hooks: ["turn_start"] }),
					registration("guard.fixture", (input) =>
						input.toolCallId === "t-loop-chat" ? [{ kind: "block_tool", reason: "repeat", severity: "hard-block" }] : [],
					),
				],
			}).contract;
			const order: string[] = [];
			const loopFired: string[] = [];
			const loopSettled = new Map<string, { outcome: string; admittedIn: string | null }>();
			stops.push(
				hub.subscribe("middleware.fired", (payload, ctx) => {
					if (ctx?.sessionId === loopSession && payload.firingId !== undefined) loopFired.push(payload.firingId);
				}),
				hub.subscribe("surface.settled", (payload, ctx) => {
					if (ctx?.sessionId !== loopSession) return;
					ok(!loopSettled.has(payload.firingId), `settled twice: ${payload.firingId}`);
					loopSettled.set(payload.firingId, { outcome: payload.outcome, admittedIn: payload.admittedIn });
					order.push(`settled ${payload.firingId}`);
				}),
			);
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.chat.prewarm = false;
			const stubContext = dispatchStubContext({ settings });
			const target = settings.targets[0];
			ok(target);
			settings.chat.target = target.id;
			settings.chat.model = target.defaultModel ?? "gpt-4o";
			const entries: SessionEntry[] = [];
			let leaf: string | null = null;
			const journals = createSessionJournals(clioStateDir(), () => {
				throw new Error("fixture journal unavailable");
			});
			/** What the faux model does: reply, or fire and carry a block, then throw or reset the conversation. */
			let mode: "reply" | "throw" | "reset" = "reply";
			let settledAtReset: string[] = [];
			const loop: ReturnType<typeof createChatLoop> = createChatLoop({
				getSettings: () => settings,
				providers: stubContext.getContract("providers") as ProvidersContract,
				knownTargets: () => new Set([target.id]),
				session: {
					current: () => ({ id: loopSession, cwd: scratchEnv.dir, cwdHash: "md12-repo" }),
					tree: () => ({ leafId: leaf }),
					leafId: () => leaf,
					append(turn: TurnInput) {
						const turnId = `turn-${entries.length + 1}`;
						leaf = turnId;
						entries.push({
							kind: "message",
							turnId,
							parentTurnId: turn.parentId,
							timestamp: new Date().toISOString(),
							role: turn.kind,
							payload: turn.payload,
						} as SessionEntry);
						return { id: turnId };
					},
					appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
						const row = { ...entry, turnId: `entry-${entries.length + 1}`, timestamp: new Date().toISOString() };
						entries.push(row as SessionEntry);
						return row as SessionEntry;
					},
				} as unknown as SessionContract,
				readSessionEntries: () => entries,
				middleware: loopMiddleware,
				turnOutcomeCollector: loopCollector,
				bus: hub,
				telemetry: {
					async acquireTelemetrySession(...args: Parameters<typeof journals.acquire>) {
						const lease = await journals.acquire(...args);
						const release = lease.release.bind(lease);
						lease.release = async () => {
							order.push("release");
							await release();
						};
						return lease;
					},
				} as unknown as TelemetryContract,
				createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
					Object.assign(options?.initialState?.model ?? {}, { api: "openai-responses" });
					let listener: (event: AgentEvent) => unknown = () => {};
					const agentState = { ...options?.initialState, messages: [] as AgentMessage[] };
					return {
						requestCorrelationId: () => undefined,
						agent: {
							state: agentState,
							subscribe: (next: typeof listener) => {
								listener = next;
								return () => {};
							},
							abort() {},
							async prompt() {
								await listener({ type: "agent_start" });
								await listener({ type: "turn_start" });
								if (mode !== "reply") {
									// A tool hook's block fires and the request after it goes out: any send admits an in-run firing.
									loopMiddleware.runHook({
										sessionId: loopSession,
										hook: "before_tool",
										toolName: "bash",
										toolCallId: "t-loop-chat",
										toolArgs: {},
									});
									loopCollector.requestSent(null, []);
									if (mode === "throw") throw new Error("fixture prompt failed");
									loop.resetForSession(null);
									settledAtReset = [...loopSettled.keys()];
									return;
								}
								const message = {
									role: "assistant",
									content: [{ type: "text", text: "done" }],
									stopReason: "stop",
									timestamp: Date.now(),
								} as AgentMessage;
								agentState.messages.push(message);
								await listener({ type: "message_end", message });
								await listener({ type: "agent_end", messages: [message] });
							},
						},
					};
				}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
			});
			try {
				// A turn whose start armed a tool lock that no request carried: the lock settles before the lease releases.
				lockAtStart = true;
				await loop.submit("lock the tools");
				lockAtStart = false;
				const [l1] = loopFired;
				ok(l1 !== undefined);
				deepStrictEqual(loopSettled.get(l1), { outcome: "suppressed", admittedIn: null });
				ok(order.indexOf(`settled ${l1}`) < order.lastIndexOf("release"), order.join(", "));
				// The model throws before any reply, so no turn_end hook runs: the carried block still settles with the submit.
				mode = "throw";
				await loop.submit("throw before replying");
				const [, g5] = loopFired;
				ok(g5 !== undefined);
				deepStrictEqual(loopSettled.get(g5), { outcome: "ignored", admittedIn: null });
				// The conversation resets mid-turn: the turn's carried block settles with the reset, not at a later session.
				mode = "reset";
				await loop.submit("reset mid-turn");
				const [, , g6] = loopFired;
				ok(g6 !== undefined && settledAtReset.includes(g6), `open after the reset: ${g6}`);
				deepStrictEqual(loopSettled.get(g6), { outcome: "ignored", admittedIn: null });
			} finally {
				loop.dispose();
				await loop.whenSettled();
				await journals.closeAll();
				scratchEnv.restore();
			}
		} finally {
			detach();
			for (const stop of stops) stop();
		}
	});
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("marks both tool hooks only when the host supplies harness origin", async () => {
		const seen: MiddlewareHookInput[] = [];
		const recorder = registration(
			"origin-recorder",
			(input) => {
				seen.push(input);
				return [];
			},
			{ hooks: ["before_tool", "after_tool"] },
		);
		const middleware = createMiddlewareBundle({ registrations: [recorder] }).contract;
		const registry = createRegistry({ safety: createWorkerSafety(), middleware });
		registry.register({
			name: ToolNames.Read,
			description: "Read fixture",
			parameters: Type.Object({ origin: Type.String() }),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "fixture" }),
		});
		for (const options of [{ origin: "harness" }, {}] satisfies ToolInvokeOptions[]) {
			seen.length = 0;
			const result = await registry.invoke({ tool: ToolNames.Read, args: { origin: "harness" } }, options);
			strictEqual(result.kind, "ok");
			deepStrictEqual(
				seen.map((input) => input.hook),
				["before_tool", "after_tool"],
			);
			for (const input of seen) strictEqual(input.metadata?.origin, options.origin);
		}
	});

	it("records a check's pass only when the exit status is the check's own", async () => {
		const seen: MiddlewareHookInput[] = [];
		const recorder = registration(
			"check-recorder",
			(input) => {
				seen.push(input);
				return [];
			},
			{ hooks: ["after_tool"] },
		);
		const middleware = createMiddlewareBundle({ registrations: [recorder] }).contract;
		const registry = createRegistry({ safety: createWorkerSafety(), middleware });
		registry.register({
			name: ToolNames.Bash,
			description: "Bash fixture",
			parameters: Type.Object({ command: Type.String() }),
			baseActionClass: "execute",
			run: async () => ({ kind: "ok", output: "finished" }),
		});
		const effects = createRunEffectsRecorder(process.cwd());
		const outcomes: Array<[string | undefined, number | undefined, boolean, boolean | undefined]> = [];
		for (const command of ["pytest; echo finished", "pytest && echo finished"]) {
			seen.length = 0;
			strictEqual((await registry.invoke({ tool: ToolNames.Bash, args: { command } })).kind, "ok");
			effects.start(command, ToolNames.Bash, { command });
			effects.checkOutcome(command, "ok");
			effects.finish(command, false);
			const snapshot = effects.snapshot();
			outcomes.push([
				seen[0]?.metadata?.validationCommand as string | undefined,
				seen[0]?.metadata?.validationExitCode as number | undefined,
				snapshot.validationCommands.has(command),
				snapshot.validationOutcomes.get(command),
			]);
		}
		// A trailing `echo` exits 0 over a red suite: the check is named, its outcome unknown.
		deepStrictEqual(outcomes, [
			["pytest", undefined, false, undefined],
			["pytest", 0, true, true],
		]);
	});

	it("names the middleware rule that blocked a call on the guard block's policy", async () => {
		const guard = registration("edit-guard", () => [
			{ kind: "block_tool", reason: "stale edit", severity: "hard-block" },
		]);
		const quiet = registration("quiet", () => [{ kind: "annotate_tool_result", message: "seen", severity: "info" }]);
		const middleware = createMiddlewareBundle({ registrations: [quiet, guard] }).contract;
		const registry = createRegistry({ safety: createWorkerSafety(), middleware });
		registry.register({
			name: ToolNames.Read,
			description: "Read fixture",
			parameters: Type.Object({ path: Type.String() }),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "fixture" }),
		});
		const result = await registry.invoke({ tool: ToolNames.Read, args: { path: "a.txt" } });
		strictEqual(result.kind, "blocked");
		const policy = result.kind === "blocked" ? result.decision.policy : undefined;
		ok(policy !== undefined, "the guard block keeps the admission's policy");
		strictEqual(policy.reasonCode, "guard_block");
		strictEqual(policy.ruleId, "edit-guard");
	});

	it("does not admit hooks from an unverifiable installed extension", () => {
		const project = scratch();
		const outside = scratch();
		const extensionRoot = path.join(project, ".clio-coder", "extensions", "invalid-hooks");
		mkdirSync(extensionRoot, { recursive: true });
		mkdirSync(path.join(outside, "payload"));
		writeFileSync(
			path.join(extensionRoot, "clio-coder-extension.yaml"),
			["id: invalid-hooks", "name: Invalid Hooks", "version: 1.0.0", "description: Invalid hook fixture.", ""].join("\n"),
		);
		symlinkSync(path.join(outside, "payload"), path.join(extensionRoot, "payload"), "dir");
		writeFileSync(
			path.join(extensionRoot, "hooks.yaml"),
			"- id: must-not-load\n  on: turn_start\n  kind: prompt\n  message: unsafe\n",
		);

		const snapshot = buildExtensionSnapshot({ cwd: project, generation: 0 });
		strictEqual(snapshot.packages[0]?.loadable, false);
		deepStrictEqual(snapshot.hookSources, []);
		deepStrictEqual(readHookSources({ cwd: project, capturedSources: capturedHookSourcesFor(snapshot) }).batches, []);
	});

	it("builds extension hooks from captured bytes and attributes receipts to the admitting generation", () => {
		const project = scratch();
		const source = scratch();
		writeFileSync(
			path.join(source, "clio-coder-extension.yaml"),
			[
				"id: receipt-hooks",
				"name: Receipt Hooks",
				"version: 1.0.0",
				"description: Hook receipt provenance fixture.",
				"",
			].join("\n"),
		);
		writeFileSync(
			path.join(source, "hooks.yaml"),
			"- id: receipted\n  on: turn_start\n  kind: prompt\n  message: verify\n",
		);
		installExtension(source, { cwd: project, scope: "project" });
		trustProjectPackages(project, "extensions");
		const installed = listInstalledExtensions(project).find((entry) => entry.id === "receipt-hooks");
		strictEqual(installed?.loadable, true);
		const second = buildExtensionSnapshot({ cwd: project, generation: 2 });
		const [captured] = second.hookSources;
		ok(captured);
		// The bytes admitted are the ones the digest covered; a rewrite after the
		// snapshot was built cannot reach this generation's registrations.
		writeFileSync(
			path.join(project, ".clio-coder", "extensions", "receipt-hooks", "hooks.yaml"),
			"- id: rewritten\n  on: turn_start\n  kind: prompt\n  message: tampered\n",
		);
		const receipts: HookReceipt[] = [];
		const built = buildUserHookRegistrations({
			cwd: project,
			capturedSources: capturedHookSourcesFor(second),
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand: () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
			now: () => 123,
		});
		deepStrictEqual(built.fileIssues, []);
		deepStrictEqual(
			built.hooks.map((hook) => [hook.id, hook.source.origin, hook.source.extension?.generation]),
			[["receipted", "extension", 2]],
		);
		const [registration] = built.registrations;
		ok(registration);
		registration.evaluate({ hook: "turn_start" });
		deepStrictEqual(receipts[0]?.extension, {
			id: "receipt-hooks",
			scope: "project",
			canonicalRoot: captured.provenance.canonicalRoot,
			manifestDigest: captured.provenance.manifestDigest,
			contentDigest: captured.provenance.contentDigest,
			declarationsDigest: captured.declarationsDigest,
			generation: 2,
		});
		strictEqual(receipts[0]?.extension?.contentDigest, installed?.provenance?.contentDigest);

		// The rewritten tree no longer verifies, so the next generation admits no
		// extension hooks at all, while a registration built under generation 2
		// keeps writing generation 2 into its receipts.
		const third = buildExtensionSnapshot({ cwd: project, generation: 3 });
		deepStrictEqual(third.hookSources, []);
		const middleware = middlewareOwner(createMiddlewareBundle());
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, built.registrations).applied, true);
		const rebuilt = buildUserHookRegistrations({
			cwd: project,
			capturedSources: capturedHookSourcesFor(third),
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand: () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
			now: () => 456,
		});
		deepStrictEqual(rebuilt.registrations, []);
		strictEqual(middleware.replaceRegistrations("user-hooks", 3, rebuilt.registrations).applied, true);
		deepStrictEqual(middleware.runHook({ hook: "turn_start" }).ruleIds, []);
		registration.evaluate({ hook: "turn_start" });
		strictEqual(receipts.length, 2);
		strictEqual(receipts[1]?.extension?.generation, 2);
	});

	it("evaluates matching registrations in order and exposes prior effects", () => {
		const seen: string[][] = [];
		const first = registration("first", () => [{ kind: "inject_reminder", message: "prepare" }]);
		const second = registration("second", (_input, context) => {
			seen.push((context?.priorEffects ?? []).map(({ kind }) => kind));
			return [{ kind: "block_tool", reason: "protected", severity: "hard-block" }];
		});
		const result = runMiddlewareRegistrations({ hook: "before_tool", toolName: "write", toolArgs: { path: "PLAN.md" } }, [
			first,
			second,
		]);
		deepStrictEqual(result.ruleIds, ["first", "second"]);
		deepStrictEqual(result.effects, [
			{ kind: "inject_reminder", message: "prepare" },
			{ kind: "block_tool", reason: "protected", severity: "hard-block" },
		]);
		deepStrictEqual(seen, [["inject_reminder"]]);
	});

	it("isolates a failed registration and continues later effects", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const failed = registration("failed", () => {
			throw new Error("hook exploded");
		});
		const survivor = registration("survivor", () => [
			{ kind: "annotate_tool_result", message: "checked", severity: "info" },
		]);
		const result = runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [failed, survivor], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(result.ruleIds, ["survivor"]);
		deepStrictEqual(result.effects, [{ kind: "annotate_tool_result", message: "checked", severity: "info" }]);
		deepStrictEqual(diagnostics, [
			{ kind: "hook_failed", registrationId: "failed", hook: "before_tool", message: "hook exploded" },
		]);
	});

	it("records a stall but not a lone overrun short of one as a hook failure (bt-12)", () => {
		const tracker = createHookBudgetTracker();
		const diagnostics: MiddlewareDiagnostic[] = [];
		const observer = registration("observer", () => []);
		for (const elapsedMs of [40, 30, 300]) {
			const clock = [0, elapsedMs];
			runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [observer], {
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
				now: () => clock.shift() ?? 0,
				budgetTracker: tracker,
			});
		}
		// 40 is warmup and 30 a lone overrun of the 25 ms budget; 300 is past ten times it.
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "budget_exceeded" ? [diagnostic.elapsedMs, diagnostic.steadyStateWarn] : diagnostic.kind,
			),
			[[300, false]],
		);
	});

	it("matches exact hook and tool scopes", () => {
		const scoped = registration("write-only", () => [{ kind: "lock_tools" }], { toolNames: ["write"] });
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool", toolName: "write" }, [scoped]).effects.length, 1);
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [scoped]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool" }, [scoped]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "after_tool", toolName: "write" }, [scoped]).effects.length, 0);
	});

	it("serializes async phases in registration order and isolates rejection", async () => {
		const calls: string[] = [];
		const diagnostics: MiddlewareDiagnostic[] = [];
		const regs: MiddlewareHookRegistration[] = [
			registration("one", () => [], {
				evaluateAsync: async () => {
					calls.push("one");
					return [{ kind: "inject_reminder", message: "first" }];
				},
			}),
			registration("broken", () => [], {
				evaluateAsync: async () => {
					calls.push("broken");
					throw new Error("async failure");
				},
			}),
			registration("three", () => [], {
				evaluateAsync: async (_input, context) => {
					calls.push(`three:${context?.priorEffects.length ?? 0}`);
					return [{ kind: "request_continuation", message: "continue" }];
				},
			}),
		];
		const result = await runMiddlewareAsyncRegistrations({ hook: "before_tool", toolName: "write" }, regs, [], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(calls, ["one", "broken", "three:1"]);
		deepStrictEqual(result.effects, [
			{ kind: "inject_reminder", message: "first" },
			{ kind: "request_continuation", message: "continue" },
		]);
		strictEqual(diagnostics[0]?.kind, "hook_failed");
	});
});

const FIXED_RULE_ID = "rule.fixed";
const FIXED_RULE: MiddlewareRuleDefinition = {
	rule: {
		id: FIXED_RULE_ID,
		source: "builtin",
		description: "fixed rule fixture",
		enabled: true,
		hooks: ["before_tool"],
		effectKinds: ["inject_reminder"],
	},
	effects: [{ kind: "inject_reminder", message: FIXED_RULE_ID }],
};
const PROBE: MiddlewareHookInput = { hook: "before_tool", toolName: "read" };

function emitting(id: string, message = id): MiddlewareHookRegistration {
	return registration(id, () => [{ kind: "inject_reminder", message }]);
}

function messages(effects: ReadonlyArray<MiddlewareEffect>): string[] {
	return effects.map((effect) => (effect.kind === "inject_reminder" ? effect.message : effect.kind));
}

function ownedBundle(diagnostics: MiddlewareDiagnostic[] = []) {
	return middlewareOwner(
		createMiddlewareBundle({
			ruleDefinitions: [FIXED_RULE],
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		}),
	);
}

function permutations<T>(items: ReadonlyArray<T>): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
	);
}

describe("middleware generation-owned registrations", () => {
	it("replaces an owner's set as one unit under a strictly increasing generation", () => {
		const middleware = ownedBundle();
		const first = middleware.replaceRegistrations("user-hooks", 1, [emitting("a")]);
		strictEqual(first.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "a"]);
		const second = middleware.replaceRegistrations("user-hooks", 2, [emitting("b")]);
		strictEqual(second.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "b"]);
		for (const stale of [2, 1, 0, 1.5]) {
			const report = middleware.replaceRegistrations("user-hooks", stale, [emitting("c")]);
			deepStrictEqual(
				{ applied: report.applied, reason: report.reason, activeGeneration: report.activeGeneration },
				{ applied: false, reason: "stale", activeGeneration: 2 },
			);
		}
		strictEqual(middleware.ownedGeneration("user-hooks"), 2);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "b"]);
		const unknown = middleware.replaceRegistrations("nobody" as "user-hooks", 9, [emitting("z")]);
		strictEqual(unknown.reason, "unknown-owner");
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "b"]);
	});

	it("makes a stale disposer harmless and lets a prepared replacement refuse after supersession", () => {
		const middleware = ownedBundle();
		const three = middleware.replaceRegistrations("user-hooks", 3, [emitting("h3")]);
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, []).applied, false, "an older empty set is refused");
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "h3"]);
		const four = middleware.replaceRegistrations("user-hooks", 4, [emitting("h4")]);
		three.dispose();
		deepStrictEqual(
			middleware.runHook(PROBE).ruleIds,
			[FIXED_RULE_ID, "h4"],
			"disposing generation 3 cannot remove generation 4",
		);
		const prepared = middleware.prepareRegistrationReplacement("user-hooks", 5, [emitting("h5")]);
		strictEqual(prepared.status, "prepared");
		if (prepared.status !== "prepared") return;
		strictEqual(prepared.replacement.current(), true);
		strictEqual(middleware.replaceRegistrations("user-hooks", 6, [emitting("h6")]).applied, true);
		strictEqual(prepared.replacement.current(), false, "a superseded prepared replacement is no longer current");
		prepared.replacement.discard();
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "h6"]);
		four.dispose();
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "h6"]);
		const host = middleware.prepareRegistrationReplacement("user-hooks", 7, [emitting("h7")]);
		strictEqual(host.status, "prepared");
		if (host.status !== "prepared") return;
		middleware.registerHook(emitting("host.late"));
		strictEqual(host.replacement.current(), false, "a host registration after prepare invalidates the prepared list");
		host.replacement.discard();
		strictEqual(middleware.ownedGeneration("user-hooks"), 6);
		const applied = middleware.replaceRegistrations("user-hooks", 8, []);
		strictEqual(applied.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "host.late"]);
	});

	it("keeps builtin and host ids out of owned sets and lets a host registration evict an owned one", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const middleware = ownedBundle(diagnostics);
		middleware.registerHook(emitting("host.x"));
		const builtinId = BUILTIN_MIDDLEWARE_RULE_IDS[0] as string;
		const report = middleware.replaceRegistrations("user-hooks", 1, [
			emitting(builtinId, "owned-builtin"),
			emitting(FIXED_RULE_ID, "owned-fixed"),
			emitting("host.x", "owned-host"),
			emitting("u", "owned-u"),
			emitting("u", "owned-u-duplicate"),
		]);
		deepStrictEqual(report.dropped, [
			{ id: builtinId, conflictsWith: "builtin" },
			{ id: FIXED_RULE_ID, conflictsWith: "builtin" },
			{ id: "host.x", conflictsWith: "host" },
			{ id: "u", conflictsWith: "owned" },
		]);
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "registration_conflict"
					? [diagnostic.registrationId, diagnostic.conflictsWith, diagnostic.action, diagnostic.generation]
					: diagnostic.kind,
			),
			[
				[builtinId, "builtin", "dropped", 1],
				[FIXED_RULE_ID, "builtin", "dropped", 1],
				["host.x", "host", "dropped", 1],
				["u", "owned", "dropped", 1],
			],
		);
		const before = middleware.runHook(PROBE);
		deepStrictEqual(before.ruleIds, [FIXED_RULE_ID, "host.x", "u"]);
		deepStrictEqual(messages(before.effects), [FIXED_RULE_ID, "host.x", "owned-u"]);
		diagnostics.length = 0;
		middleware.registerHook(emitting("u", "host-u"));
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "registration_conflict"
					? [diagnostic.registrationId, diagnostic.conflictsWith, diagnostic.action]
					: diagnostic.kind,
			),
			[["u", "host", "evicted"]],
		);
		const after = middleware.runHook(PROBE);
		deepStrictEqual(after.ruleIds, [FIXED_RULE_ID, "host.x", "u"]);
		deepStrictEqual(messages(after.effects), [FIXED_RULE_ID, "host.x", "host-u"]);
		strictEqual(middleware.snapshot().rules[0]?.id, builtinId, "builtin rules stay first in the declarative order");
	});

	it("anchors the owned slot where it was first applied and keeps it there across replacements", () => {
		const middleware = ownedBundle();
		middleware.registerHook(emitting("A"));
		strictEqual(middleware.replaceRegistrations("user-hooks", 1, [emitting("u")]).applied, true);
		middleware.registerHook(emitting("B"));
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "A", "u", "B"]);
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, [emitting("v"), emitting("w")]).applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "A", "v", "w", "B"]);
		const worker = middlewareOwner(createMiddlewareHostFromSnapshot(middleware.snapshot()));
		strictEqual(worker.replaceRegistrations("user-hooks", 1, [emitting("worker-u")]).applied, true);
		strictEqual(worker.ownedGeneration("user-hooks"), 1);
		deepStrictEqual(worker.runHook(PROBE).ruleIds, ["worker-u"], "the worker contract honours the same owner semantics");
	});

	it("finishes an in-flight async evaluation against its captured list while later evaluations use the new one", async () => {
		const middleware = ownedBundle();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const u1 = registration("u1", () => [], {
			evaluateAsync: async () => {
				await gate;
				return [{ kind: "inject_reminder", message: "u1" }];
			},
		});
		const u2 = registration("u2", () => [], {
			evaluateAsync: async () => [{ kind: "inject_reminder", message: "u2" }],
		});
		strictEqual(middleware.replaceRegistrations("user-hooks", 1, [u1]).applied, true);
		ok(middleware.runAsyncHook);
		const inFlight = middleware.runAsyncHook(PROBE);
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, [u2]).applied, true);
		release();
		const old = await inFlight;
		deepStrictEqual(old.ruleIds, ["u1"]);
		const fresh = await middleware.runAsyncHook(PROBE);
		deepStrictEqual(fresh.ruleIds, ["u2"]);
	});

	it("matches a reference model across every ordering of replace, dispose, host, and evaluate", () => {
		type Op = "R2" | "R3" | "D2" | "H" | "E";
		const orderings = permutations<Op>(["R2", "R3", "D2", "H", "E"]);
		strictEqual(orderings.length, 120);
		for (const ordering of orderings) {
			const middleware = ownedBundle();
			const model = { generation: 0, owned: [] as string[], disposeTwo: false };
			let disposeTwo: (() => void) | null = null;
			let hostRegistered = false;
			const observe = (): void => {
				const result = middleware.runHook(PROBE);
				const ids = result.ruleIds.filter((id) => id !== FIXED_RULE_ID && id !== "x");
				deepStrictEqual(ids, model.owned, `owned ids after ${ordering.join(",")}`);
				strictEqual(result.ruleIds.includes("x"), hostRegistered, `host presence after ${ordering.join(",")}`);
				strictEqual(new Set(result.ruleIds).size, result.ruleIds.length, `duplicate id after ${ordering.join(",")}`);
				strictEqual(result.ruleIds[0], FIXED_RULE_ID);
			};
			for (const op of ordering) {
				if (op === "R2") {
					const report = middleware.replaceRegistrations("user-hooks", 2, [emitting("a")]);
					if (2 > model.generation) {
						model.generation = 2;
						model.owned = ["a"];
						model.disposeTwo = true;
						disposeTwo = report.dispose;
						strictEqual(report.applied, true);
					} else strictEqual(report.applied, false);
				} else if (op === "R3") {
					const report = middleware.replaceRegistrations("user-hooks", 3, [emitting("b")]);
					strictEqual(report.applied, true);
					model.generation = 3;
					model.owned = ["b"];
				} else if (op === "D2") {
					disposeTwo?.();
					if (model.disposeTwo && model.generation === 2) model.owned = [];
				} else if (op === "H") {
					middleware.registerHook(emitting("x"));
					hostRegistered = true;
				} else observe();
				observe();
			}
		}
	});
});

describe("middleware registration table publication", () => {
	it("holds one copy-on-write state reference and publishes with an assignment that cannot refuse", () => {
		const middleware = ownedBundle();
		const before = middleware.runHook(PROBE);
		const listBefore = middleware.snapshot().rules;
		ok(listBefore.length > 0);
		const prepared = middleware.prepareRegistrationReplacement("user-hooks", 1, [emitting("u")]);
		strictEqual(prepared.status, "prepared");
		if (prepared.status !== "prepared") return;
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, before.ruleIds, "prepare publishes nothing");
		strictEqual(prepared.replacement.current(), true);
		strictEqual(prepared.replacement.publish(), undefined, "publish returns nothing and cannot report a refusal");
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "u"]);
		strictEqual(middleware.ownedGeneration("user-hooks"), 1);
		// The published state is one frozen reference; a second publish of a
		// newer prepared state swaps the reference, and the old one is intact.
		const second = middleware.prepareRegistrationReplacement("user-hooks", 2, [emitting("v")]);
		strictEqual(second.status, "prepared");
		if (second.status !== "prepared") return;
		second.replacement.publish();
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "v"]);
		strictEqual(prepared.replacement.current(), false);
		strictEqual(second.replacement.current(), false, "a published replacement is settled");
	});

	it("never invokes the diagnostic sink during preparation and survives a sink that registers a colliding host", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		let sinkCalls = 0;
		const middleware = middlewareOwner(
			createMiddlewareBundle({
				ruleDefinitions: [FIXED_RULE],
				onDiagnostic: (diagnostic) => {
					sinkCalls += 1;
					diagnostics.push(diagnostic);
					// A hostile or careless sink registers a host hook that takes an id
					// the owned set just accepted. Preparation must not have exposed the
					// prepared list to this; publication must already be complete.
					middleware.registerHook(emitting("v", "host-v"));
				},
			}),
		);
		const prepared = middleware.prepareRegistrationReplacement("user-hooks", 1, [
			emitting("u"),
			emitting("u", "owned-u-duplicate"),
			emitting("v", "owned-v"),
		]);
		strictEqual(sinkCalls, 0, "preparation emits nothing");
		strictEqual(prepared.status, "prepared");
		if (prepared.status !== "prepared") return;
		deepStrictEqual(
			prepared.replacement.conflicts.map((conflict) => [conflict.registrationId, conflict.conflictsWith, conflict.action]),
			[["u", "owned", "dropped"]],
		);
		strictEqual(prepared.replacement.current(), true);
		prepared.replacement.publish();
		strictEqual(sinkCalls, 0, "publication emits nothing");
		prepared.replacement.emitConflicts();
		ok(sinkCalls >= 1);
		const result = middleware.runHook(PROBE);
		strictEqual(new Set(result.ruleIds).size, result.ruleIds.length, "no duplicate ids after sink re-entry");
		deepStrictEqual(result.ruleIds, [FIXED_RULE_ID, "u", "v"]);
		deepStrictEqual(
			messages(result.effects),
			[FIXED_RULE_ID, "u", "host-v"],
			"the host registration evicted the owned v",
		);
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "registration_conflict" ? [diagnostic.registrationId, diagnostic.action] : diagnostic.kind,
			),
			[
				["u", "dropped"],
				["v", "evicted"],
			],
		);
		strictEqual(middleware.ownedGeneration("user-hooks"), 1);
		// The one-call form behaves identically: conflicts emit after publish.
		sinkCalls = 0;
		const report = middleware.replaceRegistrations("user-hooks", 2, [emitting("w"), emitting("w")]);
		strictEqual(report.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "w", "v"]);
	});
});

describe("user hook applicability", () => {
	const source = { origin: "project" as const, sourcePath: "hooks.yaml" };
	const options = { workspaceRoot: "/workspace" };
	const issuesFor = (raw: Record<string, unknown>): string[] => normalizeUserHook(raw, source, options).issues;

	it("rejects a hook whose event cannot apply the effect it produces, naming the events that can", () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[
				{ on: "before_tool", kind: "prompt", message: "m" },
				/before_tool cannot apply inject_reminder.*turn_start, turn_end/u,
			],
			[
				{ on: "after_tool", kind: "effect", effect: { kind: "block_tool", reason: "r", severity: "hard-block" } },
				/after_tool cannot apply block_tool.*before_tool/u,
			],
			[{ on: "turn_end", kind: "command", argv: ["true"] }, /turn_end cannot apply annotate_tool_result/u],
			[{ on: "on_compaction", kind: "prompt", message: "m" }, /on_compaction cannot apply inject_reminder/u],
			[
				{ on: "turn_end", kind: "effect", effect: { kind: "lock_tools" } },
				/turn_end cannot apply lock_tools.*before_tool, after_tool, turn_start/u,
			],
		];
		for (const [raw, expected] of cases) {
			const result = normalizeUserHook(raw, source, options);
			strictEqual(result.hook, undefined, JSON.stringify(raw));
			ok(
				result.issues.some((issue) => expected.test(issue)),
				`${JSON.stringify(raw)}: ${result.issues.join("; ")}`,
			);
		}
	});

	it("admits each event paired with an effect it applies", () => {
		deepStrictEqual(issuesFor({ on: "turn_start", kind: "prompt", message: "m" }), []);
		deepStrictEqual(issuesFor({ on: "turn_end", kind: "command", argv: ["true"], as: "reminder" }), []);
		deepStrictEqual(issuesFor({ on: "after_tool", kind: "command", argv: ["true"] }), []);
		deepStrictEqual(
			issuesFor({
				on: "before_tool",
				kind: "effect",
				effect: { kind: "block_tool", reason: "r", severity: "hard-block" },
			}),
			[],
		);
		deepStrictEqual(
			issuesFor({ on: "turn_end", kind: "effect", effect: { kind: "request_continuation", message: "m" } }),
			[],
		);
	});

	it("receipts a command hook's run time, its own limit and the effect its output became (D2-2)", () => {
		const hook = normalizeUserHook(
			{ id: "lint", on: "before_tool", tools: ["read"], kind: "command", argv: ["lint"], timeoutMs: 1500 },
			source,
			options,
		).hook;
		ok(hook);
		const receipts: HookReceipt[] = [];
		const registration = userHookToRegistration(hook, {
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand: () => ({ code: 1, timedOut: false, stdout: "lint failed\n", stderr: "" }),
		});
		deepStrictEqual(registration.evaluate({ hook: "before_tool", toolName: "read" }), [
			{ kind: "annotate_tool_result", message: "lint failed" },
		]);
		const [receipt] = receipts;
		strictEqual(receipt?.outcome, "command-failed");
		strictEqual(receipt.timeoutMs, 1500);
		ok(typeof receipt.durationMs === "number" && receipt.durationMs >= 0);
		deepStrictEqual(receipt.effectKinds, ["annotate_tool_result"]);
	});

	it("surfaces a command hook's first-run stall and receipts a thrown hook as failed, not skipped (D2-3)", () => {
		const hook = normalizeUserHook(
			{ id: "cold", on: "turn_start", kind: "command", argv: ["npx", "x"], as: "reminder" },
			source,
			options,
		).hook;
		ok(hook);
		const receipts: HookReceipt[] = [];
		let run: UserHookCommandRunner = () => ({ code: 0, timedOut: false, stdout: "", stderr: "" });
		const cold = userHookToRegistration(hook, {
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand: (argv, runOptions) => run(argv, runOptions),
		});
		const inProcess = registration("in-process", () => [], { hooks: ["turn_start"] });
		const clock = [0, 5000, 5000, 10_000];
		const diagnostics: MiddlewareDiagnostic[] = [];
		// Both overrun on their first call; only the subprocess is denied the warmup grace.
		runMiddlewareRegistrations({ hook: "turn_start" }, [cold, inProcess], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			now: () => clock.shift() ?? 0,
		});
		deepStrictEqual(
			diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.registrationId]),
			[["budget_exceeded", "cold"]],
		);
		// A lone stall is no steady-state slowness, but the operator still hears of it, once (EX-2).
		const stall = { kind: "budget_exceeded", registrationId: "cold", hook: "turn_start", elapsedMs: 5000, budgetMs: 50 };
		const seen = new Set<string>();
		ok(
			middlewareHookFailedSessionNotice({ ...stall, steadyStateWarn: false }, seen)?.text.includes(
				"stalled on turn_start",
			),
		);
		strictEqual(middlewareHookFailedSessionNotice({ ...stall, steadyStateWarn: false }, seen), null);
		strictEqual(middlewareHookFailedSessionNotice({ ...stall, elapsedMs: 60, steadyStateWarn: false }, new Set()), null);
		run = () => {
			throw new Error("spawn exploded");
		};
		diagnostics.length = 0;
		runMiddlewareRegistrations({ hook: "turn_start" }, [cold], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		strictEqual(receipts.at(-1)?.outcome, "failed");
		deepStrictEqual(diagnostics, [
			{ kind: "hook_failed", registrationId: "cold", hook: "turn_start", message: "spawn exploded" },
		]);
	});

	it("strips operator-notification rules from the snapshot workers receive", () => {
		const rule = (id: string, effectKinds: MiddlewareRule["effectKinds"]): MiddlewareRule => ({
			id,
			source: "builtin",
			description: id,
			enabled: true,
			hooks: ["turn_end"],
			effectKinds,
		});
		const snapshot = createMiddlewareSnapshot([
			rule("notifies", ["inject_reminder", "notify_operator"]),
			rule("continues", ["request_continuation"]),
		]);
		deepStrictEqual(
			snapshot.rules.map((entry) => entry.id),
			["continues"],
		);
	});
});
