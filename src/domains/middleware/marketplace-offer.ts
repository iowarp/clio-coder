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
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

export function marketplaceOfferReminder(entry: MarketplaceSkill): string {
	return (
		`[Marketplace] This request may need expertise no installed skill covers. The local marketplace has ` +
		`"${entry.name}" (not installed): ${entry.description} ` +
		`First check the installed side with context(scope="skills"); if ${entry.name} is genuinely the right fit ` +
		`and nothing installed serves, ask the operator with ask_user (mode=single_question, header "Install skill") ` +
		`whether to install ${entry.name}, offering exactly these options in this order: ` +
		`"${SKILL_INSTALL_OFFER_OPTION_PROJECT}", "${SKILL_INSTALL_OFFER_OPTION_USER}", ` +
		`"${SKILL_INSTALL_OFFER_OPTION_NOT_NOW}", "${SKILL_INSTALL_OFFER_OPTION_NEVER}". ` +
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
	// Per-session state, reset on a session id change (same adoption rule as
	// the skills reminder: a fresh session's opening turn fires with a null id
	// that the created session then fills in).
	let lastSeenSessionId: string | null | undefined;
	let offeredNames = new Set<string>();
	let sessionDeclines = new Set<string>();
	// The offer put to the operator this turn; consumed by the ask_user
	// after_tool observer, cleared at turn_end so a stale offer can never bind
	// a later, unrelated answer.
	let pendingOffer: MarketplaceSkill | null = null;

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
		if (input.toolResultDetails?.cancelled === true) {
			// A cancelled interview is the soft dismiss: session-only decline.
			sessionDeclines.add(offer.name);
			pendingOffer = null;
			return NO_EFFECTS;
		}
		for (const answer of answersFromDetails(input.toolResultDetails)) {
			const option = chosenOfferOption(answer);
			if (option === null) continue;
			pendingOffer = null;
			if (option === SKILL_INSTALL_OFFER_OPTION_NOT_NOW) {
				sessionDeclines.add(offer.name);
				return NO_EFFECTS;
			}
			if (option === SKILL_INSTALL_OFFER_OPTION_NEVER) {
				sessionDeclines.add(offer.name);
				try {
					declines.recordNever(offer.name);
				} catch {
					// Persistence failure degrades to a session decline.
				}
				return NO_EFFECTS;
			}
			const scope = option === SKILL_INSTALL_OFFER_OPTION_USER ? "user" : "project";
			try {
				const result = installGated(offer, scope);
				return [
					{
						kind: "annotate_tool_result",
						severity: "info",
						message:
							`[Marketplace] Installed skill "${offer.name}" (${scope} scope) to ${result.path}. ` +
							`It is installed but not active; the operator activates it with /skill ${offer.name}.`,
					},
				];
			} catch (error) {
				sessionDeclines.add(offer.name);
				return [
					{
						kind: "annotate_tool_result",
						severity: "warn",
						message: `[Marketplace] Install of "${offer.name}" failed: ${
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
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			trackSession(input);
			if (input.hook === "turn_end") {
				pendingOffer = null;
				return NO_EFFECTS;
			}
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
			pendingOffer = match.entry;
			return [{ kind: "inject_reminder", severity: "info", message: marketplaceOfferReminder(match.entry) }];
		},
	};
}
