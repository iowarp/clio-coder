import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { attestedToolSignature, createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { effectiveToolNames, resolveAgentTools } from "../../src/tools/agent-tools.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import type { ToolRegistry, ToolSpec } from "../../src/tools/registry.js";
import { toolSignatureOf } from "../../src/worker/protocol.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * A worker whose recipe lists a gateway-placed capability attests a surface
 * that carries `gateway`, gets `gateway` (not the capability) as an attached
 * schema, and reaches the capability through `gateway call`, which refuses
 * anything outside the admitted list with a clear message.
 */

const RECIPE_TOOLS: ToolName[] = [ToolNames.Read, ToolNames.Edit, ToolNames.Context, ToolNames.Git];
const roots: string[] = [];

function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-gateway-worker-")));
	roots.push(root);
	return root;
}

describe("gateway on the worker surface", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-worker-");
	});
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	it("intersects explicit turn scope with recipe schemas and gateway admission", async () => {
		const registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: scratch() }), undefined, []);
		const turnConstraints = {
			allowedTools: ["git", "context"],
			skills: "disabled" as const,
			delegation: "forbidden" as const,
		};
		deepStrictEqual(
			resolveAgentTools({ registry, allowedTools: RECIPE_TOOLS, turnConstraints }).map((tool) => tool.name),
			["context", "gateway"],
		);
		const options = { turnConstraints, allowedTools: [...RECIPE_TOOLS, ToolNames.Gateway] };
		strictEqual((await registry.invoke({ tool: "edit", args: {} }, options)).kind, "blocked");
		strictEqual((await registry.invoke({ tool: "context", args: { scope: "skills" } }, options)).kind, "blocked");
		const listing = await registry.invoke({ tool: "gateway", args: { op: "find" } }, options);
		ok(listing.kind === "ok" && listing.result.kind === "ok");
		deepStrictEqual(
			JSON.parse(listing.result.output).capabilities.map((entry: { name: string }) => entry.name),
			["git"],
		);
		const excluded = await registry.invoke(
			{ tool: "gateway", args: { op: "call", capability: "artifact", args: {} } },
			options,
		);
		ok(excluded.kind === "ok" && excluded.result.kind === "error");
		const empty = resolveAgentTools({ registry, turnConstraints: { allowedTools: [] } });
		deepStrictEqual(empty, []);
	});

	it("refuses delegation that would widen the parent's explicit tools before spawning", async () => {
		let spawned = false;
		const bundle = makeDispatchBundle(dispatchStubContext({ agentTools: RECIPE_TOOLS }), {
			spawnWorker: () => {
				spawned = true;
				throw new Error("must not spawn");
			},
		});
		await bundle.extension.start();
		try {
			const request = { agentId: "coder", task: "Inspect files", cwd: scratch(), executionRole: "builder" as const };
			await rejects(
				bundle.contract.dispatch(request, undefined, { turnConstraints: { allowedTools: ["dispatch", "read"] } }),
				/exceeds the parent task's explicit scope/,
			);
			await rejects(
				bundle.contract.dispatch(request, undefined, { turnConstraints: { delegation: "forbidden" } }),
				/forbidden by the parent/,
			);
			strictEqual(spawned, false);
			strictEqual(bundle.contract.listRuns().length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("narrows a recipe that lists git to a surface that carries gateway and attaches gateway instead of git", () => {
		const registry = createWorkerToolRegistry();
		const names = effectiveToolNames({ registry, allowedTools: RECIPE_TOOLS, includeInteractiveTools: false });
		deepStrictEqual([...names].sort(), [...RECIPE_TOOLS, ToolNames.Gateway].sort());
		const attached = resolveAgentTools({ registry, allowedTools: RECIPE_TOOLS, includeInteractiveTools: false }).map(
			(tool) => tool.name,
		);
		deepStrictEqual(attached, [ToolNames.Context, ToolNames.Edit, ToolNames.Gateway, ToolNames.Read]);
		// A recipe that reaches nothing behind the gateway gains no gateway.
		const plain = effectiveToolNames({
			registry,
			allowedTools: [ToolNames.Read, ToolNames.Grep],
			includeInteractiveTools: false,
		});
		deepStrictEqual([...plain].sort(), [ToolNames.Grep, ToolNames.Read]);
	});

	it("attests the same signature the orchestrator approves for a git recipe", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext({ agentTools: RECIPE_TOOLS }));
		await bundle.extension.start();
		try {
			const request = { agentId: "coder", task: "inspect the git log", cwd: scratch(), executionRole: "builder" as const };
			const preview = bundle.contract.preview?.(request);
			ok(preview);
			// Every role row holds code_nav, so the surface carries it beside the recipe's tools.
			const surface = [...RECIPE_TOOLS, ToolNames.CodeNav, ToolNames.Gateway].sort();
			strictEqual(preview.toolSignature, createHash("sha256").update(JSON.stringify(surface)).digest("hex"));
			// The worker attests its sealed envelope's names, which already carry gateway (M7).
			const attested = attestedToolSignature({
				allowedTools: surface,
				toolsSupported: true,
				agentId: "coder",
				task: request.task,
			});
			strictEqual(attested, toolSignatureOf(surface));
			ok(attested !== toolSignatureOf(RECIPE_TOOLS), "the signed surface carries gateway for a gatewayed capability");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("runs gateway → git for the admitted recipe and refuses a capability the recipe did not declare", async () => {
		const cwd = scratch();
		const registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd }), undefined, []);
		const allowedTools = [...RECIPE_TOOLS, ToolNames.Gateway];
		const git = await registry.invoke(
			{ tool: ToolNames.Gateway, args: { op: "call", capability: ToolNames.Git, args: { op: "log", limit: 1 } } },
			{ allowedTools },
		);
		strictEqual(git.kind, "ok", JSON.stringify(git));
		if (git.kind !== "ok") return;
		strictEqual(git.result.details?.capability, ToolNames.Git);
		const artifact = await registry.invoke(
			{
				tool: ToolNames.Gateway,
				args: { op: "call", capability: ToolNames.Artifact, args: { kind: "report", content: "x" } },
			},
			{ allowedTools },
		);
		if (artifact.kind !== "ok" || artifact.result.kind !== "error") throw new Error(JSON.stringify(artifact));
		ok(artifact.result.message.includes(`capability "${ToolNames.Artifact}" is not on this run's admitted tool surface`));
		ok(artifact.result.message.includes(ToolNames.Git), "the refusal names the admitted surface");
		// find and describe honor the same bound: the worker sees only what it may call.
		const listing = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }, { allowedTools });
		if (listing.kind !== "ok" || listing.result.kind !== "ok") throw new Error(JSON.stringify(listing));
		const payload = JSON.parse(listing.result.output) as { capabilities: Array<{ name: string }> };
		deepStrictEqual(
			payload.capabilities.map((entry) => entry.name),
			[ToolNames.Git],
		);
		const describe = await registry.invoke(
			{ tool: ToolNames.Gateway, args: { op: "describe", capability: ToolNames.Artifact } },
			{ allowedTools },
		);
		if (describe.kind !== "ok" || describe.result.kind !== "error") throw new Error(JSON.stringify(describe));
		ok(describe.result.message.includes("not on this run's admitted tool surface"));
	});

	it("a read-only run refuses a withheld write as read-only and never invokes an off-surface read or shell", async () => {
		const cwd = scratch();
		const notes = join(cwd, "notes.txt");
		writeFileSync(notes, "kept\n");
		const registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd }), undefined, [], true);
		const inner: string[] = [];
		const invoke = registry.invoke.bind(registry);
		registry.invoke = (call, options) => {
			if (call.tool !== ToolNames.Gateway) inner.push(call.tool);
			return invoke(call, options);
		};
		// No run tool list: only the turn bounds the surface, so nothing here leans on admission's run-scope check.
		const options = { turnConstraints: { allowedTools: [ToolNames.Grep, ToolNames.Gateway] } };
		const call = (capability: string, args: Record<string, unknown>) =>
			registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability, args } }, options);
		for (const [capability, args] of [
			[ToolNames.Read, { path: notes }],
			[ToolNames.Bash, { command: `cat ${notes}` }],
		] as const) {
			const verdict = await call(capability, args);
			if (verdict.kind !== "ok" || verdict.result.kind !== "error") throw new Error(JSON.stringify(verdict));
			ok(verdict.result.message.includes(`capability "${capability}" is not on this run's admitted tool surface`));
		}
		deepStrictEqual(inner, [], "an off-surface read or shell call is refused without being invoked");
		const write = JSON.stringify(await call(ToolNames.Write, { path: notes, content: "changed\n" }));
		ok(/write denied: this run is read-only/u.test(write), write);
		ok(write.includes("dispatch:read_only"), write);
		deepStrictEqual(inner, [], "the withheld write is refused from admission's decision, never invoked");
		strictEqual(readFileSync(notes, "utf8"), "kept\n");
	});

	it("never executes an off-surface write in a read-only run, even when admission would admit it", async () => {
		const cwd = scratch();
		const notes = join(cwd, "notes.txt");
		writeFileSync(notes, "kept\n");
		// Drift on purpose: the gateway is told the run is read-only, the registry's admission is not and admits.
		const real = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd }), undefined, []);
		const writeSpec = real.get(ToolNames.Write);
		ok(writeSpec);
		const ran: unknown[] = [];
		const spy: ToolSpec = {
			...writeSpec,
			run: async (args) => {
				ran.push(args);
				return { kind: "ok", output: "wrote" };
			},
		};
		const stub: ToolRegistry = {
			...real,
			get: (name) => (name === ToolNames.Write ? spy : real.get(name)),
			invoke: async (call, options) => {
				const spec = stub.get(call.tool as ToolName);
				if (spec === undefined) return { kind: "not_visible", reason: call.tool };
				const result = await spec.run(call.args ?? {}, options);
				return { kind: "ok", result, decision: { kind: "allow", classification: { actionClass: "write", reasons: [] } } };
			},
		};
		const gateway = createGatewayTool({ registry: stub, readOnly: true });
		const result = await gateway.run(
			{ op: "call", capability: ToolNames.Write, args: { path: notes, content: "changed\n" } },
			{ turnConstraints: { allowedTools: [ToolNames.Grep, ToolNames.Gateway] } },
		);
		deepStrictEqual(ran, [], "the off-surface write's run is never called");
		if (result.kind !== "error") throw new Error(JSON.stringify(result));
		ok(result.message.includes(`capability "${ToolNames.Write}" is not on this run's admitted tool surface`));
		strictEqual(readFileSync(notes, "utf8"), "kept\n");
	});
});
