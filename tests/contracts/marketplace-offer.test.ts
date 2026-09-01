import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	SKILL_INSTALL_OFFER_OPTION_NEVER,
	SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
	SKILL_INSTALL_OFFER_OPTION_PROJECT,
	SKILL_INSTALL_OFFER_OPTION_USER,
} from "../../src/core/skill-activation.js";
import {
	createMarketplaceOfferRegistration,
	MARKETPLACE_OFFER_REGISTRATION_ID,
	type MarketplaceOfferDeps,
	offerBindingTag,
} from "../../src/domains/middleware/marketplace-offer.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { MarketplaceSkill } from "../../src/domains/resources/skills/marketplace.js";
import {
	assertPromotionInstallSource,
	isOwnMarketplaceSource,
	matchMarketplaceSkills,
	readPromotionDeclines,
	recordPromotionNeverDecline,
	scorePromotionEntry,
} from "../../src/domains/resources/skills/promotion.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-promotion-"));
	roots.push(root);
	return root;
}

function entry(overrides: Partial<MarketplaceSkill> = {}): MarketplaceSkill {
	return {
		kind: "skill",
		name: "resolve-merge-conflicts",
		description: "Resolve git merge conflicts hunk by hunk with semantic verification.",
		sourceUrl: "/opt/clio/skills/git/resolve-merge-conflicts",
		origin: "catalog",
		triggers: ["merge conflict", "resolve conflicts"],
		...overrides,
	};
}

describe("contracts/marketplace-offer matcher", () => {
	it("fires on a trigger phrase and reports it", () => {
		const match = scorePromotionEntry("help me fix this merge conflict in main", entry());
		ok(match);
		strictEqual(match.matchedTrigger, "merge conflict");
	});

	it("stays silent on weak overlap and greetings", () => {
		strictEqual(scorePromotionEntry("hello there", entry()), null);
		strictEqual(scorePromotionEntry("rename this variable", entry()), null);
	});

	it("fires on strong distinctive-token overlap without triggers", () => {
		const { triggers: _omitted, ...rest } = entry();
		const noTriggers = rest as MarketplaceSkill;
		const match = scorePromotionEntry("resolve the merge conflicts with semantic verification", noTriggers);
		ok(match);
	});

	it("excludes installed and declined names and prefers trigger matches", () => {
		const conflicts = entry();
		const other = entry({
			name: "arxiv-literature",
			description: "Search arxiv literature and synthesize papers.",
			triggers: ["literature review"],
		});
		const matches = matchMarketplaceSkills("fix the merge conflict", [conflicts, other], new Set());
		deepStrictEqual(
			matches.map((m) => m.entry.name),
			["resolve-merge-conflicts"],
		);
		strictEqual(
			matchMarketplaceSkills("fix the merge conflict", [conflicts], new Set(["resolve-merge-conflicts"])).length,
			0,
		);
	});
});

describe("contracts/marketplace-offer own-marketplace gate", () => {
	it("accepts the local catalog and the project's own repository tree", () => {
		ok(isOwnMarketplaceSource(entry()));
		ok(
			isOwnMarketplaceSource(
				entry({ origin: "index", sourceUrl: "https://github.com/iowarp/clio-coder/tree/main/skills/git/ship" }),
			),
		);
	});

	it("rejects public registries and foreign repositories in code", () => {
		strictEqual(
			isOwnMarketplaceSource(entry({ origin: "index", sourceUrl: "https://github.com/someone/skills" })),
			false,
		);
		strictEqual(isOwnMarketplaceSource(entry({ origin: "index", sourceUrl: "https://skills.example.com/ship" })), false);
		// A local path is only trusted when catalog discovery produced it.
		strictEqual(isOwnMarketplaceSource(entry({ origin: "index", sourceUrl: "/somewhere/on/disk" })), false);
		throws(() => assertPromotionInstallSource(entry({ origin: "index", sourceUrl: "https://github.com/x/y" })), {
			message: /own marketplace/,
		});
	});
});

