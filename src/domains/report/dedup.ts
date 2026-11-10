import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { RenderedReport } from "./body.js";
import { type ReportCommandRunner, runReportCommand } from "./command.js";
import type { ReportDraft } from "./draft.js";
import { titleCore } from "./draft.js";
import { ghEnvironment, REPORT_GH_TIMEOUT_MS, type ReportTransport } from "./transport.js";
import { REPORT_REPOSITORY } from "./vocabulary.js";

export interface RelatedIssue {
	number: number;
	title: string;
	url: string;
	state: "open" | "closed";
	closedAt: string | null;
	updatedAt: string;
	labels: string[];
	score: number;
	fingerprintHit: boolean;
	/** The installed changelog's version heading above `#<number>`; null when the installed version does not cite it. */
	fixedIn: string | null;
}

export type RelatedVerdict =
	| { kind: "comment"; issue: RelatedIssue }
	| { kind: "upgrade"; issue: RelatedIssue; installed: string; latest: string }
	| { kind: "regression"; issue: RelatedIssue }
	| { kind: "create"; upgradeHint: string | null }
	| { kind: "unknown"; reason: string; searchUrl: string };

export interface RelatedResult {
	matches: RelatedIssue[];
	latestVersion: string | null;
	verdict: RelatedVerdict;
}

const STOP_WORDS: ReadonlySet<string> = new Set(
	(
		"a about after again all also an and any are as at be been before but by can cannot could did does doesn't " +
		"don't for from get gets had has have how i if in into is isn't it it's its just no not of on only or out " +
		"over same should so some than that the then there this to too up was wasn't we were what when where which " +
		"while why will with won't would you your clio coder clio-coder bug issue error fails failed broken works " +
		"work doesnt dont"
	).split(" "),
);

/**
 * Query words from a scrubbed title: lowercase, no conventional prefix, no stop words, no scrubber placeholder or
 * redaction marker, the six longest. The title passed in is the rendered one, so a masked name is already gone.
 */
export function titleTokens(title: string, limit = 6): string[] {
	const core = titleCore(title)
		.replace(/^regression:\s*/iu, "")
		.replace(/\[redacted:[^\]]*\]/gu, " ")
		.replace(/<[a-z]+>/gu, " ")
		.toLowerCase();
	const seen = new Set<string>();
	for (const raw of core.split(/[^a-z0-9._-]+/u)) {
		const token = raw.replace(/^[._-]+|[._-]+$/gu, "");
		if (token.length < 3 || STOP_WORDS.has(token) || /^\d+$/u.test(token)) continue;
		seen.add(token);
	}
	return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, limit);
}

export function titleQuery(tokens: ReadonlyArray<string>): string {
	return `repo:${REPORT_REPOSITORY} is:issue ${tokens.join(" ")}`.trim();
}

/** A search page the reporter opens when Clio cannot search for them. */
export function relatedSearchUrl(tokens: ReadonlyArray<string>): string {
	return `https://github.com/${REPORT_REPOSITORY}/issues?${new URLSearchParams({ q: `is:issue ${tokens.join(" ")}`.trim() }).toString()}`;
}

/** The version heading of the oldest section citing `#<number>`: the release that shipped the fix. */
export function changelogFixedIn(changelog: string, number: number): string | null {
	const cite = new RegExp(
		`(?:(?:^|[^\\w#/]|${REPORT_REPOSITORY})#${number}|github\\.com/${REPORT_REPOSITORY}/(?:issues|pull)/${number})(?!\\d)`,
		"u",
	);
	let heading: string | null = null;
	let found: string | null = null;
	for (const line of changelog.split("\n")) {
		const match = /^##\s+v?(\d+\.\d+\.\d+[^\s]*)/u.exec(line);
		if (match) heading = match[1] ?? null;
		else if (heading !== null && cite.test(line)) found = heading;
	}
	return found;
}

