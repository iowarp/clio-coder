import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { buildExtensionRuntimeHookRegistrations } from "../../src/entry/extension-runtime-hooks.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/mcp-capabilities.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** A registry whose awaited phase runs one installed extension's before_tool hook, recording what it was sent. */
async function hookedRegistry(t: TestContext, tools: string[], onHook?: () => void) {
	const env = await isolateClioEnv("clio-coder-hook-landing-");
	const source = path.join(env.dir, "source");
	const workspace = path.join(env.dir, "workspace");
	mkdirSync(source);
	mkdirSync(path.join(workspace, "real", "sub"), { recursive: true });
	writeFileSync(
		path.join(source, "clio-coder-extension.json"),
		JSON.stringify({
			id: "landing_probe",
			name: "Landing probe",
			version: "1.0.0",
			description: "Records what a tool hook is told",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				hooks: [{ on: "before_tool", tools, timeoutMs: 1000, onTimeout: "block", onError: "block" }],
				access: ["tool-args"],
			},
		}),
	);
	writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
	ok(installExtension(source, { cwd: workspace, scope: "user" }).extension?.loadable);
	const previous = process.cwd();
	process.chdir(workspace);
	t.after(() => {
		process.chdir(previous);
		env.restore();
	});
	const events: ExtensionHookEvent[] = [];
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({
		hook: async (_id, event) => {
			events.push(event);
			onHook?.();
			return { kind: "ok", effects: [] };
		},
		notify: () => {},
	});
	// As in the orchestrator, hooks read MCP ownership from the session gateway registered after them.
	let mcp: McpCapabilitySource | null = null;
	const registrations = buildExtensionRuntimeHookRegistrations(
		listInstalledExtensions(workspace, { all: true }),
		bridge,
		{ generation: 1, recordReceipt: () => {}, mcpOwner: (tool) => mcp?.ownerIdOf(tool) ?? null },
	);
	const middleware = createMiddlewareBundle({ registrations }).contract;
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: workspace }), middleware });
	const gateway = createMcpCapabilitySource({ cwd: workspace, registry });
	mcp = gateway;
	t.after(() => gateway.close());
	return { registry, middleware, events, mcp: gateway, workspace: realpathSync(workspace) };
}

test("a tool hook is told where the tool lands its path, a `..` after a link included", async (t) => {
	const { registry, events, workspace } = await hookedRegistry(t, ["write"]);
	symlinkSync(path.join(workspace, "real", "sub"), path.join(workspace, "link"), "dir");
	registry.register({
		name: ToolNames.Write,
		description: "Write fixture",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		baseActionClass: "write",
		run: async () => ({ kind: "ok", output: "written" }),
	});
	const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "@link/../landed.txt", content: "x" } });
	strictEqual(verdict.kind, "ok");
	const [event] = events;
	ok(event?.point === "before_tool");
	// The kernel steps up from the link's target, so the file lands in real/, not beside the link.
	deepStrictEqual(event.target, {
		arg: "path",
		path: path.join(workspace, "real", "landed.txt"),
		resolved: true,
		workspacePath: "real/landed.txt",
	});
});

test("a landing the walk could not resolve has no workspace path, however its text reads", async (t) => {
	const { middleware, events, workspace } = await hookedRegistry(t, ["read"]);
	// The walk stops at a link loop, so the landing stays the text `loop/../x.txt`, which is not `x.txt`.
	const unresolved = [workspace, "loop", "..", "x.txt"].join(path.sep);
	await middleware.runAwaitedHook?.({
		hook: "before_tool",
		toolName: ToolNames.Read,
		toolArgs: { path: "loop/../x.txt" },
		toolLanding: { path: { arg: "path", path: unresolved, resolved: false } },
	});
	const [event] = events;
	ok(event?.point === "before_tool");
	deepStrictEqual(event.target, { arg: "path", path: unresolved, resolved: false, workspacePath: null });
});

test("a link swapped while the hook ran makes the tool refuse instead of opening another file", async (t) => {
	let swap = () => {};
	const { registry, events, workspace } = await hookedRegistry(t, ["read"], () => swap());
	mkdirSync(path.join(workspace, "real", "other"));
	writeFileSync(path.join(workspace, "real", "sub", "notes.txt"), "approved\n");
	writeFileSync(path.join(workspace, "real", "other", "notes.txt"), "never judged\n");
	const link = path.join(workspace, "link");
	symlinkSync(path.join(workspace, "real", "sub"), link, "dir");
	swap = () => {
		rmSync(link);
		symlinkSync(path.join(workspace, "real", "other"), link, "dir");
	};
	registry.register(readTool);
	const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: "link/notes.txt" } });
	strictEqual(events.length, 1);
	ok(verdict.kind === "ok");
	strictEqual(verdict.result.kind, "error", JSON.stringify(verdict.result));
	ok(verdict.result.kind === "error" && verdict.result.message.includes("refused"), verdict.result.message);
});

test("a tool hook can name the MCP tools it cannot list by name", async (t) => {
	const { registry, events } = await hookedRegistry(t, ["mcp_*"]);
	registry.register({
		name: "mcp_notes__append" as never,
		description: "MCP fixture",
		parameters: Type.Object({ text: Type.String() }),
		baseActionClass: "execute",
		run: async () => ({ kind: "ok", output: "appended" }),
	});
	strictEqual((await registry.invoke({ tool: "mcp_notes__append" as never, args: { text: "x" } })).kind, "ok");
	deepStrictEqual(
		events.map((event) => (event.point === "before_tool" ? event.tool : event.point)),
		["mcp_notes__append"],
	);
});

