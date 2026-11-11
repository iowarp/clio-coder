import { canOpenBrowser, openBrowser } from "../../core/open-browser.js";
import { resolveToolBinary } from "../toolchain/index.js";
import type { RenderedReport } from "./body.js";
import { issueCanaryFinding, issueCanaryGate } from "./canary.js";
import { type ReportCommandRunner, runReportCommand } from "./command.js";
import { type OutboxEntry, outboxEntry, updateOutbox } from "./outbox.js";
import type { LocalIdentity } from "./scrub.js";
import { writeReportMarkdown } from "./store.js";
import { REPORT_REPOSITORY, type ReportKind } from "./vocabulary.js";

export type ReportTransport = { kind: "gh"; login: string; path: string } | { kind: "browser" } | { kind: "file" };

/**
 * Where a report may go. This table is the only source of a destination: no caller text names a repository, and
 * `gh` is always pinned to github.com so a default enterprise host never receives the report.
 */
export type ReportRoute =
	| { name: "issue"; kind: "bug" | "feature"; template: "bug_report.yml" | "feature_request.yml" }
	| { name: "discussion"; kind: "question"; category: "Help" }
	| { name: "security"; kind: "bug"; url: string };

const GITHUB = "https://github.com";
const REPOSITORY_URL = `${GITHUB}/${REPORT_REPOSITORY}`;
const GH_REPOSITORY = `github.com/${REPORT_REPOSITORY}`;
const [REPOSITORY_OWNER, REPOSITORY_NAME] = REPORT_REPOSITORY.split("/") as [string, string];

export function routeFor(key: ReportKind | "security"): ReportRoute {
	switch (key) {
		case "bug":
			return { name: "issue", kind: "bug", template: "bug_report.yml" };
		case "feature":
			return { name: "issue", kind: "feature", template: "feature_request.yml" };
		case "question":
			return { name: "discussion", kind: "question", category: "Help" };
		case "security":
			return { name: "security", kind: "bug", url: `${REPOSITORY_URL}/security/advisories/new` };
	}
}

export const REPORT_DETECT_TIMEOUT_MS = 10_000;
export const REPORT_GH_TIMEOUT_MS = 30_000;
/** GitHub rejects longer new-issue links; the budget leaves room for the browser's own limits. */
export const REPORT_URL_BUDGET = 6_000;

const GH_PASSTHROUGH = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN"] as const;

/** `gh`'s credentials travel per call; safe-exec's allowlist stays as it is. */
export function ghEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
	for (const key of GH_PASSTHROUGH) {
		const value = env[key];
		if (value !== undefined && value !== "") out[key] = value;
	}
	return out;
}

export interface TransportDetectDeps {
	run?: ReportCommandRunner;
	findGh?: () => string | null;
	browserAvailable?: (env: NodeJS.ProcessEnv) => boolean;
}

/** The best way this machine can file a report. Every failure falls through to the next; none is an error. */
export async function detectTransport(
	env: NodeJS.ProcessEnv = process.env,
	deps: TransportDetectDeps = {},
): Promise<ReportTransport> {
	const run = deps.run ?? runReportCommand;
	const gh = (deps.findGh ?? (() => resolveToolBinary("gh").binaryPath))();
	if (gh !== null) {
		const options = { timeoutMs: REPORT_DETECT_TIMEOUT_MS, env: ghEnvironment(env) };
		try {
			const status = await run(gh, ["auth", "status", "--hostname", "github.com"], options);
			if (status.exitCode === 0) {
				const user = await run(gh, ["api", "--hostname", "github.com", "user", "--jq", ".login"], options);
				const login = user.stdout.trim();
				if (user.exitCode === 0 && /^[A-Za-z0-9-]{1,39}$/u.test(login)) return { kind: "gh", login, path: gh };
			}
		} catch {
			// A gh that cannot run is a gh that is not there.
		}
	}
	return (deps.browserAvailable ?? canOpenBrowser)(env) ? { kind: "browser" } : { kind: "file" };
}

function encodedLength(value: string): number {
	return new URLSearchParams({ v: value }).toString().length - 2;
}

const CUT_NOTE = "\n\n_Cut to fit a link. The full report is in the file Clio wrote; paste the rest here._";
/** Below this much room for `problem`, optional fields give way first. */
const PROBLEM_FLOOR = 600;

/** The longest prefix of `text` whose encoding fits, ended at a paragraph, else a line, else a space. */
function cutToFit(text: string, room: number): string {
	if (room <= 0) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encodedLength(text.slice(0, middle)) <= room) low = middle;
		else high = middle - 1;
	}
	const prefix = text.slice(0, low);
	for (const boundary of ["\n\n", "\n", " "]) {
		const at = prefix.lastIndexOf(boundary);
		if (at > 0) return prefix.slice(0, at).trimEnd();
	}
	return prefix;
}

