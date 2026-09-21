import {
	SKILL_INSTALL_OFFER_OPTION_NEVER,
	SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
	SKILL_INSTALL_OFFER_OPTION_PROJECT,
	SKILL_INSTALL_OFFER_OPTION_USER,
	SKILL_SUGGESTION_ANCHOR,
} from "../../../core/skill-activation.js";
import { type LexicalMatchMode, lexicalMatches } from "./lexical-match.js";
import type { Skill } from "./loader.js";
import type { MarketplaceSkill } from "./marketplace.js";

/**
 * The model-facing skills listing: which rows exist, which of them the caller
 * asked for, and how many of those fit the byte budget.
 *
 * It lives here rather than in the context tool for two reasons. The row model
 * and the query filter are resource concerns, and the tool should hold only the
 * call site. And the budget arithmetic wants to be testable without standing up
 * an observation reservation.
 *
 * Two properties this module exists to guarantee.
 *
 * A listing that is neither filtered nor cut renders byte-identical to what the
 * tool emitted before any of this existed. Narrowing is something the caller
 * opts into; the default view still shows every skill, because a ranked or
 * clipped default would decide for the model which skills it is allowed to
 * know about.
 *
 * The footer always survives. The listing used to be rendered whole and then
 * head-truncated against the per-call cap, which keeps the head and drops the
 * tail. The tail is the reply protocol, the one line a model actually acts on.
 * Here the footer is measured and reserved first and rows are fitted into what
 * is left, so an over-budget catalog loses catalog rows and says so, rather
 * than losing the instruction that tells the model what to do with them.
 */

/** Ordered lowest-value-last, which is also the order overflow drops them in. */
export type SkillCatalogRowKind = "ready" | "session" | "package" | "marketplace";

export interface SkillCatalogRow {
	kind: SkillCatalogRowKind;
	name: string;
	/** The rendered bullet, exactly as it appears in the listing. */
	line: string;
}

/** Disk-install state for one package, as {@link installedSkillPackages} reports it. */
export interface SkillCatalogPackage {
	name: string;
	names: string[];
	scope: string;
	state: string;
	origin: string;
	path: string;
}

export interface SkillCatalogViewInput {
	/** Model-visible skills, already filtered by trust and disable-model-invocation. */
	skills: ReadonlyArray<Skill>;
	packages: ReadonlyArray<SkillCatalogPackage>;
	marketplace: ReadonlyArray<MarketplaceSkill>;
	/** Names of ready skills whose content no longer matches its recorded hash. */
	drifted?: ReadonlySet<string>;
	/** False on a registry that never offers the marketplace, such as a worker. */
	marketplaceOffered: boolean;
	modelActivation: boolean;
	/** Operator/model query; empty means no filtering. */
	query?: string;
	/** Maximum rows on this page; undefined means every row the budget allows. */
	limit?: number | undefined;
	offset?: number;
	/** Per-call observation cap in bytes. */
	capBytes: number;
}

export interface SkillCatalogView {
	text: string;
	/** The rows actually rendered. */
	rows: SkillCatalogRow[];
	/** Rows matching the query across every kind, before paging. */
	total: number;
	shown: number;
	/** Offset to continue from, when rows remain. */
	nextOffset: number | undefined;
	/** True when a query was applied, whatever it matched. */
	filtered: boolean;
	/** Which token rule produced the matches; null when no query was applied. */
	matchMode: LexicalMatchMode | null;
	/** True when the byte budget, rather than the query or the limit, cut the page. */
	budgetLimited: boolean;
	/** Ready-row names reported as drifted in this result set. */
	driftedNames: string[];
}

const LISTING_HEADER = "Available skills.";
const SESSION_NOTE =
	"These skills were explicitly supplied for this session. Preserve their source; session availability does not mean Clio installed or copied them.";
const INTEROP_NOTE =
	"Other-agent skill folders are discovery-only. Explicitly import into Clio before use; the trust-imports setting does not install or activate loose files.";
const MARKETPLACE_HEADER = "Marketplace (additional skills available to install; /skill <name> offers to install):";
const SESSION_HEADER = "Explicitly supplied session skills (not installed packages):";
const EMPTY_WITH_MARKETPLACE = "No skills are available in Clio and no additional marketplace skills were found.";
const EMPTY_WITHOUT_MARKETPLACE = "No skills are available in Clio.";

