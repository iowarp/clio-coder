import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { listCapacityLeases } from "../../src/domains/dispatch/capacity-lease.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { ROUTE_CANDIDATE_LIMIT } from "../../src/domains/dispatch/route-candidates.js";
import type { RunNodeIdentity, RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createPermissionOverlayBody } from "../../src/interactive/permission-overlay.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import {
	describeDispatchPlan,
	RESOLVED_DISPATCH_PLAN_ARGUMENT,
	resolvedDispatchPlanFromArgs,
} from "../../src/tools/dispatch-plan.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

interface SpawnRecord {
	spec: WorkerSpec;
	cwd: string | undefined;
}

function successfulFabric(): {
	spawn: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker;
	spawns: SpawnRecord[];
} {
	const spawns: SpawnRecord[] = [];
	return {
		spawns,
		spawn(spec, opts) {
			spawns.push({ spec, cwd: opts?.cwd });
			return {
				pid: 900 + spawns.length,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				events: (async function* () {
					yield {
						type: "message_end",
						message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } },
					};
				})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			};
		},
	};
}

function remoteNode(id: string): RunNodeIdentity {
	return { id, kind: "ssh", host: `${id}.example.test` };
}

function baseSettings(): typeof DEFAULT_SETTINGS {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "primary", runtime: "openai", defaultModel: "base-model" }];
	settings.workers.default.target = "primary";
	settings.workers.default.model = "base-model";
	settings.fleet.nodes = [
		{ id: "blade", host: "blade.example.test", maxWorkers: 2 },
		{ id: "mini", host: "mini.example.test", maxWorkers: 2 },
	];
	return settings;
}

