import { randomUUID } from "node:crypto";
import {
	SKILL_INSTALL_OFFER_OPTION_NEVER,
	SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
	SKILL_INSTALL_OFFER_OPTION_PROJECT,
	SKILL_INSTALL_OFFER_OPTION_USER,
} from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { MarketplaceSkill } from "../resources/skills/marketplace.js";
import {
	assertPromotionInstallSource,
	matchMarketplaceSkills,
	type PromotionMatch,
	readPromotionDeclines,
	recordPromotionNeverDecline,
} from "../resources/skills/promotion.js";
import type { AutonomyLevel } from "../safety/autonomy.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import { isSubstantiveUserTurn } from "./skills-reminder.js";
import { type MiddlewareEffect, type MiddlewareHookInput, metadataNumber } from "./types.js";

/**
 * Marketplace self-promotion offer. When the operator's request needs
 * expertise no installed skill covers and the local marketplace has a match,
 * this registration teaches the model to put one tight ask_user question to
 * the operator; the after_tool observer then acts on the answer — a consented
 * install runs harness-side through the injected installer, "Not now" is a
 * session-only decline, and "Never offer this skill" persists.
 *
 * Firing is need-driven, not count-budgeted: any substantive turn whose text
 * matches an uninstalled, undeclined marketplace skill may fire, but each
 * skill is offered at most once per session so a repeated request never
 * becomes a nag. Detection is the local lexical matcher in
 * resources/skills/promotion.ts — no request text leaves the machine.
 *
 * At full-auto the offer collapses into an autonomous install, but ONLY from
 * Clio's own marketplace: every promotion-flow install (consented or
 * autonomous) passes `assertPromotionInstallSource`, the hard runtime gate
 * that rejects public registries in code rather than prompt text.
 *
 * Coordinator-only by wiring: this registration is created in the
 * orchestrator entry and never in a dispatch worker's loop, so workers can
 * neither see nor trigger offers.
 */

export const MARKETPLACE_OFFER_REGISTRATION_ID = "observer.marketplace-offer";

export interface MarketplaceOfferInstallResult {
	path: string;
	/** The source the skill was fetched from; surfaced so an autonomous install stays auditable. */
	sourceUrl: string;
	/** Normalized content hash of what was written; the integrity record the consent overlay would have shown. */
	installedHash: string;
}

export interface MarketplaceOfferDeps {
	/** Installed skill names the matcher must exclude. */
	listInstalledSkillNames(): ReadonlyArray<string>;
	/** The local marketplace lookup (catalog + index); already local-only. */
	listMarketplaceEntries(): ReadonlyArray<MarketplaceSkill>;
	/** The session's effective autonomy at evaluation time. */
	getAutonomy(): AutonomyLevel;
	/** Perform the install; the registration gates the source before calling. */
	installEntry(entry: MarketplaceSkill, scope: "user" | "project"): MarketplaceOfferInstallResult;
	/** Decline persistence; defaults to the promotion module's config-dir store. */
	declines?: {
		readNever(): Readonly<Record<string, string>>;
		recordNever(name: string): void;
	};
	/** Per-offer binding tag source; injectable for deterministic tests. Defaults to a random id. */
	newOfferTag?: () => string;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

/**
 * The tag the model must echo verbatim in its ask_user question so the harness
 * binds the answer to this specific offer and nothing else. The tag lives only
 * in a system reminder (a trusted channel), so prompt-injected user or file
 * content cannot forge it onto an unrelated question.
 */
export function offerBindingTag(offerTag: string): string {
	return `[clio-install:${offerTag}]`;
}

export function marketplaceOfferReminder(entry: MarketplaceSkill, offerTag: string): string {
	return (
		`[Marketplace] This request may need expertise no installed skill covers. The local marketplace has ` +
		`"${entry.name}" (not installed): ${entry.description} ` +
		`First check the installed side with context(scope="skills"); if ${entry.name} is genuinely the right fit ` +
		`and nothing installed serves, ask the operator with ask_user (mode=single_question, header "Install skill") ` +
		`whether to install ${entry.name}, offering exactly these options in this order: ` +
		`"${SKILL_INSTALL_OFFER_OPTION_PROJECT}", "${SKILL_INSTALL_OFFER_OPTION_USER}", ` +
		`"${SKILL_INSTALL_OFFER_OPTION_NOT_NOW}", "${SKILL_INSTALL_OFFER_OPTION_NEVER}". ` +
		`Include the exact tag ${offerBindingTag(offerTag)} verbatim in that question's text so the harness can bind ` +
		`the answer to this offer; the harness acts only on an answer carrying this tag. ` +
		`Then continue the task in the same turn. The harness handles the answer; never install or load a skill yourself. ` +
		`If it is not actually needed, do not mention it.`
	);
}

export function marketplaceAutoInstallReminder(entry: MarketplaceSkill, result: MarketplaceOfferInstallResult): string {
	// Full-auto skips the operator's yes/no, never the integrity record. The
	// consent overlay states the source and the SHA-256 of what it writes; the
	// autonomous path computes the same hash and must surface it here, so an
	// install nobody was asked about is still traceable to its source and bytes.
	return (
		`[Marketplace] Installed skill "${entry.name}" from Clio's own local marketplace (full-auto) to ${result.path}. ` +
		`Source ${result.sourceUrl}, sha256 ${result.installedHash}. ${entry.description} ` +
		`It is installed but not active — activation stays operator-gated. If it fits this task, ` +
		`suggest /skill ${entry.name} to the operator; never load it yourself.`
	);
}

interface AnswerLike {
	question: string;
	answer: string;
	options?: ReadonlyArray<string>;
}

function answersFromDetails(details: Readonly<Record<string, unknown>> | undefined): AnswerLike[] {
	const raw = details?.answers;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is AnswerLike =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as AnswerLike).question === "string" &&
			typeof (entry as AnswerLike).answer === "string",
	);
}

