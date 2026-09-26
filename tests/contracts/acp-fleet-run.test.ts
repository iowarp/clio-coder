import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { FleetContract } from "../../src/domains/agents/index.js";
import {
	agentRoleFactsResolver,
	compileFleetRunPreview,
	type FleetRunPreview,
} from "../../src/domains/dispatch/index.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import {
	ACP_FLEET_MAX_STEPS,
	type AcpFleetControl,
	type AcpFleetPreview,
	projectFleetPreview,
} from "../../src/engine/acp/fleet-run.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function contract(root: string, stepIds: string[], agent = "coder"): FleetContract {
	return {
		version: 3,
		name: "survey",
		description: "Survey fixture",
		path: join(root, "survey.md"),
		body: "Survey {{site}} and report.",
		maxWorkers: 1,
		budgetUsd: null,
		onFailure: "stop",
		steps: stepIds.map((id, index) => ({
			kind: "agent",
			id,
			agent,
			scope: "readonly",
			dependencies: index === 0 ? [] : [stepIds[index - 1] as string],
		})),
	} as FleetContract;
}

async function peer() {
	const scratch = await isolateClioEnv("clio-coder-acp-fleet-");
	const root = realpathSync(scratch.dir);
	const context = dispatchStubContext({ settings: DEFAULT_SETTINGS });
	const agents = context.getContract<AgentsContract>("agents");
	ok(agents);
	const state = {
		steps: ["survey", "report"],
		agent: "coder",
		model: "approved-model",
		recipeSuffix: "",
		command: null as { argv: string[]; cwd: string; env: string[] } | null,
		refuseAtAdmission: null as string | null,
	};
	const getSpec = (id: string) => {
		const spec = agents.getSpec(id);
		return spec === null ? null : { ...spec, body: spec.body + state.recipeSuffix };
	};
	const started: FleetRunPreview[] = [];
	const control: AcpFleetControl = {
		preview: (name, vars) =>
			compileFleetRunPreview({
				workspaceRoot: root,
				name,
				vars,
				getAgentSpec: getSpec,
				roleFacts: agentRoleFactsResolver(getSpec),
				resolveRoute: () => ({
					targetId: "target",
					wireModelId: state.model,
					nodeId: "local",
					endpoint: { key: "same-endpoint", label: "Local", limit: 1 },
				}),
				load: () => {
					const fleet = contract(root, state.steps, state.agent);
					if (state.command === null) return { commands: null, contract: fleet };
					return {
						contract: {
							...fleet,
							steps: [...fleet.steps, { kind: "code", id: "check", command: "test", scope: "readonly", dependencies: [] }],
						} as FleetContract,
						commands: {
							version: 1,
							path: join(root, "commands.yaml"),
							commands: new Map([["test", { id: "test", ...state.command, timeoutMs: 1000, description: "Run checks" }]]),
						},
					};
				},
			}),
		run: async (preview) => {
			started.push(preview);
			return state.refuseAtAdmission === null
				? { status: "started", fleetRootId: "fleet-0123456789ab" }
				: { status: "failed", fleetRootId: "fleet-0123456789ab", reason: state.refuseAtAdmission };
		},
	};
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	let streaming = false;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const done = serveClioAcpAgent({
		transport,
		cwd: root,
		fleet: control,
		autonomy: () => "default",
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => streaming,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) =>
		(await handlers.get(method)?.(params)) as Record<string, unknown>;
	const init = await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: root, mcpServers: [] })) as { sessionId: string };
	return {
		init,
		sessionId,
		call,
		state,
		started,
		compile: () => control.preview("survey", { site: "plot-7" }),
		set streaming(value: boolean) {
			streaming = value;
		},
		stop: async () => {
			close();
			await done;
			scratch.restore();
		},
	};
}

async function refusal(promise: Promise<unknown>, code: string) {
	await rejects(promise, (error: unknown) => {
		ok(error instanceof AcpRequestError, String(error));
		strictEqual(error.detail.code, code);
		return true;
	});
}

