import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import {
	createMcpStdioClient,
	type McpClient,
	trustMcpServer,
	untrustMcpServer,
} from "../../src/domains/gateway/mcp/index.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import { createRegistry, type ToolRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Local MCP servers through the gateway: an untrusted or stale project server
 * is listed with the exact trust remedy and never launched; a trusted one is
 * launched lazily on the first find, describe, or call that needs it, lists
 * as `mcp_<id>__<tool>`, calls, and is closed when the session ends. The
 * trust record's action class is the capability's action class.
 */

const FIXTURE = resolve("tests/fixtures/mcp-fake-server.mjs");
const roots: string[] = [];

interface Scenario {
	project: string;
	configDir: string;
	markerPath: string;
}

function scenario(): Scenario {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-gateway-mcp-")));
	roots.push(root);
	const project = join(root, "project");
	const configDir = join(root, "config");
	mkdirSync(join(project, ".clio-coder"), { recursive: true });
	mkdirSync(configDir, { recursive: true });
	const markerPath = join(root, "marker-launched");
	writeConfig(project, markerPath, "normal");
	return { project, configDir, markerPath };
}

/** Two project servers: the fixture (to be trusted) and one that proves launch by writing a marker file. */
function writeConfig(project: string, markerPath: string, fixtureMode: string): void {
	const launchScript = "require('fs').writeFileSync(process.argv[1], 'launched')";
	const text = [
		"version: 1",
		"servers:",
		"  - id: fake",
		`    command: ${JSON.stringify(process.execPath)}`,
		`    args: [${JSON.stringify(FIXTURE)}, ${JSON.stringify(fixtureMode)}]`,
		"  - id: marker",
		`    command: ${JSON.stringify(process.execPath)}`,
		`    args: ["-e", ${JSON.stringify(launchScript)}, ${JSON.stringify(markerPath)}]`,
		"",
	].join("\n");
	writeFileSync(join(project, ".clio-coder", "mcp.yaml"), text);
}

interface Wired {
	registry: ToolRegistry;
	source: McpCapabilitySource;
	clients: McpClient[];
	parks: string[];
}

function wire(scene: Scenario, level: AutonomyLevel = "yolo", readOnly = false): Wired {
	const clients: McpClient[] = [];
	const parks: string[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: scene.project }),
		autonomy: () => level,
		...(readOnly ? { readOnly: true } : {}),
	});
	const source = createMcpCapabilitySource({
		cwd: scene.project,
		configDir: scene.configDir,
		registry,
		requestTimeoutMs: 5_000,
		clientFactory: (spec, options) => {
			const client = createMcpStdioClient(spec, { ...options, initializeTimeoutMs: 5_000, killGraceMs: 200 });
			clients.push(client);
			return client;
		},
	});
	registerCoreTools(registry, { mcpCapabilities: source });
	registry.onPermissionRequired((call, _decision, meta) => {
		parks.push(call.tool);
		registry.cancelParkedCall(meta.requestId, "denied by the test");
	});
	return { registry, source, clients, parks };
}

function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((settle) => setTimeout(settle, 10));
	}
}

function payloadOf(verdict: Awaited<ReturnType<ToolRegistry["invoke"]>>): Record<string, unknown> {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
	return JSON.parse(verdict.result.output) as Record<string, unknown>;
}

const ECHO = "mcp_fake__echo";

