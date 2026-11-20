import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Type } from "typebox";
import { validPayload } from "../../src/core/telemetry/events.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newCallId } from "../../src/core/telemetry/ids.js";
import { ToolNames } from "../../src/core/tool-names.js";
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
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareRule } from "../../src/domains/middleware/types.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { capturedHookSourcesFor } from "../../src/entry/extension-hook-sources.js";
import { middlewareHookFailedSessionNotice } from "../../src/interactive/bus-notices.js";
import { createTurnOutcomeCollector } from "../../src/session-control/turn-outcome-collector.js";
import type { ToolInvokeOptions } from "../../src/tools/registry.js";
import { createRegistry } from "../../src/tools/registry.js";
import { middlewareOwner } from "../harness/middleware-owner.js";
import { trustProjectPackages } from "../harness/project-trust.js";

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

	it("settles each firing once against the request that carried it and the typed fact after it (memory design MD12)", () => {
		const sessionId = "md12-outcome-ledger";
		const collector = createTurnOutcomeCollector();
		const nudge = (id: string, flag: string): MiddlewareHookRegistration =>
			registration(
				id,
				(input) =>
					input.metadata?.[flag] === true
						? [
								{ kind: "inject_reminder", message: `${id} reminder` },
								{ kind: "request_continuation", message: `${id} continue` },
							]
						: [],
				{ hooks: ["turn_end"] },
			);
		const middleware = createMiddlewareBundle({
			registrations: [
				collector,
				nudge("nudge.a", "fireA"),
				nudge("nudge.b", "fireB"),
				registration("reminder.only", () => [{ kind: "inject_reminder", message: "count only" }], {
					hooks: ["turn_end"],
				}),
				registration("guard.fixture", (input) =>
					input.toolArgs?.path === "loop" ? [{ kind: "block_tool", reason: "repeat", severity: "hard-block" }] : [],
				),
			],
		}).contract;
		const hub = telemetryHub();
		const fired: Array<{ ruleId: string; firingId?: string }> = [];
		const settled = new Map<string, { surface: string; outcome: string; admittedIn: string | null; fact: string }>();
		const stops = [
			hub.subscribe("middleware.fired", (payload, ctx) => {
				if (ctx?.sessionId === sessionId) fired.push(payload);
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
			}),
		];
		const detach = collector.attachLedger(hub, () => sessionId);
		const hook = (input: MiddlewareHookInput) => middleware.runHook({ sessionId, ...input });
		const ids = () => fired.flatMap((row) => (row.firingId === undefined ? [] : [row.firingId]));
		const call = (turnId: string, toolName: string, toolCallId: string, toolArgs: Record<string, unknown>) => {
			hook({ hook: "before_tool", turnId, toolName, toolCallId, toolArgs });
			hook({ hook: "after_tool", turnId, toolName, toolCallId, toolArgs, metadata: { resultKind: "ok" } });
		};
		const [c1, c2, c3, c4, c5, c6] = [newCallId(), newCallId(), newCallId(), newCallId(), newCallId(), newCallId()];
		try {
			// Turn 1: two nudges ride one request; one check credits the later firing and the other is moot. The same
			// rule fires again in the same turn under a new id, and waits for the next turn's request.
			hook({ hook: "turn_start", turnId: "u1" });
			collector.requestSent(c1);
			hook({ hook: "turn_end", turnId: "a1", metadata: { userTurnId: "u1", fireA: true, fireB: true } });
			const [a1, b1] = ids();
			collector.requestSent(c2);
			call("u1", "verify", "t-check", { check: "test" });
			hook({ hook: "turn_end", turnId: "a2", metadata: { userTurnId: "u1", fireA: true } });
			const a2 = ids()[2];
			ok(a1 && b1 && a2 && new Set([a1, b1, a2]).size === 3, `two firings of one rule stay distinct: ${ids()}`);
			deepStrictEqual(
				fired.filter((row) => row.ruleId === "reminder.only").map((row) => row.firingId),
				[undefined, undefined],
			);
			// Turn 2: the delayed nudge is carried by this turn's first request; a read states nothing, an edit acts.
			// A block whose turn sees only reads and its own call's success is ignored, never recovered.
			hook({ hook: "turn_start", turnId: "u2" });
			collector.requestSent(c3);
			call("u2", "read", "t-read", { path: "a.ts" });
			call("u2", "edit", "t-edit", { path: "a.ts" });
			hook({ hook: "before_tool", turnId: "u2", toolName: "bash", toolCallId: "t-loop", toolArgs: { path: "loop" } });
			const g1 = ids()[3];
			collector.requestSent(c4);
			call("u2", "read", "t-read-2", { path: "b.ts" });
			hook({ hook: "turn_end", turnId: "a3", metadata: { userTurnId: "u2" } });
			// Turn 3: a lockout exhausts the block; a nudge that is spent before any request carries it is suppressed.
			hook({ hook: "turn_start", turnId: "u3" });
			hook({ hook: "before_tool", turnId: "u3", toolName: "bash", toolCallId: "t-loop-2", toolArgs: { path: "loop" } });
			const g2 = ids()[4];
			hub.emit(
				"safety.loop_blocked",
				{ tool: "bash", repeatCount: 3, blocksThisTurn: 3, budget: 3, interrupted: false, disposition: "lockout", at: 1 },
				{ sessionId, agent: { role: "main", id: sessionId }, turnId: "u3" },
			);
			collector.requestSent(c5);
			call("u3", "edit", "t-edit-2", { path: "c.ts" });
			hook({ hook: "turn_end", turnId: "a4", metadata: { userTurnId: "u3", fireA: true, fireB: true } });
			const [a3, b2] = ids().slice(5);
			collector.suppressFirings([b2 as string]);
			// Turn 4: the carried nudge meets no receipt, so it is ignored, not moot.
			hook({ hook: "turn_start", turnId: "u4" });
			collector.requestSent(c6);
			hook({ hook: "turn_end", turnId: "a5", metadata: { userTurnId: "u4" } });
			const expected = [
				[a1, "nudge.a", "moot", c2, "receipt"],
				[b1, "nudge.b", "acted", c2, "receipt"],
				[a2, "nudge.a", "acted", c3, "receipt"],
				[g1, "guard.fixture", "ignored", c4, "none"],
				[g2, "guard.fixture", "exhausted", c5, "scope-end"],
				[a3, "nudge.a", "ignored", c6, "none"],
				[b2, "nudge.b", "suppressed", null, "none"],
			];
			deepStrictEqual(
				Object.fromEntries([...settled].sort(([x], [y]) => x.localeCompare(y))),
				Object.fromEntries(
					expected
						.map(([id, surface, outcome, admittedIn, fact]) => [id, { surface, outcome, admittedIn, fact }] as const)
						.sort(([x], [y]) => String(x).localeCompare(String(y))),
				),
			);
			strictEqual(ids().length, settled.size);
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
