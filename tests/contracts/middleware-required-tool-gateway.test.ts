import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareHookRegistration } from "../../src/domains/middleware/runtime.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import { FINISH_CONTRACT_REGISTRATION_ID } from "../../src/domains/safety/finish-contract-registration.js";
import { setValidationWrappers } from "../../src/domains/safety/protected-artifacts.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { ToolRoundRecord } from "../../src/engine/types.js";
import { createTurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { createTurnOutcomeCollector } from "../../src/session-control/turn-outcome-collector.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { effectiveToolCall } from "../../src/tools/surface.js";

test("a required capability clears when a gateway call carries it, not on other gateway ops", () => {
	const control = createMiddlewareToolChoiceControl();
	control.apply([{ kind: "require_tool", toolName: "extension_desk__gate" }]);
	control.toolStarted("gateway", { op: "describe", capability: "extension_desk__gate" });
	deepStrictEqual(control.current(), { kind: "required", toolName: "extension_desk__gate" });
	control.toolStarted("gateway", { op: "call", capability: "extension_desk__status", args: {} });
	deepStrictEqual(control.current(), { kind: "required", toolName: "extension_desk__gate" });
	control.toolStarted("gateway", { op: "call", capability: "extension_desk__gate", args: {} });
	deepStrictEqual(control.current(), { kind: "auto" });
	control.apply([{ kind: "require_tool", toolName: "read" }]);
	control.toolStarted("read", { path: "a.ts" });
	deepStrictEqual(control.current(), { kind: "auto" });
});

test("a gateway shorthand the gateway runs as a call meets the requirement at start and at round completion", () => {
	const shorthand = { capability: "extension_desk__next", args: "{}" };
	deepStrictEqual(effectiveToolCall("gateway", shorthand), {
		toolName: "extension_desk__next",
		args: {},
		viaGateway: true,
	});
	const control = createMiddlewareToolChoiceControl();
	control.apply([{ kind: "require_tool", toolName: "extension_desk__next" }]);
	control.toolStarted("gateway", { capability: "extension_desk__next" });
	deepStrictEqual(control.current(), { kind: "required", toolName: "extension_desk__next" });
	const round = { kind: "required", toolName: "extension_desk__next", choice: "auto", attempt: 0 } as ToolRoundRecord;
	const message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "gateway", arguments: shorthand }],
		stopReason: "toolUse",
		toolRounds: [round],
	} as unknown as Parameters<typeof control.completeRound>[0];
	strictEqual(control.completeRound(message), null);
	strictEqual(round.enforcement, undefined);
	control.toolStarted("gateway", shorthand);
	deepStrictEqual(control.current(), { kind: "auto" });
});

