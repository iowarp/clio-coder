import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DynamicToolName, ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { extensionToolName } from "../../src/domains/extensions/command-schema.js";
import {
	extensionManifestYaml,
	loadManifestFromRoot,
	parseExtensionManifest,
} from "../../src/domains/extensions/discovery.js";
import {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/state.js";
import { attestedToolSignature, createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { registerHarnessExtensionTools } from "../../src/tools/harness-extensions.js";
import { applyToolProfile } from "../../src/tools/profiles.js";
import { createRegistry } from "../../src/tools/registry.js";
import { toolSignatureOf } from "../../src/worker/protocol.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const roots: string[] = [];
const envBefore = { ...process.env };
const testName = extensionToolName("fixture", "inspect") as DynamicToolName;
function fixture(
	script = "const input=JSON.parse(process.argv[2]); console.log(JSON.stringify({input, secret:process.env.TEST_HARNESS_SECRET ?? null, cwd:process.cwd()}));",
) {
	const root = mkdtempSync(path.join(tmpdir(), "harness-extension-"));
	roots.push(root);
	const source = path.join(root, "source");
	const cwd = path.join(root, "project");
	mkdirSync(source);
	mkdirSync(cwd);
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.CLIO_CODER_CONFIG_DIR = path.join(root, "config", "clio-coder");
	process.env.CLIO_CODER_STATE_DIR = path.join(root, "state");
	resetXdgCache();
	process.env.TEST_HARNESS_SECRET = "private-test-value";
	const manifest = {
		id: "fixture",
		name: "Fixture",
		version: "1.0.0",
		description: "Command tool fixture",
		capabilities: {
			tools: [
				{
					name: "inspect",
					description: "Inspect JSON input",
					runtime: "node",
					entrypoint: "command.cjs",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
						additionalProperties: false,
					},
				},
			],
		},
	};
	writeFileSync(path.join(source, "clio-coder-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(source, "command.cjs"), script);
	return { root, source, cwd, manifest };
}
function installed(script?: string) {
	const data = fixture(script);
	const result = installExtension(data.source, { cwd: data.cwd, scope: "project" });
	ok(result.extension?.loadable, JSON.stringify(result.diagnostics));
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: data.cwd }), autonomy: () => "full-auto" });
	deepStrictEqual(registerHarnessExtensionTools(registry, data.cwd), []);
	registry.onPermissionRequired((_call, decision, meta) => {
		void registry.resumeParkedCalls({
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			requestedBy: "test",
		});
	});
	return { ...data, registry, extension: result.extension };
}