export interface PrefillLink {
	url: string;
	/** True when `problem` was shortened or a field dropped; the full text is only in the written file. */
	cut: boolean;
}

/** A new-issue or new-discussion link with the form prefilled, at most `budget` bytes long. */
export function prefillLink(
	rendered: RenderedReport,
	route: ReportRoute,
	budget: number = REPORT_URL_BUDGET,
): PrefillLink | null {
	if (route.name === "security") return null;
	const { problem, expected, reproduce, environment, details } = rendered.fields;
	let base: string;
	let fixed: Array<[string, string]>;
	let optional: Array<[string, string]>;
	let problemKey: string;
	if (route.name === "discussion") {
		base = `${REPOSITORY_URL}/discussions/new`;
		fixed = [
			["category", "help"],
			["title", rendered.title],
		];
		optional = [];
		problemKey = "body";
	} else if (route.kind === "bug") {
		base = `${REPOSITORY_URL}/issues/new`;
		fixed = [
			["template", route.template],
			["title", rendered.title],
			["details", details],
		];
		optional = [
			["environment", environment],
			["expected", expected],
			["reproduce", reproduce],
		];
		problemKey = "problem";
	} else {
		base = `${REPOSITORY_URL}/issues/new`;
		fixed = [
			["template", route.template],
			["title", rendered.title],
			["details", details],
		];
		optional = [["shape", expected]];
		problemKey = "problem";
	}
	const fullProblem = route.name === "discussion" ? rendered.body : problem;
	const build = (problemText: string, kept: Array<[string, string]>): string => {
		const params = new URLSearchParams();
		for (const [key, value] of [...fixed.slice(0, 2), [problemKey, problemText], ...kept, ...fixed.slice(2)] as Array<
			[string, string]
		>)
			if (value !== "") params.set(key, value);
		return `${base}?${params.toString()}`;
	};
	let kept = optional.filter(([, value]) => value !== "");
	const full = build(fullProblem, kept);
	if (Buffer.byteLength(full) <= budget) return { url: full, cut: false };
	const roomFor = (fields: Array<[string, string]>) =>
		budget - Buffer.byteLength(build("", fields)) - encodedLength(problemKey) - 2 - encodedLength(CUT_NOTE);
	// Optional fields go last-listed first until `problem` has a useful amount of room.
	while (kept.length > 0 && roomFor(kept) < PROBLEM_FLOOR) kept = kept.slice(0, -1);
	const room = roomFor(kept);
	let url = build(`${cutToFit(fullProblem, room)}${CUT_NOTE}`, kept);
	// The fixed fields alone can pass the budget with a very long title; the link then carries the title only.
	if (Buffer.byteLength(url) > budget) url = `${base}?${new URLSearchParams(fixed.slice(0, 2)).toString()}`;
	return { url, cut: true };
}

/** The short link a reporter opens by hand next to the written file. */
export function newReportLink(route: ReportRoute): string {
	if (route.name === "security") return route.url;
	if (route.name === "discussion") return `${REPOSITORY_URL}/discussions/new?category=help`;
	return `${REPOSITORY_URL}/issues/new?template=${route.template}`;
}

export type ReportAction =
	| { kind: "create" }
	/** Adds `body` as a comment and a +1 reaction to an existing issue (R-08's "add to it"). */
	| { kind: "comment"; number: number; body: string }
	| { kind: "react"; number: number };

export type SendResult =
	| { status: "sent"; url: string; number: number; adopted: boolean }
	| { status: "commented"; url: string; number: number }
	| { status: "reacted"; url: string; number: number }
	| { status: "opened"; url: string; path: string; cut: boolean }
	| { status: "written"; url: string; path: string }
	| { status: "failed"; reason: string; path: string };

export interface SendDeps {
	stateDir: string;
	run?: ReportCommandRunner;
	env?: NodeJS.ProcessEnv;
	/** Opens a link; false when nothing could be shown. */
	open?: (url: string) => boolean;
	now?: () => Date;
	/** When given, Send refuses before anything is written if the issue still carries one of its identifiers (R-19). */
	identity?: LocalIdentity;
}

const ISSUE_URL = new RegExp(`https://github\\.com/${REPORT_REPOSITORY.replace("/", "\\/")}/issues/(\\d+)`, "u");
const DISCUSSION_URL = new RegExp(
	`https://github\\.com/${REPORT_REPOSITORY.replace("/", "\\/")}/discussions/(\\d+)`,
	"u",
);

