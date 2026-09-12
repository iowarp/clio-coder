import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { selectWorkerContext } from "../../src/domains/context/worker/select.js";
import { captureWorkerContext } from "../../src/domains/context/worker/snapshot.js";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createProvidersBundle } from "../../src/domains/providers/extension.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { startWorkerRun } from "../../src/engine/worker-runtime.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { resolvedDispatchPlanFromArgs } from "../../src/tools/dispatch-plan.js";
import { parseWorkerSpec } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const mode of ["isolated", "fork", "splice"] as const) {
	test(`production dispatch and native HTTP worker deliver ${mode} context exactly once`, async () => {
		const env = await isolateClioEnv("clio-coder-worker-context-dispatch-");
		const parent: AgentMessage[] = [{ role: "user", content: "PARENT_CONSTRAINT_42", timestamp: 1 }];
		let captures = 0;
		const fixture = await startGatewayThinkingFixture("lm-studio", "zbook/ornith-1.5-35b-a3b", async () => {
			parent.push({ role: "user", content: "LATER_PARENT_TURN", timestamp: 2 });
		});
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [{ id: "worker", runtime: "litellm", url: fixture.url, defaultModel: fixture.modelId }];
		settings.fleet.default.target = "worker";
		settings.fleet.default.model = fixture.modelId;
		const context = dispatchStubContext({ settings });
		const providers = createProvidersBundle(context);
		const target = settings.targets[0];
		ok(target);
		providers.contract.auth.setRuntimeOverrideForTarget(target, litellm, "fixture");
		const specs: WorkerSpec[] = [];
		const bundle = makeDispatchBundle(
			{
				bus: context.bus,
				getContract: ((name: string) =>
					name === "providers" ? providers.contract : context.getContract(name)) as typeof context.getContract,
			},
			{
				spawnWorker(spec) {
					specs.push(spec);
					throw new Error("captured context worker");
				},
			},
		);
		try {
			await providers.extension.start();
			await bundle.extension.start();
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
				getAutonomy: () => "full-auto",
				captureWorkerContext: () => {
					captures++;
					return captureWorkerContext({ sessionId: "parent", leafTurnId: "leaf", cwd: env.dir }, parent);
				},
			});
			ok(tool.prepareAdmissionArguments);
			const args = tool.prepareAdmissionArguments({
				agent: "researcher",
				task: "Compute 17 times 19.",
				context: { mode },
				target: "worker",
				cwd: env.dir,
			});
			const outcome = await tool.run(args, {});
			equal(outcome.kind, "error");
			match(JSON.stringify(outcome), /captured context worker/);
			equal(captures, mode === "isolated" ? 0 : 1);
			equal(capacityLeaseUsage().global, 0);
			const spec = specs[0];
			ok(spec);
			deepStrictEqual(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).contextSeed, spec.contextSeed);
			const input = { ...spec, runtime: litellm, cwd: env.dir };
			// Test the production context path independently of the recipe's report schema.
			delete input.resultContract;
			const events: unknown[] = [];
			const result = await startWorkerRun(input, (event) => events.push(event)).promise;
			equal(result.exitCode, 0);
			equal(fixture.requests.length, 1);
			const request = JSON.stringify(fixture.requests[0]);
			equal(request.split("PARENT_CONSTRAINT_42").length - 1, mode === "isolated" ? 0 : 1);
			ok(!request.includes("LATER_PARENT_TURN"));
			if (mode === "fork")
				ok(
					!JSON.stringify(events).includes("PARENT_CONSTRAINT_42"),
					"inherited history must not emit as new worker events",
				);
			if (mode === "fork") ok(!JSON.stringify(result.messages).includes("PARENT_CONSTRAINT_42"));
			if (mode === "fork") {
				const reviewed = tool.prepareAdmissionArguments({
					agent: "researcher",
					task: "Inspect the result.",
					context: { mode },
					review: { reviewer: "oracle" },
					cwd: env.dir,
				});
				const plan = resolvedDispatchPlanFromArgs(reviewed);
				ok(plan, JSON.stringify(reviewed));
				ok(plan.tasks.some((task) => task.role === "builder" && task.workerContext?.mode === "fork"));
				ok(
					plan.tasks.some(
						(task) => task.role === "reviewer" && task.workerContext === undefined && task.context === undefined,
					),
				);
				tool.disposeAdmissionArguments?.(reviewed);
				const tooLarge = selectWorkerContext(
					captureWorkerContext({ sessionId: "p", leafTurnId: null, cwd: env.dir }, [
						{ role: "user", content: "large ".repeat(5000), timestamp: 1 },
					]),
					{ mode: "fork" },
				);
				const exhausted: unknown[] = [];
				ok(input.runtimeResolution);
				const failed = await startWorkerRun(
					{
						...input,
						contextSeed: tooLarge,
						runtimeResolution: {
							...input.runtimeResolution,
							capabilities: { ...input.runtimeResolution.capabilities, contextWindow: 1000 },
						},
					},
					(event) => exhausted.push(event),
				).promise;
				equal(failed.exitCode, 1);
				match(JSON.stringify(exhausted), /worker_context_exhausted/);
				equal(fixture.requests.length, 1, "oversize context fails before a provider call");
				ok(isDeterministicOutcomeCode("worker_context_exhausted"));
				throws(() => parseWorkerSpec({ ...spec, specVersion: 3 }), /unsupported/);
			}
		} finally {
			await bundle.extension.stop?.();
			await providers.extension.stop?.();
			await fixture.close();
			env.restore();
		}
	});
}

