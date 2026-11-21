import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { type TurnConstraints, templateToolConstraints } from "../../src/core/turn-constraints.js";
import { createReadOnlyExplorationNudgeRegistration } from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/index.js";
import { createMarketplaceOfferRegistration } from "../../src/domains/middleware/marketplace-offer.js";
import { createPlanCloseRegistration } from "../../src/domains/middleware/plan-close.js";
import { createReadStreakRegistration } from "../../src/domains/middleware/read-streak.js";
import { createScoutNudgeRegistration } from "../../src/domains/middleware/scout-nudge.js";
import { createTaskBoardReminderRegistration } from "../../src/domains/middleware/task-board-reminder.js";
import { createCitationGroundingRegistration } from "../../src/domains/safety/citation-grounding.js";
import { callChangesTree } from "../../src/domains/safety/index.js";
import { callRepeatsAsRead } from "../../src/engine/loop-guard.js";

// The host reports the turn's callable tools as activeCapabilityNames: the
// attached and gateway-reachable tools the turn's constraints admit. A
// headless `run --allow-tools gateway,mcp_...` leaves tasks, ask_user, read
// and dispatch out of it, and a reminder naming them sent the model hunting.
const SCOPED = "gateway,mcp_zulip__agent_message";
const surface = (...tools: string[]): string => [ToolNames.Gateway, ...tools].join(",");

const ENUMERATED = "Do this:\n1) read the config\n2) fix the parser\n3) run the tests\n4) report";

