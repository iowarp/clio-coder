import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createSkillsReminderRegistration,
	isSubstantiveUserTurn,
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
	text?: string;
}): MiddlewareHookInput {
	// Default to a substantive task so the existing "fires on the first turn"
	// cases still exercise a real task turn; greeting cases pass text explicitly.
	const text = input.text ?? "refactor the failing parser and add a regression test";
	return {
		hook: "turn_start",
		...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		text,
		metadata: {
			promptChars: text.length,
			queued: false,
			conversationMessages: input.conversationMessages ?? 0,
			pendingSkillRequests: input.pendingSkillRequests ?? 0,
		},
	};
}

describe("contracts/skills substance classifier", () => {
	it("treats bare greetings as non-substantive and any real task as substantive", () => {
		const table: Array<[string, boolean]> = [
			["hi", false],
			["Hello!", false],
			["hey there", false],
			["good morning", false],
			["thanks 🙏", false],
			["ok", false],
			["", false],
			["   ", false],
			["hi clio", false],
			["fix the bug", true],
			["how does bootstrapping work", true],
			["hello, can you read src/index.ts", true],
			["test the parser", true], // "parser" is a real token even though "test" alone is a greeting
			["good work on the refactor", true],
		];
		for (const [text, expected] of table) {
			strictEqual(isSubstantiveUserTurn(text), expected, `"${text}" should be substantive=${expected}`);
		}
	});
});

describe("contracts/skills first-turn reminder", () => {
	it("spends the shot on the first real task turn, not on a greeting-first session", () => {
		const registration = createSkillsReminderRegistration({ countModelVisibleSkills: () => 3 });
		// "hi" opens a fresh session: no reminder, and the shot is NOT spent.
		strictEqual(registration.evaluate(turnStart({ conversationMessages: 0, text: "hi" })).length, 0);
		// A second greeting still carries the shot even though the conversation grew.
		strictEqual(registration.evaluate(turnStart({ sessionId: "s1", conversationMessages: 2, text: "hello" })).length, 0);
		// The first real task turn fires, despite a non-empty conversation.
		strictEqual(
			registration.evaluate(turnStart({ sessionId: "s1", conversationMessages: 4, text: "fix the failing test" })).length,
			1,
		);
		// And only once.
		strictEqual(
			registration.evaluate(turnStart({ sessionId: "s1", conversationMessages: 6, text: "now add docs" })).length,
			0,
		);
	});

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

	it("fires on a fresh install with nothing installed when the marketplace has skills", () => {
		// The npm-install case: zero installed, a shipped catalog full of
		// installable skills. Gating on installed alone kept this reminder, the
		// one channel local models act on, from ever firing for exactly the
		// operator who had never installed anything.
		const fresh = createSkillsReminderRegistration({
			countModelVisibleSkills: () => 0,
			countInstallableSkills: () => 31,
		});
		const effects = fresh.evaluate(turnStart({ conversationMessages: 0, text: "grill me on this plan" }));
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect && effect.kind === "inject_reminder");
		if (effect?.kind === "inject_reminder") {
			strictEqual(effect.message, skillsReminderMessage(0, 31));
			ok(effect.message.includes("[Skills] 0 installed, 31 installable from the marketplace"));
			ok(effect.message.includes("offered for install"));
			ok(effect.message.includes(SKILL_SUGGESTION_ANCHOR));
		}
		// Both counts present: the line names both.
		ok(skillsReminderMessage(2, 29).includes("[Skills] 2 installed, 29 installable from the marketplace"));
		// No marketplace: the original shape, so a configured host reads as before.
		ok(skillsReminderMessage(2, 0).includes("[Skills] 2 installed."));
	});

	it("stays silent with zero model-visible skills and on skill-request turns", () => {
		const none = createSkillsReminderRegistration({ countModelVisibleSkills: () => 0 });
		strictEqual(none.evaluate(turnStart({ conversationMessages: 0 })).length, 0);
		const noneAnywhere = createSkillsReminderRegistration({
			countModelVisibleSkills: () => 0,
			countInstallableSkills: () => 0,
		});
		strictEqual(noneAnywhere.evaluate(turnStart({ conversationMessages: 0 })).length, 0);

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
		const skillDir = join(project, ".clio-coder", "skills", "visible");
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