describe("resolved dispatch plan admission", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	afterEach(() => {
		restoreDispatchState();
	});

	it("sanitizes control bytes in typed plan fields before overlay rendering", () => {
		const plan = describeDispatchPlan({
			tasks: ["one"],
			[RESOLVED_DISPATCH_PLAN_ARGUMENT]: {
				version: 1,
				topology: "parallel",
				tasks: [
					{
						agent: "coder\nforged",
						task: "inspect\rthe repo\u001b[31m",
						target: "primary\u001b[2J",
						model: "model\u0000suffix",
						node: "blade\rforged",
						nodeKind: "ssh",
						nodeHost: "host\nforged",
						routingIntent: {
							posture: "balanced",
							maxCostUsd: null,
							deadlineMs: null,
							minimumQuality: null,
							requiredCapabilities: [],
							locality: "any",
							failover: "none",
						},
						failover: "none",
						role: "task",
						position: 1,
					},
				],
				costCeilingUsd: 5,
			},
		});
		strictEqual(plan.text.includes("\u001b"), false);
		strictEqual(plan.text.includes("\u0000"), false);
		strictEqual(plan.text.split("\n").length, 3, "embedded line breaks cannot forge plan rows");
		match(
			plan.text,
			/agent=coder\?forged target=primary\?\[2J model=model\?suffix node=blade\?forged kind=ssh host=host\?forged failover=none .* task="inspect\?the repo\?\[31m"/,
		);
	});

	it("binds the reviewed task into the artifact text and hash", () => {
		const first = describeDispatchPlan({ tasks: [{ agent: "scout", task: "map dispatch lifecycle" }] });
		const second = describeDispatchPlan({ tasks: [{ agent: "scout", task: "map worker guardrails" }] });
		match(first.text, /agent=scout .* task="map dispatch lifecycle"/);
		strictEqual(first.tasks[0]?.task, "map dispatch lifecycle");
		strictEqual(first.hash === second.hash, false, "changing only the approved task must change the plan hash");
	});

	it("distinguishes fallback envelopes cryptographically in the plan hash", () => {
		const resolvedTask = (extra: Record<string, unknown>) => ({
			tasks: ["route"],
			[RESOLVED_DISPATCH_PLAN_ARGUMENT]: {
				version: 1,
				topology: "parallel",
				tasks: [
					{
						agent: "coder",
						task: "route",
						target: "primary",
						model: "base-model",
						node: "blade",
						nodeKind: "ssh",
						nodeHost: "blade.example.test",
						role: "task",
						position: 1,
						routingIntent: {
							posture: "balanced",
							maxCostUsd: null,
							deadlineMs: null,
							minimumQuality: null,
							requiredCapabilities: [],
							locality: "any",
							failover: "none",
						},
						...extra,
					},
				],
				costCeilingUsd: 5,
			},
		});
		const c1 = { agentId: "coder", target: "primary", model: "base-model", node: "blade" };
		const c2 = { agentId: "coder", target: "primary", model: "base-model", node: "local" };

		const oneCandidate = describeDispatchPlan(resolvedTask({ failover: "approved", allowedCandidates: [c1] }));
		const twoCandidates = describeDispatchPlan(resolvedTask({ failover: "approved", allowedCandidates: [c1, c2] }));
		strictEqual(
			oneCandidate.hash === twoCandidates.hash,
			false,
			"changing only the allowed candidates must change the plan hash",
		);
		// Order is the approved preference and must be part of the hash.
		const reordered = describeDispatchPlan(resolvedTask({ failover: "approved", allowedCandidates: [c2, c1] }));
		strictEqual(twoCandidates.hash === reordered.hash, false, "candidate order is part of the approved envelope");
	});

	it("seals an approved envelope for an unpinned task and an exact pin for a pinned one", async () => {
		const settings = baseSettings();
		settings.targets = [
			{ id: "primary", runtime: "openai", defaultModel: "base-model" },
			{ id: "secondary", runtime: "openai", defaultModel: "base-model" },
		];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			previewNode: () => ({ node: { id: "local", kind: "local" } }),
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const unpinned = tool.prepareAdmissionArguments?.({ tasks: ["one", "two"] });
			ok(unpinned);
			const unpinnedTasks = resolvedDispatchPlanFromArgs(unpinned)?.tasks ?? [];
			ok(unpinnedTasks.length > 0);
			for (const task of unpinnedTasks) {
				strictEqual(task.failover, "approved", "an unpinned planned task seals a bounded envelope");
				ok(task.allowedCandidates && task.allowedCandidates.length > 0);
				ok(task.allowedCandidates.length <= ROUTE_CANDIDATE_LIMIT);
				// The resolved route is always the first approved candidate.
				strictEqual(task.allowedCandidates[0]?.target, task.target);
				strictEqual(task.allowedCandidates[0]?.node, task.node);
			}
			// Enumeration is deterministic, so the same request seals the same hash.
			const repeat = tool.prepareAdmissionArguments?.({ tasks: ["one", "two"] });
			ok(repeat);
			deepStrictEqual(resolvedDispatchPlanFromArgs(repeat)?.tasks, unpinnedTasks);

			const pinned = tool.prepareAdmissionArguments?.({ tasks: ["one", "two"], target: "primary" });
			ok(pinned);
			for (const task of resolvedDispatchPlanFromArgs(pinned)?.tasks ?? []) {
				strictEqual(task.failover, "none", "an explicit pin seals an exact route with no failover");
				strictEqual(task.allowedCandidates, undefined);
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("fails a plan-approved pipeline step over to an approved candidate and pipes its output on", async () => {
		const settings = baseSettings();
		settings.targets = [
			{ id: "primary", runtime: "openai", defaultModel: "base-model" },
			{ id: "secondary", runtime: "openai", defaultModel: "base-model" },
		];
		settings.workers.maxRetries = 1;
		settings.fleet.nodes = [];
		const spawns: Array<{ target: string; task: string; messages: string }> = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			previewNode: () => ({ node: { id: "local", kind: "local" } }),
			spawnWorker: (spec) => {
				spawns.push({
					target: spec.target.id,
					task: spec.task,
					messages: JSON.stringify(spec.dynamicPromptMessages ?? []),
				});
				// Only step 1's first attempt fails, so the pipeline's second step
				// proves it received the output of the failed-over first step.
				const failing = spawns.length === 1;
				return {
					pid: 950 + spawns.length,
					promise: Promise.resolve(
						failing
							? { exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" }
							: { exitCode: 0, signal: null },
					),
					events: (async function* () {
						if (failing) return;
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								content: `OUTPUT-OF(${spec.task})`,
								usage: { input: 1, output: 1 },
							},
						};
					})(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const args = tool.prepareAdmissionArguments?.({ tasks: ["step one", "step two"], mode: "pipeline" });
			ok(args);
			const planned = resolvedDispatchPlanFromArgs(args)?.tasks ?? [];
			strictEqual(planned.length, 2);
			strictEqual(planned[0]?.failover, "approved");
			ok(planned[0]?.allowedCandidates?.some((candidate) => candidate.target === "secondary"));

			const result = await tool.run(args, {});
			strictEqual(result.kind, "ok", JSON.stringify(result));
			// Step 1 failed over from primary to an approved candidate, and step 2
			// ran with step 1's successful output as its input data.
			deepStrictEqual(
				spawns.map((entry) => entry.target),
				["primary", "secondary", "primary"],
			);
			const stepTwo = spawns[2];
			ok(stepTwo);
			strictEqual(stepTwo.task, "step two");
			// Step 2's pipeline input is the terminal (failed-over) attempt's output,
			// not the failed first attempt's.
			ok(stepTwo.messages.includes("OUTPUT-OF(step one)"), `step two context was ${stepTwo.messages}`);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("binds briefing presence, bytes, hash, and a bounded preview into approval", () => {
		const first = describeDispatchPlan({ tasks: [{ task: "inspect", briefing: "Prior finding: src/a.ts:12" }] });
		const second = describeDispatchPlan({ tasks: [{ task: "inspect", briefing: "Different finding" }] });
		match(first.text, /briefing_bytes=26 briefing_sha256=[0-9a-f]{64} briefing_preview=/);
		strictEqual(first.tasks[0]?.briefing, "Prior finding: src/a.ts:12");
		strictEqual(first.hash === second.hash, false, "changing only briefing must change the approval hash");
	});

	it("shows, approves once, pins, executes, and receipts explicit/profile/automatic placements", async () => {
		for (const placementCase of ["explicit", "profile", "automatic"] as const) {
			const settings = baseSettings();
			if (placementCase === "explicit") {
				settings.workers.profiles.pinned = {
					target: "primary",
					model: "profile-model",
					thinkingLevel: "off",
					node: "mini",
				};
				settings.workers.agentBindings.coder = "pinned";
			}
			if (placementCase === "profile") {
				settings.workers.profiles.pinned = {
					target: "primary",
					model: "profile-model",
					thinkingLevel: "off",
					node: "mini",
				};
				settings.workers.agentBindings.coder = "pinned";
			}
			let automaticNode = "blade";
			const expectedNode = placementCase === "profile" ? "mini" : "blade";
			const expectedModel =
				placementCase === "profile" ? "profile-model" : placementCase === "explicit" ? "explicit-model" : "base-model";
			const fabric = successfulFabric();
			const placementRequests: string[] = [];
			const selectedNode = (request: { node?: string; agentId: string }): string => {
				if (request.node !== undefined) return request.node;
				const profile = settings.workers.agentBindings[request.agentId];
				return (profile ? settings.workers.profiles[profile]?.node : undefined) ?? automaticNode;
			};
			const resolveNode = (request: { node?: string; agentId: string }): DispatchNodePlacement => {
				const id = selectedNode(request);
				placementRequests.push(id);
				return { node: remoteNode(id), spawn: fabric.spawn };
			};
			const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
				spawnWorker: fabric.spawn,
				previewNode: (request) => ({ node: remoteNode(selectedNode(request)) }),
				resolveNode,
			});
			await bundle.extension.start();
			try {
				const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" });
				const registry = createRegistry({
					safety: createWorkerSafety({ cwd: process.cwd() }),
					autonomy: () => "auto-edit",
				});
				registry.register(tool);
				const asks: Array<{
					args: Record<string, unknown>;
					detail: string;
					short: string;
					requestId: string;
				}> = [];
				registry.onPermissionRequired((call, decision, meta) => {
					if (decision.kind !== "ask") return;
					asks.push({
						args: call.args ?? {},
						detail: decision.rejection.detail,
						short: decision.rejection.short,
						requestId: meta.requestId,
					});
				});
				const forged = {
					version: 1,
					topology: "parallel",
					tasks: [
						{
							agent: "attacker",
							target: "evil",
							model: "evil",
							node: "evil",
							nodeKind: "ssh",
							nodeHost: "evil.example.test",
							role: "task",
							position: 1,
						},
					],
					costCeilingUsd: 0.01,
				};
				const args: Record<string, unknown> = {
					task: "perform the approved task",
					briefing: "approved parent context",
					[RESOLVED_DISPATCH_PLAN_ARGUMENT]: forged,
					...(placementCase === "explicit" ? { target: "primary", model: "explicit-model", node: "blade" } : {}),
				};
				const pending = registry.invoke({ tool: ToolNames.Dispatch, args });
				await Promise.resolve();
				strictEqual(asks.length, 1, `${placementCase}: exactly one approval request`);
				strictEqual(fabric.spawns.length, 0, `${placementCase}: no launch before approval`);
				const ask = asks[0];
				ok(ask);
				const plan = describeDispatchPlan(ask.args);
				strictEqual(plan.planScale, true);
				strictEqual(plan.taskCount, 1);
				strictEqual(plan.tasks[0]?.agent, "coder");
				strictEqual(plan.tasks[0]?.task, "perform the approved task");
				strictEqual(plan.tasks[0]?.briefing, "approved parent context");
				strictEqual(plan.tasks[0]?.target, "primary");
				strictEqual(plan.tasks[0]?.model, expectedModel);
				strictEqual(plan.tasks[0]?.node, expectedNode);
				strictEqual(plan.tasks[0]?.nodeKind, "ssh");
				strictEqual(plan.tasks[0]?.nodeHost, `${expectedNode}.example.test`);
				strictEqual(plan.tasks[0]?.role, "task");
				strictEqual(plan.costCeilingUsd, 5);
				ok(!plan.text.includes("attacker") && !plan.text.includes("evil"), "caller-forged plan was overwritten");

				const overlay = createPermissionOverlayBody({
					requestId: ask.requestId,
					tool: ToolNames.Dispatch,
					actionClass: "dispatch",
					axis: { kind: "autonomy", level: "auto-edit" },
					origin: { kind: "main" },
					reason: ask.short,
					artifact: { kind: "dispatch-plan", text: ask.detail },
				})
					.render(120)
					.join("\n");
				const compactOverlay = overlay.replace(/\s+/gu, "");
				for (const line of plan.text.split("\n")) {
					for (const field of line.trim().split(/\s+/u)) {
						ok(overlay.includes(field) || compactOverlay.includes(field), `${placementCase}: missing overlay field ${field}`);
					}
				}

				if (placementCase === "automatic") {
					automaticNode = "mini";
					settings.workers.default.model = "drift-model";
				}
				// The resolved artifact is the approval authority. Even if the raw
				// argument object is changed while parked, execution restores the task
				// the operator actually reviewed.
				ask.args.tasks = ["substituted after approval"];
				ask.args.briefing = "substituted briefing after approval";
				const hidden = ask.args[RESOLVED_DISPATCH_PLAN_ARGUMENT] as {
					tasks: Array<{ briefing?: string }>;
				};
				const hiddenTask = hidden.tasks[0];
				ok(hiddenTask);
				strictEqual(Reflect.set(hiddenTask, "briefing", "nested artifact substitution after approval"), false);
				strictEqual(
					Reflect.set(ask.args, RESOLVED_DISPATCH_PLAN_ARGUMENT, {
						...hidden,
						tasks: [{ ...hiddenTask, briefing: "replacement artifact substitution after approval" }],
					}),
					false,
				);
				await registry.resumeParkedCalls({
					actionClass: "dispatch",
					requestId: ask.requestId,
					requestedBy: `integration:${placementCase}`,
				});
				const verdict = await pending;
				strictEqual(verdict.kind, "ok");
				if (verdict.kind !== "ok") throw new Error("dispatch did not execute");
				strictEqual(verdict.result.kind, "ok");
				strictEqual(asks.length, 1, `${placementCase}: one approval covers the complete plan`);
				strictEqual(fabric.spawns.length, 1);
				strictEqual(placementRequests[0], expectedNode, `${placementCase}: execution uses approved node pin`);
				const firstSpawn = fabric.spawns[0];
				ok(firstSpawn);
				strictEqual(firstSpawn.spec.target.id, "primary");
				strictEqual(firstSpawn.spec.wireModelId, expectedModel);
				strictEqual(firstSpawn.spec.task, "perform the approved task");
				const briefingMessage = (firstSpawn.spec.dynamicPromptMessages ?? []).find(
					(message) => message.id === "dispatch-briefing",
				);
				ok(briefingMessage?.body.includes("approved parent context"));
				strictEqual(briefingMessage?.body.includes("substituted briefing"), false);

				const runs = (verdict.result.details?.runs ?? []) as Array<{ runId: string }>;
				strictEqual(runs.length, 1);
				const envelope = bundle.contract.getRun(runs[0]?.runId ?? "");
				ok(envelope?.receiptPath);
				const receipt = JSON.parse(readFileSync(envelope?.receiptPath ?? "", "utf8")) as RunReceipt;
				strictEqual(receipt.node?.id, expectedNode);
				strictEqual(receipt.node?.host, `${expectedNode}.example.test`);
				strictEqual(receipt.targetId, "primary");
				strictEqual(receipt.wireModelId, expectedModel);
				deepStrictEqual(receipt.briefing, {
					bytes: Buffer.byteLength("approved parent context", "utf8"),
					contentHash: createHash("sha256").update("approved parent context", "utf8").digest("hex"),
				});
				strictEqual(receipt.plan?.hash, plan.hash);
				strictEqual(receipt.plan?.costCeilingUsd, plan.costCeilingUsd);
				strictEqual(receipt.plan?.approval, "operator");
				strictEqual(receipt.plan?.approvalRequestId, ask.requestId);
				strictEqual(receipt.plan?.approvalRequestedBy, `integration:${placementCase}`);
				if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
			} finally {
				await bundle.extension.stop?.();
			}
		}
	});

	it("keeps authenticated operator authority when autonomy changes while the plan is parked", async () => {
		let autonomy: "auto-edit" | "full-auto" = "auto-edit";
		const fabric = successfulFabric();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => autonomy });
			const registry = createRegistry({
				safety: createWorkerSafety({ cwd: process.cwd() }),
				autonomy: () => autonomy,
			});
			registry.register(tool);
			let requestId = "";
			registry.onPermissionRequired((_call, _decision, meta) => {
				requestId = meta.requestId;
			});
			const pending = registry.invoke({ tool: ToolNames.Dispatch, args: { tasks: ["one", "two"] } });
			await Promise.resolve();
			ok(requestId.length > 0);
			autonomy = "full-auto";
			await registry.resumeParkedCalls({ actionClass: "dispatch", requestId, requestedBy: "reload-operator" });
			const verdict = await pending;
			strictEqual(verdict.kind, "ok");
			if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error("approved plan did not execute");
			const runId = (verdict.result.details?.runs as Array<{ runId: string }>)[0]?.runId ?? "";
			const envelope = bundle.contract.getRun(runId);
			const receipt = JSON.parse(readFileSync(envelope?.receiptPath ?? "", "utf8")) as RunReceipt;
			strictEqual(receipt.plan?.approval, "operator");
			strictEqual(receipt.plan?.approvalRequestId, requestId);
			strictEqual(receipt.plan?.approvalRequestedBy, "reload-operator");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("fails closed when an approved cost ceiling or SSH host identity drifts before launch", async () => {
		for (const drift of ["ceiling", "host"] as const) {
			let ceilingUsd = 5;
			const settings = baseSettings();
			const fabric = successfulFabric();
			const context = dispatchStubContext({
				settings,
				scheduling: {
					ceilingUsd: () => ceilingUsd,
					preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd }),
				},
			});
			const hostForBlade = () => settings.fleet.nodes.find((node) => node.id === "blade")?.host ?? "missing";
			const bundle = makeDispatchBundle(context, {
				spawnWorker: fabric.spawn,
				previewNode: () => ({ node: { id: "blade", kind: "ssh", host: hostForBlade() } }),
				resolveNode: () => ({ node: { id: "blade", kind: "ssh", host: hostForBlade() }, spawn: fabric.spawn }),
			});
			await bundle.extension.start();
			try {
				const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" });
				const registry = createRegistry({
					safety: createWorkerSafety({ cwd: process.cwd() }),
					autonomy: () => "auto-edit",
				});
				registry.register(tool);
				let requestId = "";
				registry.onPermissionRequired((_call, _decision, meta) => {
					requestId = meta.requestId;
				});
				const pending = registry.invoke({ tool: ToolNames.Dispatch, args: { tasks: ["approved remote task"] } });
				await Promise.resolve();
				ok(requestId.length > 0);
				if (drift === "ceiling") ceilingUsd = 10;
				else {
					const blade = settings.fleet.nodes.find((node) => node.id === "blade");
					if (blade === undefined) throw new Error("blade fixture missing");
					blade.host = "repointed.example.test";
				}
				await registry.resumeParkedCalls({ actionClass: "dispatch", requestId, requestedBy: "drift-test" });
				const verdict = await pending;
				strictEqual(verdict.kind, "ok");
				if (verdict.kind !== "ok") throw new Error("registry did not execute approved plan");
				strictEqual(verdict.result.kind, "error");
				if (verdict.result.kind === "error") {
					match(verdict.result.message, drift === "ceiling" ? /cost ceiling drifted/ : /node identity drifted/);
				}
				strictEqual(fabric.spawns.length, 0, `${drift}: drift must fail before worker launch`);
				// Drift is caught before admission, so no capacity lease was taken.
				strictEqual(listCapacityLeases().length, 0);
			} finally {
				await bundle.extension.stop?.();
			}
		}
	});

	it("full-auto logs the same resolved artifact that headless supervised mode denies", async () => {
		const fabric = successfulFabric();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const args = { tasks: ["one", "two"] };
			const fullTool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const fullRegistry = createRegistry({
				safety: createWorkerSafety({ cwd: process.cwd() }),
				autonomy: () => "full-auto",
			});
			fullRegistry.register(fullTool);
			let fullAsks = 0;
			fullRegistry.onPermissionRequired(() => {
				fullAsks += 1;
			});
			const fullVerdict = await fullRegistry.invoke({ tool: ToolNames.Dispatch, args });
			strictEqual(fullVerdict.kind, "ok");
			strictEqual(fullAsks, 0);
			if (fullVerdict.kind !== "ok" || fullVerdict.result.kind !== "ok") throw new Error("full-auto dispatch failed");
			const fullRun = (fullVerdict.result.details?.runs as Array<{ runId: string }>)[0];
			const fullEnvelope = bundle.contract.getRun(fullRun?.runId ?? "");
			const fullReceipt = JSON.parse(readFileSync(fullEnvelope?.receiptPath ?? "", "utf8")) as RunReceipt;
			strictEqual(fullReceipt.plan?.approval, "full-auto");

			const headlessTool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" });
			const headlessRegistry = createRegistry({
				safety: createWorkerSafety({ cwd: process.cwd() }),
				autonomy: () => "auto-edit",
			});
			headlessRegistry.register(headlessTool);
			const capturedPlans: string[] = [];
			headlessRegistry.onPermissionRequired((call, _decision, meta) => {
				capturedPlans.push(describeDispatchPlan(call.args).hash);
				headlessRegistry.cancelParkedCall(meta.requestId, "headless mode cannot approve dispatch plans");
			});
			const launchesBeforeHeadless = fabric.spawns.length;
			const headlessVerdict = await headlessRegistry.invoke({ tool: ToolNames.Dispatch, args });
			strictEqual(headlessVerdict.kind, "blocked");
			strictEqual(capturedPlans.length, 1);
			strictEqual(capturedPlans[0], fullReceipt.plan?.hash);
			strictEqual(fabric.spawns.length, launchesBeforeHeadless, "headless denial launches no worker");
			if (headlessVerdict.kind === "blocked") match(headlessVerdict.reason, /headless mode cannot approve/);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
