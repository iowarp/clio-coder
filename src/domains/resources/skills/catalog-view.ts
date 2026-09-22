import { type PrecomputedRanking, rankByPrecomputedScore } from "../../../core/precomputed-rank.js";
import {
	SKILL_INSTALL_OFFER_OPTION_NEVER,
	SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
	SKILL_INSTALL_OFFER_OPTION_PROJECT,
	SKILL_INSTALL_OFFER_OPTION_USER,
	SKILL_SUGGESTION_ANCHOR,
} from "../../../core/skill-activation.js";
import { type LexicalMatchMode, lexicalMatches, normalize } from "./lexical-match.js";
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

/** The same order {@link buildRows} emits, named so ranking can rebuild the blocks. */
const ROW_KIND_ORDER: ReadonlyArray<SkillCatalogRowKind> = ["ready", "session", "package", "marketplace"];

export interface SkillCatalogRow {
	kind: SkillCatalogRowKind;
	name: string;
	/** The rendered bullet, exactly as it appears in the listing. */
	line: string;
	/** Typed drift state. Never re-derived by reading the rendered line back. */
	drifted: boolean;
	/**
	 * Stable identity for this row, unique across the whole listing.
	 *
	 * A name is not an identity here. One installed standalone skill produces a
	 * ready row and a package row under the same name, and the same package id
	 * can be installed at both user and project scope. Callers that reconcile a
	 * page against their own inventories have to match on this, not on the name.
	 */
	key: string;
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
	/**
	 * Per-skill-name relevance from a decision model, resolved before the turn.
	 *
	 * It orders rows and never removes one. A skill the model cannot see is a
	 * capability it cannot use and has no way to ask for, so a wrong judgment
	 * must cost position rather than visibility. Paging already bounds the
	 * listing; ranking is what makes the first page carry the useful rows.
	 */
	relevance?: PrecomputedRanking;
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
	/** Who ordered the rows, or null when nothing did and the listing is in catalog order. */
	rankedBy: string | null;
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

/** Ceiling on an explicit `limit`; the byte budget is the real bound. */
const MAX_LIMIT = 200;

/** Code points of a caller-supplied query echoed back in the note. */
const MAX_QUERY_ECHO = 48;
/** Code points of a name echoed back in the note. */
const MAX_NAME_ECHO = 64;
/** Drifted skills named individually before the notice reports a remainder. */
const MAX_DRIFT_NAMES = 6;

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Clip by code point, not by UTF-16 unit, so a surrogate pair is never split
 * into a lone half and a multi-byte script is bounded by what it reads as
 * rather than by how it happens to encode.
 */
function boundText(text: string, maxCodePoints: number): string {
	const points = [...text];
	if (points.length <= maxCodePoints) return text;
	return `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

/** Echoing the caller's query must not let one argument size the response. */
function boundQuery(query: string): string {
	return boundText(query.replace(/\s+/g, " ").trim(), MAX_QUERY_ECHO);
}

function boundName(name: string): string {
	return boundText(name, MAX_NAME_ECHO);
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
	// Bounded: a catalog where everything drifted would otherwise put every name
	// in one sentence and size the response by how much is wrong.
	const shown = names.slice(0, MAX_DRIFT_NAMES).map(boundName);
	const omitted = names.length - shown.length;
	const list = omitted > 0 ? `${shown.join(", ")} and ${omitted} more` : shown.join(", ");
	const subject = names.length === 1 ? `${list} no longer matches` : `${list} no longer match`;
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
		const isDrifted = drifted.has(skill.name);
		rows.push({
			kind: "ready",
			name: skill.name,
			key: `ready:${skill.filePath}`,
			drifted: isDrifted,
			line: `- ${skill.name}${isDrifted ? DRIFT_MARKER : ""} (source: ${skill.source}; scope: ${skill.scope}): ${skill.description}`,
			haystack: haystackForSkill(skill),
		});
	}
	for (const skill of sessionSkills(input.skills)) {
		rows.push({
			kind: "session",
			name: skill.name,
			key: `session:${skill.filePath}`,
			drifted: false,
			line: `- ${skill.name} (source: ${skill.source}; scope: ${skill.scope}; file: ${skill.filePath}): ${skill.description}`,
			haystack: haystackForSkill(skill),
		});
	}
	for (const record of input.packages) {
		rows.push({
			kind: "package",
			name: record.name,
			key: `package:${record.scope}:${record.path}`,
			drifted: false,
			line: `- ${record.name} (scope: ${record.scope}; origin: ${record.origin === "catalog" ? "marketplace catalog" : record.origin}; state: ${record.state}; path: ${record.path})`,
			haystack: haystackForPackage(record),
		});
	}
	for (const entry of input.marketplace) {
		const category = entry.category ? ` [${entry.category}]` : "";
		rows.push({
			kind: "marketplace",
			name: entry.name,
			key: `marketplace:${entry.sourceUrl}`,
			drifted: false,
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
 * Order rows by relevance inside each kind, keeping every row.
 *
 * The kind blocks stay put because their order is also the order overflow drops
 * them in: a highly ranked marketplace row must not cost a ready skill its
 * place on the page. Inside a block, scored rows sort by score and an unscored
 * row keeps the slot the catalog gave it, so an abstention is not read as a
 * judgment that the skill is irrelevant.
 */
function rankRows(rows: ReadonlyArray<CandidateRow>, relevance: PrecomputedRanking): CandidateRow[] {
	return ROW_KIND_ORDER.flatMap((kind) =>
		rankByPrecomputedScore(
			rows.filter((row) => row.kind === kind),
			(row) => row.name,
			relevance.scores,
		).map(({ item }) => item),
	);
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
	const rawQuery = (input.query ?? "").trim();
	// A query of punctuation or emoji normalizes to nothing searchable. Filtering
	// on it would return an empty page for a request that carried no terms, so it
	// is treated as no query and the note says the terms were dropped.
	const query = normalize(rawQuery).length > 0 ? rawQuery : "";
	const emptyTerms = rawQuery.length > 0 && query.length === 0;
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
			rankedBy: null,
			driftedNames: [],
		};
	}

	const selected = filtered ? selectRows(all, query) : { rows: [...all], mode: null as LexicalMatchMode | null };
	// Ranking runs after the query, on the rows that are actually about to be
	// paged, so an unscored row holds its position in the list the caller sees
	// rather than in one the filter already changed.
	const matching = input.relevance === undefined ? selected.rows : rankRows(selected.rows, input.relevance);
	// Named only when the pass had an opinion on a row the caller is about to
	// see. A ranking in which every row abstained left the catalog order intact,
	// and claiming a relevance order for it would explain an order nothing made.
	const scores = input.relevance?.scores;
	const rankedBy =
		input.relevance !== undefined &&
		scores !== undefined &&
		selected.rows.some((row) => Number.isFinite(scores[row.name]))
			? boundName(input.relevance.source)
			: null;
	const total = matching.length;
	const offset = clampOffset(input.offset);
	const limit = clampLimit(input.limit, total);
	const window = matching.slice(offset, offset + limit);

	// The drift notice describes the matched result set, not the page: a drifted
	// skill the caller filtered to is worth naming even when paging pushed its
	// row to the next offset. Read from the typed flag, never from the rendered
	// line, so a description that happens to contain the marker text cannot give
	// a healthy skill a drift footer.
	const driftedNames = matching.filter((row) => row.drifted).map((row) => row.name);

	const context: RenderContext = {
		input,
		drift: driftNotice(driftedNames),
		filtered,
		emptyTerms,
		query,
		matchMode: selected.mode,
		rankedBy,
		total,
		offset,
		catalogTotal: all.length,
		window,
	};

	// The whole window first, so an inventory that exactly fits is never cut. The
	// previous version reserved scaffolding for sections that did not exist and
	// dropped complete listings that fitted with room to spare.
	const whole = renderCandidate(context, window.length, false);
	if (byteLength(whole) <= input.capBytes) {
		return finishView(context, window, whole, false);
	}

	// Bisection is valid only over row counts of one or more.
	//
	// For k >= 1 the rendered size is non-decreasing in k: each extra row adds
	// its line and, at a section's first row, that section's heading, while the
	// note only grows by the digits of a larger count. A zero-row page is NOT on
	// that curve, because it alone carries the "this row is too large, open it
	// directly" sentence, which a one-row page does not. Including 0 in the
	// search let a midpoint of 0 test larger than a one-row page and report that
	// nothing fits while the first row would have fitted comfortably.
	let low = 1;
	let high = window.length - 1;
	let best = -1;
	let bestText = "";
	while (low <= high) {
		const mid = (low + high) >> 1;
		const text = renderCandidate(context, mid, true);
		if (byteLength(text) <= input.capBytes) {
			best = mid;
			bestText = text;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	if (best >= 1) return finishView(context, window.slice(0, best), bestText, true);

	// No row fits. The zero-row page is measured on its own, off the monotonic
	// curve, because it says something the others do not.
	const blocked = renderCandidate(context, 0, true);
	if (byteLength(blocked) <= input.capBytes) {
		return finishView(context, [], blocked, true);
	}
	// Not even the scaffolding fits. Say what is there and how to reach it, in a
	// line short enough to survive any usable reservation.
	return {
		text: compactFallback(context),
		rows: [],
		total,
		shown: 0,
		nextOffset: undefined,
		filtered,
		matchMode: selected.mode,
		budgetLimited: true,
		rankedBy,
		driftedNames,
	};
}

interface RenderContext {
	input: SkillCatalogViewInput;
	drift: string;
	filtered: boolean;
	emptyTerms: boolean;
	query: string;
	matchMode: LexicalMatchMode | null;
	rankedBy: string | null;
	total: number;
	offset: number;
	catalogTotal: number;
	window: ReadonlyArray<SkillCatalogRow>;
}

/** Where paging resumes, and whether a row too large to carry was stepped over. */
function continuation(context: RenderContext, shown: number): { nextOffset: number | undefined; blocked: boolean } {
	const consumed = context.offset + shown;
	if (consumed >= context.total) return { nextOffset: undefined, blocked: false };
	// A page that carried nothing must not hand back the offset it was given:
	// that is a loop, not a continuation. Stepping over the oversized row keeps
	// the rows behind it reachable, and the note names what was stepped over.
	if (shown === 0) return { nextOffset: context.offset + 1, blocked: true };
	return { nextOffset: consumed, blocked: false };
}

function renderCandidate(context: RenderContext, shown: number, cut: boolean): string {
	const page = context.window.slice(0, shown);
	const body = renderSections(page, context.input, context.drift);
	const { nextOffset, blocked } = continuation(context, shown);
	const note = pageNote({
		filtered: context.filtered,
		emptyTerms: context.emptyTerms,
		query: context.query,
		matchMode: context.matchMode,
		rankedBy: context.rankedBy,
		total: context.total,
		shown,
		nextOffset,
		budgetLimited: cut,
		blockedRow: blocked ? (context.window[0] ?? null) : null,
		catalogTotal: context.catalogTotal,
	});
	return note.length > 0 ? `${body}\n${note}` : body;
}

function finishView(
	context: RenderContext,
	page: ReadonlyArray<SkillCatalogRow>,
	text: string,
	budgetLimited: boolean,
): SkillCatalogView {
	const { nextOffset } = continuation(context, page.length);
	return {
		text,
		rows: page.map((row) => ({ ...row })),
		total: context.total,
		shown: page.length,
		nextOffset,
		filtered: context.filtered,
		matchMode: context.matchMode,
		budgetLimited,
		rankedBy: context.rankedBy,
		driftedNames: context.window.filter((row) => row.drifted).map((row) => row.name),
	};
}

/**
 * What to say when the reservation cannot carry the listing's own scaffolding.
 *
 * One short line naming the size of the thing and the one argument that makes
 * it smaller. Deliberately free of the reply protocol: a page that shows no
 * skills has nothing for the protocol to point at, and repeating it here would
 * be the same overrun in a smaller font.
 */
function compactFallback(context: RenderContext): string {
	const scope = context.filtered ? `${context.total} matching` : `${context.total}`;
	return `Available skills: ${scope}. This call's budget cannot carry the listing; narrow it with context(scope="skills", query="<terms>") or raise the budget in a fresh turn.`;
}

interface PageNoteInput {
	filtered: boolean;
	emptyTerms: boolean;
	query: string;
	matchMode: LexicalMatchMode | null;
	rankedBy: string | null;
	total: number;
	shown: number;
	nextOffset: number | undefined;
	budgetLimited: boolean;
	blockedRow: SkillCatalogRow | null;
	catalogTotal: number;
}

/**
 * Emitted only when the view is narrowed or cut.
 *
 * A complete unfiltered listing gains no new text at all, which is what keeps
 * the default view byte-identical to the one this module replaced. Everything
 * here is a statement about what the caller is *not* seeing, so a view that
 * hides nothing has nothing to say.
 *
 * Every value interpolated here is bounded. The query is a caller-supplied
 * string with no length limit in the schema, and the drift notice can name a
 * whole catalog, so echoing either whole would let one argument decide the size
 * of a response this module exists to keep inside its budget.
 */
function pageNote(input: PageNoteInput): string {
	const clauses: string[] = [];
	// An unexpected order is worth one sentence. Without it an operator reading a
	// listing that no longer matches the catalog order has no way to tell that a
	// decision model produced it, and a listing nothing ranked says nothing.
	if (input.rankedBy !== null) {
		clauses.push(
			`Ordered by relevance to this task, judged by ${input.rankedBy}; every skill is still listed and paging carries the rest.`,
		);
	}
	if (input.emptyTerms) {
		clauses.push("The query carried no searchable terms, so the full list is shown.");
	}
	if (input.filtered) {
		const broadened = input.matchMode === "any" ? ", matched on any query word after no row matched them all" : "";
		clauses.push(
			input.total === 0
				? `No skill matches "${boundQuery(input.query)}"; ${input.catalogTotal} are available unfiltered, so drop query to list them.`
				: `Filtered by "${boundQuery(input.query)}"${broadened}: ${input.total} of ${input.catalogTotal} rows match.`,
		);
	}
	if (input.shown < input.total) {
		clauses.push(
			input.budgetLimited
				? `Showing ${input.shown} of ${input.total} matching rows; the rest did not fit this call's budget.`
				: `Showing ${input.shown} of ${input.total} matching rows.`,
		);
	}
	if (input.blockedRow !== null) {
		clauses.push(
			`"${boundName(input.blockedRow.name)}" is too large to carry in this call's budget and was stepped over; open it directly with context(scope="skills", name="${boundName(input.blockedRow.name)}").`,
		);
	}
	if (input.nextOffset !== undefined) {
		clauses.push(
			input.filtered
				? // Offsets index the FILTERED result set. A continuation that dropped
					// the query would apply this cursor to the unfiltered catalog, which
					// repeats rows and skips matches.
					`Continue with the same query at offset=${input.nextOffset}; the offset indexes the filtered rows, so dropping query changes which rows it selects.`
				: `Continue with context(scope="skills", offset=${input.nextOffset}) for the remainder.`,
		);
	} else if (input.shown < input.total) {
		clauses.push("The remainder cannot be carried this turn; narrow with query or continue in a follow-up turn.");
	}
	return clauses.join(" ");
}