test("fleet approval changes when the resolved model changes on the same endpoint", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-route-seal-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract<AgentsContract>("agents");
		ok(agents);
		const compile = (model: string) =>
			compileFleetRunPreview({
				workspaceRoot: root,
				name: "survey",
				vars: { site: "plot-7" },
				getAgentSpec: (id) => agents.getSpec(id),
				roleFacts: agentRoleFactsResolver((id) => agents.getSpec(id)),
				resolveRoute: () => ({
					targetId: "target",
					wireModelId: model,
					nodeId: "local",
					endpoint: { key: "same-endpoint", label: "Local", limit: 1 },
				}),
				load: () => ({ commands: null, contract: contract(root, ["survey"]) }),
			});
		const approved = compile("approved-model");
		const changed = compile("changed-model");
		ok(approved.ok && changed.ok);
		strictEqual(approved.preview.waves[0]?.steps[0]?.route?.wireModelId, "approved-model");
		strictEqual(changed.preview.waves[0]?.steps[0]?.route?.wireModelId, "changed-model");
		notStrictEqual(
			changed.preview.planHash,
			approved.preview.planHash,
			"an endpoint identity cannot stand in for its model",
		);
	} finally {
		scratch.restore();
	}
});

test("fleet approval changes when a registered command's argv changes under the same id", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-command-seal-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract<AgentsContract>("agents");
		ok(agents);
		const compile = (argv: string[], args?: string[]) =>
			compileFleetRunPreview({
				workspaceRoot: root,
				name: "survey",
				vars: { site: "plot-7" },
				getAgentSpec: (id) => agents.getSpec(id),
				roleFacts: agentRoleFactsResolver((id) => agents.getSpec(id)),
				load: () => ({
					contract: {
						...contract(root, []),
						steps: [
							{ kind: "code", id: "check", command: "test", scope: "readonly", dependencies: [], ...(args ? { args } : {}) },
						],
					} as FleetContract,
					commands: {
						version: 1,
						path: join(root, "commands.yaml"),
						commands: new Map([
							[
								"test",
								{
									id: "test",
									argv,
									cwd: "",
									timeoutMs: 1000,
									env: [],
									description: "Run the checks",
									...(args ? { argumentSlots: [{ name: "path", maxLength: 64 }] } : {}),
								},
							],
						]),
					},
				}),
			});
		const approved = compile(["node", "approved-check.js"]);
		const changed = compile(["node", "changed-check.js"]);
		ok(approved.ok && changed.ok);
		const withArgs = compile(["node", "check.js"], ["src/solver.ts"]);
		ok(withArgs.ok);
		deepStrictEqual(
			withArgs.preview.waves[0]?.steps[0]?.argv,
			["node", "check.js", "src/solver.ts"],
			"approval shows the complete declared invocation",
		);
		deepStrictEqual(approved.preview.waves[0]?.steps[0]?.argv, ["node", "approved-check.js"]);
		deepStrictEqual(changed.preview.waves[0]?.steps[0]?.argv, ["node", "changed-check.js"]);
		notStrictEqual(
			changed.preview.planHash,
			approved.preview.planHash,
			"a command id cannot stand in for its invocation",
		);
	} finally {
		scratch.restore();
	}
});

