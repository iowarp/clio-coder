import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WORKER_SANDBOX_SPEC_VERSION } from "../../src/core/sandbox/types.js";
import { configureWorkerProcessSandbox } from "../../src/core/sandbox/worker-process.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resolveWorkerMcpAdmission, workerMcpRuntimeRefusal } from "../../src/domains/dispatch/worker-mcp.js";
import {
	canonicalProjectRoot,
	createMcpStdioClient,
	type McpClient,
	trustMcpServer,
} from "../../src/domains/gateway/mcp/index.js";
import { mcpCatalogPath } from "../../src/domains/gateway/mcp/metadata-cache.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { resolveWorkerPermit, type WorkerMcpAttestation } from "../../src/domains/safety/worker-permit.js";
import { startWorkerRun } from "../../src/engine/worker-runtime.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import type { RegistryVerdict } from "../../src/tools/registry.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Native workers reach exact MCP capabilities their recipe names. Admission
 * resolves trust and class once from the project root through the shared
 * classifier, applies the ordinary ceiling, and attests the result into the
 * permit; the worker launches only the attested declaration and closes it.
 */

const FIXTURE = resolve("tests/fixtures/mcp-fake-server.mjs");
const ECHO = "mcp_fake__echo" as ToolName;
const TOOLS: ToolName[] = [ToolNames.Read, ToolNames.Gateway, ECHO];

function payloadOf(verdict: RegistryVerdict): Record<string, unknown> {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
	return JSON.parse(verdict.result.output) as Record<string, unknown>;
}

const enforcement = {
	toolNarrowing: "exact",
	perCallMediation: true,
	scopeEnforcement: true,
	grantPauseResume: true,
	cancellation: true,
} as const;

