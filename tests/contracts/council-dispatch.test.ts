import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { CouncilReport } from "../../src/domains/agents/result-contract.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { dispatchCouncilThroughRegistry } from "../../src/interactive/council-dispatch.js";
import { councilAnswerGist, presentCouncilReport } from "../../src/interactive/renderers/worker-answer.js";
import { parseCouncilDeadline } from "../../src/session-control/council.js";
import { councilShortfall } from "../../src/session-control/poll.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { COUNCIL_DEFAULT_AGENT_ID } from "../../src/tools/dispatch-arguments.js";
import { applyToolProfile } from "../../src/tools/profiles.js";
import { createRegistry } from "../../src/tools/registry.js";
import { runResultPath } from "../../src/tools/worker-evidence.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

/**
 * `/council` invokes dispatch with no turn. The turn's denial memory must not
 * hold a declined council in a bucket that never resets, or every later
 * council in the session is refused without being asked.
 */
test("a council declined once is asked again the next time", async () => {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }), autonomy: () => "default" });
	registry.register({
		name: ToolNames.Dispatch,
		description: "stub dispatch",
		parameters: Type.Object({}, { additionalProperties: true }),
		baseActionClass: "dispatch",
		async run() {
			return { kind: "ok", output: "council dispatched" };
		},
	});
	let asks = 0;
	registry.onPermissionRequired((_call, _decision, meta) => {
		asks += 1;
		registry.cancelParkedCall(meta.requestId, HEADLESS_PERMISSION_DENIED_REASON);
	});
	const args = {
		tasks: [
			{ agent: "reviewer", task: "review" },
			{ agent: "reviewer", task: "review again" },
		],
	};
	const first = await dispatchCouncilThroughRegistry(registry, args);
	const second = await dispatchCouncilThroughRegistry(registry, args);
	deepStrictEqual([first.status, second.status, asks], ["blocked", "blocked", 2]);
});

/**
 * A roster member may name its own agent, and a member that names none sits
 * as the council's agent. Each keeps its own route and thinking level.
 */
test("council members run as their roster agent, else the council agent", async () => {
	const settings = validateSettings({
		targets: [{ id: "mini", runtime: "openai-compat", url: "http://127.0.0.1:1", defaultModel: "m" }],
		fleet: {
			rosters: {
				design: {
					members: [
						{ label: "arch", target: "mini", model: "a", agent: "architect" },
						{ label: "plain", target: "mini", model: "b", thinkingLevel: "low" },
					],
				},
			},
		},
	});
	deepStrictEqual(settings.issues, []);
	const seated: DispatchRequest[] = [];
	const tool = createDispatchTool({
		dispatch: {
			dispatch: async (request: DispatchRequest) => {
				seated.push(request);
				throw new Error("stub workers");
			},
		} as unknown as DispatchContract,
		getAgentSpecs: () => [{ id: "architect" }, { id: "researcher" }, { id: "scout" }] as never,
		getWorkerRosters: () => settings.settings.fleet.rosters,
		getAutonomy: () => "yolo",
	});
	await tool.run({ mode: "council", roster: "design", agent: "researcher", task: "Who owns the clock?" }, {} as never);
	deepStrictEqual(
		seated.map((request) => [request.council?.label, request.agentId, request.model, request.thinkingLevel ?? null]),
		[
			["arch", "architect", "a", null],
			["plain", "researcher", "b", "low"],
		],
	);
	for (const request of seated) match(request.briefing ?? "", /advising a council read-only/u);
	const refused = await tool.run(
		{
			mode: "council",
			members: [
				{ label: "x", target: "mini", agent: "nope" },
				{ label: "y", target: "mini" },
			],
			task: "t",
		},
		{} as never,
	);
	strictEqual(refused.kind, "error");
	match(refused.kind === "error" ? refused.message : "", /council_member_agent_unknown: x: 'nope'/u);
});