function issueUrl(number: number): string {
	return `${REPOSITORY_URL}/issues/${number}`;
}

function failure(reason: string, stdout: string, stderr: string, timedOut: boolean): string {
	if (timedOut) return `${reason}: timed out`;
	const detail = (stderr.trim() || stdout.trim()).split("\n")[0] ?? "";
	return detail === "" ? reason : `${reason}: ${detail}`;
}

/**
 * Files, opens or writes a rendered report. A create through `gh` is recorded as `sending` before the call, and a
 * retry of a `sending` report looks for its id on GitHub first, so a crash between the two leaves one issue.
 */
export async function sendReport(
	rendered: RenderedReport,
	route: ReportRoute,
	transport: ReportTransport,
	action: ReportAction,
	deps: SendDeps,
): Promise<SendResult> {
	const { stateDir } = deps;
	if (deps.identity !== undefined) {
		const finding = issueCanaryFinding(rendered, deps.identity);
		if (finding !== null) throw new Error(`the report was not sent: ${issueCanaryGate(finding)}`);
	}
	const run = deps.run ?? runReportCommand;
	const env = deps.env ?? process.env;
	const now = deps.now ?? (() => new Date());
	const record = (patch: Partial<OutboxEntry>): OutboxEntry =>
		updateOutbox(stateDir, rendered.id, {
			kind: route.kind,
			title: rendered.title,
			route: route.name,
			...patch,
		});

	if (action.kind !== "create") {
		if (transport.kind !== "gh") throw new Error(`adding to issue #${action.number} needs an authenticated gh`);
		return addToIssue(rendered.id, action, transport.path, run, env, stateDir);
	}

	const path = writeReportMarkdown(stateDir, rendered.id, rendered.body);
	const previous = outboxEntry(stateDir, rendered.id);
	if (previous?.state === "sent" && previous.url !== null && previous.number !== null)
		return { status: "sent", url: previous.url, number: previous.number, adopted: true };

	const offline = (): SendResult => {
		const link = prefillLink(rendered, route);
		const open = deps.open ?? ((url: string) => openBrowser(url, env));
		if (link !== null && transport.kind !== "file" && open(link.url)) {
			// The outbox keeps the short link: the prefilled one embeds the whole body.
			record({ transport: "browser", state: "opened", url: newReportLink(route), sentAt: now().toISOString() });
			return { status: "opened", url: link.url, path, cut: link.cut };
		}
		const url = newReportLink(route);
		record({ transport: "file", state: "written", url });
		return { status: "written", url, path };
	};

	if (transport.kind !== "gh" || route.name === "security") return offline();

	const options = { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(env) };
	if (previous?.state === "sending") {
		const found = await findFiled(rendered.id, route, transport.login, transport.path, run, options);
		if (found === undefined)
			return { status: "failed", reason: "could not check whether the last attempt was filed", path };
		if (found !== null) {
			record({ transport: "gh", state: "sent", url: found.url, number: found.number, sentAt: now().toISOString() });
			return { status: "sent", ...found, adopted: true };
		}
	}

	record({ transport: "gh", state: "sending" });
	if (route.name === "discussion") {
		const target = await discussionCategory("Help", transport.path, run, options);
		if (target === null) return offline();
		const filed = await createDiscussion(rendered.title, path, target, transport.path, run, options);
		if ("failed" in filed) return { status: "failed", reason: filed.failed, path };
		record({ transport: "gh", state: "sent", url: filed.url, number: filed.number, sentAt: now().toISOString() });
		return { status: "sent", ...filed, adopted: false };
	}
	const result = await run(
		transport.path,
		["issue", "create", "--repo", GH_REPOSITORY, `--title=${rendered.title}`, "--body-file", path],
		options,
	);
	const match = result.exitCode === 0 ? ISSUE_URL.exec(result.stdout) : null;
	if (match === null) {
		// The entry stays `sending`: an exit that is not a clean refusal may still have filed the issue.
		return { status: "failed", reason: failure("gh issue create", result.stdout, result.stderr, result.timedOut), path };
	}
	const number = Number(match[1]);
	const url = issueUrl(number);
	record({ transport: "gh", state: "sent", url, number, sentAt: now().toISOString() });
	return { status: "sent", url, number, adopted: false };
}

type GhOptions = { timeoutMs: number; env: Record<string, string> };

export type LastAttempt =
	| { status: "filed"; url: string; number: number }
	| { status: "unfiled" }
	| { status: "unknown"; reason: string };

/**
 * For a report left `sending`, whether its last create reached GitHub. A filed one is recorded `sent`; when GitHub
 * shows none the entry becomes a draft again, so it may be forgotten or sent anew. Any other entry is `unfiled`.
 */