/** Marks a ready row whose content no longer matches the hash recorded for it. */
const DRIFT_MARKER = " [drifted]";

/** Upper bound on the bytes the shown/total and continuation lines can take. */
const PAGE_NOTE_RESERVE = 320;

/** Ceiling on an explicit `limit`; the byte budget is the real bound. */
const MAX_LIMIT = 200;

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function activationProtocolLine(modelActivation: boolean): string {
	return modelActivation
		? `If one skill above matches the current task, load it now with context(scope="skills", name="<name>") and continue in the same turn; at this autonomy level you activate installed skills yourself and do not wait for the operator. Marketplace additions still require operator approval. If none match, do not mention skills.`
		: `If one skill above matches the current task, begin your reply with the line \`${SKILL_SUGGESTION_ANCHOR}\` (a comma-separated sequence, in order, when several compose), then continue the task in the same turn without it; only the operator can run it. If none match, do not mention skills.`;
}

function marketplaceOfferClause(): string {
	return `When no installed skill serves the task but a marketplace skill above genuinely does, you may instead ask the operator with ask_user (mode=single_question, header "Install skill") whether to install it, offering exactly: "${SKILL_INSTALL_OFFER_OPTION_PROJECT}", "${SKILL_INSTALL_OFFER_OPTION_USER}", "${SKILL_INSTALL_OFFER_OPTION_NOT_NOW}", "${SKILL_INSTALL_OFFER_OPTION_NEVER}". The harness handles those exact offer options. An explicit operator request or approval also authorizes the documented library install CLI. After installation, refresh the inventory; distinguish installed from ready and report /library reload when required.`;
}

/**
 * One sentence, only when something actually drifted.
 *
 * Visibility and nothing else. The skill stays listed, stays ready and stays
 * loadable; the operator owns the installed copy and this does not reinstall,
 * repair, suppress or reorder anything. It exists because the drift warning
 * used to arrive only after the model had already spent a turn loading the
 * skill, which is too late to choose a different one.
 */
function driftNotice(names: ReadonlyArray<string>): string {
	if (names.length === 0) return "";
	const subject = names.length === 1 ? `${names[0]} no longer matches` : `${names.join(", ")} no longer match`;
	return `Marked [drifted]: ${subject} the content hash recorded for it; the skill still loads unchanged, and /library shows the installed copy.`;
}

function readySkills(skills: ReadonlyArray<Skill>): Skill[] {
	return skills.filter((skill) => skill.source === "clio-coder" || skill.source === "plugin");
}

function sessionSkills(skills: ReadonlyArray<Skill>): Skill[] {
	return skills.filter((skill) => skill.source !== "clio-coder" && skill.source !== "plugin");
}

/** The text a query is matched against, per row kind. */
function haystackForSkill(skill: Skill): string {
	const triggers = skill.metadata.triggers;
	const triggerText = Array.isArray(triggers)
		? triggers.filter((entry): entry is string => typeof entry === "string").join(" ")
		: "";
	return `${skill.name.replace(/-/g, " ")} ${skill.description} ${triggerText}`;
}

function haystackForMarketplace(entry: MarketplaceSkill): string {
	return `${entry.name.replace(/-/g, " ")} ${entry.description} ${entry.category ?? ""} ${(entry.triggers ?? []).join(" ")}`;
}

function haystackForPackage(record: SkillCatalogPackage): string {
	return `${record.name.replace(/-/g, " ")} ${record.names.join(" ").replace(/-/g, " ")}`;
}

interface CandidateRow extends SkillCatalogRow {
	haystack: string;
}