test("the default council member agent can search code under the council profile", async () => {
	const recipe = readFileSync(`src/domains/agents/builtins/${COUNCIL_DEFAULT_AGENT_ID}.md`, "utf8");
	const tools = /^tools:\n {2}required: \[(.*)\]\n {2}optional: \[(.*)\]/mu.exec(recipe);
	const declared = `${tools?.[1]}, ${tools?.[2]}`.split(", ");
	const kept = applyToolProfile(declared as never, "council-read-only");
	for (const tool of [ToolNames.Grep, ToolNames.Find, ToolNames.Ls, ToolNames.CodeNav]) ok(kept.includes(tool), tool);
});

test("a member deadline aborts only the slow member and names the deadline", async () => {
	deepStrictEqual(["90", "45s", "2m", "0", "x"].map(parseCouncilDeadline), [
		90_000,
		45_000,
		120_000,
		undefined,
		undefined,
	]);
	const aborted: Array<[string, string | undefined]> = [];
	const releases = new Map<string, (error: Error) => void>();
	let next = 0;
	const tool = createDispatchTool({
		dispatch: {
			dispatch: async (request: DispatchRequest) => {
				next += 1;
				const runId = `run-${next}-${request.council?.label}`;
				const finalPromise = new Promise<never>((_resolve, reject) => releases.set(runId, reject));
				return { runId, events: (async function* () {})(), finalPromise };
			},
			abort: (runId: string, reason?: { detail?: string }) => {
				aborted.push([runId, reason?.detail]);
				releases.get(runId)?.(new Error("aborted"));
			},
		} as unknown as DispatchContract,
		getAgentSpecs: () => [{ id: "scout" }] as never,
		getAutonomy: () => "yolo",
	});
	await tool.run(
		{
			mode: "council",
			members: [
				{ label: "a", target: "mini" },
				{ label: "b", target: "mini" },
			],
			member_deadline_ms: 20,
			task: "t",
		},
		{} as never,
	);
	ok(aborted.length > 0);
	for (const [, detail] of aborted) strictEqual(detail, "member deadline of 20ms passed");
});

test("a running member's progress counts the output it has streamed", () => {
	const fold = createWorkerProgressFold();
	strictEqual(fold.snapshot().streamedOutputTokens, undefined);
	fold.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(10) } }, 0);
	fold.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y".repeat(30) } }, 2000);
	strictEqual(fold.snapshot().streamedOutputTokens, 10);
});