export async function checkLastAttempt(
	id: string,
	transport: Extract<ReportTransport, { kind: "gh" }>,
	deps: Pick<SendDeps, "stateDir" | "run" | "env" | "now">,
): Promise<LastAttempt> {
	const entry = outboxEntry(deps.stateDir, id);
	if (entry?.state !== "sending") return { status: "unfiled" };
	const route = routeFor(entry.kind);
	const run = deps.run ?? runReportCommand;
	const options = { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) };
	const found = await findFiled(id, route, transport.login, transport.path, run, options);
	if (found === undefined) return { status: "unknown", reason: "could not check whether the last attempt was filed" };
	if (found === null) {
		updateOutbox(deps.stateDir, id, { kind: entry.kind, title: entry.title, state: "draft" });
		return { status: "unfiled" };
	}
	updateOutbox(deps.stateDir, id, {
		kind: entry.kind,
		title: entry.title,
		route: route.name,
		transport: "gh",
		state: "sent",
		url: found.url,
		number: found.number,
		sentAt: (deps.now ?? (() => new Date()))().toISOString(),
	});
	return { status: "filed", ...found };
}

/** The issue or discussion already carrying this report id; null when none; undefined when the search failed. */
async function findFiled(
	id: string,
	route: ReportRoute,
	login: string,
	gh: string,
	run: ReportCommandRunner,
	options: GhOptions,
): Promise<{ url: string; number: number } | null | undefined> {
	if (route.name === "discussion") {
		// The repository's newest discussions, not the search index: search lags filing, so a retry would post twice.
		const result = await run(
			gh,
			[
				"api",
				"graphql",
				"--hostname",
				"github.com",
				"-f",
				`owner=${REPOSITORY_OWNER}`,
				"-f",
				`name=${REPOSITORY_NAME}`,
				"-f",
				"query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussions(first: 30, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { url body } } } }",
				"--jq",
				`.data.repository.discussions.nodes | map(select((.body // "") | contains("${id}"))) | .[0].url // empty`,
			],
			options,
		);
		if (result.exitCode !== 0) return undefined;
		let match = DISCUSSION_URL.exec(result.stdout);
		if (match === null) {
			// More than thirty newer discussions push it out of that window; by then the search index has caught up.
			const searched = await run(
				gh,
				[
					"api",
					"graphql",
					"--hostname",
					"github.com",
					"-f",
					`q=repo:${REPORT_REPOSITORY} "${id}" in:body`,
					"-f",
					"query=query($q: String!) { search(query: $q, type: DISCUSSION, first: 1) { nodes { ... on Discussion { url number } } } }",
					"--jq",
					".data.search.nodes[0].url // empty",
				],
				options,
			);
			if (searched.exitCode !== 0) return undefined;
			match = DISCUSSION_URL.exec(searched.stdout);
		}
		return match === null ? null : { url: match[0], number: Number(match[1]) };
	}
	// The reporter's own newest issues, not the search index: search lags filing by up to minutes.
	const result = await run(
		gh,
		[
			"api",
			"--hostname",
			"github.com",
			"-X",
			"GET",
			`repos/${REPORT_REPOSITORY}/issues`,
			"-f",
			`creator=${login}`,
			"-f",
			"state=all",
			"-f",
			"sort=created",
			"-f",
			"direction=desc",
			"-f",
			"per_page=30",
			"--jq",
			`map(select((.body // "") | contains("${id}"))) | .[0].html_url // empty`,
		],
		options,
	);
	if (result.exitCode !== 0) return undefined;
	const match = ISSUE_URL.exec(result.stdout);
	return match === null ? null : { url: issueUrl(Number(match[1])), number: Number(match[1]) };
}

export interface DiscussionCategory {
	repositoryId: string;
	categoryId: string;
}

async function discussionCategory(
	category: string,
	gh: string,
	run: ReportCommandRunner,
	options: GhOptions,
): Promise<DiscussionCategory | null> {
	const ids = await run(
		gh,
		[
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"-f",
			`owner=${REPOSITORY_OWNER}`,
			"-f",
			`name=${REPOSITORY_NAME}`,
			"-f",
			"query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id discussionCategories(first: 50) { nodes { id name } } } }",
			"--jq",
			`[.data.repository.id, (.data.repository.discussionCategories.nodes[] | select(.name == "${category}") | .id)] | @tsv`,
		],
		options,
	);
	const [repositoryId, categoryId] = ids.stdout.trim().split("\t");
	if (ids.exitCode !== 0 || !repositoryId || !categoryId) return null;
	return { repositoryId, categoryId };
}

