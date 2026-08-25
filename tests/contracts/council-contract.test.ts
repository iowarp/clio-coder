import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { parseCouncilReport, validateResultContract } from "../../src/domains/agents/result-contract.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { scriptedGateFabric } from "../harness/gate-fabric.js";

const TARGET = { id: "local", runtime: "openai", defaultModel: "model" };

function roster(members: unknown[]): unknown {
	return { targets: [TARGET], workers: { rosters: { design: { members } } } };
}

describe("council roster configuration", () => {
	it("accepts two to five unique members and rejects invalid roster fields", () => {
		const valid = validateSettings(
			roster([
				{ label: "alpha", target: "local", color: "accent" },
				{ label: "beta-2", target: "local", model: "m2", thinking: "high", color: "#12aBcD" },
			]),
		);
		deepStrictEqual(valid.issues, []);
		strictEqual(valid.settings.workers.rosters.design?.members.length, 2);

		for (const members of [
			[{ label: "alpha", target: "local" }],
			Array.from({ length: 6 }, (_, index) => ({ label: `member${index}`, target: "local" })),
		]) {
			ok(validateSettings(roster(members)).issues.some((issue) => issue.path.endsWith(".members")));
		}
		const malformed = validateSettings(
			roster([
				{ label: "same", target: "local", color: "chartreuse", extra: true },
				{ label: "same", target: "local" },
			]),
		);
		ok(malformed.issues.some((issue) => issue.message === "duplicate label"));
		ok(malformed.issues.some((issue) => issue.path.endsWith(".color")));
		ok(malformed.issues.some((issue) => issue.path.endsWith(".extra") && issue.message === "unknown key"));
	});
});

describe("council-report result contract", () => {
	const report = {
		members: [{ label: "alpha", runId: "run-1", round: 1, answer: "answer", verdict: "pass" }],
		synthesis: { kind: "vote", verdict: "pass", tally: { pass: 1 } },
	};

	it("validates the strict aggregate shape and rejects malformed members", () => {
		deepStrictEqual(parseCouncilReport(JSON.stringify(report)), report);
		strictEqual(
			validateResultContract({
				contract: { kind: "council-report" },
				output: JSON.stringify(report),
				cwd: process.cwd(),
				networkAllowed: false,
				filesystem: { readFile: () => null },
			}).conformance,
			"pass",
		);
		strictEqual(parseCouncilReport(JSON.stringify({ ...report, members: [{ label: "alpha" }] })), null);
	});
});