test("/poll seats n independent vote members cycling over --models and tallies the distribution", async () => {
	const { buildPollDispatchArgs, formatPollTally } = await import("../../src/session-control/poll.js");
	const built = buildPollDispatchArgs(
		{
			participants: 3,
			question: "Tabs or spaces?",
			options: ["tabs", "spaces"],
			models: ["copilot/gpt-6-luna", "litellm/mini/q"],
		},
		{ target: "chat" },
	);
	ok(built.ok);
	deepStrictEqual(built.args.members, [
		{ label: "p1", target: "copilot", model: "gpt-6-luna" },
		{ label: "p2", target: "litellm", model: "mini/q" },
		{ label: "p3", target: "copilot", model: "gpt-6-luna" },
	]);
	strictEqual(built.args.synthesis, "vote");
	strictEqual(built.args.rounds, undefined);
	match(String(built.args.task), /exactly one of these options: tabs, spaces/);
	strictEqual(buildPollDispatchArgs({ participants: 6, question: "q" }, { target: "chat" }).ok, false);
	match(formatPollTally({ tabs: 2, spaces: 1 }, 3), /^poll: 3 of 3 voted; majority: tabs\n {2}tabs {4}## 2 \(67%\)/);
});

test("a vote task that lists options gets a neutral verdict placeholder; others keep the directive", async () => {
	const { renderCouncilVoteMemberTask, COUNCIL_VOTE_MEMBER_DIRECTIVE } = await import(
		"../../src/domains/dispatch/gate-role-prompts.js"
	);
	const { renderPollQuestion } = await import("../../src/session-control/poll.js");
	strictEqual(renderCouncilVoteMemberTask("plain"), `plain\n\n${COUNCIL_VOTE_MEMBER_DIRECTIVE}`);
	const polled = renderCouncilVoteMemberTask(
		renderPollQuestion({ participants: 3, question: "q", options: ["a", "b", "c"] }),
	);
	match(polled, /\{"verdict":"<one of: a\|b\|c>","text":/);
	ok(!polled.includes('"verdict":"yes"'));
	// The prose names the options too, so no example token is left to copy.
	doesNotMatch(polled, /"yes"|"keep"/u);
	match(polled, /exactly one of the options listed above, verbatim: a \| b \| c/u);
});

test("a poll seat votes under the bounded voter prompt and no ballot example carries an answer token (FL-23)", async () => {
	const { COUNCIL_VOTE_MEMBER_DIRECTIVE, COUNCIL_VOTER_PROMPT, isBoundedGateRolePrompt } = await import(
		"../../src/domains/dispatch/gate-role-prompts.js"
	);
	const { resultContractReminder, resultContractShape, validateResultContract } = await import(
		"../../src/domains/agents/result-contract.js"
	);
	const { buildPollDispatchArgs } = await import("../../src/session-control/poll.js");
	const seated: DispatchRequest[] = [];
	const tool = createDispatchTool({
		dispatch: {
			preview: (request: DispatchRequest) => ({
				agentId: request.agentId,
				targetId: request.target,
				wireModelId: "m",
				runtimeId: "openai-compat",
				node: { id: "local", kind: "local" },
				routeApproval: null,
			}),
			costCeilingUsd: () => 0,
			dispatch: async (request: DispatchRequest) => {
				seated.push(request);
				const runId = `run-${seated.length}-${request.council?.label}`;
				const receipt = {
					...fixtureReceiptDraft(fixtureEnvelope(runId)),
					agentId: request.agentId,
					...(request.council ? { council: request.council } : {}),
					...(request.gate ? { gate: request.gate } : {}),
				} as RunResultDraft;
				// Two spellings of one answer; the tally must count them together.
				const verdict = seated.length === 1 ? "Spaces-only" : "spaces only";
				const ballot = JSON.stringify({ verdict, text: "PEP 8" });
				const events = (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ballot }] } };
				})();
				return { runId, events, finalPromise: Promise.resolve(receipt) };
			},
			abort() {},
			getRun: () => undefined,
		} as unknown as DispatchContract,
		getAgentSpecs: () => [{ id: "scout" }] as never,
		getAutonomy: () => "yolo",
	});
	const built = buildPollDispatchArgs({ participants: 2, question: "Tabs or spaces?" }, { target: "mini" });
	if (!built.ok) throw new Error(built.reason);
	const result = await tool.run(built.args, {} as never);
	strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
	strictEqual(seated.length, 2);
	for (const request of seated) {
		// The scout's findings persona demands its own report shape; a voter seated on it votes under the coordinator's prompt.
		strictEqual(request.systemPrompt, COUNCIL_VOTER_PROMPT);
		ok(
			isBoundedGateRolePrompt({
				role: request.gate?.role,
				readOnly: request.readOnly,
				systemPrompt: request.systemPrompt,
			}),
		);
	}
	deepStrictEqual((result.details as { council?: CouncilReport }).council?.synthesis, {
		kind: "vote",
		verdict: "spaces only",
		tally: { "spaces only": 2 },
	});
	// Neither the directive, the reminder nor the repair shape shows an answer a member could copy.
	const contract = { kind: "council-ballot" } as const;
	for (const text of [COUNCIL_VOTE_MEMBER_DIRECTIVE, COUNCIL_VOTER_PROMPT, resultContractReminder(contract) ?? ""]) {
		doesNotMatch(text, /"yes"|"no"|"keep"/u);
	}
	match(resultContractShape(contract), /^\{"verdict":"<your answer as one short token>","text":/u);
	const copied = validateResultContract({
		contract,
		output: '{"verdict":"<your answer as one short token>","text":"x"}',
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => null },
	});
	strictEqual(copied.conformance, "fail");
	match(copied.reason ?? "", /copies the placeholder/u);
});