describe("native worker MCP capabilities", () => {
	let env: IsolatedClioEnv;
	let project: string;
	const sources: McpCapabilitySource[] = [];
	const clients: McpClient[] = [];

	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-worker-mcp-");
		project = join(env.dir, "project");
		mkdirSync(join(project, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(project, ".clio-coder", "mcp.yaml"),
			[
				"version: 1",
				"servers:",
				"  - id: fake",
				`    command: ${JSON.stringify(process.execPath)}`,
				`    args: [${JSON.stringify(FIXTURE)}]`,
				"  - id: other",
				`    command: ${JSON.stringify(process.execPath)}`,
				`    args: [${JSON.stringify(FIXTURE)}]`,
				"",
			].join("\n"),
		);
	});

	afterEach(async () => {
		await Promise.all(sources.splice(0).map((source) => source.close()));
		clients.splice(0);
		env.restore();
	});

	function admitted(): WorkerMcpAttestation {
		const attestation = resolveWorkerMcpAdmission({ agentId: "coder", projectCwd: project, tools: TOOLS });
		ok(attestation);
		return attestation;
	}

	function wire(attestation: WorkerMcpAttestation) {
		let source!: McpCapabilitySource;
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: project }),
			undefined,
			undefined,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(registry) => {
				source = createMcpCapabilitySource({
					cwd: attestation.projectRoot,
					registry,
					persistCatalog: false,
					admitted: attestation,
					clientFactory: (spec, options) => {
						const client = createMcpStdioClient(spec, { ...options, initializeTimeoutMs: 5_000, killGraceMs: 200 });
						clients.push(client);
						return client;
					},
				});
				sources.push(source);
				return source;
			},
		);
		registry.onPermissionRequired((_call, _decision, meta) => registry.cancelParkedCall(meta.requestId, "denied"));
		return { registry, source };
	}

	const call = (capability: string = ECHO) => ({
		tool: ToolNames.Gateway,
		args: { op: "call", capability, args: { text: "evidence-67" } },
	});

	it("refuses untrusted and unclassed servers by name and admits a trusted read class into the permit", async () => {
		// The stub's coder keeps its git worktree allowance, which needs edit authority.
		const context = dispatchStubContext({ agentTools: [...TOOLS, ToolNames.Edit, ToolNames.Write] });
		const safety = createWorkerSafety({ cwd: project });
		const bundle = makeDispatchBundle({
			...context,
			getContract<T extends object>(name: string): T | undefined {
				return name === "safety" ? (safety as T) : context.getContract<T>(name);
			},
		});
		await bundle.extension.start();
		try {
			const request = { agentId: "coder", task: "Inspect evidence.", cwd: project, executionRole: "builder" as const };
			throws(() => bundle.contract.preview?.(request), /MCP server 'fake' is untrusted.*`clio-coder mcp trust fake`/);
			ok(trustMcpServer({ cwd: project, id: "fake" }).ok);
			throws(
				() => bundle.contract.preview?.(request),
				/MCP server 'fake' gives action class unknown.*`clio-coder mcp trust fake --action-class <class>`/,
			);
			ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
			const preview = bundle.contract.preview?.(request);
			ok(preview);
			strictEqual(
				preview.toolSignature,
				createHash("sha256")
					.update(JSON.stringify([...TOOLS, ToolNames.Edit, ToolNames.Write].sort()))
					.digest("hex"),
			);
		} finally {
			await bundle.extension.stop?.();
		}
		const attestation = admitted();
		strictEqual(attestation.projectRoot, canonicalProjectRoot(project));
		deepStrictEqual(
			attestation.tools.map(({ serverId, tool, actionClass }) => ({ serverId, tool, actionClass })),
			[{ serverId: "fake", tool: "echo", actionClass: "read" }],
		);
		const permitFor = (capabilityClass: "read-only" | "workspace-edit", mcp: WorkerMcpAttestation) =>
			resolveWorkerPermit({
				agentId: "coder",
				capabilityClass,
				tools: TOOLS,
				readOnly: capabilityClass === "read-only",
				writeRoots: [],
				mode: "deny",
				runtime: { id: "openai", targetId: "t", enforcement, trustedUnmediated: false },
				mcp,
			});
		const permit = permitFor("read-only", attestation);
		deepStrictEqual(permit.ceiling.mcp, attestation);
		const execute = {
			...attestation,
			tools: attestation.tools.map((entry) => ({ ...entry, actionClass: "execute" as const })),
		};
		throws(
			() => permitFor("read-only", execute),
			/read-only ceiling excludes execute tool mcp_fake__echo \(MCP server 'fake'/,
		);
		ok(permitFor("workspace-edit", execute).digest !== permit.digest, "the attested class is part of the permit digest");
		match(
			workerMcpRuntimeRefusal("coder", TOOLS, { id: "claude-sdk", kind: "http" }) ?? "",
			/the Claude SDK runtime runs its own tool loop/,
		);
		strictEqual(clients.length, 0, "admission launched nothing");
	});

	it("launches only the attested declaration, persists no catalog, and closes it at run end", async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		ok(trustMcpServer({ cwd: project, id: "other", actionClass: "read" }).ok);
		const attestation = admitted();
		const { registry, source } = wire(attestation);
		deepStrictEqual(payloadOf(await registry.invoke(call(), { allowedTools: TOOLS })), { text: "evidence-67" });
		deepStrictEqual(source.connectedIds(), ["fake"]);
		const other = await source.ensure("mcp_other__echo");
		match(other.reason ?? "", /not admitted for this run/);
		strictEqual(
			existsSync(
				mcpCatalogPath({
					projectRoot: attestation.projectRoot,
					scope: "project",
					declarationPath: join(attestation.projectRoot, ".clio-coder", "mcp.yaml"),
					serverId: "fake",
					digest: attestation.tools[0]?.digest ?? "",
					cwd: attestation.projectRoot,
				}),
			),
			false,
		);
		await source.close();
		ok(clients.every((client) => client.state().status === "closed"));
		// A declaration edited and re-trusted after admission is stale for that
		// run and never starts; the operator's new review is not this run's.
		const path = join(project, ".clio-coder", "mcp.yaml");
		writeFileSync(path, readFileSync(path, "utf8").replace("  - id: other", "    timeoutMs: 5000\n  - id: other"));
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		const stale = wire(attestation);
		const refused = await stale.registry.invoke(call(), { allowedTools: TOOLS });
		ok(refused.kind === "ok" && refused.result.kind === "error", JSON.stringify(refused));
		match(refused.result.message, /changed since this run was admitted.*clio-coder mcp trust fake/);
		strictEqual(clients.length, 1);
	});

	it("starts a worker's MCP server under the worker sandbox, so it never writes outside the write roots", async () => {
		const tree = join(env.dir, "tree");
		mkdirSync(tree);
		const outside = join(env.dir, "outside-marker");
		// `required` makes the outcome host-independent: bwrap runs the server
		// confined, and a host without it refuses the launch.
		configureWorkerProcessSandbox({
			version: WORKER_SANDBOX_SPEC_VERSION,
			mode: "required",
			writableRoots: [`${tree}/`],
			readOnlyPaths: [],
			gitWritablePaths: [],
			readableRoots: [tree],
			network: false,
		});
		const client = createMcpStdioClient(
			{
				id: "shell",
				command: "/bin/sh",
				args: [
					"-c",
					`echo x > ${JSON.stringify(outside)}; echo y > inside-marker; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`,
				],
			},
			{ workspaceRoot: tree, initializeTimeoutMs: 5_000, killGraceMs: 200 },
		);
		let started = true;
		try {
			await client.initialize();
		} catch (error) {
			started = false;
			match(error instanceof Error ? error.message : String(error), /sandbox/);
		} finally {
			await client.close();
			configureWorkerProcessSandbox(undefined);
		}
		strictEqual(existsSync(outside), false);
		if (started) ok(existsSync(join(tree, "inside-marker")));
	});

	it("gives the native model loop an MCP result through the worker-local source", { timeout: 20_000 }, async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		const bodies: Array<Record<string, unknown>> = [];
		const server = createServer(async (req, res) => {
			bodies.push(JSON.parse(await readRequestBody(req)));
			const first = bodies.length === 1;
			const delta = first
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "mcp-query",
								type: "function",
								function: { name: "gateway", arguments: JSON.stringify(call().args) },
							},
						],
					}
				: { role: "assistant", content: "Retrieved evidence-67." };
			res.setHeader("content-type", "text/event-stream");
			res.end(
				`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
		const events: unknown[] = [];
		try {
			const run = startWorkerRun(
				{
					agentId: "scout",
					systemPrompt: "Query the admitted evidence tool and report its text.",
					task: "Retrieve evidence.",
					target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
					runtime: litellm,
					wireModelId: "fixture",
					apiKey: "fixture",
					thinkingLevel: "off",
					modelCapabilities: { contextWindow: 131072, maxTokens: 2048, tools: true },
					allowedTools: TOOLS,
					budget: { mode: "advisory", toolCalls: 6, readReserve: 0, synthesis: true, hardCap: 20 },
					noSkills: true,
					cwd: project,
					readOnly: true,
					mcp: admitted(),
				},
				(event) => events.push(event),
			);
			const result = await run.promise;
			strictEqual(result.exitCode, 0, JSON.stringify(events).slice(0, 2000));
			strictEqual(bodies.length, 2);
			// The call's own arguments carry the same text, so read the tool result itself.
			const messages = bodies[1]?.messages as Array<{ role: string; content: unknown }>;
			const toolResult = messages.find((message) => message.role === "tool");
			ok(toolResult, JSON.stringify(messages));
			const text = Array.isArray(toolResult.content)
				? toolResult.content.map((part: { text?: string }) => part.text ?? "").join("")
				: String(toolResult.content);
			deepStrictEqual(JSON.parse(text), { text: "evidence-67" });
			const tools = bodies[0]?.tools as Array<{ function: { name: string } }>;
			deepStrictEqual(tools.map((tool) => tool.function.name).sort(), ["gateway", "read"]);
		} finally {
			await closeServer(server);
		}
	});
});