describe("council dispatch", () => {
	beforeEach(async () => isolateDispatchState());
	after(() => restoreDispatchState());

	it("runs read-only members, computes a vote, and binds roster and rounds into the plan hash", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [TARGET];
		settings.workers.default.target = "local";
		settings.workers.default.model = "model";
		settings.workers.rosters = {
			design: {
				members: [
					{ label: "alpha", target: "local" },
					{ label: "beta", target: "local" },
				],
			},
		};
		const fabric = scriptedGateFabric({ builderText: JSON.stringify({ verdict: "pass", answer: "supported" }) });
		const context = dispatchStubContext({ settings });
		const lifecycle: Array<{
			channel: string;
			runId: string;
			label: string | undefined;
			outcome?: string;
			origin?: string;
		}> = [];
		context.bus.on(BusChannels.DispatchEnqueued, (payload) => {
			lifecycle.push({ channel: "enqueued", runId: payload.runId, label: payload.council?.label });
		});
		context.bus.on(BusChannels.DispatchStarted, (payload) => {
			lifecycle.push({
				channel: "started",
				runId: payload.runId,
				label: payload.council?.label,
				origin: payload.requestOrigin,
			});
		});
		context.bus.on(BusChannels.DispatchCompleted, (payload) => {
			lifecycle.push({
				channel: "completed",
				runId: payload.runId,
				label: payload.council?.label,
				outcome: payload.outcome,
			});
		});
		const bundle = makeDispatchBundle(context, { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAgentSpecs: () => [],
				getWorkerRosters: () => settings.workers.rosters,
			});
			const run = tool.run;
			const prepare = tool.prepareAdmissionArguments;
			const describe = tool.describeDispatchPlan;
			ok(prepare && describe);
			const result = await run(
				{ mode: "council", task: "Assess the contract", roster: "design", synthesis: "vote" },
				{ approval: { requestId: "approval", requestedBy: "tester", actionClass: "dispatch" } },
			);
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			// A council with no agent named seats the read-only researcher, not
			// coder, whose write requirement the council profile cannot satisfy.
			for (const spawn of fabric.spawns) strictEqual(spawn.spec.agentId, "researcher");
			const council = result.details?.council as { synthesis: { verdict: string; tally: Record<string, number> } };
			strictEqual(council.synthesis.verdict, "pass");
			deepStrictEqual(council.synthesis.tally, { pass: 2 });
			const detailRuns = result.details?.runs as Array<{ runId: string; receiptIntegrity: { ok: boolean } }>;
			strictEqual(detailRuns.length, 3);
			const synthesisEnvelope = bundle.contract.getRun(detailRuns[2]?.runId ?? "");
			strictEqual(synthesisEnvelope?.gate?.role, "synthesis");
			strictEqual(synthesisEnvelope?.gate?.subjects?.length, 2);
			strictEqual(detailRuns[2]?.receiptIntegrity.ok, true);
			const synthesisPath = synthesisEnvelope?.receiptPath;
			if (synthesisPath === null || synthesisPath === undefined) throw new Error("synthesis receipt path missing");
			const synthesisReceipt = JSON.parse(readFileSync(synthesisPath, "utf8")) as RunReceipt;
			strictEqual(synthesisReceipt.intent, undefined);
			strictEqual(synthesisReceipt.identity, undefined);
			strictEqual(synthesisReceipt.hostVerification, undefined);
			strictEqual(synthesisReceipt.toolActivity, undefined);
			strictEqual(synthesisReceipt.routeDecision, undefined);
			deepStrictEqual(verifyReceiptIntegrity(synthesisReceipt, synthesisEnvelope), { ok: true });
			// The coordinator-sealed synthesis publishes the same lifecycle the
			// board and /share are built from, so the verdict is visible in the
			// session that asked for it.
			const synthesisRunId = detailRuns[2]?.runId;
			const memberStart = lifecycle.find((event) => event.channel === "started" && event.label === "alpha");
			ok(memberStart);
			deepStrictEqual(
				lifecycle.filter((event) => event.runId === synthesisRunId),
				[
					{ channel: "enqueued", runId: synthesisRunId, label: "synthesis" },
					// Filed under the council's own origin, never "internal": the
					// transcript worker fold opens entries for user and agent runs
					// only, and /share resolves run ids from that fold.
					{ channel: "started", runId: synthesisRunId, label: "synthesis", origin: memberStart?.origin },
					{ channel: "completed", runId: synthesisRunId, label: "synthesis", outcome: "succeeded" },
				],
			);
			strictEqual(synthesisReceipt.requestOrigin, memberStart?.origin);
			// The sealed text is the whole council-report, which is what /share
			// renders as the labelled member answers plus the synthesis line.
			const sealedReport = parseCouncilReport(
				synthesisReceipt.output?.state === "final" ? synthesisReceipt.output.text : null,
			);
			ok(sealedReport, "the synthesis receipt seals a parseable council-report");
			deepStrictEqual(
				sealedReport?.members.map((member) => member.label),
				["alpha", "beta"],
			);
			strictEqual(sealedReport?.synthesis.verdict, "pass");
			strictEqual(fabric.spawns.length, 2);
			for (const spawn of fabric.spawns) {
				strictEqual(spawn.spec.autonomy, "read-only");
				strictEqual(spawn.spec.toolProfile, "council-read-only");
			}

			const view = (args: Record<string, unknown>) => {
				const prepared = prepare(args);
				return describe(prepared);
			};
			const base = view({ mode: "council", task: "Assess", members: settings.workers.rosters.design?.members, rounds: 1 });
			const changedRounds = view({
				mode: "council",
				task: "Assess",
				members: settings.workers.rosters.design?.members,
				rounds: 2,
			});
			const changedRoster = view({
				mode: "council",
				task: "Assess",
				members: [
					{ label: "gamma", target: "local" },
					{ label: "beta", target: "local" },
				],
				rounds: 1,
			});
			notStrictEqual(base.hash, changedRounds.hash);
			notStrictEqual(base.hash, changedRoster.hash);
			match(result.output, /\[alpha\] local\/model/);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("returns typed request refusals", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: scriptedGateFabric({}).spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAgentSpecs: () => [],
				getWorkerRosters: () => ({}),
			});
			const run = tool.run;
			ok(run);
			for (const [args, reason] of [
				[{ mode: "council", task: "x", roster: "missing" }, "council_roster_unknown"],
				[{ mode: "council", task: "x", members: [{ label: "one", target: "default" }] }, "council_members_out_of_range"],
				[
					{
						mode: "council",
						task: "x",
						members: [
							{ label: "one", target: "default" },
							{ label: "one", target: "default" },
						],
					},
					"council_member_label_duplicate",
				],
				[
					{
						mode: "council",
						task: "x",
						members: [
							{ label: "one", target: "missing" },
							{ label: "two", target: "default" },
						],
					},
					"council_member_target_unknown",
				],
				[
					{
						mode: "council",
						task: "x",
						members: [
							{ label: "one", target: "default" },
							{ label: "two", target: "default" },
						],
						synthesis: "vote",
						judge: { model: "m" },
					},
					"council_synthesis_requires_judge_settings",
				],
			] as const) {
				const result = await run(args as Record<string, unknown>);
				strictEqual(result.kind, "error");
				match(result.kind === "error" ? result.message : "", new RegExp(reason));
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("refuses a council member placed on an SSH fleet node before approval", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "default", runtime: "openai", defaultModel: "model" },
			{ id: "remote-target", runtime: "openai", defaultModel: "model" },
		];
		settings.workers.default.target = "default";
		settings.workers.default.model = "model";
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: scriptedGateFabric({}).spawn,
			previewNode: (request) =>
				request.target === "remote-target"
					? { node: { id: "blade", kind: "ssh", host: "blade.example.test" } }
					: { node: { id: "local", kind: "local" } },
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAgentSpecs: () => [] });
			const result = await tool.run({
				mode: "council",
				task: "inspect placement",
				members: [
					{ label: "remote", target: "remote-target" },
					{ label: "local", target: "default" },
				],
			});
			strictEqual(result.kind, "error");
			match(result.kind === "error" ? result.message : "", /council_member_remote_node: remote/);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("labels only the other members' bounded prior answers in round two", async () => {
		const specs: WorkerSpec[] = [];
		const answers = ["alpha-answer", "beta-answer", "alpha-final", "beta-final"];
		const spawnWorker = (spec: WorkerSpec): SpawnedWorker => {
			specs.push(spec);
			const spawnIndex = specs.length;
			const text = answers[spawnIndex - 1] ?? "final";
			return {
				pid: 900 + spawnIndex,
				promise: Promise.resolve({ exitCode: spawnIndex === 1 ? 1 : 0, signal: null }),
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
				})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			};
		};
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), { spawnWorker });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAgentSpecs: () => [] });
			const result = await tool.run(
				{
					mode: "council",
					task: "compare",
					members: [
						{ label: "alpha", target: "default" },
						{ label: "beta", target: "default" },
					],
					rounds: 2,
				},
				{ approval: { requestId: "rounds", requestedBy: "tester", actionClass: "dispatch" } },
			);
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const council = result.details?.council as {
				members: Array<{ label: string; round: number; failed?: { reason: string } }>;
			};
			ok(council.members.some((member) => member.label === "alpha" && member.round === 1 && member.failed !== undefined));
			const alphaBriefing =
				specs[2]?.dynamicPromptMessages?.find((message) => message.id === "dispatch-briefing")?.body ?? "";
			const betaBriefing =
				specs[3]?.dynamicPromptMessages?.find((message) => message.id === "dispatch-briefing")?.body ?? "";
			match(alphaBriefing, /\[beta\] beta-answer/);
			ok(!alphaBriefing.includes("[alpha] alpha-answer"));
			match(betaBriefing, /\[alpha\] failed in prior round; no answer contributed\./);
			ok(!betaBriefing.includes("[beta] beta-answer"));
			ok(Buffer.byteLength(alphaBriefing, "utf8") < 9 * 1024);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("seals a judge receipt that references every final member", async () => {
		const fabric = scriptedGateFabric({ builderText: JSON.stringify({ verdict: "pass", text: "synthesized" }) });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAgentSpecs: () => [] });
			const result = await tool.run(
				{
					mode: "council",
					task: "judge",
					members: [
						{ label: "alpha", target: "default" },
						{ label: "beta", target: "default" },
					],
					synthesis: "judge",
				},
				{ approval: { requestId: "judge", requestedBy: "tester", actionClass: "dispatch" } },
			);
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const council = result.details?.council as { synthesis: { text: string; judgeRunId: string } };
			strictEqual(council.synthesis.text, "synthesized");
			const judge = bundle.contract.getRun(council.synthesis.judgeRunId);
			strictEqual(judge?.gate?.role, "synthesis");
			strictEqual(judge?.gate?.subjects?.length, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