test("/poll refuses a choice its ballot could not carry verbatim", async () => {
	const { parseSlashCommand } = await import("../../src/session-control/slash-commands.js");
	const { councilBallotContract } = await import("../../src/domains/dispatch/gate-role-prompts.js");
	const { renderPollQuestion } = await import("../../src/session-control/poll.js");
	// The task lists its choices joined by ", ", so a choice holding one would split into two and spoil the verbatim match.
	const comma = parseSlashCommand('/poll --options "yes, ship it|no" 3 Ship?');
	strictEqual(comma.kind, "usage-error");
	match((comma as { reason?: string }).reason ?? "", /"yes, ship it" holds ", "/u);
	// A choice past the verdict bound would leave the poll with no options to bind the ballot to.
	const long = parseSlashCommand(`/poll --options "${"x".repeat(65)}|no" 3 Ship?`);
	strictEqual(long.kind, "usage-error");
	match((long as { reason?: string }).reason ?? "", /longer than 64 bytes/u);
	const kept = parseSlashCommand('/poll --options "ship it,now|no" 3 Ship?');
	if (kept.kind !== "poll") throw new Error(`expected a poll, got ${kept.kind}`);
	const options = kept.options.options;
	deepStrictEqual(options, ["ship it,now", "no"]);
	deepStrictEqual(councilBallotContract(renderPollQuestion({ participants: 3, question: "Ship?", options })), {
		kind: "council-ballot",
		options,
	});
});

test("a poll ballot that copies an example token fails into a repair round that names the options", async () => {
	const { councilBallotContract } = await import("../../src/domains/dispatch/gate-role-prompts.js");
	const { parseWorkerResultContract, resultContractShape, validateResultContract } = await import(
		"../../src/domains/agents/result-contract.js"
	);
	const { renderPollQuestion } = await import("../../src/session-control/poll.js");
	const contract = councilBallotContract(
		renderPollQuestion({ participants: 3, question: "Indent?", options: ["tabs", "spaces"] }),
	);
	deepStrictEqual(contract, { kind: "council-ballot", options: ["tabs", "spaces"] });
	deepStrictEqual(councilBallotContract("plain"), { kind: "council-ballot" });
	// The contract crosses to the worker on its spec and must read back whole.
	deepStrictEqual(parseWorkerResultContract(JSON.parse(JSON.stringify(contract)), "spec"), contract);
	const validate = (output: string) =>
		validateResultContract({
			contract,
			output,
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => null },
		});
	const copied = validate('{"verdict":"yes","text":"spaces read better"}');
	strictEqual(copied.conformance, "fail");
	match(copied.reason ?? "", /"yes" is not one of the listed options: tabs \| spaces/u);
	strictEqual(validate('{"verdict":"Spaces","text":"spaces read better"}').conformance, "pass");
	const repair = resultContractShape(contract);
	match(repair, /"verdict":"<one of: tabs\|spaces>"/u);
	match(repair, /verdict legal values are tabs \| spaces/u);
	ok(!repair.includes('"verdict":"yes"'), repair);
});

test("a council with one answer and one failed member reports partial, not failed", async () => {
	const registry = {
		invoke: async () => ({
			kind: "ok",
			result: {
				kind: "error",
				message: "[alpha] t/m\nyes\n\n[broken] dead/dead-model\n\n[synthesis] none\nnone",
				details: {
					council: {
						members: [
							{ label: "alpha", round: 1, answer: "yes" },
							{ label: "broken", round: 1, answer: "", failed: { reason: "ECONNREFUSED" } },
						],
						synthesis: { kind: "none" },
					},
				},
			},
		}),
	} as never;
	const outcome = await dispatchCouncilThroughRegistry(registry, { mode: "council" });
	deepStrictEqual(outcome.status === "error" ? outcome.partial : outcome, { answered: 1, total: 2, failed: ["broken"] });
});

