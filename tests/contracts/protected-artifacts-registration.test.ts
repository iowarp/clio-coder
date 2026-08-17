import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareRuleDefinition } from "../../src/domains/middleware/runtime.js";
import { detectValidationCommand, type ProtectedArtifactState } from "../../src/domains/safety/protected-artifacts.js";
import {
	createProtectedArtifactsRegistration,
	type ProtectedArtifactProtectEvent,
} from "../../src/domains/safety/protected-artifacts-registration.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import {
	readPendingProtectedArtifacts,
	reconcilePendingProtectedArtifacts,
	stagePendingProtectedArtifact,
} from "../../src/domains/session/protected-artifact-journal.js";
import { protectedArtifactStateFromSessionEntries } from "../../src/domains/session/protected-artifacts.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { reloadProtectedArtifactsForSession } from "../../src/interactive/chat-loop.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function allowAllSafety() {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

function sessionContext() {
	return {
		bus: { emit: () => {}, on: () => () => {} },
		getContract: () => undefined,
	} as never;
}

function mockSpec(name: ToolName, output = "tool output"): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output }),
	};
}

function protectedState(...paths: string[]): ProtectedArtifactState {
	return {
		artifacts: paths.map((path) => ({
			path,
			protectedAt: "2026-06-12T00:00:00.000Z",
			reason: "test protection",
			source: "user" as const,
		})),
	};
}

/** Declarative after_tool rule protecting a fixed path, for absorption tests. */
function protectRule(
	id: string,
	path: string,
	hooks: MiddlewareRuleDefinition["rule"]["hooks"],
): MiddlewareRuleDefinition {
	return {
		rule: {
			id,
			source: "builtin",
			description: `protects ${path}`,
			enabled: true,
			hooks,
			effectKinds: ["protect_path"],
		},
		toolNames: [ToolNames.Write],
		effects: [{ kind: "protect_path", path, reason: `protected by ${id}` }],
	};
}