test("fleet preview compiles the contract, announces its hash, and dispatches nothing", async () => {
	const agent = await peer();
	try {
		deepStrictEqual((agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta["clio-coder/fleet"], {
			version: 1,
			preview: "_clio-coder/fleet/preview",
			run: "_clio-coder/fleet/run",
		});
		const preview = (await agent.call("_clio-coder/fleet/preview", {
			sessionId: agent.sessionId,
			name: "survey",
			vars: { site: "plot-7" },
		})) as AcpFleetPreview;
		strictEqual(preview.status, "ready");
		if (preview.status !== "ready") return;
		ok(/^[0-9a-f]{64}$/u.test(preview.planHash));
		strictEqual(preview.stepCount, 2);
		deepStrictEqual(
			preview.waves.map((wave) => wave.steps.map((step) => [step.stepId, step.agentId, step.scope])),
			[[["survey", "coder", "readonly"]], [["report", "coder", "readonly"]]],
		);
		strictEqual(agent.started.length, 0, "preview is side-effect free");
		await refusal(
			agent.call("_clio-coder/fleet/preview", { sessionId: agent.sessionId, name: "../etc" }),
			"invalid_params",
		);
	} finally {
		await agent.stop();
	}
});

test("fleet run starts only the plan whose hash was approved and refuses a changed or broken one first", async () => {
	const agent = await peer();
	try {
		const base = { sessionId: agent.sessionId, name: "survey", vars: { site: "plot-7" } };
		const preview = (await agent.call("_clio-coder/fleet/preview", base)) as Extract<
			AcpFleetPreview,
			{ status: "ready" }
		>;

		agent.streaming = true;
		await refusal(agent.call("_clio-coder/fleet/run", { ...base, planHash: preview.planHash }), "prompt_active");
		agent.streaming = false;

		const otherVars = await agent.call("_clio-coder/fleet/run", {
			...base,
			vars: { site: "plot-8" },
			planHash: preview.planHash,
		});
		strictEqual(otherVars.status, "changed", "the rendered task is part of what was approved");

		agent.state.steps = ["survey", "report", "archive"];
		const changed = await agent.call("_clio-coder/fleet/run", { ...base, planHash: preview.planHash });
		strictEqual(changed.status, "changed");
		ok(changed.planHash !== preview.planHash);
		strictEqual(agent.started.length, 0, "a changed plan dispatches nothing");

		agent.state.agent = "no-such-agent";
		const broken = await agent.call("_clio-coder/fleet/run", { ...base, planHash: preview.planHash });
		strictEqual(broken.status, "refused");
		ok((broken.diagnostics as string[]).some((line) => line.includes("unknown agent 'no-such-agent'")));
		strictEqual(agent.started.length, 0);

		agent.state.steps = ["survey", "report"];
		agent.state.agent = "coder";
		const started = await agent.call("_clio-coder/fleet/run", { ...base, planHash: preview.planHash });
		deepStrictEqual(started, {
			status: "started",
			name: "survey",
			planHash: preview.planHash,
			fleetRootId: "fleet-0123456789ab",
			stepCount: 2,
		});
		strictEqual(agent.started.length, 1);
		strictEqual(agent.started[0]?.planHash, preview.planHash, "the run is the plan that was approved");
		await refusal(agent.call("_clio-coder/fleet/run", { ...base, planHash: "not-a-hash" }), "invalid_params");
	} finally {
		await agent.stop();
	}
});

test("ACP refuses an old approval after model, recipe, or command bindings drift without a DAG change", async () => {
	const agent = await peer();
	try {
		const base = { sessionId: agent.sessionId, name: "survey", vars: { site: "plot-7" } };
		const reset = () => {
			agent.state.model = "approved-model";
			agent.state.recipeSuffix = "";
			agent.state.command = { argv: ["node", "approved-check.js"], cwd: "", env: [] };
		};
		const changes = [
			[
				"model on the same endpoint",
				() => {
					agent.state.model = "changed-model";
				},
			],
			[
				"recipe body",
				() => {
					agent.state.recipeSuffix = "\nUse a different analysis method.";
				},
			],
			[
				"command argv",
				() => {
					ok(agent.state.command);
					agent.state.command.argv = ["node", "changed-check.js"];
				},
			],
			[
				"command cwd",
				() => {
					ok(agent.state.command);
					agent.state.command.cwd = "src";
				},
			],
			[
				"command env allowance",
				() => {
					ok(agent.state.command);
					agent.state.command.env = ["NODE_OPTIONS"];
				},
			],
		] as const;
		for (const [label, change] of changes) {
			reset();
			const before = agent.compile();
			ok(before.ok);
			const approved = (await agent.call("_clio-coder/fleet/preview", base)) as Extract<
				AcpFleetPreview,
				{ status: "ready" }
			>;
			strictEqual(approved.status, "ready");
			change();
			const after = agent.compile();
			ok(after.ok);
			strictEqual(after.preview.plan.hash, before.preview.plan.hash, `${label} leaves the DAG unchanged`);
			notStrictEqual(after.preview.planHash, before.preview.planHash, `${label} changes approval identity`);
			const result = await agent.call("_clio-coder/fleet/run", { ...base, planHash: approved.planHash });
			strictEqual(result.status, "changed", `${label} must be reapproved`);
			strictEqual(agent.started.length, 0, `${label} cannot dispatch under the earlier approval`);
		}
	} finally {
		await agent.stop();
	}
});

test("the fleet projection caps steps and diagnostics and strips control characters", () => {
	const steps = Array.from({ length: ACP_FLEET_MAX_STEPS + 6 }, (_, index) => ({
		stepId: `step-${index}\u001b[2J`,
		kind: "agent" as const,
		scope: "readonly" as const,
		agentId: "coder",
		writes: undefined,
	}));
	const preview = {
		name: "wide",
		vars: {},
		planHash: "a".repeat(64),
		waves: [{ index: 0, steps }],
		budget: { ceilingUsd: 0, currentUsd: 0, contractUsd: null },
		plan: { steps },
	} as unknown as FleetRunPreview;
	const ready = projectFleetPreview({ ok: true, preview });
	strictEqual(ready.status, "ready");
	if (ready.status !== "ready") return;
	strictEqual(ready.truncated, true);
	strictEqual(ready.waves[0]?.steps.length, ACP_FLEET_MAX_STEPS);
	strictEqual(ready.stepCount, ACP_FLEET_MAX_STEPS + 6);
	ok(ready.waves[0]?.steps.every((step) => !step.stepId.includes("\u001b")));
	const refused = projectFleetPreview({
		ok: false,
		name: "wide",
		diagnostics: Array.from({ length: 50 }, () => "x".repeat(5000)),
	});
	strictEqual(refused.status, "refused");
	if (refused.status !== "refused") return;
	strictEqual(refused.diagnostics.length, 32);
	ok(refused.diagnostics.every((line) => Buffer.byteLength(line) <= 1024));
});

test("a bounded fleet argument or write-path list marks the approval preview as incomplete", () => {
	for (const field of ["argv", "writes"] as const) {
		const steps = [
			{
				stepId: "check",
				kind: "code" as const,
				scope: "readonly" as const,
				writes: [],
				[field]: Array.from({ length: 20 }, (_, index) => `item-${index}`),
			},
		];
		const result = projectFleetPreview({
			ok: true,
			preview: {
				name: "bounded",
				vars: {},
				planHash: "a".repeat(64),
				waves: [{ index: 0, steps }],
				budget: { ceilingUsd: 0, currentUsd: 0, contractUsd: null },
				plan: { steps },
			} as unknown as FleetRunPreview,
		});
		ok(result.status === "ready");
		strictEqual(result.waves[0]?.steps[0]?.[field]?.length, 16);
		strictEqual(result.truncated, true, `${field} must not look complete after it was shortened`);
	}
});

test("shortening one fleet argument or write path marks the approval preview as incomplete", () => {
	for (const field of ["argv", "writes"] as const) {
		for (const text of ["x".repeat(512), "x".repeat(513), "λ".repeat(257)]) {
			const steps = [{ stepId: "check", kind: "code", scope: "readonly", writes: [], [field]: [text] }];
			const result = projectFleetPreview({
				ok: true,
				preview: {
					name: "bounded",
					vars: {},
					planHash: "a".repeat(64),
					waves: [{ index: 0, steps }],
					budget: { ceilingUsd: 0, currentUsd: 0, contractUsd: null },
					plan: { steps },
				} as unknown as FleetRunPreview,
			});
			ok(result.status === "ready");
			const projected = result.waves[0]?.steps[0]?.[field]?.[0];
			ok(projected !== undefined);
			ok(Buffer.byteLength(projected) <= 512);
			strictEqual(result.truncated, projected !== text, `${field} must disclose text shortened at the byte bound`);
		}
	}
});

test("a fleet run that fails before its first step says so instead of reading as started", async () => {
	const agent = await peer();
	try {
		const base = { sessionId: agent.sessionId, name: "survey", vars: { site: "plot-7" } };
		const preview = (await agent.call("_clio-coder/fleet/preview", base)) as Extract<
			AcpFleetPreview,
			{ status: "ready" }
		>;
		agent.state.refuseAtAdmission = "dispatch: agent 'verifier' cannot write to the workspace\u0007";
		const failed = await agent.call("_clio-coder/fleet/run", { ...base, planHash: preview.planHash });
		deepStrictEqual(failed, {
			status: "failed",
			name: "survey",
			planHash: preview.planHash,
			fleetRootId: "fleet-0123456789ab",
			reason: "dispatch: agent 'verifier' cannot write to the workspace ",
		});
	} finally {
		await agent.stop();
	}
});
