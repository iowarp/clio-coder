import { deepStrictEqual, match, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import {
	COUNCIL_BALLOT_VERDICT_MAX_BYTES,
	parseCouncilReport,
	parseResultContract,
	parseWorkerResultContract,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { councilBallot, councilSynthesisReport, researchReport, scriptedGateFabric } from "../harness/gate-fabric.js";

const TARGET = { id: "local", runtime: "openai", defaultModel: "model" };

function roster(members: unknown[]): unknown {
	return { targets: [TARGET], workers: { rosters: { design: { members } } } };
}

/**
 * The stub fleet's `researcher` recipe is a permissive harness fixture: an
 * `external-delegation` contract and the `base` audience. Neither is what a
 * real council seats. `src/domains/agents/builtins/researcher.md` declares
 * `resultContract: {kind: research-report}` and `audience: shadow`, and both
 * facts are what the judge synthesis broke on: the contract it could never
 * satisfy, and the audience that refused its bounded gate-role prompt as a
 * persona override. A council test that means to exercise either has to run
 * the production recipe facts.
 */
function withBuiltinResearcherFacts(context: DomainContext): DomainContext {
	const agents = context.getContract<AgentsContract>("agents");
	if (agents === undefined) throw new Error("the dispatch stub context has no agents contract");
	const recipes = agents
		.list()
		.map((recipe) =>
			recipe.id === "researcher"
				? { ...recipe, audience: "shadow" as const, resultContract: { kind: "research-report" as const } }
				: recipe,
		);
	const faithful: AgentsContract = {
		...agents,
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
	};
	return {
		bus: context.bus,
		getContract: ((name: string) =>
			name === "agents" ? faithful : context.getContract(name)) as DomainContext["getContract"],
	};
}

/** The sealed receipt on disk, which is where the applied result contract is recorded. */
function sealedReceipt(envelope: { receiptPath?: string | null } | null): RunReceipt {
	const receiptPath = envelope?.receiptPath;
	if (receiptPath === null || receiptPath === undefined) throw new Error("run has no sealed receipt path");
	return JSON.parse(readFileSync(receiptPath, "utf8")) as RunReceipt;
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

describe("council-ballot result contract", () => {
	const validate = (output: string) =>
		validateResultContract({
			contract: { kind: "council-ballot" },
			output,
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => null },
		});

	it("admits a verdict the tally can match and refuses one it cannot", () => {
		strictEqual(validate(councilBallot("keep", "the tuple key survives a node rename")).conformance, "pass");
		// The researcher's own contract shape, which is what a council member
		// emitted before the ballot existed. It is not a ballot, and saying so is
		// the whole point: the vote no longer reads a field nobody asked for.
		strictEqual(validate(researchReport("the tuple key survives")).conformance, "fail");
		strictEqual(validate(JSON.stringify({ verdict: "keep", text: "why", source: "local" })).conformance, "fail");
		strictEqual(validate(JSON.stringify({ verdict: "keep" })).conformance, "fail");
		// A tally groups by the exact verdict string, so a verdict that is prose
		// can only ever tie with itself.
		strictEqual(validate(councilBallot("keep\nbecause", "why")).conformance, "fail");
		strictEqual(validate(councilBallot("k".repeat(COUNCIL_BALLOT_VERDICT_MAX_BYTES + 1), "why")).conformance, "fail");
		match(validate(researchReport("x")).reason ?? "", /verdict a single line of at most 64 bytes/);
	});

	it("cannot be declared by an agent recipe, but is readable where the worker validates its spec", () => {
		throws(() => parseResultContract({ kind: "council-ballot" }, "/test/agent.md"), /resultContract.kind is unsupported/);
		// The worker re-parses its own WorkerSpec.resultContract before any model
		// call. Sending it a kind only the recipe parser knows kills the run with
		// a fatal spec error, which is exactly what a live vote council did.
		deepStrictEqual(parseWorkerResultContract({ kind: "council-ballot" }, "WorkerSpec.resultContract"), {
			kind: "council-ballot",
		});
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
		const fabric = scriptedGateFabric({ builderText: councilBallot("pass", "supported") });
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

	/**
	 * One default council through `--synthesis vote` against the builtin
	 * researcher's real recipe facts, which is the shape #230 says can never
	 * tally. `withBuiltinResearcherFacts` restores the `research-report`
	 * contract and the `shadow` audience the harness stub drops; without it a
	 * council runs against a permissive `external-delegation` fixture and any
	 * answer at all passes, which is what hid the defect.
	 */
	const runVoteCouncil = async (
		ballots: string[],
		members: Array<{ label: string; target: string }>,
	): Promise<{
		result: Awaited<ReturnType<NonNullable<ReturnType<typeof createDispatchTool>["run"]>>>;
		council: { members: Array<{ label: string; runId: string; answer: string; verdict?: string; failed?: unknown }> } & {
			synthesis: { kind: string; verdict?: string; tally?: Record<string, number> };
		};
		spawns: ReadonlyArray<{ spec: WorkerSpec }>;
		getRun: (runId: string) => { receiptPath?: string | null } | null;
		stop: () => Promise<void>;
	}> => {
		const fabric = scriptedGateFabric({ memberAnswers: ballots });
		const bundle = makeDispatchBundle(withBuiltinResearcherFacts(dispatchStubContext()), {
			spawnWorker: fabric.spawn,
		});
		await bundle.extension.start();
		const tool = createDispatchTool({ dispatch: bundle.contract, getAgentSpecs: () => [] });
		const result = await tool.run(
			{ mode: "council", task: "Should the cache key stay a tuple?", members, synthesis: "vote" },
			{ approval: { requestId: "vote", requestedBy: "tester", actionClass: "dispatch" } },
		);
		return {
			result,
			council: result.details?.council as never,
			spawns: fabric.spawns,
			getRun: (runId) => bundle.contract.getRun(runId) ?? null,
			stop: async () => {
				await bundle.extension.stop?.();
			},
		};
	};

	const TWO_MEMBERS = [
		{ label: "alpha", target: "default" },
		{ label: "beta", target: "default" },
	];

	it("asks a default vote council's members for a ballot and tallies the verdicts they cast", async () => {
		const run = await runVoteCouncil(
			[
				councilBallot("keep", "the tuple key survives a node rename"),
				councilBallot("keep", "keying by node loses the failover case"),
			],
			TWO_MEMBERS,
		);
		try {
			strictEqual(run.result.kind, "ok", run.result.kind === "error" ? run.result.message : "");
			// The seated agent is unchanged: a council that names none still seats
			// the read-only builtin researcher, persona and all.
			for (const spawn of run.spawns) strictEqual(spawn.spec.agentId, "researcher");
			// What changed is the postcondition for this slot. The member is asked
			// for the ballot and seals the ballot, so the field the tally reads is
			// one the run was actually required to produce.
			for (const spawn of run.spawns) {
				deepStrictEqual(spawn.spec.resultContract, { kind: "council-ballot" });
				// The worker re-parses this field before its first model call, so a
				// spec the coordinator can send but the worker cannot read is a
				// fatal run rather than a vote.
				deepStrictEqual(parseWorkerResultContract(spawn.spec.resultContract, "WorkerSpec.resultContract"), {
					kind: "council-ballot",
				});
				match(spawn.spec.task, /^Should the cache key stay a tuple\?/);
				match(spawn.spec.task, /This council round is a vote/);
				match(spawn.spec.task, /End with a JSON object only: \{"verdict":"yes","text":/);
			}
			// The tally the ticket says no input could produce.
			strictEqual(run.council.synthesis.verdict, "keep");
			deepStrictEqual(run.council.synthesis.tally, { keep: 2 });
			// And it is validated rather than merely parsed: a member that sealed
			// no conforming ballot could not have contributed to it.
			for (const member of run.council.members) {
				const receipt = sealedReceipt(run.getRun(member.runId));
				strictEqual(receipt.quality?.resultContract?.conformance, "pass", member.label);
				strictEqual(receipt.quality?.resultContract?.sourceId?.includes("council-ballot"), true, member.label);
			}
			// The report carries the ballot's prose, not its wire envelope, so
			// /share and the council card read as answers rather than as JSON.
			deepStrictEqual(run.council.members.map((member) => member.answer).sort(), [
				"keying by node loses the failover case",
				"the tuple key survives a node rename",
			]);
		} finally {
			await run.stop();
		}
	});

	it("reports no_majority on a split vote and folds verdict case into one tally key", async () => {
		// "Keep" and "keep" are one verdict. Counting them apart would report a
		// split the council did not have.
		const run = await runVoteCouncil(
			[councilBallot("Keep", "the tuple key holds"), councilBallot("drop", "key by node")],
			TWO_MEMBERS,
		);
		try {
			strictEqual(run.result.kind, "ok", run.result.kind === "error" ? run.result.message : "");
			deepStrictEqual(run.council.synthesis.tally, { drop: 1, keep: 1 });
			strictEqual(run.council.synthesis.verdict, "no_majority");
			deepStrictEqual(run.council.members.map((member) => member.verdict).sort(), ["drop", "keep"]);
		} finally {
			await run.stop();
		}
	});

	it("fails a member that answers in its recipe's shape instead of dropping it from the tally", async () => {
		// The pre-#230 behaviour: the researcher emits the only thing its own
		// contract allowed, and the vote silently resolved to no_verdict_field
		// with an empty tally on every run. The member now fails its ballot and
		// the council says so.
		const run = await runVoteCouncil(
			[councilBallot("keep", "the tuple key holds"), researchReport("the tuple key survives a node rename")],
			TWO_MEMBERS,
		);
		try {
			strictEqual(run.result.kind, "error");
			const failed = run.council.members.filter((member) => member.failed !== undefined);
			strictEqual(failed.length, 1);
			const receipt = sealedReceipt(run.getRun(failed[0]?.runId ?? ""));
			strictEqual(receipt.outcome, "failed");
			strictEqual(receipt.outcomeCode, "result_contract_exhausted");
			strictEqual(receipt.quality?.resultContract?.conformance, "fail");
			match(receipt.outcomeDetail ?? "", /A council ballot must carry only verdict and text/);
		} finally {
			await run.stop();
		}
	});

	it("seals a judge receipt that references every final member and passes the applied contract", async () => {
		const fabric = scriptedGateFabric({
			builderText: researchReport("the tuple key survives a node rename"),
			synthesisAnswers: [councilSynthesisReport("pass", "synthesized")],
		});
		const bundle = makeDispatchBundle(withBuiltinResearcherFacts(dispatchStubContext()), {
			spawnWorker: fabric.spawn,
		});
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
			const council = result.details?.council as {
				members: Array<{ label: string; runId: string }>;
				synthesis: { kind: string; text: string; verdict?: string; judgeRunId: string };
			};
			strictEqual(council.synthesis.text, "synthesized");
			const judgeEnvelope = bundle.contract.getRun(council.synthesis.judgeRunId);
			strictEqual(judgeEnvelope?.gate?.role, "synthesis");
			strictEqual(judgeEnvelope?.gate?.subjects?.length, 2);
			// The members prove the sealed validation is live on this fleet: their
			// recipe contract was applied and passed. The judge answered the same
			// council with {"verdict","text"}, which is not a research-report, so
			// a run that seals green here is one the contract was not applied to.
			for (const member of council.members) {
				const memberReceipt = sealedReceipt(bundle.contract.getRun(member.runId));
				strictEqual(memberReceipt.quality?.resultContract?.conformance, "pass", member.label);
			}
			const judgeReceipt = sealedReceipt(judgeEnvelope);
			strictEqual(judgeReceipt.outcome, "succeeded", judgeReceipt.outcomeDetail ?? "");
			strictEqual(judgeReceipt.quality?.resultContract, null);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("seals the whole council report for a judge synthesis, as vote and none already do", async () => {
		const fabric = scriptedGateFabric({
			builderText: researchReport("keep the tuple key"),
			synthesisAnswers: [councilSynthesisReport("keep", "the members agree on the tuple key")],
		});
		const bundle = makeDispatchBundle(withBuiltinResearcherFacts(dispatchStubContext()), {
			spawnWorker: fabric.spawn,
		});
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
				{ approval: { requestId: "judge-seal", requestedBy: "tester", actionClass: "dispatch" } },
			);
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const council = result.details?.council as { synthesis: { judgeRunId: string } };
			const detailRuns = result.details?.runs as Array<{ runId: string }>;
			// Two members, the judge run, then the coordinator-sealed synthesis.
			strictEqual(detailRuns.length, 4);
			const sealedRunId = detailRuns[3]?.runId ?? "";
			notStrictEqual(sealedRunId, council.synthesis.judgeRunId);
			const sealedEnvelope = bundle.contract.getRun(sealedRunId);
			strictEqual(sealedEnvelope?.agentId, "council-synthesis");
			strictEqual(sealedEnvelope?.council?.label, "synthesis");
			strictEqual(sealedEnvelope?.gate?.subjects?.length, 2);
			const receipt = sealedReceipt(sealedEnvelope);
			strictEqual(receipt.outcome, "succeeded");
			deepStrictEqual(verifyReceiptIntegrity(receipt, sealedEnvelope), { ok: true });
			// This is what /share <synthesis runId> reads: the whole council-report,
			// so the main agent gets every final member's labelled answer and the
			// judge line rather than the judge's bare {"verdict","text"} payload.
			const report = parseCouncilReport(receipt.output?.state === "final" ? receipt.output.text : null);
			ok(report, "the judge synthesis receipt seals a parseable council-report");
			deepStrictEqual(
				report?.members.map((member) => member.label),
				["alpha", "beta"],
			);
			strictEqual(report?.synthesis.kind, "judge");
			strictEqual(report?.synthesis.text, "the members agree on the tuple key");
			strictEqual(report?.synthesis.verdict, "keep");
			strictEqual(report?.synthesis.judgeRunId, council.synthesis.judgeRunId);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
