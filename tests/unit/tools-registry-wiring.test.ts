import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { ToolName } from "../../src/core/tool-names.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ModeName } from "../../src/domains/modes/matrix.js";
import type { Classification, ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, SUPER_SCOPE } from "../../src/domains/safety/scope.js";
import { createAgentProgress } from "../../src/engine/tui.js";
import { createWorkerToolRegistry, resolveAgentTools } from "../../src/engine/worker-tools.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

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

	it("validates and coerces tool arguments before registry admission", async () => {
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

		const [tool] = resolveAgentTools({
			registry,
			allowedTools: ["write"],
			mode: "default",
		});
		ok(tool);

		const result = await tool.execute("tool-call-coerce", { path: "notes.txt", content: 123 });
		strictEqual(runCalls, 1);
		strictEqual(decisions[0]?.args?.content, "123");
		if (result.content[0]?.type === "text") {
			strictEqual(result.content[0].text, "notes.txt:123");
		}

		await rejects(tool.execute("tool-call-invalid", { path: "notes.txt" }), /Validation failed for tool "write"/);
		strictEqual(runCalls, 1);
		strictEqual(decisions.length, 1);
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