function buildRows(input: SkillCatalogViewInput): CandidateRow[] {
	const drifted = input.drifted ?? new Set<string>();
	const rows: CandidateRow[] = [];
	for (const skill of readySkills(input.skills)) {
		const marker = drifted.has(skill.name) ? DRIFT_MARKER : "";
		rows.push({
			kind: "ready",
			name: skill.name,
			line: `- ${skill.name}${marker} (source: ${skill.source}; scope: ${skill.scope}): ${skill.description}`,
			haystack: haystackForSkill(skill),
		});
	}
	for (const skill of sessionSkills(input.skills)) {
		rows.push({
			kind: "session",
			name: skill.name,
			line: `- ${skill.name} (source: ${skill.source}; scope: ${skill.scope}; file: ${skill.filePath}): ${skill.description}`,
			haystack: haystackForSkill(skill),
		});
	}
	for (const record of input.packages) {
		rows.push({
			kind: "package",
			name: record.name,
			line: `- ${record.name} (scope: ${record.scope}; origin: ${record.origin === "catalog" ? "marketplace catalog" : record.origin}; state: ${record.state}; path: ${record.path})`,
			haystack: haystackForPackage(record),
		});
	}
	for (const entry of input.marketplace) {
		const category = entry.category ? ` [${entry.category}]` : "";
		rows.push({
			kind: "marketplace",
			name: entry.name,
			line: `- ${entry.name}${category}: ${entry.description}`,
			haystack: haystackForMarketplace(entry),
		});
	}
	return rows;
}

/**
 * Narrow to the rows the query asked for.
 *
 * `all` first, then `any`. A precise query ("worktree merge") should narrow to
 * the rows carrying both words, but a query written as a sentence would then
 * match nothing, and an empty page is a worse answer than a broad one. The
 * chosen mode is reported so the payload can say which happened.
 */
function selectRows(
	rows: ReadonlyArray<CandidateRow>,
	query: string,
): { rows: CandidateRow[]; mode: LexicalMatchMode } {
	const strict = rows.filter((row) => lexicalMatches(query, row.haystack, "all"));
	if (strict.length > 0) return { rows: strict, mode: "all" };
	return { rows: rows.filter((row) => lexicalMatches(query, row.haystack, "any")), mode: "any" };
}

/**
 * Bytes every line that is not a catalog row could take, measured with every
 * optional section present.
 *
 * Over-reserving is the safe direction: the real rendering is always at most
 * this much scaffolding, so a page fitted against this bound cannot overrun the
 * cap once the shorter real text is written. Under-reserving would put the
 * whole listing back through the truncation this module exists to avoid.
 */
function scaffoldBytes(input: SkillCatalogViewInput, drift: string): number {
	const lines = [
		LISTING_HEADER,
		"",
		`Ready skills in Clio (${input.skills.length}):`,
		"- none",
		"",
		SESSION_HEADER,
		SESSION_NOTE,
		"",
		`Installed packages providing skills (${input.packages.length}):`,
		"",
		INTEROP_NOTE,
		"",
		MARKETPLACE_HEADER,
		"",
		activationProtocolLine(input.modelActivation),
		marketplaceOfferClause(),
		drift,
	];
	return byteLength(lines.join("\n")) + PAGE_NOTE_RESERVE;
}

function renderSections(rows: ReadonlyArray<SkillCatalogRow>, input: SkillCatalogViewInput, drift: string): string {
	const ready = rows.filter((row) => row.kind === "ready");
	const session = rows.filter((row) => row.kind === "session");
	const packages = rows.filter((row) => row.kind === "package");
	const marketplace = rows.filter((row) => row.kind === "marketplace");

	const lines = [LISTING_HEADER, ""];
	lines.push(`Ready skills in Clio (${ready.length}):`);
	if (ready.length === 0) lines.push("- none");
	for (const row of ready) lines.push(row.line);
	if (session.length > 0) {
		lines.push("", SESSION_HEADER);
		for (const row of session) lines.push(row.line);
		lines.push(SESSION_NOTE);
	}
	if (packages.length > 0) {
		lines.push("", `Installed packages providing skills (${packages.length}):`);
		for (const row of packages) lines.push(row.line);
	}
	lines.push("", INTEROP_NOTE);
	if (marketplace.length > 0) {
		lines.push("", MARKETPLACE_HEADER);
		for (const row of marketplace) lines.push(row.line);
	}
	if (drift.length > 0) lines.push("", drift);
	lines.push("", activationProtocolLine(input.modelActivation));
	if (marketplace.length > 0) lines.push(marketplaceOfferClause());
	return lines.join("\n");
}

function clampLimit(limit: number | undefined, fallback: number): number {
	if (limit === undefined || !Number.isFinite(limit)) return fallback;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
	if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
	return Math.floor(offset);
}

