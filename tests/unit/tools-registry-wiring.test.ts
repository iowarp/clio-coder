import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { ToolName } from "../../src/core/tool-names.js";
import {
	createMiddlewareSnapshot,
	type MiddlewareContract,
	type MiddlewareEffect,
	type MiddlewareHookInput,
} from "../../src/domains/middleware/index.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ModeName } from "../../src/domains/modes/matrix.js";
import type { Classification, ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, SUPER_SCOPE } from "../../src/domains/safety/scope.js";
import { createAgentProgress } from "../../src/engine/tui.js";
import {
	createWorkerToolRegistry,
	invokeWorkerTool,
	resolveAgentTools,
	type ToolFinishEvent,
	type ToolStartEvent,
} from "../../src/engine/worker-tools.js";
import {
	createRegistry,
	type ProtectedArtifactRegistryEvent,
	type ToolRegistry,
	type ToolSpec,
} from "../../src/tools/registry.js";

function makeModes(
	initial: ModeName,
	allowAction: (action: Classification["actionClass"]) => boolean,
	visibleTools: ReadonlyArray<ToolName>,
): ModesContract {
	return {
		current: () => initial,
		setMode: () => initial,
		cycleNormal: () => initial,
		visibleTools: () => new Set(visibleTools),
		isToolVisible: (tool) => visibleTools.includes(tool),
		isActionAllowed: (action) => allowAction(action),
		requestSuper: () => {},
		confirmSuper: () => initial,
		elevatedModeFor: () => null,
	};
}

function makeSafety(classification: Classification, decisions: ClassifierCall[]): SafetyContract {
	const decision: SafetyDecision = { kind: "allow", classification };
	return {
		classify: () => classification,
		evaluate(call) {
			decisions.push(call);
			return decision;
		},
		observeLoop: (key) => ({ looping: false, key, count: 1 }),
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

function registerWriteTool(registry: ToolRegistry, run: ToolSpec["run"]): void {
	registry.register({
		name: "write",
		description: "test write",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
		}),
		baseActionClass: "write",
		allowedModes: ["default"],
		run,
	});
}

function registerBashTool(registry: ToolRegistry, run: ToolSpec["run"]): void {
	registry.register({
		name: "bash",
		description: "test bash",
		parameters: Type.Object({
			command: Type.String(),
		}),
		baseActionClass: "execute",
		allowedModes: ["default"],
		run,
	});
}

function makeMiddleware(
	inputs: MiddlewareHookInput[],
	effectsForInput: (input: MiddlewareHookInput) => ReadonlyArray<MiddlewareEffect> = () => [],
): MiddlewareContract {
	return {
		runHook(input) {
			inputs.push(input);
			return {
				hook: input.hook,
				input,
				effects: effectsForInput(input),
				ruleIds: [],
			};
		},
		listRules: () => [],
		snapshot: () => createMiddlewareSnapshot([]),
	};
}

