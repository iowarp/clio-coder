import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { attestedToolSignature, createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { effectiveToolNames, resolveAgentTools } from "../../src/tools/agent-tools.js";
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
			const surface = [...RECIPE_TOOLS, ToolNames.Gateway].sort();
			strictEqual(preview.toolSignature, createHash("sha256").update(JSON.stringify(surface)).digest("hex"));
			const attested = attestedToolSignature({
				allowedTools: RECIPE_TOOLS,
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
		const registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd }), undefined, [], "full-auto");
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
});
