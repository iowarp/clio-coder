import { deepStrictEqual, equal, match, notEqual, ok, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createExtensionsBundle } from "../../src/domains/extensions/extension.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { parseExtensionHookResult } from "../../src/domains/extensions/runtime-output-v2.js";
import {
	capabilityEnvelope,
	envelopeDigest,
	envelopeGrowth,
	parseExtensionRuntimeV2,
	RUNTIME_V2_LIMITS,
} from "../../src/domains/extensions/runtime-schema-v2.js";
import { disableExtension, installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { applyToolRounds, type ToolRound } from "../../src/engine/provider-payload.js";
import type { AgentTool, EngineModel } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createExtensionReloadCoordinator } from "../../src/entry/extension-reload.js";
import { buildExtensionRuntimeHooks } from "../../src/entry/extension-runtime-hooks.js";
import { toolSignatureFromState } from "../../src/session-control/chat-loop-messages.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { buildExtensionRuntimeToolSpecs } from "../../src/tools/extension-runtime-tools.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { directSurfaceNames } from "../../src/tools/surface.js";
import { middlewareOwner } from "../harness/middleware-owner.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const tool = (name: string, description = `Desk ${name}`) => ({
	name,
	description,
	actionClass: "execute",
	inputSchema: { type: "object", properties: { after: { type: "string" } }, additionalProperties: false },
});
const runtime = (extra: Record<string, unknown>) =>
	parseExtensionRuntimeV2({
		api: 2,
		entrypoint: "extension.mjs",
		tools: ["next_step", "status", "gate", "record", "archive"].map((name) => tool(name)),
		...extra,
	});

test("runtime.promote names declared tools and is capped by count and by schema bytes", () => {
	const promoted = runtime({ promote: ["next_step", "gate"] });
	deepStrictEqual(promoted.promote, ["next_step", "gate"]);
	const plain = runtime({});
	// A manifest that promotes nothing keeps the declaration and the envelope digest it had before the key existed.
	ok(!("promote" in plain) && !("promote" in capabilityEnvelope(plain)));
	notEqual(envelopeDigest(capabilityEnvelope(promoted)), envelopeDigest(capabilityEnvelope(plain)));
	deepStrictEqual(envelopeGrowth(capabilityEnvelope(plain), capabilityEnvelope(promoted)), [
		"attaches tool schemas to every request: next_step, gate",
	]);
	deepStrictEqual(envelopeGrowth(capabilityEnvelope(promoted), capabilityEnvelope(plain)), []);
	throws(() => runtime({ promote: ["missing"] }), /runtime\.promote\[0\] 'missing' is not a declared runtime tool/u);
	throws(() => runtime({ promote: ["gate", "gate"] }), /runtime\.promote lists a tool twice/u);
	equal(RUNTIME_V2_LIMITS.promotedTools, 4);
	throws(
		() => runtime({ promote: ["next_step", "status", "gate", "record", "archive"] }),
		/runtime\.promote allows at most 4 entries/u,
	);
	throws(
		() =>
			parseExtensionRuntimeV2({
				api: 2,
				entrypoint: "extension.mjs",
				tools: [tool("wide", "w".repeat(1000)), { ...tool("deep"), description: "d".repeat(1000) }].map((entry) => ({
					...entry,
					inputSchema: { type: "object", properties: { note: { type: "string", description: "n".repeat(1100) } } },
				})),
				promote: ["wide"],
			}),
		/'wide' would attach \d+ bytes of description and input schema to every request; a promoted tool allows at most 2048/u,
	);
});

test("a reload that reclassifies an approved tool asks again and names both classes", () => {
	// Astra r6-2: only execute to read used to count, so execute to write reloaded without a consent ask.
	const writer = (actionClass: string) =>
		capabilityEnvelope(
			parseExtensionRuntimeV2({
				api: 2,
				entrypoint: "extension.mjs",
				tools: [{ ...tool("gate"), actionClass }],
				permissions: { fs: { write: ["out"] } },
			}),
		);
	notEqual(envelopeDigest(writer("execute")), envelopeDigest(writer("write")));
	deepStrictEqual(envelopeGrowth(writer("execute"), writer("write")), ["tool gate is now write (approved execute)"]);
	deepStrictEqual(envelopeGrowth(writer("write"), writer("execute")), ["tool gate is now execute (approved write)"]);
	deepStrictEqual(envelopeGrowth(capabilityEnvelope(runtime({})), capabilityEnvelope(runtime({}))), []);
});