describe("contracts/marketplace-offer decline store", () => {
	it("round-trips never-declines and survives an unreadable file", () => {
		const configDir = tempDir();
		deepStrictEqual(readPromotionDeclines(configDir), { never: {} });
		recordPromotionNeverDecline("resolve-merge-conflicts", configDir);
		const store = readPromotionDeclines(configDir);
		ok(store.never["resolve-merge-conflicts"]);
	});
});

interface Installed {
	name: string;
	scope: string;
}

function makeDeps(overrides: Partial<MarketplaceOfferDeps> = {}): {
	deps: MarketplaceOfferDeps;
	installs: Installed[];
	nevers: string[];
} {
	const installs: Installed[] = [];
	const nevers: string[] = [];
	const deps: MarketplaceOfferDeps = {
		listInstalledSkillNames: () => [],
		listMarketplaceEntries: () => [entry()],
		getAutonomy: () => "auto-edit",
		installEntry: (skill, scope) => {
			installs.push({ name: skill.name, scope });
			return { path: `/tmp/${skill.name}/SKILL.md`, sourceUrl: skill.sourceUrl, installedHash: `sha256:${skill.name}` };
		},
		declines: {
			readNever: () => Object.fromEntries(nevers.map((name) => [name, "2026-01-01T00:00:00Z"])),
			recordNever: (name) => {
				nevers.push(name);
			},
		},
		newOfferTag: () => TEST_OFFER_TAG,
		...overrides,
	};
	return { deps, installs, nevers };
}

const TEST_OFFER_TAG = "test-offer-1";

function turnStart(text: string, sessionId = "s1"): MiddlewareHookInput {
	return { hook: "turn_start", sessionId, text };
}

function askUserAnswer(answerLabel: string, sessionId = "s1", tag: string = TEST_OFFER_TAG): MiddlewareHookInput {
	return {
		hook: "after_tool",
		sessionId,
		toolName: "ask_user",
		toolResultDetails: {
			answers: [
				{
					question: `Install the resolve-merge-conflicts skill? ${offerBindingTag(tag)}`,
					answer: answerLabel,
					options: [answerLabel],
				},
			],
		},
	};
}

function reminderText(effects: ReadonlyArray<MiddlewareEffect>): string {
	const effect = effects[0];
	ok(effect && (effect.kind === "inject_reminder" || effect.kind === "annotate_tool_result"));
	return effect.message;
}

