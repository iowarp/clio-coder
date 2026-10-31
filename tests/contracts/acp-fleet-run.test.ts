import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { Playbook } from "../../src/domains/agents/index.js";
import { cancelStoredAssignment, registerAssignment } from "../../src/domains/dispatch/assignment-store.js";
import type { ExecutionStepResult } from "../../src/domains/dispatch/execution-scheduler.js";
import {
	agentRoleFactsResolver,
	compileFleetRunPreview,
	type FleetRunPreview,
} from "../../src/domains/dispatch/index.js";
import type { FleetRunRecord } from "../../src/domains/dispatch/state.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import {
	ACP_FLEET_MAX_STEPS,
	type AcpFleetControl,
	type AcpFleetPreview,
	projectFleetPreview,
} from "../../src/engine/acp/fleet-run.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { AcpFleetPreviewSchema } from "../../src/engine/acp/types.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function playbook(root: string, stepIds: string[], agent = "coder"): Playbook {
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
	} as Playbook;
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
					const fleet = playbook(root, state.steps, state.agent);
					if (state.command === null) return { commands: null, playbook: fleet };
					return {
						playbook: {
							...fleet,
							steps: [...fleet.steps, { kind: "code", id: "check", command: "test", scope: "readonly", dependencies: [] }],
						} as Playbook,
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
				load: () => ({ commands: null, playbook: playbook(root, ["survey"]) }),
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
					playbook: {
						...playbook(root, []),
						steps: [
							{ kind: "code", id: "check", command: "test", scope: "readonly", dependencies: [], ...(args ? { args } : {}) },
						],
					} as Playbook,
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

test("a resume id compiles the replayed prefix into every surface's approval", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-resume-preview-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract<AgentsContract>("agents");
		ok(agents);
		const records = new Map<string, FleetRunRecord>();
		const compile = (vars: Record<string, string>, resume?: string) =>
			compileFleetRunPreview({
				workspaceRoot: root,
				name: "survey",
				vars,
				getAgentSpec: (id) => agents.getSpec(id),
				roleFacts: agentRoleFactsResolver((id) => agents.getSpec(id)),
				load: () => ({ commands: null, playbook: playbook(root, ["survey", "report"]) }),
				...(resume !== undefined ? { resume } : {}),
				readRun: (id) => records.get(id) ?? null,
			});
		const fresh = compile({ site: "plot-7" });
		ok(fresh.ok);
		records.set("fleet-0123456789ab", {
			version: 1,
			id: "fleet-0123456789ab",
			cwd: root,
			fleet: "survey",
			planHash: fresh.preview.plan.hash,
			stepIds: fresh.preview.plan.steps.map((step) => step.id),
			planSteps: [...fresh.preview.plan.steps],
			vars: { site: "plot-7" },
			startedAt: "2026-10-01T00:00:00.000Z",
			endedAt: "2026-10-01T00:01:00.000Z",
			resumedFrom: null,
			steps: [
				{
					stepId: "survey",
					result: { succeeded: true, integrityValid: true, terminalRunId: "r1", runDigest: "d1" } as ExecutionStepResult,
				},
			],
		});
		const resumed = compile({ site: "plot-7" }, "fleet-0123456789ab");
		ok(resumed.ok, JSON.stringify(resumed));
		deepStrictEqual([...(resumed.preview.resume?.replayed.keys() ?? [])], ["survey"]);
		const steps = resumed.preview.waves.flatMap((wave) => wave.steps);
		deepStrictEqual(
			steps.map((step) => [step.stepId, step.replayed === true]),
			[
				["survey", true],
				["report", false],
			],
		);
		notStrictEqual(resumed.preview.planHash, fresh.preview.planHash, "approving a resume is not approving a fresh run");
		const projected = projectFleetPreview(resumed);
		ok(projected.status === "ready");
		deepStrictEqual(projected.resume, { fromRunId: "fleet-0123456789ab", replayed: ["survey"] });
		ok(Value.Check(AcpFleetPreviewSchema, projected), "the wire schema carries the replayed prefix");
		const drifted = compile({ site: "plot-8" }, "fleet-0123456789ab");
		ok(!drifted.ok);
		deepStrictEqual(drifted.diagnostics, ["resume run 'fleet-0123456789ab' used different --var values"]);
		const missing = compile({ site: "plot-7" }, "fleet-ffffffffffff");
		ok(!missing.ok);
		deepStrictEqual(missing.diagnostics, ["resume run 'fleet-ffffffffffff' was not found in the durable fleet ledger"]);
		deepStrictEqual(parseSlashCommand("/fleet run survey --var site=plot-7 --resume fleet-0123456789ab"), {
			kind: "fleet-run",
			name: "survey",
			vars: { site: "plot-7" },
			resume: "fleet-0123456789ab",
		});
	} finally {
		scratch.restore();
	}
});