/**
 * The listing, narrowed and fitted.
 *
 * A catalog with nothing in it keeps the exact sentence the tool emitted
 * before, including the distinction between "no marketplace was offered" and
 * "the marketplace was offered and had nothing", because a worker registry must
 * not claim a marketplace is unconfigured when it simply has none of its own.
 */
export function buildSkillCatalogView(input: SkillCatalogViewInput): SkillCatalogView {
	const query = (input.query ?? "").trim();
	const filtered = query.length > 0;
	const all = buildRows(input);

	if (all.length === 0 && !filtered) {
		return {
			text: input.marketplaceOffered ? EMPTY_WITH_MARKETPLACE : EMPTY_WITHOUT_MARKETPLACE,
			rows: [],
			total: 0,
			shown: 0,
			nextOffset: undefined,
			filtered: false,
			matchMode: null,
			budgetLimited: false,
			driftedNames: [],
		};
	}

	const selected = filtered ? selectRows(all, query) : { rows: [...all], mode: null as LexicalMatchMode | null };
	const matching = selected.rows;
	const total = matching.length;
	const offset = clampOffset(input.offset);
	const limit = clampLimit(input.limit, total);
	const window = matching.slice(offset, offset + limit);

	// The drift notice describes the matched result set, not the page: a drifted
	// skill the caller filtered to is worth naming even when paging pushed its
	// row to the next offset.
	const driftedNames = matching
		.filter((row) => row.kind === "ready" && row.line.includes(DRIFT_MARKER))
		.map((row) => row.name);
	const drift = driftNotice(driftedNames);

	const budget = input.capBytes - scaffoldBytes(input, drift);
	const page: SkillCatalogRow[] = [];
	let used = 0;
	let budgetLimited = false;
	for (const row of window) {
		const cost = byteLength(row.line) + 1;
		if (used + cost > budget) {
			budgetLimited = true;
			break;
		}
		used += cost;
		page.push({ kind: row.kind, name: row.name, line: row.line });
	}

	const consumed = offset + page.length;
	// A page that carried nothing must not hand back the offset it was given:
	// that is a loop, not a continuation.
	const nextOffset = page.length > 0 && consumed < total ? consumed : undefined;
	const body = renderSections(page, input, drift);
	const note = pageNote({
		filtered,
		query,
		matchMode: selected.mode,
		total,
		shown: page.length,
		offset,
		nextOffset,
		budgetLimited,
		catalogTotal: all.length,
	});

	return {
		text: note.length > 0 ? `${body}\n${note}` : body,
		rows: page,
		total,
		shown: page.length,
		nextOffset,
		filtered,
		matchMode: selected.mode,
		budgetLimited,
		driftedNames,
	};
}

interface PageNoteInput {
	filtered: boolean;
	query: string;
	matchMode: LexicalMatchMode | null;
	total: number;
	shown: number;
	offset: number;
	nextOffset: number | undefined;
	budgetLimited: boolean;
	catalogTotal: number;
}

/**
 * Emitted only when the view is narrowed or cut.
 *
 * A complete unfiltered listing gains no new text at all, which is what keeps
 * the default view byte-identical to the one this module replaced. Everything
 * here is a statement about what the caller is *not* seeing, so a view that
 * hides nothing has nothing to say.
 */
function pageNote(input: PageNoteInput): string {
	const clauses: string[] = [];
	if (input.filtered) {
		const broadened = input.matchMode === "any" ? ", matched on any query word after no row matched them all" : "";
		clauses.push(
			input.total === 0
				? `No skill matches "${input.query}"; ${input.catalogTotal} are available unfiltered, so drop query to list them.`
				: `Filtered by "${input.query}"${broadened}: ${input.total} of ${input.catalogTotal} rows match.`,
		);
	}
	if (input.shown < input.total) {
		clauses.push(
			input.budgetLimited
				? `Showing ${input.shown} of ${input.total} matching rows; the rest did not fit this call's budget.`
				: `Showing ${input.shown} of ${input.total} matching rows.`,
		);
	}
	if (input.nextOffset !== undefined) {
		clauses.push(`Continue with context(scope="skills", offset=${input.nextOffset}) for the remainder.`);
	} else if (input.shown < input.total) {
		clauses.push("The remainder cannot be carried this turn; narrow with query or continue in a follow-up turn.");
	}
	return clauses.join(" ");
}