describe("harness extension executable capabilities", () => {
	afterEach(() => {
		for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
		Object.assign(process.env, envBefore);
		resetXdgCache();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	it("discovers declarative tools without executing package code", () => {
		const data = fixture('require("node:fs").writeFileSync("DISCOVERY_EXECUTED", "bad")');
		const candidate = loadManifestFromRoot(data.source);
		ok(candidate.valid);
		ok(candidate.manifest);
		ok(!existsSync(path.join(data.cwd, "DISCOVERY_EXECUTED")));
		ok(!extensionManifestYaml(candidate.manifest).includes("resources:"));
		deepStrictEqual(
			parseExtensionManifest(data.manifest, "fixture.json").manifest?.capabilities?.tools.map((tool) => tool.name),
			["inspect"],
		);
	});
	it("rejects resources, claimed read-only effects, traversal, symlinks, unknown schema keywords, and duplicate tool names", () => {
		const data = fixture();
		for (const mutate of [
			(value: Record<string, unknown>) => {
				value.resources = {};
			},
			(value: Record<string, unknown>) => {
				((value.capabilities as { tools: object[] }).tools[0] as Record<string, unknown>).baseActionClass = "read";
			},
			(value: Record<string, unknown>) => {
				((value.capabilities as { tools: object[] }).tools[0] as Record<string, unknown>).entrypoint = "../outside.cjs";
			},
			(value: Record<string, unknown>) => {
				((value.capabilities as { tools: object[] }).tools[0] as Record<string, unknown>).inputSchema = {
					type: "object",
					$ref: "https://example.invalid/schema",
				};
			},
			(value: Record<string, unknown>) => {
				const tools = (value.capabilities as { tools: object[] }).tools;
				tools.push({ ...tools[0] });
			},
		]) {
			const manifest: Record<string, unknown> = structuredClone(data.manifest);
			mutate(manifest);
			ok(parseExtensionManifest(manifest, "fixture.json").diagnostics.some((entry) => entry.type === "error"));
		}
		rmSync(path.join(data.source, "command.cjs"));
		writeFileSync(path.join(data.source, "target.cjs"), "console.log('{}')");
		symlinkSync("target.cjs", path.join(data.source, "command.cjs"));
		equal(loadManifestFromRoot(data.source).valid, false);
	});
	it("executes JSON literally, strips secrets, returns provenance, and validates input", async () => {
		const { registry, cwd } = installed();
		const text = 'hello; $(touch SHOULD_NOT_EXIST) `echo bad` "quotes"';
		const verdict = await registry.invoke({ tool: testName, args: { text } });
		equal(verdict.kind, "ok");
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
		deepStrictEqual(JSON.parse(verdict.result.output), { input: { text }, secret: null, cwd });
		equal(verdict.decision.classification.actionClass, "execute");
		ok(verdict.result.details?.extension);
		ok(!existsSync(path.join(cwd, "SHOULD_NOT_EXIST")));
		const invalid = await registry.get(testName)?.run({ unknown: true });
		equal(invalid?.kind, "error");
	});
	it("does not bypass read-only autonomy or worker write confinement", async () => {
		const { cwd } = installed();
		for (const [autonomy, writeRoots] of [
			["read-only", undefined],
			["full-auto", ["outputs"]],
		] as const) {
			const registry = createRegistry({
				safety: createWorkerSafety({ cwd, ...(writeRoots ? { writeRoots } : {}) }),
				autonomy: () => autonomy,
			});
			registerHarnessExtensionTools(registry, cwd);
			const verdict = await registry.invoke({ tool: testName, args: { text: "read" } });
			equal(verdict.kind, "blocked", JSON.stringify(verdict));
		}
	});
	it("refuses disabled, replaced, removed, and drifted installed commands", async () => {
		const data = installed();
		const tool = data.registry.get(testName);
		ok(tool);
		disableExtension("fixture", { cwd: data.cwd, scope: "project" });
		equal((await tool.run({ text: "test" })).kind, "error");
		enableExtension("fixture", { cwd: data.cwd, scope: "project" });
		writeFileSync(path.join(data.extension.rootPath, "command.cjs"), "console.log('{}')");
		equal((await tool.run({ text: "test" })).kind, "error");
		installExtension(data.source, { cwd: data.cwd, scope: "project", force: true });
		writeFileSync(path.join(data.source, "command.cjs"), "console.log('null')");
		installExtension(data.source, { cwd: data.cwd, scope: "project", force: true });
		equal((await tool.run({ text: "test" })).kind, "error");
		removeExtension("fixture", { cwd: data.cwd, scope: "project" });
		equal((await tool.run({ text: "test" })).kind, "error");
	});
	it("protects registered names from collisions without overwriting the existing tool", () => {
		const { registry, cwd } = installed();
		const original = registry.get(testName);
		ok(registerHarnessExtensionTools(registry, cwd).some((entry) => entry.message.includes("collision")));
		equal(registry.get(testName), original);
	});
	it("runs the effective project tool when a drifted user installation shares its id", async () => {
		const data = installed();
		const user = installExtension(data.source, { cwd: data.cwd, scope: "user" });
		ok(user.extension);
		writeFileSync(path.join(user.extension.rootPath, "command.cjs"), "console.log('null')");
		const entries = listInstalledExtensions(data.cwd).filter((entry) => entry.id === "fixture");
		equal(entries.length, 2);
		equal(entries[0]?.valid, false);
		equal(entries[1]?.loadable, true);
		const result = await data.registry.get(testName)?.run({ text: "project scope" });
		ok(result?.kind === "ok", JSON.stringify(result));
		deepStrictEqual(JSON.parse(result.output).input, { text: "project scope" });
	});
	it("keeps a rule targeting the public capability authoritative before checking command effects", async () => {
		const data = installed();
		const base = createWorkerSafety({ cwd: data.cwd });
		const registry = createRegistry({
			safety: {
				...base,
				evaluate(call, posture) {
					if (call.tool === testName)
						return {
							kind: "block",
							classification: { actionClass: "execute", reasons: ["capability denied"] },
							rejection: { short: "capability denied", detail: "test policy", hints: [] },
						};
					return base.evaluate(call, posture);
				},
			},
			autonomy: () => "full-auto",
		});
		registerHarnessExtensionTools(registry, data.cwd);
		const verdict = await registry.invoke({ tool: testName, args: { text: "test" } });
		equal(verdict.kind, "blocked");
		if (verdict.kind === "blocked") equal(verdict.reason, "capability denied");
	});
	it("loads user capabilities into session and worker registries behind the gateway while narrow profiles exclude them", () => {
		const data = fixture();
		ok(installExtension(data.source, { cwd: data.cwd, scope: "user" }).extension?.loadable);
		const registry = createWorkerToolRegistry();
		ok(registry.get(testName));
		// Registered, reachable by name, and never attached: the command sits on
		// the gateway surface, not on the direct one.
		ok(!registry.listRegistered().includes(testName), "an extension command must not be a direct tool");
		ok(
			registry.listGateway().some((spec) => spec.name === testName),
			"an extension command is a gateway capability",
		);
		const sessionRegistry = createRegistry({ safety: createWorkerSafety({ cwd: data.cwd }) });
		registerAllTools(sessionRegistry, { mcpCapabilities: false });
		ok(sessionRegistry.get(testName));
		ok(!sessionRegistry.listRegistered().includes(testName));
		deepStrictEqual(applyToolProfile([testName], "minimal-local"), []);
		deepStrictEqual(applyToolProfile([testName], "full-agent"), [testName]);
	});
	it("runs an installed command through the gateway with its execute class, provenance, and denial intact", async () => {
		const { registry, cwd } = installed();
		registry.register(createGatewayTool({ registry }));
		const text = "through the gateway";
		const verdict = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: testName, args: { text } },
		});
		equal(verdict.kind, "ok");
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
		deepStrictEqual(JSON.parse(verdict.result.output), { input: { text }, secret: null, cwd });
		equal(verdict.result.details?.capability, testName);
		ok(verdict.result.details?.extension, "the extension provenance rides the gateway result");
		const listing = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "fixture" } });
		if (listing.kind !== "ok" || listing.result.kind !== "ok") throw new Error(JSON.stringify(listing));
		const entry = (
			JSON.parse(listing.result.output) as { capabilities: Array<Record<string, unknown>> }
		).capabilities.find((candidate) => candidate.name === testName);
		deepStrictEqual(
			{ kind: entry?.kind, actionClass: entry?.actionClass },
			{ kind: "extension", actionClass: "execute" },
		);
		// read-only denies the command through the gateway exactly as it denies
		// the command by name: the gateway call itself settles as that block.
		const readOnly = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "read-only" });
		registerHarnessExtensionTools(readOnly, cwd);
		readOnly.register(createGatewayTool({ registry: readOnly }));
		const denied = await readOnly.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: testName, args: { text } },
		});
		equal(denied.kind, "blocked", JSON.stringify(denied));
		if (denied.kind === "blocked") ok(denied.reason.includes(testName), denied.reason);
	});
	it("enforces command timeout, output cap, and cancellation", async () => {
		for (const [script, limits, expected] of [
			["setInterval(() => {}, 1000)", { timeoutMs: 30 }, "timed out"],
			["console.log(JSON.stringify('x'.repeat(10000)))", { maxOutputBytes: 100 }, "output limit exceeded"],
		] as const) {
			const data = fixture(script);
			Object.assign(data.manifest.capabilities.tools[0] ?? {}, limits);
			writeFileSync(path.join(data.source, "clio-coder-extension.json"), JSON.stringify(data.manifest));
			ok(installExtension(data.source, { cwd: data.cwd, scope: "project" }).extension?.loadable);
			const registry = createRegistry({ safety: createWorkerSafety({ cwd: data.cwd }) });
			registerHarnessExtensionTools(registry, data.cwd);
			const result = await registry.get(testName)?.run({ text: "test" });
			equal(result?.kind, "error");
			if (result?.kind === "error") ok(result.message.includes(expected), result.message);
		}
		const data = installed();
		const result = await data.registry.get(testName)?.run({ text: "test" }, { signal: AbortSignal.abort() });
		equal(result?.kind, "error");
		if (result?.kind === "error") ok(result.message.includes("aborted before execution"));
	});
	it("admits installed native worker capabilities and signs the same surface in the worker", async () => {
		const data = fixture();
		ok(installExtension(data.source, { cwd: data.cwd, scope: "user" }).extension?.loadable);
		const allowedTools = [ToolNames.Read, ToolNames.Write, testName];
		const bundle = makeDispatchBundle(dispatchStubContext({ agentTools: allowedTools }));
		await bundle.extension.start();
		try {
			const request = {
				agentId: "coder",
				task: "Use the installed inspection capability",
				cwd: data.cwd,
				executionRole: "builder" as const,
			};
			const preview = bundle.contract.preview?.(request);
			ok(preview);
			// The command is a gateway capability, so the admitted surface gains
			// `gateway` on both sides: the plan the orchestrator approves and the
			// surface the worker attests are computed from the same rule.
			const surface = [...allowedTools, ToolNames.Gateway];
			equal(
				preview.toolSignature,
				createHash("sha256")
					.update(JSON.stringify([...surface].sort()))
					.digest("hex"),
			);
			equal(
				attestedToolSignature({ allowedTools, toolsSupported: true, agentId: "coder", task: request.task }),
				toolSignatureOf(surface),
			);
			disableExtension("fixture", { cwd: data.cwd, scope: "user" });
			throws(() => bundle.contract.preview?.(request), /extension_fixture__inspect/);
		} finally {
			await bundle.extension.stop?.();
		}
	});
	it("returns bounded errors for non-JSON output and nonzero exit", async () => {
		for (const script of ["console.log('not JSON')", "process.exit(7)"]) {
			const data = installed(script);
			const result = await data.registry.get(testName)?.run({ text: "test" });
			equal(result?.kind, "error");
		}
	});
	it("loads a hook-only package and registers no command tools for it", () => {
		const data = fixture();
		rmSync(path.join(data.source, "command.cjs"));
		writeFileSync(
			path.join(data.source, "clio-coder-extension.json"),
			JSON.stringify({
				id: "hooks-only",
				name: "Hooks Only",
				version: "1.0.0",
				description: "Hook declarations with no command tools",
			}),
		);
		writeFileSync(path.join(data.source, "hooks.yaml"), "[]\n");
		ok(installExtension(data.source, { cwd: data.cwd, scope: "project" }).extension?.loadable);
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: data.cwd }) });
		registerHarnessExtensionTools(registry, data.cwd);
		equal(registry.listRegistered().length, 0);
		ok(listInstalledExtensions(data.cwd).find((entry) => entry.id === "hooks-only")?.loadable);
	});
});