test("a resume refuses a root another workspace launched", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-resume-workspace-");
	try {
		const root = realpathSync(scratch.dir);
		const other = join(root, "other-project");
		mkdirSync(other);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract<AgentsContract>("agents");
		ok(agents);
		const records = new Map<string, FleetRunRecord>();
		const compile = (workspaceRoot: string, resume?: string) =>
			compileFleetRunPreview({
				workspaceRoot,
				name: "survey",
				vars: { site: "plot-7" },
				getAgentSpec: (id) => agents.getSpec(id),
				roleFacts: agentRoleFactsResolver((id) => agents.getSpec(id)),
				load: () => ({ commands: null, playbook: playbook(workspaceRoot, ["survey", "report"]) }),
				...(resume !== undefined ? { resume } : {}),
				readRun: (id) => records.get(id) ?? null,
			});
		const fresh = compile(other);
		ok(fresh.ok);
		const prior = (id: string, cwd?: string): FleetRunRecord => ({
			version: 1,
			id,
			...(cwd !== undefined ? { cwd } : {}),
			fleet: "survey",
			planHash: fresh.preview.plan.hash,
			stepIds: fresh.preview.plan.steps.map((step) => step.id),
			planSteps: [...fresh.preview.plan.steps],
			vars: { site: "plot-7" },
			startedAt: "2026-10-01T00:00:00.000Z",
			endedAt: "2026-10-01T00:01:00.000Z",
			resumedFrom: null,
			steps: [],
		});
		records.set("fleet-aaaaaaaaaaaa", prior("fleet-aaaaaaaaaaaa", other));
		records.set("fleet-bbbbbbbbbbbb", prior("fleet-bbbbbbbbbbbb"));
		const foreign = compile(root, "fleet-aaaaaaaaaaaa");
		ok(!foreign.ok);
		deepStrictEqual(foreign.diagnostics, [`resume run 'fleet-aaaaaaaaaaaa' ran in ${other}, not ${root}`]);
		const legacy = compile(root, "fleet-bbbbbbbbbbbb");
		ok(!legacy.ok);
		deepStrictEqual(legacy.diagnostics, [
			`resume run 'fleet-bbbbbbbbbbbb' predates recorded workspaces, so it cannot be resumed in ${root}`,
		]);
		ok(compile(other, "fleet-aaaaaaaaaaaa").ok, "the launching workspace still resumes it");
	} finally {
		scratch.restore();
	}
});

test("a resume refuses a root whose process still runs it", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-resume-running-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract<AgentsContract>("agents");
		ok(agents);
		const records = new Map<string, FleetRunRecord>();
		const compile = (resume?: string) =>
			compileFleetRunPreview({
				workspaceRoot: root,
				name: "survey",
				vars: { site: "plot-7" },
				getAgentSpec: (id) => agents.getSpec(id),
				roleFacts: agentRoleFactsResolver((id) => agents.getSpec(id)),
				load: () => ({ commands: null, playbook: playbook(root, ["survey", "report"]) }),
				...(resume !== undefined ? { resume } : {}),
				readRun: (id) => records.get(id) ?? null,
			});
		const fresh = compile();
		ok(fresh.ok);
		// endedAt stays null in both phases: a crashed root never stamps it either.
		records.set("fleet-cccccccccccc", {
			version: 1,
			id: "fleet-cccccccccccc",
			cwd: root,
			fleet: "survey",
			planHash: fresh.preview.plan.hash,
			stepIds: fresh.preview.plan.steps.map((step) => step.id),
			planSteps: [...fresh.preview.plan.steps],
			vars: { site: "plot-7" },
			startedAt: "2026-10-01T00:00:00.000Z",
			endedAt: null,
			resumedFrom: null,
			steps: [],
		});
		await registerAssignment("fleet-cccccccccccc");
		const running = compile("fleet-cccccccccccc");
		ok(!running.ok);
		deepStrictEqual(running.diagnostics, [
			`resume run 'fleet-cccccccccccc' is still running in process ${process.pid}; wait for it to settle or cancel it first`,
		]);
		await cancelStoredAssignment("fleet-cccccccccccc");
		ok(compile("fleet-cccccccccccc").ok, "a settled root resumes");
	} finally {
		scratch.restore();
	}
});

test("fleet preview compiles the playbook, announces its hash, and dispatches nothing", async () => {
	const agent = await peer();
	try {
		deepStrictEqual((agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta["clio-coder/fleet"], {
			version: 1,
			preview: "_clio-coder/fleet/preview",
			run: "_clio-coder/fleet/run",
			runResultFacts: true,
			resume: true,
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
		budget: { ceilingUsd: 0, currentUsd: 0, playbookUsd: null },
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
				budget: { ceilingUsd: 0, currentUsd: 0, playbookUsd: null },
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
					budget: { ceilingUsd: 0, currentUsd: 0, playbookUsd: null },
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
