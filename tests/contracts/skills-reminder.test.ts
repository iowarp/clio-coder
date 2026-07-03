import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createSkillsReminderRegistration,
	SKILL_SUGGESTION_ANCHOR,
	SKILLS_REMINDER_REGISTRATION_ID,
	skillsReminderMessage,
} from "../../src/domains/middleware/skills-reminder.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createContextTool } from "../../src/tools/context/index.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function turnStart(input: {
	sessionId?: string;
	conversationMessages?: number;
	pendingSkillRequests?: number;
}): MiddlewareHookInput {
	return {
		hook: "turn_start",
		...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		metadata: {
			promptChars: 42,
			queued: false,
			conversationMessages: input.conversationMessages ?? 0,
			pendingSkillRequests: input.pendingSkillRequests ?? 0,
		},
	};
}

describe("contracts/skills first-turn reminder", () => {
	it("injects one reminder on the first substantive turn and never again in the session", () => {
		const registration = createSkillsReminderRegistration({ countModelVisibleSkills: () => 4 });
		strictEqual(registration.id, SKILLS_REMINDER_REGISTRATION_ID);

		// First turn of a fresh session: the session is created after
		// turn_start fires, so no sessionId yet.
		const first = registration.evaluate(turnStart({ conversationMessages: 0 }));
		strictEqual(first.length, 1);
		const effect = first[0];
		ok(effect && effect.kind === "inject_reminder");
		if (effect?.kind === "inject_reminder") {
			strictEqual(effect.message, skillsReminderMessage(4));
			ok(effect.message.includes("[Skills] 4 installed"));
			ok(effect.message.includes('context(scope="skills")'));
			ok(effect.message.includes(SKILL_SUGGESTION_ANCHOR));
			ok(effect.message.includes("load only on operator request"));
			ok(effect.message.includes("do not mention skills"));
		}

		// Follow-up turns of the same session stay silent.
		strictEqual(registration.evaluate(turnStart({ sessionId: "s1", conversationMessages: 2 })).length, 0);
		strictEqual(registration.evaluate(turnStart({ sessionId: "s1", conversationMessages: 4 })).length, 0);
	});

	it("marks a resumed session spent without reminding", () => {
		const registration = createSkillsReminderRegistration({ countModelVisibleSkills: () => 2 });
		// A resumed session's first observed turn already has conversation
		// history; it must not remind now or later.
		strictEqual(registration.evaluate(turnStart({ sessionId: "old", conversationMessages: 12 })).length, 0);
		strictEqual(registration.evaluate(turnStart({ sessionId: "old", conversationMessages: 0 })).length, 0);
	});

	it("fires again for a different session and stays quiet for the spent one", () => {
		const registration = createSkillsReminderRegistration({ countModelVisibleSkills: () => 1 });
		strictEqual(registration.evaluate(turnStart({ sessionId: "a", conversationMessages: 0 })).length, 1);
		strictEqual(registration.evaluate(turnStart({ sessionId: "a", conversationMessages: 2 })).length, 0);
		// /new creates the next session before its first submit, so the id changes.
		strictEqual(registration.evaluate(turnStart({ sessionId: "b", conversationMessages: 0 })).length, 1);
	});

	it("stays silent with zero model-visible skills and on skill-request turns", () => {
		const none = createSkillsReminderRegistration({ countModelVisibleSkills: () => 0 });
		strictEqual(none.evaluate(turnStart({ conversationMessages: 0 })).length, 0);

		const withSkills = createSkillsReminderRegistration({ countModelVisibleSkills: () => 3 });
		// The operator already invoked /skill:<name>; the reminder would be noise.
		strictEqual(withSkills.evaluate(turnStart({ conversationMessages: 0, pendingSkillRequests: 1 })).length, 0);
		// And that consumed the session's only chance.
		strictEqual(withSkills.evaluate(turnStart({ sessionId: "s", conversationMessages: 2 })).length, 0);

		const throwing = createSkillsReminderRegistration({
			countModelVisibleSkills: () => {
				throw new Error("loader unavailable");
			},
		});
		strictEqual(throwing.evaluate(turnStart({ conversationMessages: 0 })).length, 0);
	});

	it("teaches the same reply anchor as the context skills listing footer", async () => {
		const project = mkdtempSync(join(tmpdir(), "clio-reminder-anchor-"));
		roots.push(project);
		const skillDir = join(project, ".clio", "skills", "visible");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			["---", 'name: "visible"', 'description: "Catalog entry."', "---", "", "# Visible", "Body."].join("\n"),
			"utf8",
		);
		const tool = createContextTool({ getCwd: () => project });
		const result = await tool.run({ scope: "skills" }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			ok(result.output.includes(SKILL_SUGGESTION_ANCHOR));
		}
		ok(skillsReminderMessage(1).includes(SKILL_SUGGESTION_ANCHOR));
	});
});
