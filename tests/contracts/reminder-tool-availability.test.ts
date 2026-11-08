import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createReadOnlyExplorationNudgeRegistration } from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/index.js";
import { createMarketplaceOfferRegistration } from "../../src/domains/middleware/marketplace-offer.js";
import { createPlanCloseRegistration } from "../../src/domains/middleware/plan-close.js";
import { createTaskBoardReminderRegistration } from "../../src/domains/middleware/task-board-reminder.js";
import { createCitationGroundingRegistration } from "../../src/domains/safety/citation-grounding.js";

// The host reports the turn's callable tools as activeCapabilityNames: the
// attached and gateway-reachable tools the turn's constraints admit. A
// headless `run --allow-tools gateway,mcp_...` leaves tasks, ask_user, read
// and dispatch out of it, and a reminder naming them sent the model hunting.
const SCOPED = "gateway,mcp_zulip__agent_message";
const surface = (...tools: string[]): string => [ToolNames.Gateway, ...tools].join(",");

const ENUMERATED = "Do this:\n1) read the config\n2) fix the parser\n3) run the tests\n4) report";

describe("reminders gate on the turn's callable tools", () => {
	it("task-board reminder is absent without tasks and present with it", () => {
		const reminder = createTaskBoardReminderRegistration();
		const turn = (names: string): MiddlewareHookInput => ({
			hook: "turn_start",
			sessionId: "s1",
			text: ENUMERATED,
			metadata: { activeCapabilityNames: names, conversationMessages: 0 },
		});
		deepStrictEqual(reminder.evaluate(turn(SCOPED)), []);
		// The skipped turn did not spend the session's one reminder.
		const effects = reminder.evaluate(turn(surface(ToolNames.Tasks)));
		strictEqual(effects.length, 1);
		ok(effects[0]?.kind === "inject_reminder" && effects[0].message.startsWith("[Tasks]"));
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
		const offer = () =>
			createMarketplaceOfferRegistration({
				interactive: true,
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