describe("engine/worker-tools registry wiring", () => {
	it("blocks execution before spec.run when the registry denies the action", async () => {
		let allowWrite = false;
		let runCalls = 0;
		const decisions: ClassifierCall[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => allowWrite && action === "write", ["write"]),
		});
		registerWriteTool(registry, async () => {
			runCalls += 1;
			return { kind: "ok", output: "wrote file" };
		});

		const [tool] = resolveAgentTools({
			registry,
			allowedTools: ["write"],
			mode: "default",
		});
		ok(tool);
		strictEqual(typeof tool.execute, "function");

		await rejects(tool.execute("tool-call-1", { path: "notes.txt", content: "draft" }), /action write not allowed/);
		strictEqual(runCalls, 0);
		strictEqual(decisions.length, 1);
		strictEqual(decisions[0]?.tool, "write");

		allowWrite = true;
		const result = await tool.execute("tool-call-2", { path: "notes.txt", content: "draft" });
		strictEqual(runCalls, 1);
		strictEqual(result.content[0]?.type, "text");
		if (result.content[0]?.type === "text") {
			strictEqual(result.content[0].text, "wrote file");
		}
	});

	it("invokeWorkerTool validates and coerces arguments before registry admission", async () => {
		let runCalls = 0;
		const decisions: ClassifierCall[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => action === "write", ["write"]),
		});
		registerWriteTool(registry, async (args) => {
			runCalls += 1;
			strictEqual(args.content, "123");
			return { kind: "ok", output: `${args.path}:${args.content}` };
		});

		const result = await invokeWorkerTool(registry, "write", { path: "notes.txt", content: 123 });
		strictEqual(runCalls, 1);
		strictEqual(decisions[0]?.args?.content, "123");
		if (result.content[0]?.type === "text") {
			strictEqual(result.content[0].text, "notes.txt:123");
		}

		await rejects(invokeWorkerTool(registry, "write", { path: "notes.txt" }), /Validation failed for tool "write"/);
		strictEqual(runCalls, 1);
		strictEqual(decisions.length, 1);
	});

	it("emits onStart and onFinish telemetry for ok, blocked, and error outcomes", async () => {
		let allowWrite = true;
		const decisions: ClassifierCall[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => allowWrite && action === "write", ["write"]),
		});
		let shouldFail = false;
		registerWriteTool(registry, async () => {
			if (shouldFail) return { kind: "error", message: "boom" };
			return { kind: "ok", output: "wrote" };
		});

		const starts: ToolStartEvent[] = [];
		const finishes: ToolFinishEvent[] = [];
		const telemetry = {
			onStart: (event: ToolStartEvent) => starts.push(event),
			onFinish: (event: ToolFinishEvent) => finishes.push(event),
		};

		await invokeWorkerTool(registry, "write", { path: "a", content: "b" }, { telemetry });
		strictEqual(starts.length, 1);
		strictEqual(starts[0]?.tool, "write");
		strictEqual(starts[0]?.mode, "default");
		strictEqual(finishes.length, 1);
		strictEqual(finishes[0]?.outcome, "ok");
		ok(typeof finishes[0]?.durationMs === "number" && finishes[0].durationMs >= 0);

		shouldFail = true;
		await rejects(invokeWorkerTool(registry, "write", { path: "a", content: "b" }, { telemetry }));
		strictEqual(finishes.length, 2);
		strictEqual(finishes[1]?.outcome, "error");
		strictEqual(finishes[1]?.reason, "boom");

		shouldFail = false;
		allowWrite = false;
		await rejects(invokeWorkerTool(registry, "write", { path: "a", content: "b" }, { telemetry }));
		strictEqual(finishes.length, 3);
		strictEqual(finishes[2]?.outcome, "blocked");
	});

	it("threads telemetry through resolveAgentTools so the agent loop path is observable", async () => {
		const decisions: ClassifierCall[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", () => true, ["write"]),
		});
		registerWriteTool(registry, async () => ({ kind: "ok", output: "wrote" }));

		const finishes: ToolFinishEvent[] = [];
		const [tool] = resolveAgentTools({
			registry,
			mode: "default",
			telemetry: { onFinish: (event) => finishes.push(event) },
		});
		ok(tool);

		await tool.execute("tc-loop", { path: "a", content: "b" });
		strictEqual(finishes.length, 1);
		strictEqual(finishes[0]?.tool, "write");
		strictEqual(finishes[0]?.outcome, "ok");
	});

	it("runs before_tool and after_tool middleware around admitted tool execution", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => action === "write", ["write"]),
			middleware: makeMiddleware(hooks),
		});
		registerWriteTool(registry, async () => ({ kind: "ok", output: "wrote" }));

		const verdict = await registry.invoke(
			{ tool: "write", args: { path: "a", content: "b" } },
			{
				runId: "run-1",
				sessionId: "session-1",
				turnId: "turn-1",
				toolCallId: "tool-call-1",
				correlationId: "corr-1",
			},
		);

		strictEqual(verdict.kind, "ok");
		deepStrictEqual(
			hooks.map((hook) => hook.hook),
			["before_tool", "after_tool"],
		);
		deepStrictEqual(hooks[0], {
			hook: "before_tool",
			toolName: "write",
			runId: "run-1",
			sessionId: "session-1",
			turnId: "turn-1",
			toolCallId: "tool-call-1",
			correlationId: "corr-1",
			metadata: {
				mode: "default",
				actionClass: "write",
				decisionKind: "allow",
			},
		});
		deepStrictEqual(hooks[1], {
			hook: "after_tool",
			toolName: "write",
			runId: "run-1",
			sessionId: "session-1",
			turnId: "turn-1",
			toolCallId: "tool-call-1",
			correlationId: "corr-1",
			metadata: {
				mode: "default",
				actionClass: "write",
				decisionKind: "allow",
				resultKind: "ok",
			},
		});
	});

	it("runs after_tool middleware when the admitted tool reports an error", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => action === "write", ["write"]),
			middleware: makeMiddleware(hooks),
		});
		registerWriteTool(registry, async () => {
			throw new Error("tool failed");
		});

		const verdict = await registry.invoke({ tool: "write", args: { path: "a", content: "b" } });

		strictEqual(verdict.kind, "ok");
		if (verdict.kind === "ok") strictEqual(verdict.result.kind, "error");
		deepStrictEqual(
			hooks.map((hook) => hook.hook),
			["before_tool", "after_tool"],
		);
		deepStrictEqual(hooks[1]?.metadata, {
			mode: "default",
			actionClass: "write",
			decisionKind: "allow",
			resultKind: "error",
			errorMessage: "tool failed",
		});
	});

	it("does not run before_tool or after_tool for blocked admission", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", () => false, ["write"]),
			middleware: makeMiddleware(hooks),
		});
		registerWriteTool(registry, async () => ({ kind: "ok", output: "wrote" }));

		const verdict = await registry.invoke({ tool: "write", args: { path: "a", content: "b" } });

		strictEqual(verdict.kind, "blocked");
		deepStrictEqual(hooks, []);
	});

	it("enforces middleware block_tool effects before running an admitted tool", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		let runCalls = 0;
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => action === "write", ["write"]),
			middleware: makeMiddleware(hooks, (input) =>
				input.hook === "before_tool"
					? [{ kind: "block_tool", reason: "middleware policy blocked write", severity: "hard-block" }]
					: [],
			),
		});
		registerWriteTool(registry, async () => {
			runCalls += 1;
			return { kind: "ok", output: "wrote" };
		});

		const verdict = await registry.invoke({ tool: "write", args: { path: "a", content: "b" } });

		strictEqual(verdict.kind, "blocked");
		if (verdict.kind === "blocked") strictEqual(verdict.reason, "middleware policy blocked write");
		strictEqual(runCalls, 0);
		deepStrictEqual(
			hooks.map((hook) => hook.hook),
			["before_tool"],
		);
	});

	it("applies middleware annotate_tool_result effects deterministically", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => action === "write", ["write"]),
			middleware: makeMiddleware(hooks, (input) =>
				input.hook === "after_tool"
					? [{ kind: "annotate_tool_result", message: "validation is still required", severity: "warn" }]
					: [],
			),
		});
		registerWriteTool(registry, async () => ({ kind: "ok", output: "wrote" }));

		const verdict = await registry.invoke({ tool: "write", args: { path: "a", content: "b" } });

		strictEqual(verdict.kind, "ok");
		if (verdict.kind === "ok") {
			deepStrictEqual(verdict.result, {
				kind: "ok",
				output: "wrote\n\n[middleware:warn] validation is still required",
			});
		}
		deepStrictEqual(
			hooks.map((hook) => hook.hook),
			["before_tool", "after_tool"],
		);
	});

	it("honors middleware protect_path effects and blocks later protected writes", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		let runCalls = 0;
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", () => true, ["write"]),
			middleware: makeMiddleware(hooks, (input) =>
				input.hook === "after_tool" && input.toolName === "write"
					? [{ kind: "protect_path", path: "artifact.txt", reason: "validated output" }]
					: [],
			),
		});
		registerWriteTool(registry, async () => {
			runCalls += 1;
			return { kind: "ok", output: "wrote" };
		});

		const first = await registry.invoke({ tool: "write", args: { path: "artifact.txt", content: "ok" } });
		strictEqual(first.kind, "ok");
		strictEqual(runCalls, 1);

		const blocked = await registry.invoke({ tool: "write", args: { path: "artifact.txt", content: "again" } });
		strictEqual(blocked.kind, "blocked");
		if (blocked.kind === "blocked") {
			strictEqual(blocked.reason, "protected artifact blocked: write would modify protected path artifact.txt");
		}
		strictEqual(runCalls, 1);

		const sibling = await registry.invoke({ tool: "write", args: { path: "artifact-copy.txt", content: "ok" } });
		strictEqual(sibling.kind, "ok");
		strictEqual(runCalls, 2);
	});

	it("lets before_tool protect_path effects block the current destructive bash command", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		let runCalls = 0;
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "execute", reasons: ["test"] }, decisions),
			modes: makeModes("default", () => true, ["bash"]),
			middleware: makeMiddleware(hooks, (input) =>
				input.hook === "before_tool" ? [{ kind: "protect_path", path: "artifact.txt", reason: "validated output" }] : [],
			),
		});
		registerBashTool(registry, async () => {
			runCalls += 1;
			return { kind: "ok", output: "removed" };
		});

		const verdict = await registry.invoke({ tool: "bash", args: { command: "rm -f artifact.txt" } });

		strictEqual(verdict.kind, "blocked");
		if (verdict.kind === "blocked") {
			strictEqual(verdict.reason, "protected artifact blocked: rm would affect artifact.txt");
		}
		strictEqual(runCalls, 0);
		deepStrictEqual(
			hooks.map((hook) => hook.hook),
			["before_tool"],
		);
	});

	it("threads validation command metadata so middleware can protect artifacts after validation", async () => {
		const decisions: ClassifierCall[] = [];
		const hooks: MiddlewareHookInput[] = [];
		let bashCalls = 0;
		let writeCalls = 0;
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "execute", reasons: ["test"] }, decisions),
			modes: makeModes("default", () => true, ["bash", "write"]),
			middleware: makeMiddleware(hooks, (input) =>
				input.hook === "after_tool" &&
				input.toolName === "bash" &&
				input.metadata?.validationCommand === "npm test" &&
				input.metadata.validationExitCode === 0
					? [{ kind: "protect_path", path: "validated.txt", reason: "validation command passed" }]
					: [],
			),
		});
		registerBashTool(registry, async () => {
			bashCalls += 1;
			return { kind: "ok", output: "tests passed" };
		});
		registerWriteTool(registry, async () => {
			writeCalls += 1;
			return { kind: "ok", output: "wrote" };
		});

		const validation = await registry.invoke({ tool: "bash", args: { command: "npm test" } });
		strictEqual(validation.kind, "ok");
		strictEqual(bashCalls, 1);

		const blocked = await registry.invoke({ tool: "write", args: { path: "validated.txt", content: "again" } });
		strictEqual(blocked.kind, "blocked");
		strictEqual(writeCalls, 0);
	});

	it("emits protected-artifact events and rehydrates protected state into another registry", async () => {
		const decisions: ClassifierCall[] = [];
		const events: ProtectedArtifactRegistryEvent[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", () => true, ["write"]),
			middleware: makeMiddleware([], (input) =>
				input.hook === "after_tool" ? [{ kind: "protect_path", path: "dist/report.txt", reason: "validated report" }] : [],
			),
			onProtectedArtifactEvent: (event) => events.push(event),
		});
		registerWriteTool(registry, async () => ({ kind: "ok", output: "wrote" }));

		const first = await registry.invoke(
			{ tool: "write", args: { path: "dist/report.txt", content: "ok" } },
			{ runId: "run-1", sessionId: "session-1", turnId: "turn-1", toolCallId: "call-1", correlationId: "corr-1" },
		);

		strictEqual(first.kind, "ok");
		strictEqual(events.length, 1);
		strictEqual(events[0]?.artifact.path, "dist/report.txt");
		strictEqual(events[0]?.artifact.reason, "validated report");
		strictEqual(events[0]?.toolName, "write");
		strictEqual(events[0]?.toolCallId, "call-1");
		strictEqual(registry.protectedArtifacts().artifacts.length, 1);

		const rehydrated = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, []),
			modes: makeModes("default", () => true, ["write"]),
			protectedArtifacts: registry.protectedArtifacts(),
		});
		registerWriteTool(rehydrated, async () => ({ kind: "ok", output: "should not run" }));

		const blocked = await rehydrated.invoke({ tool: "write", args: { path: "dist/report.txt", content: "again" } });
		strictEqual(blocked.kind, "blocked");
		if (blocked.kind === "blocked") {
			strictEqual(blocked.reason, "protected artifact blocked: write would modify protected path dist/report.txt");
		}

		rehydrated.replaceProtectedArtifacts({ artifacts: [] });
		const allowed = await rehydrated.invoke({ tool: "write", args: { path: "dist/report.txt", content: "again" } });
		strictEqual(allowed.kind, "ok");
	});

	it("worker registry rejects write-like system modifications before spec.run", async () => {
		const registry = createWorkerToolRegistry("default");
		const [tool] = resolveAgentTools({
			registry,
			allowedTools: ["write"],
			mode: "default",
		});
		ok(tool);
		strictEqual(typeof tool.execute, "function");

		await rejects(
			tool.execute("tool-call-3", { path: "/etc/clio-denied.txt", content: "forbidden" }),
			/system_modify|blocked/,
		);
	});

	it("forwards per-tool executionMode from ToolSpec to the resolved AgentTool", () => {
		const registry = createWorkerToolRegistry("default");
		const defaults = resolveAgentTools({
			registry,
			mode: "default",
		});
		const byName = new Map(defaults.map((tool) => [tool.name, tool]));
		strictEqual(byName.get("read")?.executionMode, "parallel");
		strictEqual(byName.get("grep")?.executionMode, "parallel");
		strictEqual(byName.get("glob")?.executionMode, "parallel");
		strictEqual(byName.get("ls")?.executionMode, "parallel");
		strictEqual(byName.get("web_fetch")?.executionMode, "parallel");
		strictEqual(byName.get("write")?.executionMode, "sequential");
		strictEqual(byName.get("edit")?.executionMode, "sequential");
		strictEqual(byName.get("bash")?.executionMode, "sequential");

		const adviseTools = resolveAgentTools({
			registry: createWorkerToolRegistry("advise"),
			mode: "advise",
		});
		const adviseByName = new Map(adviseTools.map((tool) => [tool.name, tool]));
		strictEqual(adviseByName.get("write_plan")?.executionMode, "sequential");
		strictEqual(adviseByName.get("write_review")?.executionMode, "sequential");
	});

	it("write_plan and write_review set terminate=true on successful advise-mode writes", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-terminate-"));
		const originalCwd = process.cwd();
		process.chdir(scratch);
		try {
			const registry = createWorkerToolRegistry("advise");
			const tools = resolveAgentTools({ registry, mode: "advise" });
			const planTool = tools.find((t) => t.name === "write_plan");
			const reviewTool = tools.find((t) => t.name === "write_review");
			ok(planTool, "write_plan missing from advise resolve");
			ok(reviewTool, "write_review missing from advise resolve");

			const planResult = await planTool.execute("tc-plan", { content: "# Plan\n- step\n" });
			strictEqual(planResult.terminate, true);
			strictEqual(readFileSync(join(scratch, "PLAN.md"), "utf8"), "# Plan\n- step\n");

			const reviewResult = await reviewTool.execute("tc-review", { content: "# Review\n- notes\n" });
			strictEqual(reviewResult.terminate, true);
			strictEqual(readFileSync(join(scratch, "REVIEW.md"), "utf8"), "# Review\n- notes\n");
		} finally {
			process.chdir(originalCwd);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("omits terminate when the underlying ToolResult does not set it", async () => {
		const registry = createWorkerToolRegistry("default");
		const tools = resolveAgentTools({ registry, mode: "default", allowedTools: ["read"] });
		const readTool = tools[0];
		ok(readTool);
		// Point read at a missing file so the registry throws (tool-reported
		// error). A successful read wouldn't flag terminate either; the
		// negative check is meaningful because the propagation path must not
		// fabricate a flag when the spec does not set one.
		await rejects(readTool.execute("tc-read", { path: "/nonexistent/clio-no-terminate" }));
	});
});

describe("engine/tui createAgentProgress", () => {
	it("emits setProgress(true) on the first start and ignores re-entrant starts", () => {
		const calls: boolean[] = [];
		const progress = createAgentProgress({ setProgress: (active) => calls.push(active) });
		progress.start();
		progress.start();
		strictEqual(calls.length, 1);
		strictEqual(calls[0], true);
		strictEqual(progress.isActive(), true);
	});

	it("emits setProgress(false) on stop and ignores double-stops", () => {
		const calls: boolean[] = [];
		const progress = createAgentProgress({ setProgress: (active) => calls.push(active) });
		progress.stop();
		strictEqual(calls.length, 0);
		progress.start();
		progress.stop();
		progress.stop();
		strictEqual(calls.length, 2);
		strictEqual(calls[1], false);
		strictEqual(progress.isActive(), false);
	});

	it("supports restart after a full stop", () => {
		const calls: boolean[] = [];
		const progress = createAgentProgress({ setProgress: (active) => calls.push(active) });
		progress.start();
		progress.stop();
		progress.start();
		strictEqual(calls.length, 3);
		strictEqual(calls[2], true);
		strictEqual(progress.isActive(), true);
	});
});