test("a seat whose target is down sits as a failed seat while the live seats deliberate; fewer than two live is refused (FL-4)", async () => {
	const seated: DispatchRequest[] = [];
	const downMessage = "dispatch: target 'deadend' unavailable: health down: ECONNREFUSED";
	const tool = createDispatchTool({
		dispatch: {
			preview: (request: DispatchRequest) => {
				if (request.target === "deadend") throw new Error(downMessage);
				return {
					agentId: request.agentId,
					targetId: request.target,
					wireModelId: "m",
					runtimeId: "openai-compat",
					node: { id: "local", kind: "local" },
					routeApproval: null,
				};
			},
			costCeilingUsd: () => 0,
			dispatch: async (request: DispatchRequest) => {
				if (request.target === "deadend") throw new Error(downMessage);
				seated.push(request);
				const runId = `run-${seated.length}-${request.council?.label}`;
				const receipt = {
					...fixtureReceiptDraft(fixtureEnvelope(runId)),
					agentId: request.agentId,
					...(request.council ? { council: request.council } : {}),
					...(request.gate ? { gate: request.gate } : {}),
				} as RunResultDraft;
				const events = (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "yes" }] } };
				})();
				return { runId, events, finalPromise: Promise.resolve(receipt) };
			},
			abort() {},
			getRun: () => undefined,
		} as unknown as DispatchContract,
		getAgentSpecs: () => [{ id: "scout" }] as never,
		getAutonomy: () => "yolo",
	});
	const members = (labels: string[]) =>
		labels.map((label) => ({ label, target: label === "dead" ? "deadend" : "mini" }));
	const result = await tool.run(
		{ mode: "council", members: members(["a", "b", "dead"]), rounds: 2, task: "t" },
		{} as never,
	);
	deepStrictEqual(
		seated.map((request) => `${request.council?.label}@${request.council?.round}`),
		["a@1", "b@1", "a@2", "b@2"],
	);
	match(seated.find((request) => request.council?.round === 2)?.briefing ?? "", /\[dead\] failed in prior round/u);
	const report = (result.details as { council?: CouncilReport } | undefined)?.council;
	deepStrictEqual(
		report?.members.filter((member) => member.round === 2).map((member) => [member.label, member.failed?.reason ?? null]),
		[
			["a", null],
			["b", null],
			["dead", "seat not run: target 'deadend' unavailable: health down: ECONNREFUSED"],
		],
	);
	// FX-20: the skipped seat is named but not counted; both seats that ran answered, so the council is whole as admitted.
	strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
	match(result.kind === "ok" ? result.output : "", /\[dead\] seat not run \(target unavailable\): target 'deadend'/u);
	const outcome = await dispatchCouncilThroughRegistry({ invoke: async () => ({ kind: "ok", result }) } as never, {
		mode: "council",
	});
	deepStrictEqual(outcome, { status: "ok", skipped: { answered: 2, ran: 2, labels: ["dead"] } });
	strictEqual(presentCouncilReport(report as CouncilReport).lines.at(-1), "dead: seat not run (target unavailable)");
	// With a ran seat failing too, partial counts only the seats that ran.
	deepStrictEqual(
		councilShortfall({
			council: {
				members: [
					{ label: "a", runId: "r1", round: 1, answer: "yes" },
					{ label: "b", runId: "r2", round: 1, answer: "", failed: { reason: "ECONNREFUSED" } },
					{ label: "dead", runId: "not-run", round: 1, answer: "", failed: { reason: "seat not run: x" } },
				],
			},
		}),
		{ answered: 1, total: 2, failed: ["b"] },
	);
	seated.length = 0;
	const refused = await tool.run({ mode: "council", members: members(["a", "dead"]), task: "t" }, {} as never);
	deepStrictEqual(seated, []);
	match(refused.kind === "error" ? refused.message : "", /council_too_few_live_seats: 1 of 2 .*health down/u);
});

