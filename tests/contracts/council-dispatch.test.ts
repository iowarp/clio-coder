import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { dispatchCouncilThroughRegistry } from "../../src/interactive/council-dispatch.js";
import { parseCouncilDeadline } from "../../src/session-control/council.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { COUNCIL_DEFAULT_AGENT_ID } from "../../src/tools/dispatch-arguments.js";
import { applyToolProfile } from "../../src/tools/profiles.js";
import { createRegistry } from "../../src/tools/registry.js";

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