describe("reminders gate on the turn's callable tools", () => {
	it("task-board reminder is absent without tasks and gateway or under a step policy, present with both", () => {
		const reminder = createTaskBoardReminderRegistration();
		const turn = (names: string): MiddlewareHookInput => ({
			hook: "turn_start",
			sessionId: "s1",
			text: ENUMERATED,
			metadata: { activeCapabilityNames: names, conversationMessages: 0 },
		});
		deepStrictEqual(reminder.evaluate(turn(SCOPED)), []);
		// The text also teaches gateway op=chain.
		deepStrictEqual(reminder.evaluate(turn(ToolNames.Tasks)), []);
		// A step template's turn runs one step, not the enumerated list (bt-12 #4).
		const step = turn(surface(ToolNames.Tasks));
		deepStrictEqual(reminder.evaluate({ ...step, metadata: { ...step.metadata, turnStepPolicy: true } }), []);
		// Nor does a turn the host scoped to an answer or to read-only work (bt-22).
		deepStrictEqual(reminder.evaluate({ ...step, metadata: { ...step.metadata, turnMode: "answer" } }), []);
		deepStrictEqual(reminder.evaluate({ ...step, metadata: { ...step.metadata, turnReadOnly: true } }), []);
		// Nor one whose prose alone states read-only scope (bt-22b).
		const prose = `This is a read-only task: do not create, modify or delete any file.\n${ENUMERATED}`;
		deepStrictEqual(reminder.evaluate({ ...step, text: prose }), []);
		// Nor `Line N:` labels, which number content, not steps (SF-14).
		deepStrictEqual(reminder.evaluate({ ...step, text: "Fix these.\nLine 1: a\nLine 2: b\nLine 3: c" }), []);
		// The skipped turn did not spend the session's one reminder.
		const effects = reminder.evaluate(turn(surface(ToolNames.Tasks)));
		strictEqual(effects.length, 1);
		ok(effects[0]?.kind === "inject_reminder" && effects[0].message.startsWith("[Tasks]"));
		ok(effects[0].message.includes('tasks action="plan"'));
		// A tasks reachable only through gateway is named as the gateway call (bt-22).
		const hidden = createTaskBoardReminderRegistration().evaluate({
			...turn(surface(ToolNames.Tasks)),
			metadata: { activeCapabilityNames: surface(ToolNames.Tasks), activeToolNames: ToolNames.Gateway },
		});
		ok(hidden[0]?.kind === "inject_reminder");
		ok(hidden[0].message.includes('gateway(op="call", capability="tasks", args={action:"plan"'));
		ok(!hidden[0].message.includes('tasks action="plan"'));
	});

	it("plan close never teaches ask_user to a turn that cannot call it", () => {
		const rule = createPlanCloseRegistration({ canAsk: () => true });
		const run = (names: string) => {
			const start = rule.evaluate({
				hook: "turn_start",
				text: "Write a plan for adding a cache.",
				metadata: { activeCapabilityNames: names },
			});
			const end = rule.evaluate({ hook: "turn_end", metadata: { stopReason: "stop", activeCapabilityNames: names } });
			return [...start, ...end];
		};
		deepStrictEqual(run(SCOPED), []);
		const effects = run(surface(ToolNames.AskUser));
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["inject_reminder", "request_continuation"],
		);
	});

	it("marketplace offer needs both context and ask_user", () => {
		const offer = (constraints?: TurnConstraints) =>
			createMarketplaceOfferRegistration({
				interactive: true,
				getTurnConstraints: () => constraints,
				listInstalledSkillNames: () => [],
				listMarketplaceEntries: () => [
					{
						kind: "skill",
						name: "resolve-merge-conflicts",
						description: "Resolve git merge conflicts hunk by hunk with semantic verification.",
						sourceUrl: "/opt/clio-coder/skills/git/resolve-merge-conflicts",
						origin: "catalog",
						triggers: ["merge conflict"],
					},
				],
				installEntry: () => ({ path: "unused", sourceUrl: "unused", installedHash: "unused" }),
				declines: { readNever: () => ({}), recordNever: () => {} },
				newOfferTag: () => "tag-1",
			});
		const turn = (names: string): MiddlewareHookInput => ({
			hook: "turn_start",
			sessionId: "s1",
			text: "help me resolve this merge conflict",
			metadata: { activeCapabilityNames: names },
		});
		const registration = offer();
		deepStrictEqual(registration.evaluate(turn(SCOPED)), []);
		deepStrictEqual(registration.evaluate(turn(surface(ToolNames.AskUser))), []);
		const effects = registration.evaluate(turn(surface(ToolNames.AskUser, ToolNames.Context)));
		strictEqual(effects.length, 1);
		ok(effects[0]?.kind === "inject_reminder" && effects[0].message.includes("ask_user"));
		// A prompt template that narrowed the turn's tools gets no install flow, even with both tools admitted.
		const narrowed = offer(templateToolConstraints({ name: "advance", allowedTools: ["ask_user", "context", "read"] }));
		deepStrictEqual(narrowed.evaluate(turn(surface(ToolNames.AskUser, ToolNames.Context))), []);
	});

	it("read-only exploration follow-up names Scout only when dispatch is callable", () => {
		const followUp = (names: string) => {
			const { registration } = createReadOnlyExplorationNudgeRegistration({ workspaceRoot: () => process.cwd() });
			for (let call = 0; call < 9; call++) {
				registration.evaluate({
					hook: "before_tool",
					sessionId: "s1",
					turnId: "t1",
					toolName: ToolNames.Read,
					toolArgs: { path: `src/file-${call}.ts` },
				});
			}
			registration.evaluate({
				hook: "turn_end",
				sessionId: "s1",
				turnId: "t1",
				metadata: { stopReason: "stop", activeCapabilityNames: surface(ToolNames.Dispatch, ToolNames.Read) },
			});
			return registration.evaluate({
				hook: "turn_start",
				sessionId: "s1",
				text: "continue",
				metadata: { activeCapabilityNames: names },
			});
		};
		deepStrictEqual(followUp(SCOPED), []);
		strictEqual(followUp(surface(ToolNames.Dispatch)).length, 1);
	});

	it("scout nudge fires once per turn after reads across three areas, only when dispatch is callable and unused", () => {
		const survey = (names: string, areas: ReadonlyArray<string>, dispatchFirst = false) => {
			const registration = createScoutNudgeRegistration({ workspaceRoot: () => process.cwd() });
			registration.evaluate({ hook: "turn_start", metadata: { userTurnId: "u1", activeCapabilityNames: names } });
			if (dispatchFirst)
				registration.evaluate({ hook: "before_tool", turnId: "u1", toolName: ToolNames.Dispatch, toolArgs: {} });
			return Array.from({ length: 12 }, (_, call) =>
				registration.evaluate({
					hook: "after_tool",
					turnId: "u1",
					toolName: ToolNames.Read,
					toolArgs: { path: `${areas[call % areas.length]}/file-${call}.ts` },
					metadata: { resultKind: "ok" },
				}),
			);
		};
		const threeAreas = ["src", "tests", "docs"];
		const fired = survey(surface(ToolNames.Dispatch, ToolNames.Read), threeAreas);
		// The tenth read crosses the line; the turn's one note is then spent.
		deepStrictEqual(
			fired.map((effects) => effects.length),
			[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
		);
		const note = fired[9]?.[0];
		ok(note?.kind === "annotate_tool_result" && note.message.includes('agent "scout"'));
		ok(note.message.includes("src/, tests/, docs/"));
		// No dispatch on the surface (a read-only or scoped session), two areas, or a dispatch already made: silent.
		deepStrictEqual(survey(SCOPED, threeAreas).flat(), []);
		deepStrictEqual(survey(surface(ToolNames.Dispatch), ["src", "tests"]).flat(), []);
		deepStrictEqual(survey(surface(ToolNames.Dispatch), threeAreas, true).flat(), []);
	});

	it("read streak asks for a decision at 25 and 40, names only callable tools, and resets only on progress", () => {
		const rule = createReadStreakRegistration({
			classifiers: { repeatsAsRead: callRepeatsAsRead, changesTree: callChangesTree },
			workspaceRoot: () => process.cwd(),
		});
		const start = (metadata: NonNullable<MiddlewareHookInput["metadata"]>) =>
			rule.evaluate({ hook: "turn_start", sessionId: "s1", metadata });
		const call = (
			toolName: string,
			toolArgs: Record<string, unknown>,
			batchSize = 3,
			declared: NonNullable<MiddlewareHookInput["metadata"]> = {},
			toolCallId?: string,
		) =>
			rule.evaluate({
				hook: "after_tool",
				sessionId: "s1",
				toolName,
				toolArgs,
				...(toolCallId !== undefined ? { toolCallId } : {}),
				metadata: { resultKind: "ok", batchSize, ...declared },
			});
		const reads = (count: number, batchSize = 3) =>
			Array.from({ length: count }, (_, index) => call(ToolNames.Read, { path: `src/f-${index}.ts` }, batchSize));
		const notes = (effects: ReadonlyArray<ReadonlyArray<{ kind: string; message?: string }>>) =>
			effects.flatMap((each, index) => each.map((effect) => ({ at: index + 1, message: effect.message ?? "" })));
		// Headless writer: edit and tasks are callable, ask_user is not.
		start({ turnOrigin: "operator", activeCapabilityNames: surface(ToolNames.Read, ToolNames.Edit, ToolNames.Tasks) });
		// Four single-read rounds draw the batching note once; a wider round and a bash mutation reset both counters.
		const serial = notes([...reads(4, 1), ...reads(6)]);
		deepStrictEqual(
			serial.map((note) => note.at),
			[4],
		);
		ok(serial[0]?.message.startsWith("[CLIO Coder] The last 4 rounds each made a single read."));
		deepStrictEqual(call(ToolNames.Bash, { command: "sed -i 's/a/b/' src/f-0.ts" }), []);
		// A cd-prefixed bash read counts as a read (X1) and crosses 25.
		const first = notes([...reads(24), call(ToolNames.Bash, { command: "cd src && grep -n streak f-0.ts" })]);
		deepStrictEqual(
			first.map((note) => note.at),
			[25],
		);
		const n1 = first[0]?.message ?? "";
		ok(n1.startsWith("[CLIO Coder] 25 read-only calls in a row with no edit or plan update."));
		ok(n1.includes("make the edit or record the plan with tasks."));
		ok(!n1.includes("question") && !n1.includes("one round"));
		// A plan recorded through gateway resets the streak and re-arms the ladder.
		deepStrictEqual(call(ToolNames.Gateway, { op: "call", capability: "tasks", args: { action: "plan" } }), []);
		const again = reads(21);
		const crossing = notes([...again, ...reads(4, 1)]);
		// Serial rounds at the 25th read ride on that note; no separate batching note.
		deepStrictEqual(
			crossing.map((note) => note.at),
			[25],
		);
		ok(crossing[0]?.message.endsWith("Send the reads and searches you already know you need together in one round."));
		// A continuation keeps the streak; the 40th read draws the firmer note.
		start({
			turnOrigin: "continuation",
			activeCapabilityNames: surface(ToolNames.Read, ToolNames.Edit, ToolNames.Tasks),
		});
		const second = notes(reads(15, 2));
		deepStrictEqual(
			second.map((note) => note.at + 25),
			[40],
		);
		const n2 = second[0]?.message ?? "";
		ok(n2.startsWith("[CLIO Coder] 40 read-only calls in a row and still no edit or plan update."));
		ok(n2.includes("The earlier reads are still in this conversation"));
		// A turn that cannot write gets one answer-worded note, at 40 only, with no batching sentence.
		start({ turnOrigin: "operator", turnMode: "answer", activeCapabilityNames: surface(ToolNames.Read) });
		const answer = notes(reads(65, 1));
		deepStrictEqual(
			answer.map((note) => note.at),
			[40],
		);
		ok(answer[0]?.message.includes("Answer from what you have now"));
		ok(!answer[0]?.message.includes("one round"));
		// The batching sentence goes out once per streak: after the standalone note the 25th read's note has none.
		const writer = surface(ToolNames.Read, ToolNames.Edit, ToolNames.Tasks);
		start({ turnOrigin: "operator", activeCapabilityNames: writer });
		const once = notes(reads(25, 1));
		deepStrictEqual(
			once.map((note) => note.at),
			[4, 25],
		);
		ok(!once[1]?.message.includes("one round"));
		// Typed git add and commit, decide, artifact and run_script are progress.
		const progress = [
			() => call(ToolNames.Git, { op: "commit", message: "wip" }),
			() => call(ToolNames.Gateway, { op: "call", capability: "git", args: { op: "add", paths: ["src/f-0.ts"] } }),
			() => call(ToolNames.Gateway, { op: "call", capability: "decide", args: { key: "k", value: "v" } }),
			() => call(ToolNames.Artifact, { kind: "report", content: "done" }),
			() => call(ToolNames.RunScript, { interpreter: "python3", script: "sweep.py" }),
		];
		deepStrictEqual(notes(progress.flatMap((step) => [step(), ...reads(24)])), []);
		// An extension tool declared only idempotent is not a read; one declared read-only is the 25th.
		deepStrictEqual(call("extension_demo__lookup", {}, 3, { toolIdempotent: true, toolReadOnly: false }), []);
		strictEqual(notes([call("extension_demo__lookup", {}, 3, { toolReadOnly: true })]).length, 1);
		// One chain of read steps is one round as wide as the chain; four one-step chains are four single-read rounds.
		const chain = (id: string, count: number) => {
			const steps = Array.from({ length: count }, (_, index) => ({
				id: `s${index}`,
				capability: ToolNames.Read,
				args: { path: `src/c-${id}-${index}.ts` },
			}));
			const args = { op: "chain", steps };
			rule.evaluate({
				hook: "before_tool",
				sessionId: "s1",
				toolName: ToolNames.Gateway,
				toolArgs: args,
				toolCallId: id,
				metadata: { batchSize: 1 },
			});
			const ran = steps.map((step) => call(ToolNames.Read, step.args, 1, {}, `${id}:${step.id}`));
			return [...ran, call(ToolNames.Gateway, args, 1, {}, id)];
		};
		deepStrictEqual(call(ToolNames.Tasks, { action: "plan" }), []);
		deepStrictEqual(notes([...reads(3, 1), ...chain("c1", 4)]), []);
		deepStrictEqual(
			notes(["c2", "c3", "c4", "c5"].flatMap((id) => chain(id, 1))).map((note) => note.at),
			[7],
		);
	});

	it("citation grounding asks for a numbered re-read only when read and grep are callable", () => {
		const turnEnd = (names: string) => {
			const registration = createCitationGroundingRegistration({ cwd: () => "/workspace" });
			registration.evaluate({
				hook: "after_tool",
				sessionId: "s1",
				toolName: ToolNames.Read,
				toolArgs: { path: "src/rates.mjs" },
				metadata: { resultKind: "ok" },
			});
			return registration.evaluate({
				hook: "turn_end",
				sessionId: "s1",
				text: "The rounding bug is at src/rates.mjs:42-48.",
				metadata: { stopReason: "stop", userTurnId: "u1", activeCapabilityNames: names },
			});
		};
		deepStrictEqual(turnEnd(SCOPED), []);
		// The message also says to grep the symbol first.
		deepStrictEqual(turnEnd(surface(ToolNames.Read)), []);
		ok(turnEnd(surface(ToolNames.Read, ToolNames.Grep)).length > 0);
	});
});
