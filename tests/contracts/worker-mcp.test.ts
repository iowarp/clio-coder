import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mcpCommandOutput } from "../../src/cli/mcp.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { WORKER_SANDBOX_SPEC_VERSION } from "../../src/core/sandbox/types.js";
import { workerMcpNoNetworkNotice } from "../../src/core/sandbox/worker-policy.js";
import { configureWorkerProcessSandbox, planSandboxedSpawn } from "../../src/core/sandbox/worker-process.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunResultSafetySummary } from "../../src/domains/dispatch/types.js";
import {
	resolveWorkerMcpAdmission,
	withholdWritableMcpNetwork,
	workerMcpRuntimeRefusal,
} from "../../src/domains/dispatch/worker-mcp.js";
import {
	canonicalProjectRoot,
	createMcpStdioClient,
	type McpClient,
	resolveMcpServers,
	trustMcpServer,
	writeMcpServerCatalog,
} from "../../src/domains/gateway/mcp/index.js";
import { mcpCatalogPath } from "../../src/domains/gateway/mcp/metadata-cache.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { resolveWorkerPermit, type WorkerMcpAttestation } from "../../src/domains/safety/worker-permit.js";
import { startWorkerRun } from "../../src/engine/worker-runtime.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { formatDispatchOutput } from "../../src/tools/dispatch-runner.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import type { RegistryVerdict } from "../../src/tools/registry.js";
import { parseWorkerSpec, type WorkerSpec } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
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

	function wire(attestation: WorkerMcpAttestation, launches?: Array<{ sandboxNetwork?: boolean }>) {
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
						launches?.push(options);
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

	it("refuses a read-only worker a tool classed read only by its server's readOnlyHint", async () => {
		writeFileSync(
			join(clioConfigDir(), "mcp.yaml"),
			["version: 1", "servers:", "  - id: hinted", `    command: ${JSON.stringify(process.execPath)}`, ""].join("\n"),
		);
		const declaration = resolveMcpServers({ cwd: project }).servers.find((server) => server.id === "hinted");
		ok(declaration);
		const projectRoot = canonicalProjectRoot(project);
		ok(
			writeMcpServerCatalog(
				{
					projectRoot,
					scope: declaration.scope,
					declarationPath: declaration.path,
					serverId: declaration.id,
					digest: declaration.digest,
					cwd: declaration.cwd,
				},
				{
					tools: [
						{
							name: "sleep",
							title: null,
							description: "",
							inputSchema: { type: "object" },
							annotations: { readOnlyHint: true },
						},
					],
					truncated: false,
				},
			),
		);
		const sleep = "mcp_hinted__sleep" as ToolName;
		const context = dispatchStubContext({ agentTools: [ToolNames.Read, sleep] });
		// The stub coder keeps its git worktree allowance, which a read-only class refuses.
		const readOnly = (recipe: AgentRecipe | null): AgentRecipe | null => {
			if (recipe === null) return null;
			const { permissions: _git, ...rest } = recipe;
			return rest;
		};
		const bundle = makeDispatchBundle({
			...context,
			getContract<T extends object>(name: string): T | undefined {
				const contract = context.getContract<T>(name);
				if (name !== "agents" || contract === undefined) return contract;
				const agents = contract as unknown as AgentsContract;
				return {
					...agents,
					get: (id: string) => readOnly(agents.get(id)),
					getSpec: (id: string) => {
						const recipe = readOnly(agents.get(id));
						return recipe ? normalizeAgentSpec(recipe) : null;
					},
				} as unknown as T;
			},
		});
		await bundle.extension.start();
		try {
			throws(
				() =>
					bundle.contract.preview?.({
						agentId: "coder",
						task: "Inspect evidence.",
						cwd: project,
						executionRole: "builder",
					}),
				/mcp_hinted__sleep.*gives action class unknown.*readOnlyHint never counts as read.*`clio-coder mcp trust hinted --action-class read`.*toolActionClasses/,
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("names the server and safety.sandboxNetwork when a sandbox without network will start an admitted MCP server", async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.sandbox = "required";
		const context = dispatchStubContext({ settings, agentTools: [...TOOLS, ToolNames.Edit, ToolNames.Write] });
		const notices: Array<{ code: string; message: string }> = [];
		const unsubscribe = context.bus.subscribe("run.scope_notice_raised", (notice) => {
			notices.push(notice);
		});
		const bundle = makeDispatchBundle(context, {
			spawnWorker: () => {
				throw new Error("fixture: admitted");
			},
		});
		await bundle.extension.start();
		try {
			await rejects(
				bundle.contract.dispatch({ agentId: "coder", task: "Inspect evidence.", cwd: project, executionRole: "builder" }),
				/fixture: admitted/,
			);
		} finally {
			unsubscribe();
			await bundle.extension.stop?.();
		}
		// A host without a sandbox backend refuses the launch instead, so there is nothing to warn about.
		const confined = sandboxAvailability().available;
		strictEqual(notices.length, confined ? 1 : 0, JSON.stringify(notices));
		if (confined) {
			strictEqual(notices[0]?.code, "mcp_sandbox_no_network");
			match(notices[0]?.message ?? "", /MCP server 'fake' starts .*no network.*safety\.sandboxNetwork/);
		}

		const envelope = fixtureEnvelope("run-mcp");
		const draft = fixtureReceiptDraft(envelope);
		const mcp = {
			projectRoot: project,
			tools: [{ serverId: "fake", digest: "d", tool: "echo", actionClass: "read" }],
		};
		const ceiling = { tools: TOOLS, readOnly: true, writeRoots: [], enforcement, mcp };
		const permit: NonNullable<RunResultSafetySummary["permit"]> = {
			version: 1,
			digest: "fixture",
			capabilityClass: "read-only",
			git: "inspect",
			asks: "deny",
			approvalAuthority: "main",
			ceiling,
		};
		const sandbox = {
			mode: "auto",
			backend: "bwrap",
			available: true,
			writableRoots: [],
			gitWritablePaths: [],
			network: false,
		} as const;
		const safety: RunResultSafetySummary = {
			decisions: { allowed: 0, blocked: 0, permissionRequested: 0 },
			blockedAttempts: [],
			permit,
			sandbox,
		};
		draft.safety = safety;
		const receipt = withReceiptIntegrity(draft, envelope);
		const summary = { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: receipt.runId };
		match(
			formatDispatchOutput("single", [{ receipt, summary }], 16_384),
			/MCP server 'fake' starts .*no network.*safety\.sandboxNetwork/,
		);
		const networked = withReceiptIntegrity(
			{ ...draft, safety: { ...safety, sandbox: { ...sandbox, network: true } } },
			envelope,
		);
		ok(!formatDispatchOutput("single", [{ receipt: networked, summary }], 16_384).includes("safety.sandboxNetwork"));

		// A grant the run's write roots voided reads back as withheld, not as never granted.
		const reason = `this run's write root ${project} overlaps its launch cwd ${project}`;
		const withheld = withReceiptIntegrity(
			{
				...draft,
				safety: {
					...safety,
					permit: {
						...permit,
						ceiling: { ...ceiling, mcp: { ...mcp, networkWithheld: [{ serverId: "fake", reason }] } },
					},
				},
			},
			envelope,
		);
		const withheldOutput = formatDispatchOutput("single", [{ receipt: withheld, summary }], 16_384);
		match(withheldOutput, /MCP server 'fake' starts without its network grant because this run's write root/);
		doesNotMatch(withheldOutput, /--network/);
	});

	it("attests the network grant of a server trusted with --network and leaves it out of the no-network notice", () => {
		const confined = { mode: "auto", available: true, network: false } as const;
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read", network: true }).ok);
		const granted = admitted();
		deepStrictEqual(
			granted.tools.map((entry) => [entry.serverId, entry.network]),
			[["fake", true]],
		);
		strictEqual(workerMcpNoNetworkNotice(confined, granted.tools), null);

		// A re-trust without the flag replaces the record and drops the grant.
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		const dropped = admitted();
		strictEqual(dropped.tools[0]?.network, undefined);
		match(workerMcpNoNetworkNotice(confined, dropped.tools) ?? "", /MCP server 'fake' starts .*no network/);
	});

	async function dispatchGranted(agentTools: ToolName[]) {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read", network: true }).ok);
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.sandbox = "required";
		const context = dispatchStubContext({ settings, agentTools });
		// The stub coder keeps its git worktree allowance, which a read-only class refuses.
		const withoutGit = (recipe: AgentRecipe | null): AgentRecipe | null => {
			if (recipe === null) return null;
			const { permissions: _git, ...rest } = recipe;
			return rest;
		};
		const getContract = <T extends object>(name: string): T | undefined => {
			const contract = context.getContract<T>(name);
			if (name !== "agents" || contract === undefined) return contract;
			const agents = contract as unknown as AgentsContract;
			return {
				...agents,
				get: (id: string) => withoutGit(agents.get(id)),
				getSpec: (id: string) => {
					const recipe = withoutGit(agents.get(id));
					return recipe ? normalizeAgentSpec(recipe) : null;
				},
			} as unknown as T;
		};
		const notices: Array<{ code: string; message: string }> = [];
		const unsubscribe = context.bus.subscribe("run.scope_notice_raised", (notice) => {
			notices.push(notice);
		});
		let spawned: WorkerSpec | undefined;
		const bundle = makeDispatchBundle(
			{ ...context, getContract },
			{
				spawnWorker: (spec) => {
					spawned = spec;
					throw new Error("fixture: admitted");
				},
			},
		);
		await bundle.extension.start();
		try {
			await rejects(
				bundle.contract.dispatch({ agentId: "coder", task: "Inspect evidence.", cwd: project, executionRole: "builder" }),
				/fixture: admitted/,
			);
		} finally {
			unsubscribe();
			await bundle.extension.stop?.();
		}
		ok(spawned);
		return { spec: spawned, notices };
	}

	it("carries a read-only worker's network grant through the worker spec", async () => {
		// Every tool reads, so the agent's class is read-only and the run has no write root.
		const { spec } = await dispatchGranted(TOOLS);
		const parsed = parseWorkerSpec(JSON.parse(JSON.stringify(spec)));
		deepStrictEqual(
			parsed.permit?.ceiling.mcp?.tools.map((entry) => [entry.serverId, entry.network]),
			[["fake", true]],
		);
	});

	it("withholds the grant from a writing worker whose write root covers the server's cwd and says why", async () => {
		const { spec, notices } = await dispatchGranted([...TOOLS, ToolNames.Edit, ToolNames.Write]);
		deepStrictEqual(
			spec.permit?.ceiling.mcp?.tools.map((entry) => [entry.serverId, entry.network]),
			[["fake", undefined]],
		);

		// A narrow write root beside an in-project entry is code the server can load, so it withholds the grant too.
		mkdirSync(join(project, "tools"));
		writeFileSync(join(project, "tools", "server.mjs"), readFileSync(FIXTURE, "utf8"));
		const file = join(project, ".clio-coder", "mcp.yaml");
		writeFileSync(
			file,
			readFileSync(file, "utf8").replace(`args: [${JSON.stringify(FIXTURE)}]`, "args: [tools/server.mjs]"),
		);
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read", network: true }).ok);
		const sibling = join(project, "tools", "json.mjs");
		const scoped = withholdWritableMcpNetwork(admitted(), { writeRoots: [sibling], launchRoot: project });
		deepStrictEqual(
			scoped.withheld.map((entry) => entry.serverId),
			["fake"],
		);
		match(scoped.withheld[0]?.reason ?? "", /write root .*json\.mjs overlaps/);

		// A host without a sandbox backend refuses the launch instead, so there is nothing to warn about.
		if (!sandboxAvailability().available) return;
		strictEqual(notices.length, 1, JSON.stringify(notices));
		strictEqual(notices[0]?.code, "mcp_sandbox_no_network");
		match(
			notices[0]?.message ?? "",
			/MCP server 'fake' starts without its network grant because this run's write root .* overlaps its launch cwd/,
		);
		doesNotMatch(notices[0]?.message ?? "", /safety\.sandboxNetwork/);
	});

	it("withholds the grant when the dispatch cwd is a symlink and the write root names the link target", () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read", network: true }).ok);
		const link = join(env.dir, "linked");
		symlinkSync(project, link);
		const tools = join(realpathSync(project), "tools");
		mkdirSync(tools);
		const scoped = withholdWritableMcpNetwork(admitted(), { writeRoots: [`${tools}/`], launchRoot: link });
		deepStrictEqual(
			scoped.withheld.map((entry) => entry.serverId),
			["fake"],
		);
		strictEqual(scoped.attestation.tools[0]?.network, undefined);
	});

	it("starts a server without sandboxNetwork when its trust record grants network but the sealed attestation withholds it", async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read", network: true }).ok);
		const granted = admitted();
		const { attestation, withheld } = withholdWritableMcpNetwork(granted, { writeRoots: [project], launchRoot: project });
		deepStrictEqual(
			withheld.map((entry) => entry.serverId),
			["fake"],
		);
		const launches: Array<{ sandboxNetwork?: boolean }> = [];
		ok((await wire(attestation, launches).source.ensure(ECHO)).spec);
		strictEqual(launches.length, 1);
		strictEqual(launches[0]?.sandboxNetwork, undefined);
		// The same server under the unwithheld attestation does get the grant, so the source reads the attestation.
		ok((await wire(granted, launches).source.ensure(ECHO)).spec);
		strictEqual(launches[1]?.sandboxNetwork, true);
	});

	it("opens the network namespace only for a granted server's sandboxed process", () => {
		const tree = join(env.dir, "tree");
		mkdirSync(tree);
		configureWorkerProcessSandbox({
			version: WORKER_SANDBOX_SPEC_VERSION,
			mode: "required",
			writableRoots: [`${tree}/`],
			readOnlyPaths: [],
			gitWritablePaths: [],
			readableRoots: [tree],
			network: false,
		});
		try {
			const command = { argv: [process.execPath, FIXTURE] };
			const granted = planSandboxedSpawn(command, tree, [], { network: true });
			const confined = planSandboxedSpawn(command, tree);
			if (!sandboxAvailability().available) {
				strictEqual(granted.kind, "refused");
				return;
			}
			ok(granted.kind === "sandboxed" && confined.kind === "sandboxed");
			strictEqual(granted.args.includes("--unshare-net"), false);
			strictEqual(confined.args.includes("--unshare-net"), true);
		} finally {
			configureWorkerProcessSandbox(undefined);
		}
	});

	it("grants nothing for a project declaration's own network field and keeps its trust digest", () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		const file = join(project, ".clio-coder", "mcp.yaml");
		writeFileSync(file, readFileSync(file, "utf8").replace("  - id: other", "    network: true\n  - id: other"));
		const resolved = resolveMcpServers({ cwd: project });
		const fake = resolved.servers.find((server) => server.id === "fake");
		deepStrictEqual(fake?.trust, { status: "trusted", actionClass: "read" });
		ok(
			resolved.diagnostics.some((entry) =>
				/servers\[0\]\.network is ignored.*mcp trust fake --network/.test(entry.message),
			),
			JSON.stringify(resolved.diagnostics),
		);
		strictEqual(admitted().tools[0]?.network, undefined);
		// The ignored field is advisory, so mcp list must not exit 1 over it.
		const listed = mcpCommandOutput(["list"], { cwd: project });
		strictEqual(listed.code, 0, listed.text);
		match(listed.text, /^fake .* network=false$/m);
	});

	it("names the write roots and the missing sandbox when they withhold a required execute-class MCP tool", async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "execute" }).ok);
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.sandbox = "off";
		const context = dispatchStubContext({ settings, agentTools: [...TOOLS, ToolNames.Edit, ToolNames.Write] });
		const stub = context.getContract<SafetyContract>("safety");
		ok(stub);
		// The stub's workspace write root is the test process cwd; this run's is the project.
		const safety: SafetyContract = {
			...stub,
			scopes: { ...stub.scopes, workspace: { ...stub.scopes.workspace, allowedWriteRoots: [`${project}/`] } },
		};
		const bundle = makeDispatchBundle({
			...context,
			getContract<T extends object>(name: string): T | undefined {
				return name === "safety" ? (safety as T) : context.getContract<T>(name);
			},
		});
		await bundle.extension.start();
		try {
			const scope = declaredScopeIntent({ writeRoots: ["src/a.ts"] });
			ok(scope.ok);
			await rejects(
				bundle.contract.dispatch({
					agentId: "coder",
					task: "Edit src/a.ts.",
					cwd: project,
					executionRole: "builder",
					intent: scope.intent,
				}),
				/missing required tools: mcp_fake__echo; declared write roots \S*src\/a\.ts have no OS sandbox enforcing them here, so mcp_fake__echo is withheld\. Enable safety\.sandbox/,
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("refuses MCP capabilities on a Claude SDK target before it asks to install the SDK", async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		// A missing prepared component makes the SDK unavailable; the refusal must
		// come first, or the operator is asked to install a runtime that is refused.
		process.env.CLIO_CODER_CLAUDE_SDK_DIR = join(env.dir, "no-sdk");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [{ id: "sdk", runtime: "claude-sdk", defaultModel: "claude-sonnet-5-5" }];
		settings.fleet.default.target = "sdk";
		settings.fleet.default.model = "claude-sonnet-5-5";
		const context = dispatchStubContext({
			settings,
			agentTools: [...TOOLS, ToolNames.Edit, ToolNames.Write],
			runtime: {
				id: "claude-sdk",
				displayName: "Claude SDK",
				kind: "sdk",
				auth: "claude-cli",
				defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
				synthesizeModel: () => ({ id: "claude-sonnet-5-5", provider: "claude-sdk" }) as never,
			} as never,
		});
		const bundle = makeDispatchBundle(context);
		await bundle.extension.start();
		try {
			await rejects(
				bundle.contract.dispatch({ agentId: "coder", task: "Inspect evidence.", cwd: project, executionRole: "builder" }),
				/the Claude SDK runtime runs its own tool loop/,
			);
		} finally {
			await bundle.extension.stop?.();
			delete process.env.CLIO_CODER_CLAUDE_SDK_DIR;
		}
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

	it("starts a task worktree run's project server at the worktree root when dispatched from a subdirectory", {
		timeout: 20_000,
	}, async () => {
		ok(trustMcpServer({ cwd: project, id: "fake", actionClass: "read" }).ok);
		const ENV = "mcp_fake__env" as ToolName;
		const tools: ToolName[] = [ToolNames.Read, ToolNames.Gateway, ENV];
		const mcp = resolveWorkerMcpAdmission({ agentId: "scout", projectCwd: project, tools });
		ok(mcp);
		const worktree = join(env.dir, "worktree");
		mkdirSync(join(worktree, "sub"), { recursive: true });
		const bodies: Array<Record<string, unknown>> = [];
		const server = createServer(async (req, res) => {
			bodies.push(JSON.parse(await readRequestBody(req)));
			const first = bodies.length === 1;
			const args = JSON.stringify({ op: "call", capability: ENV, args: {} });
			const delta = first
				? {
						role: "assistant",
						tool_calls: [{ index: 0, id: "mcp-env", type: "function", function: { name: "gateway", arguments: args } }],
					}
				: { role: "assistant", content: "Done." };
			res.setHeader("content-type", "text/event-stream");
			res.end(
				`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
		try {
			const run = startWorkerRun(
				{
					agentId: "scout",
					systemPrompt: "Query the admitted env tool.",
					task: "Report the server cwd.",
					target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
					runtime: litellm,
					wireModelId: "fixture",
					apiKey: "fixture",
					thinkingLevel: "off",
					modelCapabilities: { contextWindow: 131072, maxTokens: 2048, tools: true },
					allowedTools: tools,
					budget: { mode: "advisory", toolCalls: 6, readReserve: 0, synthesis: true, hardCap: 20 },
					noSkills: true,
					cwd: join(worktree, "sub"),
					readOnly: true,
					taskGit: {
						allowance: "inspect",
						executePermitted: false,
						taskWorktree: {
							root: project,
							runId: "run-1",
							path: worktree,
							branch: "clio-coder/run-1",
							base: "0000000",
							ownerToken: "owner",
						},
					},
					mcp,
				},
				() => {},
			);
			strictEqual((await run.promise).exitCode, 0);
			const messages = bodies[1]?.messages as Array<{ role: string; content: unknown }>;
			const toolResult = messages.find((message) => message.role === "tool");
			ok(toolResult, JSON.stringify(messages));
			const text = Array.isArray(toolResult.content)
				? toolResult.content.map((part: { text?: string }) => part.text ?? "").join("")
				: String(toolResult.content);
			strictEqual((JSON.parse(text) as { cwd: string }).cwd, worktree);
		} finally {
			await closeServer(server);
		}
	});
});