/** The offer option this answer chose, matched by exact label in options or by label substring in the one-line answer. */
function chosenOfferOption(answer: AnswerLike): string | null {
	const labels = [
		SKILL_INSTALL_OFFER_OPTION_PROJECT,
		SKILL_INSTALL_OFFER_OPTION_USER,
		SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
		SKILL_INSTALL_OFFER_OPTION_NEVER,
	];
	for (const label of labels) {
		if (answer.options?.includes(label)) return label;
	}
	for (const label of labels) {
		if (answer.answer.includes(label)) return label;
	}
	return null;
}

export function createMarketplaceOfferRegistration(deps: MarketplaceOfferDeps): MiddlewareHookRegistration {
	const declines = deps.declines ?? {
		readNever: () => readPromotionDeclines().never,
		recordNever: (name: string) => recordPromotionNeverDecline(name),
	};
	const newOfferTag = deps.newOfferTag ?? (() => randomUUID());
	// Per-session state, reset on a session id change (same adoption rule as
	// the skills reminder: a fresh session's opening turn fires with a null id
	// that the created session then fills in).
	let lastSeenSessionId: string | null | undefined;
	let offeredNames = new Set<string>();
	let sessionDeclines = new Set<string>();
	// The offer put to the operator, consumed by the ask_user after_tool
	// observer. Each offer carries a unique binding tag the model must echo in
	// its question; the observer acts only on an answer whose question carries
	// that tag, so an unrelated (or prompt-injected) ask_user answer can never
	// bind the pending offer.
	let pendingOffer: { entry: MarketplaceSkill; tag: string } | null = null;

	const trackSession = (input: MiddlewareHookInput): void => {
		const sessionId = input.sessionId ?? null;
		if (lastSeenSessionId === undefined || (lastSeenSessionId === null && sessionId !== null)) {
			lastSeenSessionId = sessionId;
			return;
		}
		if (sessionId !== lastSeenSessionId) {
			lastSeenSessionId = sessionId;
			offeredNames = new Set<string>();
			sessionDeclines = new Set<string>();
			pendingOffer = null;
		}
	};

	const bestMatch = (text: string): PromotionMatch | null => {
		let installed: ReadonlyArray<string>;
		let entries: ReadonlyArray<MarketplaceSkill>;
		let never: Readonly<Record<string, string>>;
		try {
			installed = deps.listInstalledSkillNames();
			entries = deps.listMarketplaceEntries();
			never = declines.readNever();
		} catch {
			return null;
		}
		const excluded = new Set<string>([...installed, ...Object.keys(never), ...sessionDeclines, ...offeredNames]);
		return matchMarketplaceSkills(text, entries, excluded)[0] ?? null;
	};

	const installGated = (entry: MarketplaceSkill, scope: "user" | "project"): MarketplaceOfferInstallResult => {
		assertPromotionInstallSource(entry);
		return deps.installEntry(entry, scope);
	};

	const evaluateAskUserAnswers = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		const offer = pendingOffer;
		if (!offer) return NO_EFFECTS;
		const marker = offerBindingTag(offer.tag);
		if (input.toolResultDetails?.cancelled === true) {
			// A cancelled interview carries no question text, so it cannot be
			// attributed to this offer. Do not bind it: an unrelated cancel must
			// not decline our offer, and the offer stays armed for a later answer.
			return NO_EFFECTS;
		}
		for (const answer of answersFromDetails(input.toolResultDetails)) {
			// The answer binds only when its question carries this offer's tag.
			if (!answer.question.includes(marker)) continue;
			const option = chosenOfferOption(answer);
			if (option === null) continue;
			pendingOffer = null;
			if (option === SKILL_INSTALL_OFFER_OPTION_NOT_NOW) {
				sessionDeclines.add(offer.entry.name);
				return NO_EFFECTS;
			}
			if (option === SKILL_INSTALL_OFFER_OPTION_NEVER) {
				sessionDeclines.add(offer.entry.name);
				try {
					declines.recordNever(offer.entry.name);
				} catch {
					// Persistence failure degrades to a session decline.
				}
				return NO_EFFECTS;
			}
			const scope = option === SKILL_INSTALL_OFFER_OPTION_USER ? "user" : "project";
			try {
				const result = installGated(offer.entry, scope);
				return [
					{
						kind: "annotate_tool_result",
						severity: "info",
						message:
							`[Marketplace] Installed skill "${offer.entry.name}" (${scope} scope) to ${result.path}. ` +
							`It is installed but not active; the operator activates it with /skill ${offer.entry.name}.`,
					},
				];
			} catch (error) {
				sessionDeclines.add(offer.entry.name);
				return [
					{
						kind: "annotate_tool_result",
						severity: "warn",
						message: `[Marketplace] Install of "${offer.entry.name}" failed: ${
							error instanceof Error ? error.message : String(error)
						}. Continue the task without it.`,
					},
				];
			}
		}
		return NO_EFFECTS;
	};

	return {
		id: MARKETPLACE_OFFER_REGISTRATION_ID,
		description:
			"offers an uninstalled marketplace skill via ask_user when the request matches it; consented installs run gated to Clio's own marketplace, declines are remembered",
		hooks: ["turn_start", "after_tool"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			trackSession(input);
			// The offer is deliberately NOT cleared at turn_end. The reminder asks
			// the model to put the ask_user question in the same turn, but it often
			// defers a turn; clearing here dropped that deferred answer on the floor,
			// so the operator's "Install" installed nothing and the model got no
			// signal to correct a likely success claim. The offer now stays armed
			// until a tag-carrying answer binds it, a newer offer replaces it, or the
			// session ends — safe because only a tagged answer can bind (see H4).
			if (input.hook === "after_tool") {
				return input.toolName === ToolNames.AskUser ? evaluateAskUserAnswers(input) : NO_EFFECTS;
			}
			if (input.hook !== "turn_start") return NO_EFFECTS;
			if (!isSubstantiveUserTurn(input.text)) return NO_EFFECTS;
			// The operator already chose a skill for this turn; an offer on top of
			// that choice is noise.
			const pendingSkillRequests = metadataNumber(input, "pendingSkillRequests");
			if (pendingSkillRequests !== null && pendingSkillRequests > 0) return NO_EFFECTS;
			const match = bestMatch(input.text ?? "");
			if (!match) return NO_EFFECTS;
			offeredNames.add(match.entry.name);
			if (deps.getAutonomy() === "full-auto") {
				try {
					const result = installGated(match.entry, "project");
					return [
						{
							kind: "inject_reminder",
							severity: "info",
							message: marketplaceAutoInstallReminder(match.entry, result),
						},
					];
				} catch {
					// Gate refusal or install failure: fall back to the consent offer
					// so the operator still hears about the match.
				}
			}
			const tag = newOfferTag();
			pendingOffer = { entry: match.entry, tag };
			return [{ kind: "inject_reminder", severity: "info", message: marketplaceOfferReminder(match.entry, tag) }];
		},
	};
}
