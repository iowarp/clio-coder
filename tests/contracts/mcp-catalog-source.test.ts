import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ToolName } from "../../src/core/tool-names.js";
import {
	createMcpStdioClient,
	type McpClient,
	type McpClientOptions,
	type McpServerSpec,
	trustMcpServer,
} from "../../src/domains/gateway/mcp/index.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import { createRegistry, type ToolRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Metadata discovery separated from executable registration. The source can
 * answer what a declared server offers from its recorded catalog without
 * constructing a client, publish a catalog after a live listing, and launch
 * exactly one server when a scoped refresh names it. A cached descriptor is
 * never a registry entry, so it can never skip live setup or be called.
 */

const FIXTURE = resolve("tests/fixtures/mcp-fake-server.mjs");
const roots: string[] = [];

interface Scenario {
	project: string;
	configDir: string;
	markerPath: string;
}

/** Two project servers: the fixture, and one that proves a launch by writing a marker file. */
function scenario(): Scenario {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-mcp-catalog-src-")));
	roots.push(root);
	const project = join(root, "project");
	const configDir = join(root, "config");
	mkdirSync(join(project, ".clio-coder"), { recursive: true });
	mkdirSync(configDir, { recursive: true });
	const markerPath = join(root, "marker-launched");
	const launchScript = "require('fs').writeFileSync(process.argv[1], 'launched')";
	writeFileSync(
		join(project, ".clio-coder", "mcp.yaml"),
		[
			"version: 1",
			"servers:",
			"  - id: fake",
			`    command: ${JSON.stringify(process.execPath)}`,
			`    args: [${JSON.stringify(FIXTURE)}, "normal"]`,
			"  - id: marker",
			`    command: ${JSON.stringify(process.execPath)}`,
			`    args: ["-e", ${JSON.stringify(launchScript)}, ${JSON.stringify(markerPath)}]`,
			"",
		].join("\n"),
	);
	return { project, configDir, markerPath };
}

interface Wired {
	registry: ToolRegistry;
	source: McpCapabilitySource;
	/** Every client the source constructed, in order. */
	clients: McpClient[];
}

function wire(scene: Scenario, factory?: (spec: McpServerSpec, options: McpClientOptions) => McpClient): Wired {
	const clients: McpClient[] = [];
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: scene.project }), autonomy: () => "full-auto" });
	const source = createMcpCapabilitySource({
		cwd: scene.project,
		configDir: scene.configDir,
		registry,
		requestTimeoutMs: 5_000,
		clientFactory: (spec, options) => {
			const client = (factory ?? createMcpStdioClient)(spec, { ...options, initializeTimeoutMs: 5_000, killGraceMs: 200 });
			clients.push(client);
			return client;
		},
	});
	return { registry, source, clients };
}

const ECHO = "mcp_fake__echo";

