import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolRegistry } from "../../src/tools/registry.js";
import {
	directSurfaceNames,
	effectiveToolCall,
	TOOL_PLACEMENT,
	toolPlacement,
	withGatewayForCapabilities,
} from "../../src/tools/surface.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * The placement contract: which builtins carry an attached schema, which sit
 * behind the gateway, and the invariants every registry keeps (the bootstrap
 * policy assertion, the executable projection, the loop guard's single count
 * for a gateway call, the skill surface's exemption of the gateway with the
 * capability still checked under its own name).
 */

const GATEWAY_BUILTINS = [
	ToolNames.Artifact,
	ToolNames.WebRead,
	ToolNames.WebFetch,
	ToolNames.Git,
	ToolNames.Evidence,
	ToolNames.CredentialPresent,
	ToolNames.ClioDocs,
	ToolNames.ClioLibrary,
	ToolNames.Data,
];

const DIRECT_CORE = [
	ToolNames.Read,
	ToolNames.Write,
	ToolNames.Edit,
	ToolNames.Bash,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.Context,
	ToolNames.CodeNav,
	ToolNames.Verify,
	ToolNames.RunScript,
	ToolNames.Gateway,
];

const roots: string[] = [];

function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-gateway-surface-")));
	roots.push(root);
	return root;
}

function payloadOf(verdict: Awaited<ReturnType<ToolRegistry["invoke"]>>): Record<string, unknown> {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
	return JSON.parse(verdict.result.output) as Record<string, unknown>;
}