async function createDiscussion(
	title: string,
	bodyPath: string,
	target: DiscussionCategory,
	gh: string,
	run: ReportCommandRunner,
	options: GhOptions,
): Promise<{ url: string; number: number } | { failed: string }> {
	const created = await run(
		gh,
		[
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"-f",
			`repositoryId=${target.repositoryId}`,
			"-f",
			`categoryId=${target.categoryId}`,
			"-f",
			`title=${title}`,
			"-F",
			`body=@${bodyPath}`,
			"-f",
			"query=mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) { createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) { discussion { url number } } }",
			"--jq",
			".data.createDiscussion.discussion.url",
		],
		options,
	);
	const match = created.exitCode === 0 ? DISCUSSION_URL.exec(created.stdout) : null;
	// A mutation that did not answer cleanly may still have posted; only a failed id lookup means nothing was sent.
	if (match === null)
		return { failed: failure("gh api graphql createDiscussion", created.stdout, created.stderr, created.timedOut) };
	return { url: match[0], number: Number(match[1]) };
}

/** The ids a discussion in `category` on the report repository is posted under; null when the category is not there. */
export async function findDiscussionCategory(
	category: string,
	gh: string,
	deps: { run?: ReportCommandRunner; env?: NodeJS.ProcessEnv },
): Promise<DiscussionCategory | null> {
	const options = { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) };
	return discussionCategory(category, gh, deps.run ?? runReportCommand, options);
}

/** Post a public discussion on the report repository under a category `findDiscussionCategory` found. */
export async function postDiscussion(
	title: string,
	bodyPath: string,
	target: DiscussionCategory,
	gh: string,
	deps: { run?: ReportCommandRunner; env?: NodeJS.ProcessEnv },
): Promise<{ url: string; number: number } | { failed: string }> {
	const options = { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) };
	return createDiscussion(title, bodyPath, target, gh, deps.run ?? runReportCommand, options);
}

/** The one comment `report forget` may leave on a filed report: the report id and nothing else (R-20). */
export function bundleDeletionComment(reportId: string): string {
	return `Please delete the diagnostic bundle for report ${reportId}.`;
}

/** Posts {@link bundleDeletionComment} on the report's issue; called only after the reporter confirmed it. */
export async function requestBundleDeletion(
	gh: string,
	issue: number,
	reportId: string,
	deps: { run?: ReportCommandRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<{ url: string } | { failed: string }> {
	const run = deps.run ?? runReportCommand;
	const result = await run(
		gh,
		["issue", "comment", String(issue), "--repo", GH_REPOSITORY, "--body", bundleDeletionComment(reportId)],
		{ timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) },
	);
	if (result.exitCode !== 0)
		return { failed: failure("gh issue comment", result.stdout, result.stderr, result.timedOut) };
	const comment = /https:\/\/github\.com\/\S+#issuecomment-\d+/u.exec(result.stdout);
	return { url: comment?.[0] ?? issueUrl(issue) };
}

async function addToIssue(
	id: string,
	action: Exclude<ReportAction, { kind: "create" }>,
	gh: string,
	run: ReportCommandRunner,
	env: NodeJS.ProcessEnv,
	stateDir: string,
): Promise<SendResult> {
	const options = { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(env) };
	const issue = String(action.number);
	let url = issueUrl(action.number);
	let path = "";
	if (action.kind === "comment") {
		path = writeReportMarkdown(stateDir, id, action.body, ".comment");
		const result = await run(gh, ["issue", "comment", issue, "--repo", GH_REPOSITORY, "--body-file", path], options);
		const comment = /https:\/\/github\.com\/\S+#issuecomment-\d+/u.exec(result.stdout);
		if (result.exitCode !== 0)
			return {
				status: "failed",
				reason: failure("gh issue comment", result.stdout, result.stderr, result.timedOut),
				path,
			};
		if (comment !== null) url = comment[0];
	}
	const reaction = await run(
		gh,
		[
			"api",
			"--hostname",
			"github.com",
			"-X",
			"POST",
			`repos/${REPORT_REPOSITORY}/issues/${issue}/reactions`,
			"-f",
			"content=+1",
		],
		options,
	);
	// A missing reaction is cosmetic once the comment is in; only a bare reaction reports it.
	if (action.kind === "react" && reaction.exitCode !== 0)
		return {
			status: "failed",
			reason: failure("gh api reactions", reaction.stdout, reaction.stderr, reaction.timedOut),
			path,
		};
	return action.kind === "comment"
		? { status: "commented", url, number: action.number }
		: { status: "reacted", url, number: action.number };
}