function readInstalledChangelog(): string | null {
	try {
		return readFileSync(join(resolvePackageRoot(), "CHANGELOG.md"), "utf8");
	} catch {
		// An install without its changelog cannot say a fix is in it.
		return null;
	}
}

type Triple = [number, number, number];

function versionTriple(version: string): Triple | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareTriples(a: Triple, b: Triple): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return shared / (a.size + b.size - shared);
}

const SCORE_FLOOR = 0.35;
const MAX_MATCHES = 3;
const AREA_BONUS = 0.15;
const AGE_PENALTY = 0.1;
const AGE_STEP_DAYS = 90;

interface SearchItem {
	number: number;
	title: string;
	url: string;
	state: "open" | "closed";
	closedAt: string | null;
	updatedAt: string;
	labels: string[];
}

function parseItems(stdout: string): SearchItem[] | null {
	try {
		const value: unknown = JSON.parse(stdout);
		if (!Array.isArray(value)) return null;
		const items: SearchItem[] = [];
		for (const raw of value) {
			const item = raw as Record<string, unknown>;
			if (typeof item.number !== "number" || typeof item.title !== "string") continue;
			items.push({
				number: item.number,
				title: item.title,
				url: `https://github.com/${REPORT_REPOSITORY}/issues/${item.number}`,
				state: item.state === "closed" ? "closed" : "open",
				closedAt: typeof item.closed_at === "string" ? item.closed_at : null,
				updatedAt: typeof item.updated_at === "string" ? item.updated_at : new Date(0).toISOString(),
				labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === "string") : [],
			});
		}
		return items;
	} catch {
		return null;
	}
}

const ITEM_PROJECTION =
	"[.items[] | select(.pull_request == null) | {number, title, state, closed_at, updated_at, labels: [.labels[].name]}]";

export interface RelatedDeps {
	run?: ReportCommandRunner;
	env?: NodeJS.ProcessEnv;
	/** The installed CHANGELOG.md text; read from the package when absent. */
	changelog?: string | null;
	now?: () => Date;
}

/**
 * Issues that may already describe this report, and what to offer. Runs only after the reporter pressed Send: the
 * query reaches GitHub. Every failure ends in `unknown`, never in a blocked report.
 */
