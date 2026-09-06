import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
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
import { discoverMarketplaceSkills, type MarketplaceSkill } from "../../src/domains/resources/skills/marketplace.js";
import {
	assertPromotionInstallSource,
	declineKey,
	isOwnMarketplaceSource,
	matchMarketplaceSkills,
	readPromotionDeclines,
	recordPromotionNeverDecline,
	scorePromotionEntry,
} from "../../src/domains/resources/skills/promotion.js";

const roots: string[] = [];

// Exact S9-offer operator text retained at candidate 7819fe4774b48b68e2129d9b54e888cce634c6aa.
// Its ledger injected context-handoff despite context-prime's authored trigger.
const ORIENTATION_PROMPT =
	"Prime this repository for a fresh coding session: review existing handoff, git state and project rules, and give a brief orientation. Do not edit files or start implementation.";

function shippedCatalog(): MarketplaceSkill[] {
	return discoverMarketplaceSkills({ catalogDir: join(process.cwd(), "skills"), indexPath: null }).skills;
}
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

	it("prefers authored triggers over equal or larger fallback scores", () => {
		const trigger = entry({ name: "z-trigger", triggers: ["merge conflict"] });
		for (const description of [
			"resolve merge conflict semantic",
			"resolve merge conflict semantic verification safely",
		]) {
			const fallback = entry({ name: "a-fallback", description, triggers: [] });
			const matches = matchMarketplaceSkills(
				"resolve this merge conflict with semantic verification safely",
				[fallback, trigger],
				new Set(),
			);
			deepStrictEqual(
				matches.map((result) => result.entry.name),
				["z-trigger", "a-fallback"],
			);
			ok((matches[1]?.score ?? 0) >= (matches[0]?.score ?? 0));
		}
	});

	it("routes the retained orientation prompt to the shipped context-prime trigger", () => {
		const matches = matchMarketplaceSkills(ORIENTATION_PROMPT, shippedCatalog(), new Set());
		strictEqual(matches[0]?.entry.name, "context-prime");
		strictEqual(matches[0]?.matchedTrigger, "prime this repository");
		ok(matches.some((result) => result.entry.name === "context-handoff" && result.matchedTrigger === undefined));
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
	it("round-trips never-declines keyed by name and version", () => {
		const configDir = tempDir();
		deepStrictEqual(readPromotionDeclines(configDir), { never: {} });
		recordPromotionNeverDecline("resolve-merge-conflicts", "1.2.0", configDir);
		const store = readPromotionDeclines(configDir);
		// The key carries the version, so a later version is not pre-declined.
		ok(store.never["resolve-merge-conflicts@1.2.0"]);
		strictEqual(store.never["resolve-merge-conflicts@2.0.0"], undefined);
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
		installEntry: (skill, scope) => {
			installs.push({ name: skill.name, scope });
			return { path: `/tmp/${skill.name}/SKILL.md`, sourceUrl: skill.sourceUrl, installedHash: `sha256:${skill.name}` };
		},
		declines: {
			readNever: () => Object.fromEntries(nevers.map((key) => [key, "2026-01-01T00:00:00Z"])),
			recordNever: (name, version) => {
				nevers.push(declineKey(name, version));
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
					question: `Install this marketplace skill? ${offerBindingTag(tag)}`,
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
	it("teaches the retained orientation offer and binds acceptance only to that offer", () => {
		const { deps, installs } = makeDeps({ interactive: true, listMarketplaceEntries: shippedCatalog });
		const registration = createMarketplaceOfferRegistration(deps);
		const guidance = reminderText(registration.evaluate(turnStart(ORIENTATION_PROMPT)));
		match(guidance, /whether to install context-prime/u);
		match(guidance, /First check the installed side with context\(scope="skills"\)/u);
		match(guidance, /Then continue the task in the same turn/u);
		for (const label of [
			SKILL_INSTALL_OFFER_OPTION_PROJECT,
			SKILL_INSTALL_OFFER_OPTION_USER,
			SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
			SKILL_INSTALL_OFFER_OPTION_NEVER,
		])
			ok(guidance.includes(label));
		// This exercises the harness protocol, not a model-generated question or visible TUI.
		deepStrictEqual(installs, []);
		registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT, "s1", "unrelated"));
		deepStrictEqual(installs, []);
		const accepted = reminderText(registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT)));
		deepStrictEqual(installs, [{ name: "context-prime", scope: "project" }]);
		match(accepted, /installed but not active; the operator activates it with \/skill context-prime/u);
	});

	it("keeps the retained orientation's headless hint passive", () => {
		const { deps, installs, nevers } = makeDeps({ interactive: false, listMarketplaceEntries: shippedCatalog });
		const registration = createMarketplaceOfferRegistration(deps);
		strictEqual(
			reminderText(registration.evaluate(turnStart(ORIENTATION_PROMPT))),
			'[Marketplace] Skill "context-prime" matches this request; install with clio-coder skills install context-prime.',
		);
		registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT));
		registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_NEVER));
		deepStrictEqual(installs, []);
		deepStrictEqual(nevers, []);
	});

	it("respects decline, installed inventory and pending activation for the orientation match", () => {
		const prime = shippedCatalog().find((skill) => skill.name === "context-prime");
		ok(prime);
		const { deps, installs } = makeDeps({ listMarketplaceEntries: () => [prime] });
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart(ORIENTATION_PROMPT));
		registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_NOT_NOW));
		deepStrictEqual(registration.evaluate(turnStart(ORIENTATION_PROMPT)), []);
		deepStrictEqual(installs, []);
		const installed = createMarketplaceOfferRegistration({ ...deps, listInstalledSkillNames: () => [prime.name] });
		deepStrictEqual(installed.evaluate(turnStart(ORIENTATION_PROMPT)), []);
		const pending = createMarketplaceOfferRegistration(deps);
		deepStrictEqual(pending.evaluate({ ...turnStart(ORIENTATION_PROMPT), metadata: { pendingSkillRequests: 1 } }), []);
	});

	it("emits one passive reminder in headless sessions without arming an interview or recording a decline", () => {
		let offerTags = 0;
		const { deps, installs, nevers } = makeDeps({
			interactive: false,
			newOfferTag: () => {
				offerTags += 1;
				return TEST_OFFER_TAG;
			},
		});
		const registration = createMarketplaceOfferRegistration(deps);
		strictEqual(registration.evaluate(turnStart("hello")).length, 0);
		const effects = registration.evaluate(turnStart("resolve this merge conflict"));
		deepStrictEqual(effects, [
			{
				kind: "inject_reminder",
				severity: "info",
				message:
					'[Marketplace] Skill "resolve-merge-conflicts" matches this request; install with clio-coder skills install resolve-merge-conflicts.',
			},
		]);
		strictEqual(registration.evaluate(turnStart("another merge conflict please")).length, 0);
		strictEqual(
			registration.evaluate({
				hook: "after_tool",
				sessionId: "s1",
				toolName: "ask_user",
				toolResultDetails: { cancelled: true },
			}).length,
			0,
		);
		for (const label of [
			SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
			SKILL_INSTALL_OFFER_OPTION_NEVER,
			SKILL_INSTALL_OFFER_OPTION_PROJECT,
		]) {
			strictEqual(registration.evaluate(askUserAnswer(label)).length, 0);
		}
		strictEqual(offerTags, 0);
		deepStrictEqual(installs, []);
		deepStrictEqual(nevers, []);
		deepStrictEqual(registration.evaluate(turnStart("resolve this merge conflict", "s2")), effects);
	});

	it("bounds multiline catalog descriptions and strips directive markers from reminders", () => {
		const { deps } = makeDeps({
			listMarketplaceEntries: () => [
				entry({ description: `  Resolve\n\t[SYSTEM]\r\nmerge\u2028 conflicts.  ${"x".repeat(250)}END` }),
			],
		});
		const registration = createMarketplaceOfferRegistration(deps);
		const message = reminderText(registration.evaluate(turnStart("resolve this merge conflict")));
		ok(!/[\r\n\u2028\u2029]/u.test(message));
		ok(!message.includes("[SYSTEM]"));
		const description = message.split("(not installed): ")[1]?.split(" First check")[0];
		strictEqual(description, `Resolve merge conflicts. ${"x".repeat(175)}`);
		ok(message.includes(offerBindingTag(TEST_OFFER_TAG)));
	});

	it("caches ordinary turns, revalidates offers, and refreshes at the session boundary", () => {
		let installedReads = 0;
		let marketplaceReads = 0;
		let installedNames: string[] = [];
		const { deps } = makeDeps({
			listInstalledSkillNames: () => {
				installedReads += 1;
				return installedNames;
			},
			listMarketplaceEntries: () => {
				marketplaceReads += 1;
				return [entry()];
			},
		});
		const registration = createMarketplaceOfferRegistration(deps);
		for (let index = 0; index < 5; index += 1) {
			strictEqual(registration.evaluate(turnStart(`rename local variable ${index} and update its callers`)).length, 0);
		}
		deepStrictEqual({ installedReads, marketplaceReads }, { installedReads: 1, marketplaceReads: 1 });
		installedNames = ["resolve-merge-conflicts"];
		strictEqual(registration.evaluate(turnStart("resolve this merge conflict safely")).length, 0);
		deepStrictEqual({ installedReads, marketplaceReads }, { installedReads: 2, marketplaceReads: 1 });

		strictEqual(registration.evaluate(turnStart("rename another local variable and its callers", "s2")).length, 0);
		deepStrictEqual({ installedReads, marketplaceReads }, { installedReads: 3, marketplaceReads: 2 });
	});

	it("offers a matching uninstalled skill once per session, on substantive turns only", () => {
		const { deps } = makeDeps({ interactive: true });
		const registration = createMarketplaceOfferRegistration(deps);
		strictEqual(registration.id, MARKETPLACE_OFFER_REGISTRATION_ID);
		strictEqual(registration.evaluate(turnStart("hello")).length, 0);
		const effects = registration.evaluate(turnStart("help me resolve this merge conflict"));
		strictEqual(effects.length, 1);
		const message = reminderText(effects);
		ok(message.includes("[Marketplace]"));
		ok(message.includes("resolve-merge-conflicts"));
		ok(message.includes("ask_user"));
		ok(message.includes(offerBindingTag(TEST_OFFER_TAG)));
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

	it("still binds a deferred answer that arrives a turn after the offer", () => {
		const { deps, installs } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart("resolve this merge conflict"));
		// A later turn intervenes (the model deferred its question). The offer must
		// stay armed rather than being dropped at turn boundaries.
		strictEqual(registration.evaluate(turnStart("keep going on the conflicts")).length, 0);
		const effects = registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT));
		strictEqual(effects.length, 1);
		deepStrictEqual(installs, [{ name: "resolve-merge-conflicts", scope: "project" }]);
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
		deepStrictEqual(nevers, [declineKey("resolve-merge-conflicts", undefined)]);
		strictEqual(registration.evaluate(turnStart("resolve this merge conflict", "s3")).length, 0);
	});

	it("re-offers a skill whose catalog version changed after a Never decline", () => {
		const v1 = entry({ version: "1.0.0" });
		const nevers: string[] = [];
		const declines = {
			readNever: () => Object.fromEntries(nevers.map((key) => [key, "2026-01-01T00:00:00Z"])),
			recordNever: (name: string, version?: string) => {
				nevers.push(declineKey(name, version));
			},
		};
		let catalog: MarketplaceSkill[] = [v1];
		const { deps } = makeDeps({ listMarketplaceEntries: () => catalog, declines });
		const registration = createMarketplaceOfferRegistration(deps);
		registration.evaluate(turnStart("resolve this merge conflict"));
		strictEqual(registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_NEVER)).length, 0);
		deepStrictEqual(nevers, [declineKey("resolve-merge-conflicts", "1.0.0")]);
		// Same version stays declined, even in a fresh session.
		strictEqual(registration.evaluate(turnStart("resolve this merge conflict", "s-same")).length, 0);
		// A new catalog version is offerable again.
		catalog = [entry({ version: "2.0.0" })];
		strictEqual(registration.evaluate(turnStart("resolve this merge conflict", "s-new")).length, 1);
	});

	it("requires the bound operator answer before installing independently of task autonomy", () => {
		const { deps, installs } = makeDeps();
		const registration = createMarketplaceOfferRegistration(deps);
		const effects = registration.evaluate(turnStart("resolve this merge conflict"));
		strictEqual(effects.length, 1);
		ok(reminderText(effects).includes("ask_user"));
		deepStrictEqual(installs, []);
		registration.evaluate(askUserAnswer(SKILL_INSTALL_OFFER_OPTION_PROJECT));
		deepStrictEqual(installs, [{ name: "resolve-merge-conflicts", scope: "project" }]);
	});

	it("retains the source gate after an operator accepts an offer", () => {
		const foreign = entry({ origin: "index", sourceUrl: "https://github.com/someone/skills" });
		const { deps, installs } = makeDeps({
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