describe("protected-artifacts registration", () => {
	it("blocks a write to an already-protected path through the registry", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/PLAN.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		const blocked = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } });
		strictEqual(blocked.kind, "blocked");
		ok(
			blocked.kind === "blocked" &&
				blocked.reason === "protected artifact blocked: write would modify protected path /repo/PLAN.md",
		);
		const allowed = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } });
		strictEqual(allowed.kind, "ok");
	});

	it("blocks a destructive bash command against a protected path", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/PLAN.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Bash));
		const blocked = await registry.invoke({ tool: ToolNames.Bash, args: { command: "rm /repo/PLAN.md" } });
		strictEqual(blocked.kind, "blocked");
		ok(
			blocked.kind === "blocked" && blocked.reason.includes("protected artifact blocked: rm would affect /repo/PLAN.md"),
		);
		const benign = await registry.invoke({ tool: ToolNames.Bash, args: { command: "cat /repo/PLAN.md" } });
		strictEqual(benign.kind, "ok");
	});

	it("blocks mutations that reach protected artifacts through symlinks", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-protected-artifact-"));
		try {
			const protectedPath = join(root, "PLAN.md");
			const symlinkPath = join(root, "PLAN-link.md");
			writeFileSync(protectedPath, "protected\n");
			symlinkSync(protectedPath, symlinkPath);

			const guard = createProtectedArtifactsRegistration({ initialState: protectedState(protectedPath) });
			const bundle = createMiddlewareBundle({ registrations: [guard] });
			const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
			registry.register(mockSpec(ToolNames.Write));
			registry.register(mockSpec(ToolNames.Bash));

			const write = await registry.invoke({ tool: ToolNames.Write, args: { path: symlinkPath } });
			strictEqual(write.kind, "blocked");
			ok(write.kind === "blocked" && write.reason.includes("would modify protected path"));

			const remove = await registry.invoke({ tool: ToolNames.Bash, args: { command: `rm ${symlinkPath}` } });
			strictEqual(remove.kind, "blocked");
			ok(remove.kind === "blocked" && remove.reason.includes("protected artifact blocked: rm would affect"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("absorbs protect_path from an after_tool rule and notifies the persistence sink", async () => {
		const events: ProtectedArtifactProtectEvent[] = [];
		const guard = createProtectedArtifactsRegistration({ onProtect: (event) => events.push(event) });
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["after_tool"])],
			registrations: [guard],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write, "wrote"));
		const first = await registry.invoke(
			{ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } },
			{ turnId: "t1", sessionId: "s1", toolCallId: "c1" },
		);
		strictEqual(first.kind, "ok", "the protecting write itself executes");
		strictEqual(events.length, 1);
		strictEqual(events[0]?.artifact.path, "/repo/PLAN.md");
		strictEqual(events[0]?.artifact.source, "middleware");
		strictEqual(events[0]?.toolName, ToolNames.Write);
		strictEqual(events[0]?.turnId, "t1");
		strictEqual(events[0]?.sessionId, "s1");
		strictEqual(events[0]?.toolCallId, "c1");
		const second = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } }, { turnId: "t1" });
		strictEqual(second.kind, "blocked", "the absorbed protection blocks the next mutation");
	});

	it("blocks the protecting call itself when a before_tool rule protects the very path it writes", async () => {
		const guard = createProtectedArtifactsRegistration();
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["before_tool"])],
			registrations: [guard],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		const blocked = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } });
		strictEqual(blocked.kind, "blocked", "post-hooks recheck semantics preserved: protect-then-block in one pass");
	});

	it("replaceState swaps protections wholesale, matching session switches", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/a.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/a.md" } })).kind, "blocked");
		guard.replaceState(protectedState("/repo/b.md"));
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/a.md" } })).kind, "ok");
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/b.md" } })).kind, "blocked");
		deepStrictEqual(
			guard.state().artifacts.map((artifact) => artifact.path),
			["/repo/b.md"],
		);
	});

	it("records validation metadata when absorbing during a validated run", () => {
		const events: ProtectedArtifactProtectEvent[] = [];
		const guard = createProtectedArtifactsRegistration({ onProtect: (event) => events.push(event) });
		guard.evaluate(
			{
				hook: "after_tool",
				toolName: ToolNames.Bash,
				metadata: { validationCommand: "npm test", validationExitCode: 0, resultKind: "ok" },
			},
			{ priorEffects: [{ kind: "protect_path", path: "/repo/src/fix.ts", reason: "validated edit" }] },
		);
		strictEqual(events.length, 1);
		strictEqual(events[0]?.artifact.validationCommand, "npm test");
		strictEqual(events[0]?.artifact.validationExitCode, 0);
	});

	it("survives a throwing persistence sink", async () => {
		const failures: string[] = [];
		const guard = createProtectedArtifactsRegistration({
			onProtect: () => {
				throw new Error("sink exploded");
			},
			onDurabilityFailure: (health) => failures.push(health.reason),
		});
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["after_tool"])],
			registrations: [guard],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } });
		strictEqual(verdict.kind, "ok", "tool execution is unaffected by sink failures");
		strictEqual(guard.state().artifacts.length, 1, "protection state still grew");
		strictEqual(guard.health().kind, "degraded");
		deepStrictEqual(failures, ["protected artifact persistence failed: sink exploded"]);
		const unrelated = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } });
		strictEqual(unrelated.kind, "blocked", "degraded durability fails closed for every non-read call");
		guard.replaceState(guard.state());
		strictEqual(guard.health().kind, "healthy");
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } })).kind, "ok");
	});

	it("preserves last-known protection and fails closed when a reload is marked degraded", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/PLAN.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		registry.register(mockSpec(ToolNames.Read));

		guard.markDegraded("session protection history could not be read");
		deepStrictEqual(
			guard.state().artifacts.map((artifact) => artifact.path),
			["/repo/PLAN.md"],
		);
		strictEqual((await registry.invoke({ tool: ToolNames.Read, args: {} })).kind, "ok");
		const write = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } });
		strictEqual(write.kind, "blocked");
		ok(write.kind === "blocked" && write.reason.includes("protected artifact durability degraded"));
	});

	it("session reload read failure preserves the guard and enters degraded mode", () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/PLAN.md") });
		reloadProtectedArtifactsForSession(
			{
				replace: (state) => guard.replaceState(state),
				markDegraded: (reason) => guard.markDegraded(reason),
			},
			() => {
				throw new Error("ledger read fault");
			},
		);
		deepStrictEqual(
			guard.state().artifacts.map((artifact) => artifact.path),
			["/repo/PLAN.md"],
		);
		const health = guard.health();
		strictEqual(health.kind, "degraded");
		if (health.kind === "degraded") {
			strictEqual(health.reason, "session protection history could not be read: ledger read fault");
			ok(Number.isFinite(Date.parse(health.since)));
		}
	});

	it("write-ahead protection survives append failure, reload, and process restart until reconciliation", async () => {
		const isolated = await isolateClioEnv("clio-protection-journal-");
		const session = createSessionBundle(sessionContext()).contract;
		const meta = session.create({ cwd: "/repo" });
		try {
			const guard = createProtectedArtifactsRegistration({
				onProtect: (event) => {
					stagePendingProtectedArtifact(meta.id, event);
					throw new Error("primary session append fault");
				},
			});
			const middleware = createMiddlewareBundle({
				ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["after_tool"])],
				registrations: [guard],
			});
			const registry = createRegistry({ safety: allowAllSafety(), middleware: middleware.contract });
			registry.register(mockSpec(ToolNames.Write));

			strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } })).kind, "ok");
			strictEqual(guard.health().kind, "degraded");
			strictEqual(readPendingProtectedArtifacts(meta.id).records.length, 1, "write-ahead record survived");
			strictEqual(
				(await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } })).kind,
				"blocked",
				"degraded live process remains fail-closed",
			);

			const failingSession = new Proxy(session, {
				get(target, property, receiver) {
					if (property === "appendEntry")
						return () => {
							throw new Error("append still unavailable");
						};
					return Reflect.get(target, property, receiver) as unknown;
				},
			}) as SessionContract;
			reloadProtectedArtifactsForSession(
				{
					replace: (state) => guard.replaceState(state),
					markDegraded: (reason) => guard.markDegraded(reason),
				},
				() => {
					reconcilePendingProtectedArtifacts(failingSession);
					return [];
				},
			);
			strictEqual(guard.health().kind, "degraded", "failed reset cannot clear degradation");
			strictEqual(guard.state().artifacts[0]?.path, "/repo/PLAN.md", "last-known state survives reset");

			const pending = readPendingProtectedArtifacts(meta.id);
			const restarted = createProtectedArtifactsRegistration({
				initialState: { artifacts: pending.records.map((entry) => entry.record.artifact) },
			});
			restarted.markDegraded("pending protection journal requires reconciliation");
			const restartedMiddleware = createMiddlewareBundle({ registrations: [restarted] });
			const restartedRegistry = createRegistry({ safety: allowAllSafety(), middleware: restartedMiddleware.contract });
			restartedRegistry.register(mockSpec(ToolNames.Write));
			strictEqual(
				(await restartedRegistry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } })).kind,
				"blocked",
				"restart reconstructs a fail-closed boundary from the journal",
			);

			strictEqual(reconcilePendingProtectedArtifacts(session), 1, "recovered append adopts pending protection");
			strictEqual(readPendingProtectedArtifacts(meta.id).records.length, 0, "journal clears only after durable append");
			const entries = collectSessionEntries(openSession(meta.id).turns(), sessionPaths(meta).current);
			const restoredState = protectedArtifactStateFromSessionEntries(entries);
			restarted.replaceState(restoredState);
			strictEqual(restarted.health().kind, "healthy");
			strictEqual(
				(await restartedRegistry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } })).kind,
				"blocked",
				"reconciled session retains the exact protected path",
			);
		} finally {
			await session.close();
			isolated.restore();
		}
	});

	it("fails closed on a corrupt pending-protection journal", async () => {
		const isolated = await isolateClioEnv("clio-protection-corrupt-");
		const session = createSessionBundle(sessionContext()).contract;
		const meta = session.create({ cwd: "/repo" });
		try {
			const artifact = protectedState("/repo/PLAN.md").artifacts[0];
			if (artifact === undefined) throw new Error("protected artifact fixture missing");
			const pending = stagePendingProtectedArtifact(meta.id, {
				kind: "protect",
				artifact,
				toolName: ToolNames.Write,
			});
			writeFileSync(pending.path, JSON.stringify({ ...pending.record, sessionId: "tampered" }));
			strictEqual(readPendingProtectedArtifacts(meta.id).errors.length, 1);
			throws(() => reconcilePendingProtectedArtifacts(session), /pending protection journal is untrustworthy/);
			const guard = createProtectedArtifactsRegistration();
			guard.markDegraded("pending protection journal is untrustworthy");
			const middleware = createMiddlewareBundle({ registrations: [guard] });
			const registry = createRegistry({ safety: allowAllSafety(), middleware: middleware.contract });
			registry.register(mockSpec(ToolNames.Write));
			strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } })).kind, "blocked");
		} finally {
			await session.close();
			isolated.restore();
		}
	});

	it("retains the write-ahead record until the session append is synchronously durable", async () => {
		const isolated = await isolateClioEnv("clio-protection-flush-");
		const session = createSessionBundle(sessionContext()).contract;
		const meta = session.create({ cwd: "/repo" });
		try {
			const artifact = protectedState("/repo/PLAN.md").artifacts[0];
			if (artifact === undefined) throw new Error("protected artifact fixture missing");
			stagePendingProtectedArtifact(meta.id, { kind: "protect", artifact, toolName: ToolNames.Write });
			const unflushedSession = new Proxy(session, {
				get(target, property, receiver) {
					if (property === "flushAppends")
						return () => {
							throw new Error("injected fsync fault");
						};
					return Reflect.get(target, property, receiver) as unknown;
				},
			}) as SessionContract;
			throws(() => reconcilePendingProtectedArtifacts(unflushedSession), /injected fsync fault/);
			strictEqual(
				readPendingProtectedArtifacts(meta.id).records.length,
				1,
				"WAL survives append-before-fsync crash window",
			);
			strictEqual(reconcilePendingProtectedArtifacts(session), 1);
			strictEqual(readPendingProtectedArtifacts(meta.id).records.length, 0, "WAL clears only after fsync succeeds");
		} finally {
			await session.close();
			isolated.restore();
		}
	});

	it("enforces inherited protection at the shared mediated-worker safety seam", () => {
		const safety = createWorkerSafety({
			cwd: "/repo",
			protectedArtifactState: protectedState("/repo/PLAN.md"),
		});
		const blocked = safety.evaluate({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } }, "operating");
		strictEqual(blocked.kind, "block");
		strictEqual(blocked.policy?.reasonCode, "protected-artifact");
		const allowed = safety.evaluate({ tool: ToolNames.Write, args: { path: "/repo/other.md" } }, "operating");
		ok(allowed.kind !== "block", "an unrelated write follows the ordinary autonomy policy");
	});
});