test("a council member's one-line preview skips a code-fence line (FX-19.3)", () => {
	strictEqual(councilAnswerGist('```json\n{"answer":"tabs win"}\n```'), '{"answer":"tabs win"}');
	strictEqual(councilAnswerGist("~~~\nplain body\n~~~"), "plain body");
	strictEqual(councilAnswerGist("tabs win\n```json\n{}\n```"), "tabs win");
});

test("a judge council admits round 2 and the judge when host text names an endpoint or a result object (bt-47 CF-a, CF-b)", async () => {
	const seated: DispatchRequest[] = [];
	let next = 0;
	const tool = createDispatchTool({
		dispatch: {
			dispatch: async (request: DispatchRequest) => {
				// Admission resolves the scope before anything runs; a refusal throws here as it does there.
				resolveDispatchPathScope(request);
				seated.push(request);
				next += 1;
				const label = request.council?.label ?? "member";
				const runId = `run-${next}-${label}`;
				const failed = label === "dead";
				const answer = `${label} answers: ${"x".repeat(9_000)}`;
				const receipt = {
					...fixtureReceiptDraft(fixtureEnvelope(runId)),
					agentId: request.agentId,
					exitCode: failed ? 1 : 0,
					outcome: failed ? "failed" : "succeeded",
					outcomeDetail: failed ? "provider answered http 400 from /chat/completions: model not found" : null,
					...(request.council ? { council: request.council } : {}),
					...(request.gate ? { gate: request.gate } : {}),
				} as RunResultDraft;
				if (!failed) {
					const resultPath = runResultPath(receipt);
					mkdirSync(path.dirname(resultPath), { recursive: true });
					writeFileSync(resultPath, JSON.stringify({ output: { text: answer } }));
				}
				const events = (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } };
				})();
				return { runId, events, finalPromise: Promise.resolve(receipt) };
			},
			abort() {},
			getRun: () => undefined,
		} as unknown as DispatchContract,
		getAgentSpecs: () => [{ id: "scout" }] as never,
		getAutonomy: () => "yolo",
	});
	const args = {
		mode: "council",
		members: ["a", "b", "dead"].map((label) => ({ label, target: "mini" })),
		rounds: 2,
		synthesis: "judge",
		task: "Does src/core/clock.ts own the clock?",
		cwd: process.cwd(),
	};
	await tool.run(args, {} as never);
	const judge = seated.find((request) => request.gate?.role === "synthesis");
	ok(judge !== undefined, "the judge is admitted");
	// The judge reads in the tree its seats read in, not wherever the host process started (cf-x11).
	strictEqual(judge.cwd, process.cwd());
	match(judge.briefing ?? "", /Reason: outcome=failed: provider answered http 400 from \/chat\/completions/u);
	match(judge.briefing ?? "", /read output\.text in \/\S+ for the whole answer/u);
	const second = seated.filter((request) => request.council?.round === 2 && request.gate?.role === "member");
	strictEqual(second.length, 3, "every seat is admitted to round 2");
	// The declared scope is the operator's own: what round 1 inferred from the task, nothing from the host text.
	for (const request of [...second, judge]) deepStrictEqual(request.intent?.relevantPaths, ["src/core/clock.ts"]);
	// An absolute path the operator wrote is still refused.
	seated.length = 0;
	const refused = await tool.run({ ...args, briefing: "The clock lives in /etc/clock.conf." }, {} as never);
	deepStrictEqual(seated, []);
	match(JSON.stringify(refused), /legacy_scope_path_absolute/u);
});