describe("gateway surface placement", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-surface-");
	});
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	it("declares every builtin once and places the secondary capabilities behind the gateway", () => {
		for (const name of Object.values(ToolNames)) ok(name in TOOL_PLACEMENT, `${name} has a placement row`);
		for (const name of GATEWAY_BUILTINS) strictEqual(toolPlacement(name), "gateway", name);
		for (const name of DIRECT_CORE) strictEqual(toolPlacement(name), "direct", name);
		strictEqual(toolPlacement("extension_fixture__inspect"), "gateway");
		strictEqual(toolPlacement("mcp_files__read_file"), "gateway");
		deepStrictEqual(directSurfaceNames(["read", "git", "web_fetch", "read"]), ["read", "gateway"]);
		deepStrictEqual(directSurfaceNames(["read", "grep"]), ["read", "grep"]);
		deepStrictEqual(withGatewayForCapabilities([ToolNames.Read, ToolNames.Git]), [
			ToolNames.Read,
			ToolNames.Git,
			ToolNames.Gateway,
		]);
		deepStrictEqual(withGatewayForCapabilities([ToolNames.Read, ToolNames.Grep]), [ToolNames.Read, ToolNames.Grep]);
	});

	it("registers run_script direct and data behind the gateway in session and worker registries with the policy assertion green", () => {
		const session = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
		registerAllTools(session, { mcpCapabilities: false });
		const worker = createWorkerToolRegistry();
		for (const registry of [session, worker]) {
			const direct = registry.listRegistered();
			const gateway = registry.listGateway().map((spec) => spec.name);
			ok(direct.includes(ToolNames.RunScript), "run_script is attached direct");
			ok(direct.includes(ToolNames.Gateway), "gateway is attached direct");
			for (const name of GATEWAY_BUILTINS) {
				ok(!direct.includes(name), `${name} is not attached`);
				ok(gateway.includes(name), `${name} is reachable through the gateway`);
				ok(registry.get(name) !== undefined, `${name} stays registered by name`);
			}
			strictEqual(registry.get(ToolNames.Data)?.baseActionClass, "read");
			strictEqual(registry.get(ToolNames.RunScript)?.baseActionClass, "execute");
			deepStrictEqual(
				registry.listVisible().map((spec) => spec.name),
				direct,
				"visible specs and direct names agree",
			);
		}
	});

	it("attaches only direct schemas to the agent and keeps every capability name on the effective list", () => {
		const registry = createWorkerToolRegistry();
		const attached = resolveAgentTools({ registry }).map((tool) => tool.name);
		deepStrictEqual(attached, [...registry.listRegistered()].sort());
		for (const name of GATEWAY_BUILTINS) ok(!attached.includes(name), `${name} has no attached schema`);
	});

	it("find lists capabilities with kind and class, describe hands over the wire schema, and direct tools are refused", async () => {
		const registry = createWorkerToolRegistry();
		const listing = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }));
		const capabilities = listing.capabilities as Array<Record<string, unknown>>;
		const byName = new Map(capabilities.map((entry) => [entry.name, entry]));
		deepStrictEqual(byName.get(ToolNames.Artifact)?.kind, "builtin");
		deepStrictEqual(byName.get(ToolNames.Artifact)?.actionClass, "write");
		deepStrictEqual(byName.get(ToolNames.Data)?.actionClass, "read");
		deepStrictEqual(byName.get(ToolNames.Git)?.actionClass, "read");
		ok(!byName.has(ToolNames.Read), "direct tools are not gateway capabilities");
		for (const entry of capabilities) {
			ok(typeof entry.description === "string" && entry.description.length > 0, `${entry.name} has a description`);
			ok(!(entry.description as string).includes("\n"), "find carries one sentence per capability");
		}
		const filtered = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "csv" } }));
		deepStrictEqual(
			(filtered.capabilities as Array<{ name: string }>).map((entry) => entry.name),
			[ToolNames.Data],
		);

		const described = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "describe", capability: ToolNames.Artifact },
		});
		const description = payloadOf(described);
		strictEqual(description.name, ToolNames.Artifact);
		strictEqual(description.actionClass, "write");
		const parameters = description.parameters as { properties: Record<string, unknown> };
		ok("kind" in parameters.properties && "content" in parameters.properties, "the parameter schema is attached");
		ok(!JSON.stringify(description.parameters).includes('"~'), "TypeBox markers are stripped from the wire schema");
		ok(
			(description.authority as string[]).some((note) => note.includes("write")),
			"authority notes state the action class",
		);

		const direct = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "describe", capability: ToolNames.Read },
		});
		if (direct.kind !== "ok" || direct.result.kind !== "error") throw new Error(JSON.stringify(direct));
		ok(direct.result.message.includes("direct tool"), direct.result.message);
		const unknown = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: "no_such_tool" } });
		if (unknown.kind !== "ok" || unknown.result.kind !== "error") throw new Error(JSON.stringify(unknown));
		ok(unknown.result.message.includes("unknown capability"), unknown.result.message);
	});

	it("normalizes weak-model argument shapes for the gateway call", async () => {
		const registry = createWorkerToolRegistry();
		const verdict = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { name: ToolNames.CredentialPresent, args: JSON.stringify({ name: "CLIO_GATEWAY_TEST_ABSENT" }) },
		});
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
		strictEqual(verdict.result.details?.capability, ToolNames.CredentialPresent);
		ok(verdict.result.output.includes("false"), verdict.result.output);
	});

	it("counts a gateway call once in the loop guard", async () => {
		const cwd = scratch();
		writeFileSync(join(cwd, "note.txt"), "hello\n");
		const safety = createWorkerSafety({ cwd });
		const guard = createLoopGuardRegistration({ safety, toolCallCap: 10 });
		const registry = createWorkerToolRegistry(undefined, safety, undefined, [guard], "full-auto");
		const nested = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ToolNames.CredentialPresent, args: { name: "CLIO_GATEWAY_TEST_ABSENT" } },
		});
		strictEqual(nested.kind, "ok");
		strictEqual(guard.callCount(), 1, "the gateway call and the capability it ran are one model call");
		const direct = await registry.invoke({ tool: ToolNames.Read, args: { path: join(cwd, "note.txt") } });
		strictEqual(direct.kind, "ok");
		strictEqual(guard.callCount(), 2);
	});

	it("exempts the gateway from the skill surface and checks the capability under its own name", async () => {
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: env.dir }),
			undefined,
			[],
			"full-auto",
		);
		const pendingSkillPolicy = {
			allowedSkillNames: [],
			requests: [],
			loadedSkillNames: new Set(["narrow"]),
			loadedSkillPolicies: new Map([["narrow", { allowedTools: [ToolNames.Read] }]]),
		};
		const find = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }, { pendingSkillPolicy });
		strictEqual(find.kind, "ok", "find and describe are harmless under any skill narrowing");
		const call = await registry.invoke(
			{
				tool: ToolNames.Gateway,
				args: { op: "call", capability: ToolNames.CredentialPresent, args: { name: "CLIO_GATEWAY_TEST_ABSENT" } },
			},
			{ pendingSkillPolicy },
		);
		strictEqual(call.kind, "blocked", JSON.stringify(call));
		if (call.kind === "blocked") {
			ok(call.reason.startsWith(`${ToolNames.CredentialPresent} is outside the tool surface`), call.reason);
		}
	});

	it("unwraps a gateway ledger record to the capability it ran", () => {
		const call = effectiveToolCall("gateway", { op: "call", capability: "artifact", args: { kind: "report" } });
		deepStrictEqual(call, { toolName: "artifact", args: { kind: "report" }, viaGateway: true });
		const fromDetails = effectiveToolCall("gateway", undefined, { capability: "git", exitCode: 0 });
		deepStrictEqual(fromDetails, { toolName: "git", args: undefined, viaGateway: true });
		deepStrictEqual(effectiveToolCall("gateway", { op: "find", query: "git" }), {
			toolName: "gateway",
			args: { op: "find", query: "git" },
			viaGateway: false,
		});
		deepStrictEqual(effectiveToolCall("read", { path: "a.ts" }), {
			toolName: "read",
			args: { path: "a.ts" },
			viaGateway: false,
		});
	});

	it("keeps invoke placement-agnostic so a hidden capability still runs by name", async () => {
		const registry = createWorkerToolRegistry();
		const verdict = await registry.invoke({
			tool: ToolNames.CredentialPresent,
			args: { name: "CLIO_GATEWAY_TEST_ABSENT" },
		});
		strictEqual(verdict.kind, "ok");
	});
});
