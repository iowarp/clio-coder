import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createProvidersBundle } from "../../src/domains/providers/extension.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { startWorkerRun } from "../../src/engine/worker-runtime.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function setup(beforeMetadata?: () => Promise<void>) {
	const env = await isolateClioEnv("clio-dispatch-thinking-");
	const fixture = await startGatewayThinkingFixture("lm-studio", "zbook/ornith-1.5-35b-a3b", beforeMetadata);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "worker", runtime: "litellm", url: fixture.url, defaultModel: fixture.modelId },
		{ id: "chat", runtime: "litellm", url: fixture.url, defaultModel: "dynamo/qwen3.8-27b" },
	];
	settings.fleet.default.target = "worker";
	settings.fleet.default.model = fixture.modelId;
	const context = dispatchStubContext({ settings });
	const providers = createProvidersBundle(context);
	for (const target of settings.targets) providers.contract.auth.setRuntimeOverrideForTarget(target, litellm, "fixture");
	await providers.extension.start();
	const specs: WorkerSpec[] = [];
	const probes: Array<ReturnType<typeof providers.contract.probeTarget>> = [];
	const workerProviders = {
		...providers.contract,
		probeTarget: (...args: Parameters<typeof providers.contract.probeTarget>) => {
			const probe = providers.contract.probeTarget(...args);
			probes.push(probe);
			return probe;
		},
	};
	const dispatch = makeDispatchBundle(
		{
			bus: context.bus,
			getContract: ((name: string) =>
				name === "providers" ? workerProviders : context.getContract(name)) as typeof context.getContract,
		},
		{
			spawnWorker: (spec) => {
				specs.push(spec);
				throw new Error("fixture captured worker launch");
			},
		},
	);
	await dispatch.extension.start();
	const owners: string[] = [];
	const reservations = dispatch.contract.reservations;
	ok(reservations);
	const tool = createDispatchTool({
		dispatch: {
			...dispatch.contract,
			reservations: {
				...reservations,
				prepare: (input) => {
					const record = reservations.prepare(input);
					owners.push(record.ownerId);
					return record;
				},
			},
		},
		getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
		getAutonomy: () => "full-auto",
	});
	return {
		env,
		fixture,
		settings,
		providers: providers.contract,
		dispatch: dispatch.contract,
		specs,
		probes,
		tool,
		owners,
		args: {
			agent: "oracle",
			tasks: ["Compute 17 times 19.", "Check the computed result."],
			mode: "sequential",
			target: "worker",
			model: fixture.modelId,
			cwd: env.dir,
		},
		request: {
			agentId: "oracle",
			executionRole: "researcher" as const,
			task: "Compute 17 times 19.",
			target: "worker",
			model: fixture.modelId,
			thinkingLevel: "off" as const,
			cwd: env.dir,
		},
		close: async () => {
			await dispatch.extension.stop?.();
			await providers.extension.stop?.();
			await fixture.close();
			env.restore();
		},
	};
}

test("cold worker freezes discovered gateway controls before the actual engine request", async () => {
	const f = await setup();
	try {
		strictEqual(f.providers.list()[0]?.health.lastCheckAt, null);
		await rejects(f.dispatch.dispatch(f.request), /fixture captured worker launch/u);
		const spec = f.specs[0];
		ok(spec);
		strictEqual(f.fixture.paths.filter((path) => path === "/v1/model/info").length, 1);
		strictEqual(spec.target.id, "worker");
		strictEqual(spec.wireModelId, f.fixture.modelId);
		strictEqual(spec.thinkingLevel, "off");
		const input = { ...spec, runtime: litellm, cwd: f.env.dir };
		// The controlled spawn seam captures production admission's exact input;
		// run the real worker engine against the HTTP fixture without a recipe report.
		delete input.resultContract;
		const result = await startWorkerRun(input, () => {}).promise;
		strictEqual(result.exitCode, 0);
		ok(f.fixture.requests.length > 0, "the worker must actually request a completion");
		for (const request of f.fixture.requests) {
			strictEqual(request.model, f.fixture.modelId);
			strictEqual(request.reasoning_effort, "none");
			deepStrictEqual(request.allowed_openai_params, ["reasoning_effort"]);
		}
		strictEqual(f.providers.list()[1]?.health.lastCheckAt, null, "leave unrelated chat metadata cold");
		await rejects(f.dispatch.dispatch(f.request), /fixture captured worker launch/u);
		strictEqual(f.probes.length, 1, "the successful target metadata is reused by the next worker");
	} finally {
		await f.close();
	}
});

test("the approved tool route still admits after cold metadata and releases its captured launch reservation", async () => {
	const f = await setup();
	try {
		const result = await f.tool.run(f.args, {});
		strictEqual(result.kind, "error");
		ok("message" in result && /fixture captured worker launch/u.test(result.message), JSON.stringify(result));
		strictEqual(f.specs.length, 1, "approved cold route must reach the worker boundary");
		strictEqual(f.specs[0]?.thinkingLevel, "off");
		strictEqual(f.specs[0]?.target.id, "worker");
		strictEqual(f.probes.length, 1);
		strictEqual(f.owners.length, 1);
		strictEqual(f.dispatch.reservations?.get(f.owners[0] ?? "")?.status, "rolled_back");
		strictEqual(capacityLeaseUsage().global, 0);
	} finally {
		await f.close();
	}
});

for (const ending of ["cancelled", "deadline"] as const) {
	test(`tool ${ending} during cold metadata rolls back admission and forbids a late worker`, {
		timeout: 5000,
	}, async () => {
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = await setup(async () => {
			entered();
			await gate;
		});
		try {
			const controller = new AbortController();
			const pending = f.tool.run(
				{ ...f.args, timeout_ms: ending === "deadline" ? 250 : 2000 },
				{ signal: controller.signal },
			);
			await Promise.race([
				started,
				pending.then((result) => {
					throw new Error(`admission ended before metadata: ${JSON.stringify(result)}`);
				}),
			]);
			strictEqual(f.owners.length, 1);
			strictEqual(f.dispatch.reservations?.get(f.owners[0] ?? "")?.status, "active");
			if (ending === "cancelled") controller.abort(new Error("fixture operator cancellation"));
			const result = await pending;
			strictEqual(result.kind, "error");
			strictEqual(f.dispatch.reservations?.get(f.owners[0] ?? "")?.status, "rolled_back");
			release();
			await Promise.allSettled(f.probes);
			strictEqual(f.specs.length, 0);
			strictEqual(f.fixture.requests.length, 0);
			strictEqual(f.providers.list()[0]?.health.lastCheckAt, null, "cancelled metadata is not target-down evidence");
			strictEqual(capacityLeaseUsage().global, 0);
			await rejects(f.dispatch.dispatch(f.request), /fixture captured worker launch/u);
			strictEqual(f.specs.length, 1, "a fresh invocation can recover after the late body settles");
		} finally {
			release();
			await f.close();
		}
	});
}

test("a URL changed while metadata is pending cannot silently reroute the worker", async () => {
	let changeRoute = () => {};
	const f = await setup(async () => {
		changeRoute();
	});
	try {
		changeRoute = () => {
			const target = f.settings.targets[0];
			ok(target);
			target.url = `${f.fixture.url}/changed`;
		};
		await rejects(f.dispatch.dispatch(f.request), /worker route changed during model metadata preparation/u);
		strictEqual(f.specs.length, 0);
		strictEqual(f.fixture.requests.length, 0);
		strictEqual(capacityLeaseUsage().global, 0);
	} finally {
		await f.close();
	}
});