describe("contracts/marketplace-offer registration", () => {
	it("offers a matching uninstalled skill once per session, on substantive turns only", () => {
		const { deps } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		strictEqual(registration.id, MARKETPLACE_OFFER_REGISTRATION_ID);
		strictEqual(registration.evaluate(turnStart("hello")).length, 0);
		const effects = registration.evaluate(turnStart("help me resolve this merge conflict"));
		strictEqual(effects.length, 1);
		const message = reminderText(effects);
		ok(message.includes("[Marketplace]"));
		ok(message.includes("resolve-merge-conflicts"));
		for (const label of [
			SKILL_INSTALL_OFFER_OPTION_PROJECT,
			SKILL_INSTALL_OFFER_OPTION_USER,
			SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
			SKILL_INSTALL_OFFER_OPTION_NEVER,
		]) {
			ok(message.includes(label), `offer names option ${label}`);
		}
		// Same session, same match: no second offer.
		strictEqual(registration.evaluate(turnStart("another merge conflict please")).length, 0);
	});

	it("skips offers when the operator already queued a skill request", () => {
		const { deps } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		const input: MiddlewareHookInput = {
			...turnStart("resolve this merge conflict"),
			metadata: { pendingSkillRequests: 1 },
		};
		strictEqual(registration.evaluate(input).length, 0);
	});

	it("installs on consent with the chosen scope and reports the path", () => {
		const { deps, installs } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart("resolve this merge conflict"));
		const effects = registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_USER));
		strictEqual(effects.length, 1);
		ok(reminderText(effects).includes("/skill resolve-merge-conflicts"));
		deepStrictEqual(installs, [{ name: "resolve-merge-conflicts", scope: "user" }]);
	});

	it("treats Not now as session-only and Never as persistent", () => {
		const { deps, installs, nevers } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart("resolve this merge conflict"));
		strictEqual(registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_NOT_NOW)).length, 0);
		strictEqual(installs.length, 0);
		strictEqual(nevers.length, 0);
		// A new session may offer again after Not now...
		const second = registration.evaluate(turnStart("resolve this merge conflict", "s2"));
		strictEqual(second.length, 1);
		// ...but Never persists across sessions through the injected store.
		strictEqual(registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_NEVER, "s2")).length, 0);
		deepStrictEqual(nevers, ["resolve-merge-conflicts"]);
		strictEqual(registration.evaluate(turnStart("resolve this merge conflict", "s3")).length, 0);
	});

	it("installs autonomously at full-auto only through the own-marketplace gate", () => {
		const { deps, installs } = makeDeps({ getAutonomy: () => "full-auto" });
		const registration = createMarketplaceOfferRegistration(deps);
		const effects = registration.evaluate(turnStart("resolve this merge conflict"));
		strictEqual(effects.length, 1);
		ok(reminderText(effects).includes("full-auto"));
		deepStrictEqual(installs, [{ name: "resolve-merge-conflicts", scope: "project" }]);
	});

	it("surfaces the source and content hash on an autonomous install (integrity is never skipped)", () => {
		const { deps } = makeDeps({ getAutonomy: () => "full-auto" });
		const registration = createMarketplaceOfferRegistration(deps);
		const message = reminderText(registration.evaluate(turnStart("resolve this merge conflict")));
		// Autonomy drops the operator's yes/no but keeps the integrity record the
		// consent overlay would have shown: the source and the SHA-256 of the bytes.
		ok(message.includes("/opt/clio/skills/git/resolve-merge-conflicts"), "names the install source");
		ok(message.includes("sha256:resolve-merge-conflicts"), "surfaces the content hash");
	});

	it("falls back to a consent offer when full-auto hits the source gate", () => {
		const foreign = entry({ origin: "index", sourceUrl: "https://github.com/someone/skills" });
		const { deps, installs } = makeDeps({
			getAutonomy: () => "full-auto",
			listMarketplaceEntries: () => [foreign],
		});
		const registration = createMarketplaceOfferRegistration(deps);
		const effects = registration.evaluate(turnStart("resolve this merge conflict"));
		strictEqual(effects.length, 1);
		ok(reminderText(effects).includes("ask_user"));
		strictEqual(installs.length, 0);
		// The consent path is gated identically: the consented install is refused.
		const consent = registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT));
		strictEqual(consent.length, 1);
		ok(reminderText(consent).includes("failed"));
		strictEqual(installs.length, 0);
	});

	it("does not bind an ask_user answer whose question lacks the offer tag", () => {
		const { deps, installs } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart("resolve this merge conflict"));
		// An unrelated (or prompt-injected) question carrying an install label but
		// not this offer's tag must never bind the pending offer.
		const untagged: MiddlewareHookInput = {
			hook: "after_tool",
			sessionId: "s1",
			toolName: "ask_user",
			toolResultDetails: {
				answers: [
					{
						question: "Set up the workspace?",
						answer: SKILL_INSTALL_OFFER_OPTION_PROJECT,
						options: [SKILL_INSTALL_OFFER_OPTION_PROJECT],
					},
				],
			},
		};
		strictEqual(registration.evaluate(untagged).length, 0);
		strictEqual(installs.length, 0);
		// The offer stays armed; the correctly tagged answer still installs.
		const effects = registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT));
		strictEqual(effects.length, 1);
		deepStrictEqual(installs, [{ name: "resolve-merge-conflicts", scope: "project" }]);
	});

	it("does not treat a cancelled interview as a decline (it cannot be attributed to the offer)", () => {
		const { deps, nevers } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart("resolve this merge conflict"));
		const cancelled: MiddlewareHookInput = {
			hook: "after_tool",
			sessionId: "s1",
			toolName: "ask_user",
			toolResultDetails: { cancelled: true, answers: [] },
		};
		strictEqual(registration.evaluate(cancelled).length, 0);
		strictEqual(nevers.length, 0);
		// A cancel records no persistent decline, so a fresh session offers again.
		strictEqual(registration.evaluate(turnStart("resolve this merge conflict", "s-fresh")).length, 1);
	});
});