describe("validation command scopes", () => {
	function matched(command: string, scope?: "finish-contract" | "grounding"): string | null {
		const detected = scope === undefined ? detectValidationCommand(command) : detectValidationCommand(command, scope);
		return detected.kind === "validation" ? detected.matched : null;
	}

	it("keeps the strict vocabulary for the finish contract and widens it only for grounding", () => {
		// Read verification and ad-hoc checks are what agents actually run, and
		// what the grounding layer has to be able to name. Neither asserts
		// correctness, so neither may satisfy the finish contract.
		for (const command of ["git diff", "git status --short", "node -e \"import('./src/sum.js')\""]) {
			strictEqual(matched(command), null, command);
			ok(matched(command, "grounding") !== null, command);
		}
		strictEqual(matched("git diff", "grounding"), "git diff");
		strictEqual(matched("git status --short", "grounding"), "git status");
		strictEqual(matched("node -e \"import('./src/sum.js')\"", "grounding"), "node -e");
	});

	it("recognizes typecheck and runner shapes under grounding, canonically", () => {
		strictEqual(matched("tsc --noEmit", "grounding"), "tsc --noEmit");
		strictEqual(matched("npx tsc --noemit", "grounding"), "tsc --noEmit");
		strictEqual(matched("tsc -p tsconfig.json", "grounding"), "tsc");
		strictEqual(matched("npx vitest run", "grounding"), "npx vitest");
		strictEqual(matched("npx -y jest --coverage", "grounding"), "npx jest");
		strictEqual(matched("npx tsx --test tests/unit.ts", "grounding"), "npx tsx --test");
		strictEqual(matched("node --test tests/", "grounding"), "node --test");
	});

	it("matches leading commands only, never a mention in an argument", () => {
		strictEqual(matched("echo tsc --noEmit", "grounding"), null);
		strictEqual(matched("git log --stat", "grounding"), null);
		strictEqual(matched("node server.js", "grounding"), null);
		strictEqual(matched("npx prettier --write .", "grounding"), null);
		strictEqual(matched("npx -p typescript some-other-tool", "grounding"), null);
	});

	it("leaves the shared strict vocabulary identical under both scopes", () => {
		for (const command of ["npm test", "npm run typecheck", "pytest -q", "cargo test", "go test ./..."]) {
			const strict = matched(command);
			ok(strict !== null, command);
			strictEqual(matched(command, "grounding"), strict, command);
		}
	});
});