test("ACP receives one portable splice, seals its context provenance, and refuses native fork", async () => {
	const env = await isolateClioEnv("clio-coder-acp-worker-context-");
	const peer = `
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:"2.0", ...message}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
 const r = JSON.parse(line);
 if(r.method === "initialize") send({id:r.id,result:{protocolVersion:1}});
 if(r.method === "session/new") send({id:r.id,result:{sessionId:"fixture"}});
 if(r.method === "session/prompt") {
  const count = JSON.stringify(r.params).split("ACP_PARENT_EVIDENCE").length - 1;
  send({method:"session/update", params:{sessionId:"fixture",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Inherited occurrences: " + count}}}});
  send({id:r.id,result:{stopReason:"end_turn"}});
 }
});`;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "full-auto";
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{ id: "context-fixture", command: process.execPath, args: ["-e", peer], toolGovernance: "clio-coder-policy" },
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	try {
		await bundle.extension.start();
		const snapshot = captureWorkerContext({ sessionId: "parent", leafTurnId: "leaf", cwd: env.dir }, [
			{ role: "user", content: "ACP_PARENT_EVIDENCE", timestamp: 1 },
		]);
		const seed = selectWorkerContext(snapshot, { mode: "splice" });
		const request = {
			agentId: "context-fixture",
			task: "Count inherited evidence.",
			context: { mode: "splice" as const },
			contextSeed: seed,
			executionRole: "researcher" as const,
			requestOrigin: "internal" as const,
			budget: { toolCalls: 1000, readReserve: 10 },
		};
		const run = await bundle.contract.dispatch(request);
		const receipt = await run.finalPromise;
		equal(receipt.outcome, "succeeded");
		match(JSON.stringify(receipt.output), /Inherited occurrences: 1/);
		deepStrictEqual(receipt.workerContext, seed.provenance);
		const envelope = bundle.contract.getRun(run.runId);
		ok(envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		await rejects(
			bundle.contract.dispatch({
				...request,
				context: { mode: "fork" },
				contextSeed: selectWorkerContext(snapshot, { mode: "fork" }),
			}),
			/fork requires a native Pi runtime/,
		);
		equal(capacityLeaseUsage().global, 0);
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});