test("finish consumers: the stalled-turn nudge yields to the pinned round unattended, the finish gate settles on checks that speak for themselves, and the side arm and bank status read the declaration (memory design MD14)", async () => {
	const sessionId = "md14-finish-consumers";
	const hub = telemetryHub();
	const settled = new Map<string, { surface: string; outcome: string; fact: string }>();
	const fired: string[] = [];
	const firedBy = new Map<string, string>();
	const stops = [
		hub.subscribe("surface.settled", (payload, ctx) => {
			if (ctx?.sessionId === sessionId)
				settled.set(payload.firingId, { surface: payload.surface, outcome: payload.outcome, fact: payload.fact.kind });
		}),
		hub.subscribe("middleware.fired", (payload, ctx) => {
			if (ctx?.sessionId !== sessionId || payload.firingId === undefined) return;
			fired.push(payload.firingId);
			firedBy.set(payload.firingId, payload.ruleId);
		}),
	];
	let gateOn = false;
	let otherOn = false;
	const collector = createTurnOutcomeCollector();
	const gate: MiddlewareHookRegistration = {
		id: FINISH_CONTRACT_REGISTRATION_ID,
		description: "finish gate fixture",
		hooks: ["turn_end"],
		evaluate: () =>
			gateOn ? [{ kind: "request_continuation", message: "gate: run a check", fact: "unvalidated_mutation" }] : [],
	};
	const other: MiddlewareHookRegistration = {
		id: "nudge.fixture",
		description: "another continuation producer",
		hooks: ["turn_end"],
		evaluate: () => (otherOn ? [{ kind: "request_continuation", message: "fixture: continue" }] : []),
	};
	const middleware = createMiddlewareBundle({ registrations: [collector, gate, other] }).contract;
	const state = createTurnState("off");
	const turns = createTurnMiddleware({
		state,
		middleware,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: () => {},
		session: { current: () => ({ id: sessionId }) } as unknown as SessionContract,
		suppressFirings: (ids) => collector.suppressFirings(ids),
	});
	stops.push(
		collector.attachLedger(
			hub,
			() => sessionId,
			() => turns.heldFirings(),
		),
	);
	const runtime = {
		wireModelId: "faux",
		runtimeResolution: {},
		agent: { state: { tools: [], messages: [] } },
	} as unknown as AgentRuntime;
	const end = (text: string, pinFinishRound: () => boolean) => {
		state.activeUserTurnId = "user-1";
		const reply = [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }];
		return turns.fireTurnEnd(
			runtime,
			reply as unknown as Parameters<typeof turns.fireTurnEnd>[1],
			undefined,
			pinFinishRound,
		);
	};
	const send = () => {
		turns.flushPendingReminders();
		collector.requestSent("call", turns.requestCarried());
	};
	const call = (
		toolName: string,
		toolCallId: string,
		toolArgs: Record<string, unknown>,
		state?: string,
		receipt: Record<string, unknown> = {},
	) => {
		const base = { sessionId, turnId: "user-1", toolName, toolCallId, toolArgs };
		middleware.runHook({ ...base, hook: "before_tool" });
		const details = state === undefined ? receipt : { completion: { state, limitations: [], unverified: [] } };
		middleware.runHook({ ...base, hook: "after_tool", metadata: { resultKind: "ok" }, toolResultDetails: details });
	};
	const announced = "Let me run the tests in tests/foo.test.ts.";
	const last = () => settled.get(fired.at(-1) ?? "");
	const lastOf = (rule: string) => [...fired].reverse().find((id) => firedBy.get(id) === rule) ?? "";
	const exit0 = { outcome: "success", exitCode: 0 };
	// A declared validation wrapper resolves from the working directory, so the row runs in a scratch tree that has one.
	const root = mkdtempSync(join(tmpdir(), "clio-coder-md14-"));
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts", "test-slot.sh"), '#!/bin/sh\nexec "$@"\n');
	chmodSync(join(root, "scripts", "test-slot.sh"), 0o755);
	const cwd = process.cwd();
	process.chdir(root);
	setValidationWrappers(["scripts/test-slot.sh"]);
	/** A memory intervention under `lessons: side`: the arms a declared `done` takes after `steps`, and the bank status. */
	const side = (
		steps: Array<[string, Record<string, unknown>, Record<string, unknown>, string | undefined, string?]>,
		remaining?: string,
	) => {
		const bank = new TaskMemoryBank();
		const memory = createMemoryInterventionRegistration({
			bank,
			workspaceRoot: () => root,
			surfaces: { correct: "rules", bank: "rules", lessons: "side" },
		});
		memory.evaluate({ hook: "turn_start", sessionId: "S", turnId: "u1", text: "fix it" });
		steps.forEach(([toolName, toolArgs, toolResultDetails, resultKind, actionClass], index) => {
			memory.evaluate({
				hook: "after_tool",
				sessionId: "S",
				turnId: "u1",
				toolName,
				toolCallId: String(index),
				toolArgs,
				metadata: { ...(resultKind ? { resultKind } : {}), ...(actionClass ? { actionClass } : {}) },
				toolResultDetails,
			});
		});
		const declared = remaining === undefined ? "done" : "partly_done";
		memory.evaluate({
			hook: "turn_end",
			sessionId: "S",
			turnId: "a1",
			text: "done",
			metadata: {
				stopReason: "stop",
				completionState: declared,
				...(remaining === undefined ? {} : { completionRemaining: remaining }),
			},
		});
		return { arms: memory.sideArmCount(), status: bank.snapshot().status?.content ?? "" };
	};
	try {
		// Attended: no pinned round can go out, so the prose nudge stands.
		strictEqual(await end(announced, () => false), false);
		strictEqual(state.continuation.requested, true);
		const nudged = fired.at(-1);
		// Unattended: the same zero-tool announcement yields to the pinned finish round and asks for no prose continuation;
		// the round's request carries the firing, and the declaration it asks for settles it `acted`.
		const fresh = createTurnState("off");
		Object.assign(state, { continuation: fresh.continuation });
		strictEqual(await end(announced, () => true), true);
		strictEqual(state.continuation.requested, false);
		const yielded = fired.at(-1);
		ok(yielded !== undefined && yielded !== nudged);
		send();
		call("finish", "c-finish", { state: "done" }, "done");
		deepStrictEqual(settled.get(yielded), { surface: "nudge.stalled-turn", outcome: "acted", fact: "declaration" });
		collector.endTurn();
		// The finish gate claims a check receipt and not an edit, settles `ignored` without one, and `moot` on a declared
		// unfinished state.
		gateOn = true;
		const gated = async () => {
			state.continuation.beginPrompt({ requestContinuation: false, yoloContinuation: false });
			await end("done.", () => false);
			send();
		};
		await gated();
		call("edit", "c-edit", { path: "a.ts", edits: [] });
		strictEqual(last(), undefined);
		call("verify", "c-verify", { check: "test" });
		deepStrictEqual(last(), { surface: FINISH_CONTRACT_REGISTRATION_ID, outcome: "acted", fact: "receipt" });
		await gated();
		call("edit", "c-edit-2", { path: "b.ts", edits: [] });
		collector.endTurn();
		deepStrictEqual(last(), { surface: FINISH_CONTRACT_REGISTRATION_ID, outcome: "ignored", fact: "none" });
		await gated();
		call("finish", "c-partly", { state: "partly_done" }, "partly_done");
		deepStrictEqual(last(), { surface: FINISH_CONTRACT_REGISTRATION_ID, outcome: "moot", fact: "declaration" });
		// A check whose exit is not its own, or that a change follows in the same command, settles nothing; one behind a
		// declared wrapper does.
		for (const [index, command] of ["pytest || true", "npm test; echo done", "npm test && node rewrite.mjs"].entries()) {
			await gated();
			call("bash", `c-masked-${index}`, { command }, undefined, exit0);
			strictEqual(settled.get(lastOf(FINISH_CONTRACT_REGISTRATION_ID)), undefined, command);
			collector.endTurn();
		}
		await gated();
		call("bash", "c-wrapped", { command: "scripts/test-slot.sh node --test foo.test.ts" }, undefined, exit0);
		strictEqual(settled.get(lastOf(FINISH_CONTRACT_REGISTRATION_ID))?.outcome, "acted");
		gateOn = false;
		// A limitation still states progress for every other surface (MD12).
		otherOn = true;
		await gated();
		otherOn = false;
		call("limitation", "c-limit", { scope: "live run", reason: "no model" });
		strictEqual(settled.get(lastOf("nudge.fixture"))?.outcome, "acted");
		collector.endTurn();
		// Another continuation in the same pass carries the turn on, so the nudge takes its own path and is not armed for
		// that request.
		Object.assign(state, { continuation: createTurnState("off").continuation });
		otherOn = true;
		strictEqual(await end(announced, () => true), false);
		otherOn = false;
		ok(!turns.requestCarried().includes(lastOf("nudge.stalled-turn")));
		collector.endTurn();
		turns.clearPendingReminders();
		// Once the pinned round is spent, the prose nudge is no fallback: nothing fires.
		Object.assign(state, { continuation: createTurnState("off").continuation, finishRoundSpent: true });
		const stalledFirings = fired.filter((id) => firedBy.get(id) === "nudge.stalled-turn").length;
		strictEqual(await end(announced, () => false), false);
		strictEqual(fired.filter((id) => firedBy.get(id) === "nudge.stalled-turn").length, stalledFirings);
		strictEqual(state.continuation.requested, false);
		// lessons: side arms on a declared `done` beside a passed check no change came after, a chain's step included; the
		// bank's status takes the redacted `remaining`.
		const verify: [string, Record<string, unknown>, Record<string, unknown>, string] = [
			"verify",
			{ check: "test" },
			{},
			"ok",
		];
		strictEqual(side([verify]).arms, 1);
		strictEqual(side([verify, ["edit", { path: "a.ts", edits: [] }, {}, "ok", "write"]]).arms, 0);
		strictEqual(side([verify, ["bash", { command: "echo x > a.txt" }, exit0, "ok", "execute"]]).arms, 0);
		strictEqual(side([["bash", { command: "pytest || true" }, exit0, "ok", "execute"]]).arms, 0);
		strictEqual(side([["bash", { command: "npm test && node rewrite.mjs" }, exit0, "ok", "execute"]]).arms, 0);
		strictEqual(side([["bash", { command: "scripts/test-slot.sh node --test a.test.ts" }, exit0, "ok"]]).arms, 1);
		strictEqual(side([["verify", { check: "test" }, {}, undefined]]).arms, 0);
		const admission = { outcome: "ok", decision: "allowed", actionClass: "execute" };
		const chain = {
			op: "chain",
			chainResults: [
				{
					id: "v",
					capability: "verify",
					args: { check: "test" },
					result: { details: { kind: "ok", chainAdmission: admission } },
				},
			],
		};
		strictEqual(side([["gateway", { op: "chain", steps: [] }, chain, "ok"]]).arms, 1);
		const token = `ghp_${"a1B2".repeat(10)}`;
		const status = side([], `rotate ${token} in deploy\nadd docs`).status;
		ok(status.startsWith("declared partly_done; remaining: rotate ") && status.endsWith("; add docs"), status);
		ok(!status.includes(token), status);
	} finally {
		for (const stop of stops) stop();
		setValidationWrappers([]);
		process.chdir(cwd);
		rmSync(root, { recursive: true, force: true });
	}
});