export async function findRelated(
	draft: ReportDraft,
	rendered: Pick<RenderedReport, "title">,
	transport: ReportTransport,
	deps: RelatedDeps = {},
): Promise<RelatedResult> {
	const tokens = titleTokens(rendered.title);
	const searchUrl = relatedSearchUrl(tokens);
	if (transport.kind !== "gh")
		return {
			matches: [],
			latestVersion: null,
			verdict: { kind: "unknown", reason: "searching needs gh; open the link to look", searchUrl },
		};
	const run = deps.run ?? runReportCommand;
	const options = { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) };
	const search = async (q: string): Promise<SearchItem[] | null> => {
		const result = await run(
			transport.path,
			[
				"api",
				"--hostname",
				"github.com",
				"-X",
				"GET",
				"search/issues",
				"-f",
				`q=${q}`,
				"-f",
				"per_page=10",
				"--jq",
				ITEM_PROJECTION,
			],
			options,
		);
		return result.exitCode === 0 ? parseItems(result.stdout) : null;
	};
	const unknown = (): RelatedResult => ({
		matches: [],
		latestVersion: null,
		verdict: { kind: "unknown", reason: "the search could not run", searchUrl },
	});

	const isFeature = draft.kind === "feature";
	const fingerprint = !isFeature && draft.fingerprint !== null ? draft.fingerprint : null;
	const byFingerprint = fingerprint !== null ? await search(`repo:${REPORT_REPOSITORY} "${fingerprint}" in:body`) : [];
	if (byFingerprint === null) return unknown();
	const byTitle = tokens.length > 0 ? await search(titleQuery(tokens)) : [];
	if (byTitle === null) return unknown();

	let latestVersion: string | null = null;
	if (!isFeature) {
		const latest = await run(
			transport.path,
			["api", "--hostname", "github.com", `repos/${REPORT_REPOSITORY}/releases/latest`, "--jq", ".tag_name"],
			options,
		);
		const tag = latest.stdout.trim();
		if (latest.exitCode === 0 && versionTriple(tag) !== null) latestVersion = tag.replace(/^v/u, "");
	}

	const now = (deps.now ?? (() => new Date()))().getTime();
	const draftTokens = new Set(titleTokens(rendered.title, Number.POSITIVE_INFINITY));
	const fingerprintNumbers = new Set(byFingerprint.map((item) => item.number));
	const candidates = new Map<number, SearchItem>();
	for (const item of [...byFingerprint, ...byTitle]) candidates.set(item.number, item);
	const changelog = deps.changelog === undefined ? readInstalledChangelog() : deps.changelog;

	const matches: RelatedIssue[] = [];
	for (const item of candidates.values()) {
		const fingerprintHit = fingerprintNumbers.has(item.number);
		let score = 1;
		if (!fingerprintHit) {
			const days = Math.max(0, (now - Date.parse(item.updatedAt)) / 86_400_000);
			score =
				jaccard(draftTokens, new Set(titleTokens(item.title, Number.POSITIVE_INFINITY))) +
				(draft.area !== null && item.labels.includes(`area:${draft.area}`) ? AREA_BONUS : 0) -
				AGE_PENALTY * Math.floor(days / AGE_STEP_DAYS);
		}
		if (score < SCORE_FLOOR) continue;
		const fixedIn = item.state === "closed" && changelog !== null ? changelogFixedIn(changelog, item.number) : null;
		matches.push({ ...item, score: Math.round(score * 1000) / 1000, fingerprintHit, fixedIn });
	}
	// A fingerprint hit is the same failure; it leads whatever a title happens to share.
	matches.sort(
		(a, b) => Number(b.fingerprintHit) - Number(a.fingerprintHit) || b.score - a.score || b.number - a.number,
	);
	matches.splice(MAX_MATCHES);

	return { matches, latestVersion, verdict: verdictFor(matches, draft.environment.clioCoder, latestVersion) };
}

function verdictFor(matches: ReadonlyArray<RelatedIssue>, installed: string, latest: string | null): RelatedVerdict {
	const top = matches[0];
	const installedTriple = versionTriple(installed);
	const latestTriple = latest !== null ? versionTriple(latest) : null;
	const newer = installedTriple !== null && latestTriple !== null && compareTriples(latestTriple, installedTriple) > 0;
	if (top?.state === "open") return { kind: "comment", issue: top };
	if (top?.state === "closed") {
		if (top.fixedIn !== null) return { kind: "regression", issue: top };
		if (newer && latest !== null) return { kind: "upgrade", issue: top, installed, latest };
	}
	const behind =
		newer &&
		installedTriple !== null &&
		latestTriple !== null &&
		(latestTriple[0] > installedTriple[0] || latestTriple[1] - installedTriple[1] > 2);
	return {
		kind: "create",
		upgradeHint: behind
			? `You are on ${installed}; the latest is ${latest}. \`clio-coder upgrade\` first may help.`
			: null,
	};
}

/** The draft as the verdict files it: a regression links the closed issue and says so in its title and block. */
export function applyVerdict(draft: ReportDraft, verdict: RelatedVerdict): ReportDraft {
	if (verdict.kind !== "regression") return draft;
	const links = draft.links.includes(verdict.issue.number) ? draft.links : [...draft.links, verdict.issue.number];
	return { ...draft, links, regression: true };
}

/** The comment added to an open match: the report's sections and block under one heading, without the title. */
export function renderComment(rendered: Pick<RenderedReport, "body">, draft: Pick<ReportDraft, "environment">): string {
	return `### Also seen on ${draft.environment.clioCoder}, ${draft.environment.platform}\n\n${rendered.body}`;
}