describe("MCP catalog source", () => {
	let env: IsolatedClioEnv;
	const open: McpCapabilitySource[] = [];
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-mcp-catalog-src-env-");
	});
	afterEach(async () => {
		await Promise.all(open.splice(0).map((source) => source.close()));
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	it("reports a missing catalog without constructing a client", () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { source, clients } = wire(scene);
		open.push(source);
		const catalog = source.catalog();
		strictEqual(clients.length, 0, "an offline catalog constructs nothing");
		deepStrictEqual(catalog.entries, []);
		deepStrictEqual(catalog.missing, ["fake"]);
		const fake = catalog.servers.find((server) => server.id === "fake");
		deepStrictEqual(
			{ status: fake?.status, catalog: fake?.catalog, remedy: fake?.catalogRemedy },
			{ status: "trusted", catalog: "missing", remedy: 'gateway(op="find", server="fake", refresh=true)' },
		);
		// An untrusted declaration has no catalog provenance at all: a recorded
		// listing would suggest tools that cannot be reached.
		const marker = catalog.servers.find((server) => server.id === "marker");
		strictEqual(marker?.status, "untrusted");
		strictEqual(marker.catalog, undefined);
		strictEqual(source.metadata(ECHO).metadata, null);
		ok(source.metadata(ECHO).reason?.includes('gateway(op="find", server="fake", refresh=true)'));
		strictEqual(clients.length, 0, "describing an uncached tool launches nothing");
		deepStrictEqual(source.declaredIds().sort(), ["fake", "marker"]);
	});

	it("publishes after a live listing and answers a later session offline", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const first = wire(scene);
		open.push(first.source);
		const refreshed = await first.source.refresh("fake");
		strictEqual(refreshed.reason, undefined);
		strictEqual(refreshed.listing?.status, "connected");
		strictEqual(refreshed.listing.catalog, "live");
		strictEqual(first.clients.length, 1, "a scoped refresh launches exactly its own server");
		strictEqual(existsSync(scene.markerPath), false, "the other declared server was never launched");
		await first.source.close();

		const second = wire(scene);
		open.push(second.source);
		const catalog = second.source.catalog();
		strictEqual(second.clients.length, 0, "the new session answers from the recorded catalog");
		const fake = catalog.servers.find((server) => server.id === "fake");
		strictEqual(fake?.catalog, "cached");
		strictEqual(fake.status, "trusted", "a cache hit must never report a connected server");
		strictEqual(fake.tools, undefined, "a cached server does not repeat the capability list");
		deepStrictEqual(catalog.missing, []);
		ok(catalog.entries.some((entry) => entry.name === ECHO));
		const metadata = second.source.metadata(ECHO).metadata;
		strictEqual(metadata?.provenance, "cached");
		strictEqual(metadata.actionClass, "read");
		ok("text" in ((metadata.parameters as { properties?: Record<string, unknown> }).properties ?? {}));
		strictEqual(second.clients.length, 0);
	});

	it("never registers a cached descriptor, so a call still runs live setup", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const first = wire(scene);
		open.push(first.source);
		await first.source.refresh("fake");
		await first.source.close();

		const second = wire(scene);
		open.push(second.source);
		second.source.catalog();
		second.source.metadata(ECHO);
		strictEqual(second.registry.get(ECHO as ToolName), undefined, "a catalog read must not populate the registry");
		strictEqual(second.clients.length, 0);
		const ensured = await second.source.ensure(ECHO);
		ok(ensured.spec, ensured.reason);
		strictEqual(second.clients.length, 1, "the first call constructs exactly the owning server's client");
		strictEqual(existsSync(scene.markerPath), false);
		strictEqual(second.source.metadata(ECHO).metadata?.provenance, "live");
	});

	it("shares one initialization across concurrent ensures and refreshes", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { source, clients } = wire(scene);
		open.push(source);
		const results = await Promise.all([source.ensure(ECHO), source.refresh("fake"), source.ensure(ECHO)]);
		strictEqual(clients.length, 1, "three concurrent requests share one client");
		ok(results[0].spec);
		strictEqual(results[1].listing?.status, "connected");
		ok(results[2].spec);
	});

	it("refuses to discover an undeclared, untrusted, or stale server", async () => {
		const scene = scenario();
		const { source, clients } = wire(scene);
		open.push(source);
		const undeclared = await source.refresh("nope");
		strictEqual(undeclared.listing, null);
		ok(undeclared.reason?.includes("no MCP server named 'nope' is declared"));
		const untrusted = await source.refresh("marker");
		strictEqual(untrusted.listing?.status, "untrusted");
		ok(untrusted.reason?.includes("clio-coder mcp trust marker"));
		strictEqual(existsSync(scene.markerPath), false, "an untrusted refresh launches nothing");
		strictEqual(clients.length, 0);

		// Trust the fixture, then change what it runs: a stale record is as
		// unlaunchable as an untrusted one, and its old catalog is unreadable.
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const trusted = wire(scene);
		open.push(trusted.source);
		await trusted.source.refresh("fake");
		await trusted.source.close();
		writeFileSync(
			join(scene.project, ".clio-coder", "mcp.yaml"),
			`version: 1\nservers:\n  - id: fake\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(FIXTURE)}, "endless-tools"]\n`,
		);
		const stale = wire(scene);
		open.push(stale.source);
		const catalog = stale.source.catalog();
		strictEqual(catalog.servers.find((server) => server.id === "fake")?.status, "stale");
		strictEqual(catalog.servers.find((server) => server.id === "fake")?.catalog, undefined);
		deepStrictEqual(catalog.entries, [], "a stale declaration's recorded catalog is not offered");
		ok((await stale.source.refresh("fake")).reason?.includes("stale"));
		strictEqual(stale.clients.length, 0);
	});

	it("does not publish a catalog from aborted discovery", async () => {
		const scene = scenario();
		const server = join(scene.project, "slow-server.mjs");
		const ready = join(scene.project, "paged");
		writeFileSync(
			server,
			`
			import {createInterface} from 'node:readline';
			import {writeFileSync} from 'node:fs';
			createInterface({input: process.stdin}).on('line', line => {
				const req = JSON.parse(line);
				const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
				if (req.method === 'initialize') reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'slow',version:'1'}});
				if (req.method === 'tools/list') {
					if (req.params?.cursor) { writeFileSync(${JSON.stringify(ready)}, 'ready'); return; }
					reply({tools:[{name:'echo',description:'echo',inputSchema:{type:'object'}}],nextCursor:'next'});
				}
			});
		`,
		);
		writeFileSync(
			join(scene.project, ".clio-coder", "mcp.yaml"),
			`version: 1\nservers:\n  - id: fake\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(server)}]\n`,
		);
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		const { source } = wire(scene);
		open.push(source);
		const controller = new AbortController();
		const pending = rejects(source.refresh("fake", { signal: controller.signal }), /aborted/);
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready)) {
			if (Date.now() > deadline) throw new Error("the server never reached its second page");
			await new Promise((settle) => setTimeout(settle, 10));
		}
		controller.abort();
		await pending;
		await source.close();

		const next = wire(scene);
		open.push(next.source);
		deepStrictEqual(next.source.catalog().missing, ["fake"], "aborted discovery leaves no catalog behind");
		strictEqual(next.clients.length, 0);
	});

	it("carries truncation across publication for both the tool cap and the page cap", async () => {
		// Completeness must come from the client's flag, never from counting what
		// was recorded. The page-cap case records 100 tools, far under the
		// 500-tool cap, so code that inferred completeness from the count would
		// call it complete and pass every other test in this file.
		for (const shape of [
			{ id: "toolcap", perPage: 100, expected: 500 },
			{ id: "pagecap", perPage: 1, expected: 100 },
		]) {
			const scene = scenario();
			const server = join(scene.project, `${shape.id}-server.mjs`);
			writeFileSync(
				server,
				`
				import {createInterface} from 'node:readline';
				createInterface({input: process.stdin}).on('line', line => {
					const req = JSON.parse(line);
					const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
					if (req.method === 'initialize') reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'endless',version:'1'}});
					if (req.method === 'tools/list') {
						const page = Number(req.params?.cursor ?? 0);
						const tools = Array.from({length: ${shape.perPage}}, (_, i) => ({
							name: 't' + (page * ${shape.perPage} + i),
							description: 'endless',
							inputSchema: {type: 'object'},
						}));
						reply({tools, nextCursor: String(page + 1)});
					}
				});
			`,
			);
			writeFileSync(
				join(scene.project, ".clio-coder", "mcp.yaml"),
				`version: 1\nservers:\n  - id: fake\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(server)}]\n`,
			);
			ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
			const first = wire(scene);
			open.push(first.source);
			const refreshed = await first.source.refresh("fake");
			strictEqual(refreshed.listing?.truncated, true, `${shape.id}: the live listing is partial`);
			strictEqual(refreshed.listing.catalogCount, shape.expected, `${shape.id}: recorded tool count`);
			await first.source.close();

			const second = wire(scene);
			open.push(second.source);
			const fake = second.source.catalog().servers.find((entry) => entry.id === "fake");
			deepStrictEqual(
				{ catalog: fake?.catalog, truncated: fake?.truncated, count: fake?.catalogCount },
				{ catalog: "cached", truncated: true, count: shape.expected },
				`${shape.id}: a known-partial catalog reads back partial`,
			);
			const metadata = second.source.metadata("mcp_fake__t0").metadata;
			strictEqual(metadata?.provenance, "cached", `${shape.id}: describe reads the catalog`);
			strictEqual(metadata.truncated, true, `${shape.id}: describe says its catalog is incomplete`);
			strictEqual(second.clients.length, 0, `${shape.id}: none of this constructed a client`);
		}
	});

	it("keeps a live call working when the catalog cannot be written", async () => {
		const scene = scenario();
		ok(trustMcpServer({ cwd: scene.project, configDir: scene.configDir, id: "fake", actionClass: "read" }).ok);
		// A regular file where the cache directory belongs makes every write fail.
		rmSync(join(env.dir, "cache"), { recursive: true, force: true });
		writeFileSync(join(env.dir, "cache"), "not a directory");
		const { source, clients } = wire(scene);
		open.push(source);
		const ensured = await source.ensure(ECHO);
		ok(ensured.spec, ensured.reason);
		strictEqual(clients.length, 1);
		const result = await ensured.spec.run({ text: "still works" });
		strictEqual(result.kind, "ok");
		strictEqual(source.catalog().servers.find((server) => server.id === "fake")?.catalog, "live");
	});

	it("routes a cached name by the longest declared server prefix", async () => {
		const scene = scenario();
		writeFileSync(
			join(scene.configDir, "mcp.yaml"),
			JSON.stringify({
				version: 1,
				servers: [
					{ id: "a", command: process.execPath, args: [FIXTURE, "normal"] },
					{ id: "a__b", command: process.execPath, args: [FIXTURE, "normal"] },
				],
			}),
		);
		writeFileSync(join(scene.project, ".clio-coder", "mcp.yaml"), "version: 1\nservers: []\n");
		// Server `a` also offers a tool literally named `b__echo`, so both
		// declarations compose the name mcp_a__b__echo.
		const collide = (spec: McpServerSpec, clientOptions: McpClientOptions): McpClient => {
			const client = createMcpStdioClient(spec, { ...clientOptions, killGraceMs: 50 });
			if (spec.id !== "a") return client;
			const listTools = client.listTools.bind(client);
			client.listTools = async () => {
				const listing = await listTools();
				const echo = listing.tools[0];
				ok(echo);
				return { ...listing, tools: [...listing.tools, { ...echo, name: "b__echo" }] };
			};
			return client;
		};
		const first = wire(scene, collide);
		open.push(first.source);
		await first.source.refresh("a");
		await first.source.refresh("a__b");
		await first.source.close();

		const second = wire(scene, collide);
		open.push(second.source);
		const names = second.source.catalog().entries.map((entry) => entry.name);
		strictEqual(names.filter((name) => name === "mcp_a__b__echo").length, 1, "one owner, from the longest prefix");
		strictEqual(second.source.metadata("mcp_a__b__echo").metadata?.provenance, "cached");
		ok(second.source.authorityNote("mcp_a__b__echo")?.startsWith("Local stdio MCP server a__b ("));
		strictEqual(second.clients.length, 0);
	});
});