/** A dispatch tool over a stub dispatch domain that never spawns a worker. */
async function admissionOnlyDispatchTool(t: TestContext) {
	isolateDispatchState();
	t.after(() => restoreDispatchState());
	const context = dispatchStubContext();
	const agents = context.getContract<AgentsContract>("agents");
	ok(agents);
	const bundle = makeDispatchBundle(context, {
		spawnWorker: () => {
			throw new Error("admission must not spawn a worker");
		},
	});
	await bundle.extension.start();
	t.after(() => bundle.extension.stop?.());
	const tool = createDispatchTool({
		dispatch: bundle.contract,
		getAgentSpecs: () => agents.listSpecs(),
		getAutonomy: () => "yolo",
	});
	return tool;
}

test("a server family hook does not reach the tools of a server whose id extends its own", async (t) => {
	const { registry, events } = await hookedRegistry(t, ["mcp_a__*"]);
	// `mcp_a__b__x` is server a__b's tool `x`: the longest declared id owns the name.
	writeFileSync(
		path.join(clioConfigDir(), "mcp.yaml"),
		"version: 1\nservers:\n  - id: a\n    command: node\n  - id: a__b\n    command: node\n",
	);
	for (const name of ["mcp_a__b__x", "mcp_a__y"]) {
		registry.register({
			name: name as never,
			description: "MCP fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "done" }),
		});
		strictEqual((await registry.invoke({ tool: name as never, args: {} })).kind, "ok");
	}
	deepStrictEqual(
		events.map((event) => (event.point === "before_tool" ? event.tool : event.point)),
		["mcp_a__y"],
	);
});

test("a server family hook keeps the gateway's ownership when mcp.yaml changes mid-session", async (t) => {
	const { registry, events, mcp } = await hookedRegistry(t, ["mcp_a__*"]);
	const config = path.join(clioConfigDir(), "mcp.yaml");
	writeFileSync(config, "version: 1\nservers:\n  - id: a\n    command: node\n  - id: a__b\n    command: node\n");
	for (const name of ["mcp_a__y", "mcp_a__b__x"]) {
		registry.register({
			name: name as never,
			description: "MCP fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "done" }),
		});
	}
	strictEqual((await registry.invoke({ tool: "mcp_a__y" as never, args: {} })).kind, "ok");
	// Server a__b leaves the config; the session's gateway still routes mcp_a__b__x to it.
	writeFileSync(config, "version: 1\nservers:\n  - id: a\n    command: node\n");
	strictEqual(mcp.ownerIdOf("mcp_a__b__x"), "a__b");
	strictEqual((await registry.invoke({ tool: "mcp_a__b__x" as never, args: {} })).kind, "ok");
	deepStrictEqual(
		events.map((event) => (event.point === "before_tool" ? event.tool : event.point)),
		["mcp_a__y"],
	);
});

test("a dispatch hook is told the workers admission parsed, their directories and where their roots land", async (t) => {
	const { workspace } = await hookedRegistry(t, ["dispatch"]);
	symlinkSync(path.join(workspace, "real", "sub"), path.join(workspace, "linked"), "dir");
	const tool = await admissionOnlyDispatchTool(t);
	const prepared = tool.prepareAdmissionArguments?.({
		tasks: JSON.stringify([{ task: "Fix the off-by-one in counter.js" }]),
		agent: " coder ",
		intent: { read_roots: [], write_roots: ["linked/"] },
	});
	ok(prepared);
	strictEqual(
		prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT],
		undefined,
		String(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]),
	);
	deepStrictEqual(tool.describeHookLanding?.(prepared), {
		dispatch: {
			kind: "tasks",
			mode: "parallel",
			tasks: [
				{
					role: "task",
					agent: "coder",
					cwd: workspace,
					writeRoots: ["linked/"],
					writeBoundaries: [path.join(workspace, "real", "sub")],
					worktree: false,
					readOnly: false,
				},
			],
		},
	});
	tool.disposeAdmissionArguments?.(prepared);
});

test("a review dispatch's landing names the reviewer the loop starts, not only the builder", async (t) => {
	const { workspace } = await hookedRegistry(t, ["dispatch"]);
	const tool = await admissionOnlyDispatchTool(t);
	const prepared = tool.prepareAdmissionArguments?.({
		tasks: JSON.stringify([{ task: "Fix the off-by-one in counter.js" }]),
		agent: "coder",
		review: true,
	});
	ok(prepared);
	strictEqual(
		prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT],
		undefined,
		String(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]),
	);
	const landing = tool.describeHookLanding?.(prepared)?.dispatch;
	tool.disposeAdmissionArguments?.(prepared);
	ok(landing?.kind === "tasks");
	deepStrictEqual(
		landing.tasks.map((task) => [task.role, task.agent]),
		[
			["builder", "coder"],
			["reviewer", "verifier"],
		],
	);
	deepStrictEqual(landing.tasks[1], {
		role: "reviewer",
		agent: "verifier",
		cwd: workspace,
		writeRoots: [],
		writeBoundaries: [],
		worktree: false,
		readOnly: true,
	});
});