test("a hook requires its own tool only when the manifest promotes it", () => {
	const declaration = runtime({ promote: ["next_step"] });
	const require = (toolName: string) =>
		parseExtensionHookResult({ effects: [{ kind: "require_tool", toolName }] }, declaration, "turn_start", "desk");
	deepStrictEqual(require("extension_desk__next_step").effects, [
		{ kind: "require_tool", toolName: "extension_desk__next_step" },
	]);
	throws(
		() => require("extension_desk__status"),
		/effects\[0\]\.toolName extension_desk__status is not promoted, so no request can require it; list status under runtime\.promote/u,
	);
	throws(
		() => require("next_step"),
		/effects\[0\]\.toolName 'next_step' is this package's tool extension_desk__next_step; name it in full/u,
	);
	// Names outside the package stay the host's to judge, as before.
	for (const outside of ["read", "extension_other__status", "mcp_files__list"])
		deepStrictEqual(require(outside).effects, [{ kind: "require_tool", toolName: outside }]);
});

function writeRuntime(dir: string, id: string, runtimeBlock: Record<string, unknown>): string {
	const root = path.join(dir, `source-${id}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		path.join(root, "clio-coder-extension.json"),
		JSON.stringify({
			id,
			name: id,
			version: "1.0.0",
			description: "A desk whose tools a session attaches",
			runtime: { api: 2, entrypoint: "extension.mjs", ...runtimeBlock },
		}),
	);
	writeFileSync(path.join(root, "extension.mjs"), "export default () => {};\n");
	return root;
}

function install(dir: string, cwd: string, id: string, runtimeBlock: Record<string, unknown>): void {
	const result = installExtension(writeRuntime(dir, id, runtimeBlock), { cwd, scope: "user" });
	ok(result.extension?.loadable, result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
}

/**
 * What admission, approval and the loop guard read from a spec. Placement and the bound closure stay out, and so
 * does `sourceInfo`, whose envelope digest differs because the fixture twin is a different manifest.
 */
function admissionFields(spec: ToolSpec) {
	const { name, description, parameters, baseActionClass, executionMode, metadata } = spec;
	return { name, description, parameters, baseActionClass, executionMode, metadata };
}

function sessionRegistry(cwd: string): ToolRegistry {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "default" });
	registry.register({
		name: "read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: "" }),
	});
	registry.register(createGatewayTool({ registry }));
	return registry;
}

const anthropic: EngineModel = {
	id: "claude-fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};

/** The body Pi's serializer builds for one round over the session's tools; no network is reached. */
async function wire(tools: AgentTool[], rounds: readonly (ToolRound | undefined)[]) {
	const controlled = applyToolRounds(
		anthropic,
		{ messages: [{ role: "user" as const, content: "advance", timestamp: 0 }], tools },
		{ apiKey: "fixture" },
		rounds,
	);
	let body: { tools?: unknown; tool_choice?: unknown } | undefined;
	await engineStreamSimple(anthropic, controlled.context, {
		...controlled.options,
		onPayload: async (payload, current) => {
			body = structuredClone((await controlled.options?.onPayload?.(payload, current)) ?? payload) as typeof body;
			throw new Error("captured before network I/O");
		},
	}).result();
	ok(body, "the serializer must build a body before the stream fails");
	return body;
}

test("a promoted tool is attached under its one name, and a requirement pins the provider's tool choice to it without moving the schema bytes", async (t) => {
	const env = await isolateClioEnv("clio-coder-promoted-tools-");
	t.after(() => env.restore());
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	install(env.dir, cwd, "desk", { tools: [tool("next_step"), tool("status")], promote: ["next_step"] });
	const packages = listInstalledExtensions(cwd, { all: true });
	const bridge = createExtensionRuntimeHookBridge();
	const specs = buildExtensionRuntimeToolSpecs(packages, bridge);
	deepStrictEqual(
		specs.map((spec) => [spec.name, spec.placement]),
		[
			["extension_desk__next_step", "direct"],
			["extension_desk__status", "gateway"],
		],
	);
	// Promotion changes placement and nothing admission reads: the same package unpromoted yields the same spec.
	const [unpromoted] = buildExtensionRuntimeToolSpecs(
		packages.map((entry) => {
			const { promote: _promote, ...rest } = entry.runtimeV2 ?? { promote: [] };
			return entry.runtimeV2 ? { ...entry, runtimeV2: rest as NonNullable<typeof entry.runtimeV2> } : entry;
		}),
		bridge,
	);
	const [promoted] = specs;
	ok(promoted && unpromoted);
	equal(unpromoted.placement, "gateway");
	deepStrictEqual(admissionFields(promoted), admissionFields(unpromoted));

	const registry = sessionRegistry(cwd);
	for (const spec of specs) registry.register(spec);
	const tools = resolveAgentTools({ registry });
	deepStrictEqual(
		tools.map((entry) => entry.name),
		["extension_desk__next_step", "gateway", "read"],
	);
	// The gateway keeps reaching the unpromoted sibling and refuses the promoted name, so one tool has one route.
	deepStrictEqual(
		registry.listGateway().map((spec) => spec.name),
		["extension_desk__status"],
	);
	const viaGateway = await registry.invoke({
		tool: "gateway",
		args: { op: "call", capability: "extension_desk__next_step", args: {} },
	});
	ok(viaGateway.kind === "ok" && viaGateway.result.kind === "error");
	match(
		viaGateway.result.message,
		/"extension_desk__next_step" is a direct tool with an attached schema; call it directly/u,
	);
	deepStrictEqual(
		directSurfaceNames(["extension_desk__next_step", "gateway", "read"], new Set(["extension_desk__next_step"])),
		["extension_desk__next_step", "gateway", "read"],
	);

	// Every turn resolves the same bytes, whatever order the generation's specs were registered in.
	const signature = toolSignatureFromState(tools);
	equal(toolSignatureFromState(resolveAgentTools({ registry })), signature);
	const reordered = sessionRegistry(cwd);
	for (const spec of [...specs].reverse()) reordered.register(spec);
	equal(toolSignatureFromState(resolveAgentTools({ registry: reordered })), signature);

	// A hook's requirement becomes the provider's named tool choice, and the tools the request carries do not move.
	const control = createMiddlewareToolChoiceControl();
	const free = await wire(tools, []);
	equal(free.tool_choice, undefined);
	const returned = parseExtensionHookResult(
		{ effects: [{ kind: "require_tool", toolName: "extension_desk__next_step" }] },
		packages[0]?.runtimeV2 ?? runtime({}),
		"turn_start",
		"desk",
	);
	control.apply((returned.effects ?? []).flatMap((effect) => (effect.kind === "require_tool" ? [effect] : [])));
	const choice = control.current();
	ok(choice.kind === "required");
	const pinned = await wire(tools, [{ kind: "required", toolName: choice.toolName }]);
	deepStrictEqual(pinned.tool_choice, { type: "tool", name: "extension_desk__next_step" });
	equal(JSON.stringify(pinned.tools), JSON.stringify(free.tools));
	equal(toolSignatureFromState(tools), signature);
	// The requirement clears on the direct call itself.
	control.toolStarted("extension_desk__next_step", {});
	deepStrictEqual(control.current(), { kind: "auto" });
	// Unpromoted, the same requirement has no schema to name and the request goes out unpinned.
	const absent = await wire(resolveAgentTools({ registry, allowedTools: ["read", "gateway"] as never }), [
		{ kind: "required", toolName: "extension_desk__next_step" },
	]);
	equal(absent.tool_choice, undefined);
});

test("the promoted set follows the published generation: an unchanged reload keeps the bytes, a changed one moves the tool signature, and the session cap holds the overflow", async (t) => {
	const env = await isolateClioEnv("clio-coder-promoted-reload-");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	install(env.dir, cwd, "desk", { tools: [tool("next_step"), tool("status")], promote: ["next_step"] });
	const domainContext: DomainContext = { bus: {} as DomainContext["bus"], getContract: () => undefined };
	const bundle = createExtensionsBundle(domainContext, { cwd: () => cwd });
	bundle.extension.start();
	t.after(() => {
		bundle.extension.stop?.();
		env.restore();
	});
	const lines: string[] = [];
	const coordinator = createExtensionReloadCoordinator({
		extensions: bundle.contract,
		middleware: middlewareOwner(createMiddlewareBundle()),
		cwd: () => cwd,
		recordReceipt: () => {},
		report: (line) => lines.push(line),
		runtimeHooks: createExtensionRuntimeHookBridge(),
	});
	equal(coordinator.applyBoot().status, "committed");
	const registry = sessionRegistry(cwd);
	coordinator.attachRuntimeTools(registry);
	const attached = (): string[] =>
		resolveAgentTools({ registry })
			.map((entry) => entry.name)
			.filter((name) => name.startsWith("extension_"));
	const signature = (): string => toolSignatureFromState(resolveAgentTools({ registry }));
	deepStrictEqual(attached(), ["extension_desk__next_step"]);
	const booted = signature();

	equal(coordinator.reload().status, "committed");
	equal(signature(), booted, "a reload that leaves the promoted declarations alone leaves the provider prefix alone");

	// Two more packages promote four tools each: nine in all against a session cap of eight.
	const four = ["one", "two", "three", "four"];
	for (const id of ["alpha", "zeta"])
		install(env.dir, cwd, id, { tools: four.map((name) => tool(name)), promote: four });
	equal(coordinator.reload().status, "committed");
	equal(RUNTIME_V2_LIMITS.promotedToolsPerSession, 8);
	// Packages attach in id order, so the last package's last tool is the one held behind the gateway.
	deepStrictEqual(
		attached(),
		[
			...four.map((name) => `extension_alpha__${name}`),
			"extension_desk__next_step",
			...four.slice(0, 3).map((name) => `extension_zeta__${name}`),
		].sort(),
	);
	ok(registry.listGateway().some((spec) => spec.name === "extension_zeta__four"));
	ok(
		lines.some((line) =>
			/promoted tool extension_zeta__four stays behind the gateway: a session attaches at most 8 promoted tools/u.test(
				line,
			),
		),
		lines.join("\n"),
	);
	// The signature the next turn compares against the last one, which is what records `tool_surface_change`.
	const grown = signature();
	notEqual(grown, booted);

	for (const id of ["alpha", "zeta"]) disableExtension(id, { cwd });
	equal(coordinator.reload().status, "committed");
	deepStrictEqual(attached(), ["extension_desk__next_step"]);
	equal(signature(), booted, "the same promoted declarations serialize to the same bytes again");
});

test("a requirement for a promoted tool reaches the session's turn and never a dispatched worker's", async (t) => {
	const env = await isolateClioEnv("clio-coder-promoted-worker-");
	t.after(() => env.restore());
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	install(env.dir, cwd, "desk", {
		tools: [tool("next_step")],
		promote: ["next_step"],
		hooks: [{ on: "after_tool", tools: ["write"], timeoutMs: 1000 }],
	});
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({
		hook: async () => ({ kind: "ok", effects: [{ kind: "require_tool", toolName: "extension_desk__next_step" }] }),
		notify: () => {},
	});
	const hooks = buildExtensionRuntimeHooks(listInstalledExtensions(cwd, { all: true }), bridge, {
		generation: 1,
		recordReceipt: () => {},
	});
	const [registration] = hooks.registrations;
	const worker = hooks.workerEvaluators.get(registration?.id ?? "");
	ok(registration?.evaluateAsync && worker);
	const input = { hook: "after_tool" as const, toolName: "write", metadata: { resultKind: "ok" } };
	deepStrictEqual(await registration.evaluateAsync(input), [
		{ kind: "require_tool", toolName: "extension_desk__next_step" },
	]);
	// The worker runs in its own process with none of the session's runtime tools, so it is never asked for one.
	deepStrictEqual(await worker(input), []);
});
