import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioConfigDir } from "../../../core/xdg.js";
import type { MarketplaceSkill } from "./marketplace.js";

/**
 * Marketplace self-promotion: local detection that an uninstalled marketplace
 * skill serves the operator's current request, plus the two policy pieces the
 * offer flow needs — the persistent "never offer this skill" store and the
 * own-marketplace source gate that bounds what a promotion-flow install may
 * ever fetch.
 *
 * Detection is a pure lexical match against the local catalog: no model call,
 * no network, and no request text ever leaves the process. False positives
 * cost operator trust, so the matcher is deliberately conservative — a
 * trigger-phrase hit or a strong distinctive-token overlap fires; anything
 * weaker stays silent and the broad paths (the first-turn reminder,
 * context(scope="skills")) remain the fallback.
 */

export interface PromotionMatch {
	entry: MarketplaceSkill;
	score: number;
	/** The trigger phrase that fired, when the match came from one. */
	matchedTrigger?: string;
}

const TOKEN_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"for",
	"with",
	"this",
	"that",
	"when",
	"what",
	"how",
	"into",
	"from",
	"use",
	"used",
	"using",
	"one",
	"not",
	"skill",
	"skills",
	"clio",
	"please",
	"can",
	"you",
	"should",
	"would",
	"about",
	"need",
	"want",
	"help",
	"make",
	"file",
	"files",
	"code",
]);

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Distinctive tokens: 4+ chars and outside the stopword set. */
function distinctiveTokens(text: string): Set<string> {
	return new Set(
		normalize(text)
			.split(" ")
			.filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token)),
	);
}

const TRIGGER_SCORE = 4;
/** Distinct description/name token overlaps required to fire without a trigger. */
const TOKEN_FIRE_THRESHOLD = 3;

/**
 * Score one marketplace entry against the operator's request text. A trigger
 * phrase is a whole-phrase substring match on normalized text; token overlap
 * is a fallback for skills whose triggers have not been authored yet.
 */
export function scorePromotionEntry(userText: string, entry: MarketplaceSkill): PromotionMatch | null {
	const haystack = ` ${normalize(userText)} `;
	if (haystack.trim().length === 0) return null;
	for (const trigger of entry.triggers ?? []) {
		const phrase = normalize(trigger);
		if (phrase.length >= 4 && haystack.includes(` ${phrase} `)) {
			return { entry, score: TRIGGER_SCORE, matchedTrigger: trigger };
		}
	}
	const requestTokens = distinctiveTokens(userText);
	if (requestTokens.size === 0) return null;
	const entryTokens = distinctiveTokens(`${entry.name.replace(/-/g, " ")} ${entry.description}`);
	let overlap = 0;
	for (const token of requestTokens) if (entryTokens.has(token)) overlap += 1;
	return overlap >= TOKEN_FIRE_THRESHOLD ? { entry, score: overlap } : null;
}

/**
 * The uninstalled marketplace entries that match the request, best first.
 * `excludedNames` carries installed skills plus every decline scope the
 * caller tracks; the matcher itself is stateless.
 */
export function matchMarketplaceSkills(
	userText: string,
	entries: ReadonlyArray<MarketplaceSkill>,
	excludedNames: ReadonlySet<string>,
): PromotionMatch[] {
	const matches: PromotionMatch[] = [];
	for (const entry of entries) {
		if (entry.kind !== "skill" || excludedNames.has(entry.name)) continue;
		const match = scorePromotionEntry(userText, entry);
		if (match) matches.push(match);
	}
	return matches.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

/**
 * The hard runtime gate on promotion-flow installs: only Clio's own
 * marketplace is ever an acceptable source, whether the install runs on
 * operator consent or autonomously at full-auto. A local path is the shipped
 * package catalog (install copies files, no network); the one acceptable URL
 * shape is this project's own repository tree. Public skill registries and
 * arbitrary GitHub sources are rejected here, in code — a prompt instruction
 * is not the enforcement mechanism.
 *
 * This gates the promotion flow only. Operator-driven installs through
 * `clio-coder skills install <url>` keep their existing behavior.
 */
export const OWN_MARKETPLACE_URL_PREFIX = "https://github.com/iowarp/clio-coder/";

export function isOwnMarketplaceSource(entry: Pick<MarketplaceSkill, "origin" | "sourceUrl">): boolean {
	const source = entry.sourceUrl.trim();
	if (/^(?:https?:\/\/|git@)/.test(source)) return source.startsWith(OWN_MARKETPLACE_URL_PREFIX);
	// A non-URL source is a local filesystem path; only catalog discovery
	// produces those, and it resolves them against the shipped package.
	return entry.origin === "catalog" && path.isAbsolute(source);
}

export function assertPromotionInstallSource(entry: MarketplaceSkill): void {
	if (isOwnMarketplaceSource(entry)) return;
	throw new Error(
		`skill promotion: refusing to install "${entry.name}" from ${entry.sourceUrl}; ` +
			"promotion installs only from Clio's own marketplace (local catalog or " +
			`${OWN_MARKETPLACE_URL_PREFIX}). Install manually with clio-coder skills install if intended.`,
	);
}

/**
 * Persistent "never offer this skill" store. Session-scoped declines live in
 * the offer registration's memory and die with the session; this file holds
 * only the explicit fourth option. It is a standalone JSON document in the
 * config dir rather than a settings key because the settings-v2 manifest is
 * owned elsewhere this sprint; the proposed key for a later migration is
 * `skills.promotionDeclines`.
 */
export const PROMOTION_DECLINES_FILE = "skill-promotion-declines.json";

export interface PromotionDeclineStore {
	/** decline key (name@version) -> ISO timestamp of the operator's "never" answer. */
	never: Record<string, string>;
}

/**
 * The decline store key. A "never" answer is scoped to the catalog version the
 * operator saw, so a later version of the same skill is offerable again while a
 * re-published identical version stays declined. Absent version keys as
 * `name@`, distinct from any real version, so it re-offers once a version
 * appears.
 */
export function declineKey(name: string, version?: string): string {
	return `${name}@${version ?? ""}`;
}

function declinesPath(configDir?: string): string {
	return path.join(configDir ?? clioConfigDir(), PROMOTION_DECLINES_FILE);
}

export function readPromotionDeclines(configDir?: string): PromotionDeclineStore {
	const file = declinesPath(configDir);
	if (!existsSync(file)) return { never: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		const never =
			parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { never?: unknown }).never : undefined;
		if (never && typeof never === "object" && !Array.isArray(never)) {
			const entries = Object.entries(never as Record<string, unknown>).filter(
				(pair): pair is [string, string] => typeof pair[1] === "string",
			);
			return { never: Object.fromEntries(entries) };
		}
	} catch {
		// An unreadable store means no recorded declines; the worst outcome is
		// one extra offer, which the operator can re-decline.
	}
	return { never: {} };
}

export function recordPromotionNeverDecline(name: string, version?: string, configDir?: string): void {
	const store = readPromotionDeclines(configDir);
	store.never[declineKey(name, version)] = new Date().toISOString();
	safeResourceWrite(declinesPath(configDir), `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8" });
}