describe("gateway MCP capabilities", () => {
	let env: IsolatedClioEnv;
	const open: McpCapabilitySource[] = [];
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-mcp-");
	});
	afterEach(async () => {
		await Promise.all(open.splice(0).map((source) => source.close()));
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	it("keeps structured-only MCP results visible through the gateway", async () => {
		const scene = scenario();
		writeConfig(scene.project, scene.markerPath, "raw-result");
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { registry, source } = wire(scene);
		open.push(source);
		const data = { mass: 12, unit: "kg", valid: true };
		const response = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ECHO, args: { result: { content: [], structuredContent: data } } },
		});
		deepStrictEqual(payloadOf(response), data);
	});

	it("bounds a large MCP result in model context and offloads the full text", async () => {
		// A 62 KB search result entered context verbatim under the 64 KiB session
		// cap, and two of them stalled a 131k local model.
		const scene = scenario();
		writeConfig(scene.project, scene.markerPath, "raw-result");
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { registry, source } = wire(scene);
		open.push(source);
		const text = `${"x".repeat(99)}\n`.repeat(622);
		const response = await registry.invoke(
			{
				tool: ToolNames.Gateway,
				args: { op: "call", capability: ECHO, args: { result: { content: [{ type: "text", text }] } } },
			},
			{ sessionId: "bound-session", toolCallId: "call-1", toolResultMaxBytes: 65_536 },
		);
		if (response.kind !== "ok" || response.result.kind !== "ok") throw new Error(JSON.stringify(response));
		const size = response.result.details?.resultSize as { truncated?: boolean; offloadPath?: string } | undefined;
		ok(Buffer.byteLength(response.result.output, "utf8") <= 20 * 1024, String(response.result.output.length));
		strictEqual(size?.truncated, true);
		ok(size?.offloadPath && readFileSync(size.offloadPath, "utf8").includes(text));
	});

	it("keeps malformed MCP results unsuccessful through the gateway", async () => {
		const scene = scenario();
		writeConfig(scene.project, scene.markerPath, "raw-result");
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { registry, source } = wire(scene);
		open.push(source);
		const malformed = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ECHO, args: { result: { content: [], isError: "true" } } },
		});
		ok(malformed.kind === "ok" && malformed.result.kind === "error", JSON.stringify(malformed));
		ok(malformed.result.message.includes("protocol"));
	});

	it("preserves raw-wire numeric literals through gateway output and serialized evidence", async () => {
		const scene = scenario();
		writeConfig(scene.project, scene.markerPath, "raw-numeric-result");
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { registry, source } = wire(scene);
		open.push(source);
		const response = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: ECHO, args: {} } });
		ok(response.kind === "ok" && response.result.kind === "ok", JSON.stringify(response));
		const expected =
			'{"integer":9007199254740993,"decimal":0.1000000000000000055511151231257827,"huge":1e400,"negativeZero":-0,"nested":[1e400,-0]}';
		strictEqual(response.result.output, expected);
		const evidence = JSON.parse(JSON.stringify(response.result.details));
		strictEqual(evidence.structuredContentJson, expected);
		deepStrictEqual(evidence.structuredContent.huge, { $literal: "1e400" });
		deepStrictEqual(evidence.structuredContent.negativeZero, { $literal: "-0" });
	});

	it("resolves overlapping server namespaces independently of config and discovery order", async () => {
		for (const ids of [
			["a", "a__b"],
			["a__b", "a"],
		]) {
			for (const discoverFirst of [false, true]) {
				const scene = scenario();
				writeFileSync(
					join(scene.configDir, "mcp.yaml"),
					JSON.stringify({
						version: 1,
						servers: ids.map((id) => ({ id, command: process.execPath, args: [FIXTURE, "normal"] })),
					}),
				);
				const registry = createRegistry({
					safety: createWorkerSafety({ cwd: scene.project }),
					autonomy: () => "yolo",
				});
				const source = createMcpCapabilitySource({
					cwd: scene.project,
					configDir: scene.configDir,
					registry,
					clientFactory: (spec, options) => {
						const client = createMcpStdioClient(spec, { ...options, killGraceMs: 50 });
						if (spec.id === "a") {
							const listTools = client.listTools.bind(client);
							client.listTools = async () => {
								const listing = await listTools();
								const echo = listing.tools[0];
								ok(echo);
								return { ...listing, tools: [...listing.tools, { ...echo, name: "b__echo" }] };
							};
						}
						return client;
					},
				});
				open.push(source);
				if (discoverFirst) await source.list();
				const ensured = await source.ensure("mcp_a__b__echo");
				ok(ensured.spec, ensured.reason);
				if (!discoverFirst) deepStrictEqual(source.connectedIds(), ["a__b"]);
				ok(source.authorityNote("mcp_a__b__echo")?.startsWith("Local stdio MCP server a__b ("));
				const listing = await source.list();
				deepStrictEqual(listing.servers.find((server) => server.id === "a")?.unregistrable, ["b__echo"]);
				const result = await ensured.spec.run({ text: "right server" });
				strictEqual(result.kind, "ok");
				strictEqual(result.details?.server, "a__b");
				strictEqual(result.details?.tool, "echo");
				await source.close();
			}
		}
	});

	// A scoped find used to filter on the `mcp_<id>__` prefix, which is not the
	// ownership rule: with declarations `a` and `a__b`, `mcp_a__b__echo` starts
	// with `mcp_a__` while `a__b` owns it. Asking for `a` then listed a
	// capability its own server summary did not claim. Both the registered path
	// and the cached path have to agree with `ownerIdOf`.
	it("scopes a find to the owning server rather than the name prefix", async () => {
		for (const cached of [false, true]) {
			const scene = scenario();
			writeFileSync(
				join(scene.configDir, "mcp.yaml"),
				JSON.stringify({
					version: 1,
					servers: ["a", "a__b"].map((id) => ({ id, command: process.execPath, args: [FIXTURE, "normal"] })),
				}),
			);
			const first = wire(scene);
			open.push(first.source);
			await first.registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", server: "a__b", refresh: true } });
			strictEqual(first.source.ownerIdOf("mcp_a__b__echo"), "a__b");
			strictEqual(first.source.ownerIdOf("mcp_a__echo"), "a");

			// The cached pass reads the published catalog through a fresh source,
			// so the filter is exercised without a registered spec to fall back on.
			let registry = first.registry;
			if (cached) {
				await first.source.close();
				const second = wire(scene);
				open.push(second.source);
				registry = second.registry;
			}

			const scoped = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", server: "a" } }));
			const names = (scoped.capabilities as Array<Record<string, unknown>>).map((entry) => entry.name);
			strictEqual(
				names.includes("mcp_a__b__echo"),
				false,
				`server "a" must not claim a__b's capability (cached=${cached})`,
			);
			const servers = (scoped.servers as Array<Record<string, unknown>> | undefined) ?? [];
			deepStrictEqual(
				servers.map((entry) => entry.id),
				["a"],
				"the summary already scoped to one server, so the capability list must agree with it",
			);
		}
	});

	it("never signals after ESRCH when the exit backstop runs before teardown settlement", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const previousHooks = new Set(process.listeners("exit"));
		const { source, clients } = wire(scene);
		open.push(source);
		await source.list();
		const exitHook = process.listeners("exit").find((hook) => !previousHooks.has(hook));
		ok(exitHook);
		const client = clients[0];
		ok(client);
		const pid = client.pid;
		ok(pid !== undefined);
		const realKill = process.kill;
		const lateSignals: Array<string | number | undefined> = [];
		let released = false;
		let faultRan = false;
		let teardownPending = false;
		let ownershipRetained = false;
		let settled = false;
		let settlementPending = false;
		process.kill = ((target: number, signal?: string | number) => {
			if (target === -pid && released) {
				lateSignals.push(signal);
				return true;
			}
			try {
				return realKill(target, signal);
			} catch (error) {
				if (target === -pid && (error as NodeJS.ErrnoException).code === "ESRCH") {
					released = true;
					queueMicrotask(() => {
						faultRan = true;
						teardownPending = client.state().teardown === null;
						ownershipRetained = source.connectedIds().includes("fake");
						settlementPending = !settled;
						exitHook(0);
					});
				}
				throw error;
			}
		}) as typeof process.kill;
		try {
			await source.close().then(() => {
				settled = true;
			});
			ok(released, "the real process group produced ESRCH");
			ok(
				faultRan && teardownPending && ownershipRetained && settlementPending,
				"the installed backstop ran inside the ownership-release gap",
			);
			deepStrictEqual(lateSignals, [], "no signal or probe may target the released process-group ID");
			strictEqual(source.teardownReports().length, 1);
			strictEqual(source.teardownReports()[0]?.outcome.complete, true);
		} finally {
			process.kill = realKill;
		}
	});

	it("the exit backstop kills genuinely owned live and closing process groups", async () => {
		for (const closing of [false, true]) {
			const scene = scenario();
			writeConfig(scene.project, scene.markerPath, "ignore-sigterm");
			ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
			const previousHooks = new Set(process.listeners("exit"));
			const { source, clients } = wire(scene);
			open.push(source);
			await source.list();
			const exitHook = process.listeners("exit").find((hook) => !previousHooks.has(hook));
			ok(exitHook);
			const pid = clients[0]?.pid;
			ok(pid !== undefined);
			const pendingClose = closing ? source.close() : undefined;
			const realKill = process.kill;
			const signals: Array<string | number | undefined> = [];
			process.kill = ((target: number, signal?: string | number) => {
				if (target === -pid && signal !== 0) signals.push(signal);
				return realKill(target, signal);
			}) as typeof process.kill;
			try {
				exitHook(0);
				deepStrictEqual(signals, ["SIGKILL"]);
				await (pendingClose ?? source.close());
				strictEqual(processAlive(-pid), false);
				strictEqual(source.teardownReports()[0]?.outcome.complete, true);
			} finally {
				process.kill = realKill;
			}
		}
	});

	it("awaits real termination until a TERM-resistant MCP process group disappears", async () => {
		const scene = scenario();
		writeConfig(scene.project, scene.markerPath, "ignore-sigterm");
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const script = join(scene.project, "parent.mjs");
		const moduleUrl = (file: string) => JSON.stringify(`file://${resolve(file)}`);
		writeFileSync(
			script,
			`
			import { getTerminationCoordinator } from ${moduleUrl("src/core/termination.ts")};
			import { getSharedBus } from ${moduleUrl("src/core/shared-bus.ts")};
			import { createWorkerSafety } from ${moduleUrl("src/engine/worker-tools.ts")};
			import { createRegistry } from ${moduleUrl("src/tools/registry.ts")};
			import { registerAllTools } from ${moduleUrl("src/tools/bootstrap.ts")};
			import { createMcpCapabilitySource } from ${moduleUrl("src/tools/gateway/index.ts")};
			import { createMcpStdioClient } from ${moduleUrl("src/domains/gateway/mcp/index.ts")};
			const registry = createRegistry({ safety: createWorkerSafety({cwd: ${JSON.stringify(scene.project)}}), autonomy: () => "yolo" });
			let client;
			const source = createMcpCapabilitySource({cwd: ${JSON.stringify(scene.project)}, configDir: ${JSON.stringify(scene.configDir)}, registry, clientFactory: (spec, opts) => client = createMcpStdioClient(spec, opts)});
			const termination = getTerminationCoordinator();
			registerAllTools(registry, {mcpCapabilities: source, bus: getSharedBus(), termination});
			await source.list();
			process.stdout.write(String(client.pid) + "\\n");
			await termination.shutdown(0);
		`,
		);
		const parent = spawn(process.execPath, ["--import", "tsx", script], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		parent.stdout.on("data", (data) => {
			stdout += String(data);
		});
		parent.stderr.on("data", (data) => {
			stderr += String(data);
		});
		const timer = setTimeout(() => parent.kill("SIGKILL"), 15_000);
		try {
			const [code] = await once(parent, "close");
			strictEqual(code, 0, stderr);
			const pid = Number(stdout.trim());
			ok(Number.isInteger(pid) && pid > 0, stdout);
			strictEqual(processAlive(-pid), false, "the process group is gone before the parent exits");
		} finally {
			clearTimeout(timer);
		}
	});

	it("shares pending close ownership until bounded cleanup settles", async () => {
		const scene = scenario();
		writeConfig(scene.project, scene.markerPath, "ignore-sigterm");
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { source, clients } = wire(scene);
		open.push(source);
		await source.list();
		const first = source.close();
		strictEqual(source.close(), first);
		deepStrictEqual(source.connectedIds(), ["fake"]);
		await first;
		deepStrictEqual(source.connectedIds(), []);
		strictEqual(processAlive(clients[0]?.pid), false);
	});

	it("cancels initialization and paginated discovery with owned cleanup and no successful listing", async () => {
		for (const phase of ["initialize", "pagination"]) {
			const scene = scenario();
			const marker = join(scene.project, "phase");
			const server = join(scene.project, "cancel-server.mjs");
			writeFileSync(
				server,
				`
				import {createInterface} from 'node:readline';
				import {writeFileSync} from 'node:fs';
				createInterface({input: process.stdin}).on('line', line => {
					const req = JSON.parse(line);
					const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
					if (req.method === 'initialize') {
						if (${JSON.stringify(phase)} === 'initialize') { writeFileSync(${JSON.stringify(marker)}, 'ready'); return; }
						reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cancel',version:'1'}});
					}
					if (req.method === 'tools/list') {
						if (req.params?.cursor) { writeFileSync(${JSON.stringify(marker)}, 'ready'); return; }
						reply({tools:[],nextCursor:'next'});
					}
				});
			`,
			);
			writeFileSync(
				join(scene.project, ".clio-coder", "mcp.yaml"),
				`version: 1\nservers:\n  - id: fake\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(server)}]\n`,
			);
			ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
			const { source, clients } = wire(scene);
			open.push(source);
			const controller = new AbortController();
			const pending =
				phase === "initialize"
					? source.list({ signal: controller.signal })
					: source.ensure(ECHO, { signal: controller.signal });
			const rejected = rejects(pending, /aborted/);
			await waitFor(() => existsSync(marker));
			controller.abort();
			await rejected;
			strictEqual(processAlive(clients[0]?.pid), false);
			deepStrictEqual(source.connectedIds(), []);
			strictEqual(source.teardownReports().at(-1)?.outcome.complete, true);
			strictEqual(source.teardownReports().length, 1);
		}
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { source, clients } = wire(scene);
		open.push(source);
		await rejects(source.list({ signal: AbortSignal.abort() }), /aborted/);
		strictEqual(clients.length, 0);
		await source.list();
		const controller = new AbortController();
		const listing = source.list({ signal: controller.signal });
		controller.abort();
		await rejects(listing, /aborted/);
		strictEqual(processAlive(clients[0]?.pid), false);
		deepStrictEqual(source.connectedIds(), []);
		strictEqual(source.teardownReports().length, 1);
	});

	it("never launches an untrusted server, lists it with the trust remedy, and launches a trusted one on a scoped refresh", async () => {
		const scene = scenario();
		const trusted = trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" });
		ok(trusted.ok, trusted.ok ? "" : trusted.message);
		const { registry, source, clients } = wire(scene);
		open.push(source);
		strictEqual(clients.length, 0, "registration launches nothing");
		deepStrictEqual(source.connectedIds(), []);
		deepStrictEqual(source.connectedIds({ readyOnly: true }), []);
		strictEqual(clients.length, 0, "dashboard connection sampling must not start MCP clients");

		const cold = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "mcp" } }));
		strictEqual(clients.length, 0, "an ordinary find launches nothing, not even for a trusted server");
		deepStrictEqual(cold.missingCatalogs, ["fake"], "the cold catalog is named, not filled behind the model's back");
		ok(String(cold.missingCatalogsNote).includes('gateway(op="find", server="<id>", refresh=true)'));

		const listing = payloadOf(
			await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", server: "fake", refresh: true } }),
		);
		const servers = listing.servers as Array<Record<string, unknown>>;
		strictEqual(servers.length, 1, "a scoped find answers about the server it named");
		strictEqual(existsSync(scene.markerPath), false, "the other declared server was never spawned");
		const fake = servers.find((server) => server.id === "fake");
		strictEqual(fake?.status, "connected");
		strictEqual(fake.catalog, "live");
		ok((fake.tools as string[]).includes(ECHO));
		strictEqual(clients.length, 1, "exactly the named server launched, once");
		deepStrictEqual(source.connectedIds(), ["fake"]);
		const capabilities = listing.capabilities as Array<Record<string, unknown>>;
		const echo = capabilities.find((entry) => entry.name === ECHO);
		deepStrictEqual({ kind: echo?.kind, actionClass: echo?.actionClass }, { kind: "mcp", actionClass: "read" });

		const unscoped = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "mcp" } }));
		const marker = (unscoped.servers as Array<Record<string, unknown>>).find((server) => server.id === "marker");
		deepStrictEqual(
			{ status: marker?.status, remedy: marker?.remedy, interactive: marker?.interactiveRemedy },
			{ status: "untrusted", remedy: "clio-coder mcp trust marker", interactive: "/mcp trust marker" },
		);
		ok(typeof marker?.reason === "string" && marker.reason.length > 0, "the listing says why");
		strictEqual(marker.catalog, undefined, "an untrusted server has no catalog to offer");
		strictEqual(existsSync(scene.markerPath), false);
		strictEqual(clients.length, 1);

		const described = payloadOf(
			await registry.invoke({ tool: ToolNames.Gateway, args: { op: "describe", capability: ECHO } }),
		);
		ok("text" in ((described.parameters as { properties?: Record<string, unknown> }).properties ?? {}));
		ok((described.authority as string[]).some((note) => note.includes("trusted with action class read")));

		const called = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ECHO, args: { text: "through the gateway" } },
		});
		if (called.kind !== "ok" || called.result.kind !== "ok") throw new Error(JSON.stringify(called));
		deepStrictEqual(JSON.parse(called.result.output), { text: "through the gateway" });
		deepStrictEqual(
			{ capability: called.result.details?.capability, server: called.result.details?.server },
			{ capability: ECHO, server: "fake" },
		);
		strictEqual(clients.length, 1, "a second call reuses the session's client");

		const refused = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: "mcp_marker__anything", args: {} },
		});
		if (refused.kind !== "ok" || refused.result.kind !== "error") throw new Error(JSON.stringify(refused));
		ok(refused.result.message.includes("never launched until trusted"), refused.result.message);
		ok(refused.result.message.includes("clio-coder mcp trust marker"), refused.result.message);
		strictEqual(existsSync(scene.markerPath), false);
		strictEqual(clients.length, 1);

		const pid = clients[0]?.pid;
		ok(pid !== undefined && processAlive(pid), "the trusted server runs while the session is open");
		const report = await source.close();
		deepStrictEqual(report.incomplete, []);
		await waitFor(() => !processAlive(pid));
		deepStrictEqual(source.connectedIds(), []);
		strictEqual(source.teardownReports().length, 1);
		strictEqual(source.teardownReports()[0]?.outcome.complete, true);
	});

	it("treats a trusted server whose declaration changed as stale and never launches it", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		writeConfig(scene.project, scene.markerPath, "endless-tools");
		const { registry, source, clients } = wire(scene);
		open.push(source);
		const listing = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }));
		const fake = (listing.servers as Array<Record<string, unknown>>).find((server) => server.id === "fake");
		deepStrictEqual(
			{ status: fake?.status, remedy: fake?.remedy },
			{ status: "stale", remedy: "clio-coder mcp trust fake" },
		);
		strictEqual(clients.length, 0, "a stale trust record launches nothing");
		ok(!(listing.capabilities as Array<{ name: string }>).some((entry) => entry.name.startsWith("mcp_")));
	});

	it("answers find and describe from a recorded catalog and still validates a call against the live schema", async () => {
		const scene = scenario();
		// One declaration whose server reports a different tool set per generation.
		// The declaration digest never changes, so the catalog identity holds and
		// only the server's answer moves underneath it.
		const generation = join(scene.project, "generation");
		const server = join(scene.project, "shifting-server.mjs");
		writeFileSync(
			server,
			`
			import {createInterface} from 'node:readline';
			import {readFileSync} from 'node:fs';
			const gen = () => readFileSync(${JSON.stringify(generation)}, 'utf8').trim();
			createInterface({input: process.stdin}).on('line', line => {
				const req = JSON.parse(line);
				const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
				if (req.method === 'initialize') reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'shift',version:'1'}});
				if (req.method === 'tools/list') {
					const first = gen() === '1';
					const probe = {name:'probe', description:'Probe the server.', inputSchema:{type:'object', properties: first ? {old:{type:'string'}} : {fresh:{type:'string'}}, required:[first ? 'old' : 'fresh']}};
					reply({tools: first ? [probe, {name:'gone', description:'Removed later.', inputSchema:{type:'object'}}] : [probe]});
				}
				if (req.method === 'tools/call') reply({content:[{type:'text', text: JSON.stringify(req.params.arguments)}]});
			});
		`,
		);
		writeFileSync(generation, "1");
		writeFileSync(
			join(scene.project, ".clio-coder", "mcp.yaml"),
			`version: 1\nservers:\n  - id: shift\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(server)}]\n`,
		);
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "shift", actionClass: "read" }).ok);
		const first = wire(scene);
		open.push(first.source);
		await first.registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", server: "shift", refresh: true } });
		strictEqual(first.clients.length, 1);
		await first.source.close();

		writeFileSync(generation, "2");
		const second = wire(scene);
		open.push(second.source);
		const listing = payloadOf(await second.registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }));
		strictEqual(second.clients.length, 0, "a new session lists the catalog without a process");
		const shift = (listing.servers as Array<Record<string, unknown>>).find((entry) => entry.id === "shift");
		deepStrictEqual(
			{ status: shift?.status, catalog: shift?.catalog, count: shift?.catalogCount },
			{ status: "trusted", catalog: "cached", count: 2 },
		);
		const names = (listing.capabilities as Array<{ name: string }>).map((entry) => entry.name);
		ok(names.includes("mcp_shift__probe") && names.includes("mcp_shift__gone"));

		const described = payloadOf(
			await second.registry.invoke({ tool: ToolNames.Gateway, args: { op: "describe", capability: "mcp_shift__probe" } }),
		);
		strictEqual(described.catalog, "cached");
		strictEqual(second.clients.length, 0, "describe reads the catalog rather than launching the server");
		deepStrictEqual(Object.keys((described.parameters as { properties: Record<string, unknown> }).properties), ["old"]);
		ok(
			(described.authority as string[]).some((note) =>
				note.includes("the server's current schema is what a call validates"),
			),
		);

		// The call path resolves the owner live, so the stale schema the model
		// just read is not what its arguments are checked against.
		const stale = await second.registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: "mcp_shift__probe", args: { old: "value" } },
		});
		ok(stale.kind === "ok" && stale.result.kind === "error", JSON.stringify(stale));
		ok(stale.result.message.includes("arguments rejected"), stale.result.message);
		strictEqual(second.clients.length, 1, "the call launched exactly the owning server");

		const live = await second.registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: "mcp_shift__probe", args: { fresh: "value" } },
		});
		ok(live.kind === "ok" && live.result.kind === "ok", JSON.stringify(live));
		deepStrictEqual(JSON.parse(live.result.output), { fresh: "value" });

		const removed = await second.registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: "mcp_shift__gone", args: {} },
		});
		ok(removed.kind === "ok" && removed.result.kind === "error", JSON.stringify(removed));
		ok(removed.result.message.includes("offers no tool named gone"), removed.result.message);
	});

	it("carries a filled catalog across sessions and connects only the owner on the first call", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const first = wire(scene);
		open.push(first.source);
		await first.registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", server: "fake", refresh: true } });
		strictEqual(first.clients.length, 1);
		await first.source.close();

		const second = wire(scene);
		open.push(second.source);
		const listed = payloadOf(await second.registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }));
		ok(
			(listed.capabilities as Array<{ name: string }>).some((entry) => entry.name === ECHO),
			"the catalog is in find",
		);
		strictEqual(second.registry.get(ECHO as ToolName), undefined, "a cached descriptor is not a registry entry");
		ok(!second.registry.listRegistered().includes(ECHO as ToolName));
		const attached = resolveAgentTools({ registry: second.registry }).map((tool) => tool.name);
		ok(!attached.some((name) => name.startsWith("mcp_")), "no cached schema becomes an attached agent tool");

		const described = payloadOf(
			await second.registry.invoke({ tool: ToolNames.Gateway, args: { op: "describe", capability: ECHO } }),
		);
		strictEqual(described.catalog, "cached");
		strictEqual(second.clients.length, 0, "find and describe ran the whole way with no server process");

		const called = await second.registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ECHO, args: { text: "after the cache" } },
		});
		ok(called.kind === "ok" && called.result.kind === "ok", JSON.stringify(called));
		deepStrictEqual(JSON.parse(called.result.output), { text: "after the cache" });
		strictEqual(second.clients.length, 1, "the first call connected exactly one server");
		deepStrictEqual(second.source.connectedIds(), ["fake"]);
		strictEqual(existsSync(scene.markerPath), false, "the other declared server was never launched");
		strictEqual(
			payloadOf(await second.registry.invoke({ tool: ToolNames.Gateway, args: { op: "describe", capability: ECHO } }))
				.catalog,
			"live",
			"once connected, describe reports the session's own listing",
		);
	});

	it("rejects a refresh without a server, for an undeclared server, and on describe or call", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { registry, clients, source } = wire(scene);
		open.push(source);
		const errorOf = async (args: Record<string, unknown>): Promise<string> => {
			const verdict = await registry.invoke({ tool: ToolNames.Gateway, args });
			if (verdict.kind !== "ok" || verdict.result.kind !== "error") throw new Error(JSON.stringify(verdict));
			return verdict.result.message;
		};
		ok((await errorOf({ op: "find", refresh: true })).includes("refresh needs the server it applies to"));
		const undeclared = await errorOf({ op: "find", server: "nope", refresh: true });
		ok(undeclared.includes('no MCP server named "nope" is declared'), undeclared);
		ok(undeclared.includes("fake, marker"), "the error names what is declared");
		ok(
			(await errorOf({ op: "describe", capability: ECHO, refresh: true })).includes(
				'server and refresh apply to op="find"',
			),
		);
		ok((await errorOf({ op: "call", capability: ECHO, args: {}, server: "fake" })).includes('not op="call"'));
		strictEqual(clients.length, 0, "no rejected request launched anything");
		strictEqual(existsSync(scene.markerPath), false);
	});

	it("refuses scoped MCP discovery on a restricted tool surface", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { registry, clients, source } = wire(scene);
		open.push(source);
		const restricted = { allowedTools: [ToolNames.Gateway, ECHO] as ToolName[] };
		const refused = await registry.invoke(
			{ tool: ToolNames.Gateway, args: { op: "find", server: "fake", refresh: true } },
			restricted,
		);
		ok(refused.kind === "ok" && refused.result.kind === "error", JSON.stringify(refused));
		ok(refused.result.message.includes("not available on this run's admitted tool surface"), refused.result.message);
		strictEqual(clients.length, 0, "a restricted run cannot launch a server it was not given");
		const listing = payloadOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find" } }, restricted));
		strictEqual(listing.servers, undefined, "a restricted find still reports no MCP servers");
		// An admitted exact capability still reaches its server through the call path.
		const called = await registry.invoke(
			{ tool: ToolNames.Gateway, args: { op: "call", capability: ECHO, args: { text: "admitted" } } },
			restricted,
		);
		ok(called.kind === "ok" && called.result.kind === "ok", JSON.stringify(called));
		strictEqual(clients.length, 1);
	});

	it("takes the capability's action class from trust: unknown asks in default and runs in yolo", async () => {
		const scene = scenario();
		ok(
			trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake" }).ok,
			"default trust class is unknown",
		);
		for (const level of ["default", "yolo"] as const) {
			const wired = wire(scene, level);
			open.push(wired.source);
			const verdict = await wired.registry.invoke({
				tool: ToolNames.Gateway,
				args: { op: "call", capability: ECHO, args: { text: "x" } },
			});
			strictEqual(verdict.kind, level === "default" ? "blocked" : "ok");
			deepStrictEqual(wired.parks, level === "default" ? [ECHO] : []);
			await wired.source.close();
		}
		const readOnly = wire(scene, "default", true);
		open.push(readOnly.source);
		const denied = await readOnly.registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ECHO, args: { text: "x" } },
		});
		strictEqual(denied.kind, "blocked");
		if (denied.kind === "blocked") ok(denied.reason.includes("read-only"), denied.reason);
		deepStrictEqual(readOnly.parks, []);
		ok(untrustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake" }).ok);
	});
});
