import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { resolveToolBinary } from "../toolchain/index.js";
import { type ReportCommandRunner, runReportCommand } from "./command.js";
import { type OutboxEntry, readOutbox, updateOutbox } from "./outbox.js";
import { reportsDirectory } from "./store.js";
import { ghEnvironment, REPORT_DETECT_TIMEOUT_MS } from "./transport.js";
import { REPORT_REPOSITORY } from "./vocabulary.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A reply check stops watching a report this long after it was sent. */
export const REPLY_CHECK_MAX_AGE_MS = 90 * DAY_MS;
/** At most one reply check per install in this window. */
export const REPLY_CHECK_INTERVAL_MS = DAY_MS;
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The switches that silence the update check silence the reply check too. */
export function followUpDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.CLIO_CODER_UPDATE_CHECK === "0" || Boolean(env.NO_UPDATE_NOTIFIER) || Boolean(env.CI);
}

export interface FollowUpDeps {
	run?: ReportCommandRunner;
	findGh?: () => string | null;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}

export interface IssueStatus {
	state: "OPEN" | "CLOSED";
	stateReason: string | null;
	comments: number;
	lastCommenter: string | null;
	/** When maintainers (owner, member or collaborator) commented, oldest first. */
	maintainerCommentTimes: string[];
}

function parseIssueStatus(stdout: string): IssueStatus | null {
	try {
		const value = JSON.parse(stdout) as Record<string, unknown>;
		const state = value.state === "CLOSED" ? "CLOSED" : value.state === "OPEN" ? "OPEN" : null;
		if (state === null) return null;
		const comments = Array.isArray(value.comments) ? (value.comments as Array<Record<string, unknown>>) : [];
		const last = comments.at(-1)?.author as { login?: unknown } | undefined;
		return {
			state,
			stateReason: typeof value.stateReason === "string" && value.stateReason !== "" ? value.stateReason : null,
			comments: comments.length,
			lastCommenter: typeof last?.login === "string" ? last.login : null,
			maintainerCommentTimes: comments
				.filter((comment) => MAINTAINER_ASSOCIATIONS.has(String(comment.authorAssociation)))
				.map((comment) => (typeof comment.createdAt === "string" ? comment.createdAt : ""))
				.filter((at) => at !== ""),
		};
	} catch {
		return null;
	}
}

/** One read of a public issue through the reporter's own `gh`; null on any failure. */
export async function readIssueStatus(
	gh: string,
	number: number,
	deps: Pick<FollowUpDeps, "run" | "env"> = {},
): Promise<IssueStatus | null> {
	const run = deps.run ?? runReportCommand;
	try {
		const result = await run(
			gh,
			[
				"issue",
				"view",
				String(number),
				"--repo",
				`github.com/${REPORT_REPOSITORY}`,
				"--json",
				"state,stateReason,comments",
			],
			{ timeoutMs: REPORT_DETECT_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) },
		);
		return result.exitCode === 0 ? parseIssueStatus(result.stdout) : null;
	} catch {
		// A gh that cannot run answers nothing; the stored state stands.
		return null;
	}
}

function findGhFor(deps: FollowUpDeps): string | null {
	try {
		return (deps.findGh ?? (() => resolveToolBinary("gh").binaryPath))();
	} catch {
		// No resolvable gh is the same as none.
		return null;
	}
}

function isClosed(entry: OutboxEntry): boolean {
	return entry.lastSeen?.state.toUpperCase().startsWith("CLOSED") === true;
}

function filed(entry: OutboxEntry): entry is OutboxEntry & { number: number } {
	return entry.state === "sent" && entry.number !== null;
}

/** `gh issue view` reads issues only; a question filed as a discussion keeps its stored state. */
function watchable(entry: OutboxEntry): entry is OutboxEntry & { number: number } {
	return filed(entry) && entry.route === "issue" && !isClosed(entry);
}

function remember(stateDir: string, id: string, entry: OutboxEntry, status: IssueStatus, at: Date): void {
	updateOutbox(stateDir, id, {
		kind: entry.kind,
		title: entry.title,
		lastSeen: {
			state: status.stateReason !== null ? `${status.state} ${status.stateReason}` : status.state,
			comments: status.comments,
			at: at.toISOString(),
		},
	});
}

/**
 * `report status` asks GitHub about each open filed report: the reporter's own command, so it needs no further
 * consent. Returns false when no `gh` is on this machine and the stored state is all there is.
 */
export async function refreshReportStatus(stateDir: string, deps: FollowUpDeps = {}): Promise<boolean> {
	const gh = findGhFor(deps);
	if (gh === null) return false;
	const now = deps.now ?? (() => new Date());
	for (const [id, entry] of Object.entries(readOutbox(stateDir))) {
		if (!watchable(entry)) continue;
		const status = await readIssueStatus(gh, entry.number, deps);
		if (status !== null) remember(stateDir, id, entry, status, now());
	}
	return true;
}

/** Turn the reply check on or off for one report. On records when the reporter asked. */
export function setReplyCheck(stateDir: string, id: string, on: boolean, now = new Date()): OutboxEntry | null {
	const entry = readOutbox(stateDir)[id];
	if (entry === undefined) return null;
	return updateOutbox(stateDir, id, { kind: entry.kind, title: entry.title, replyCheck: on ? now.toISOString() : null });
}

function replyCheckMarker(stateDir: string): string {
	return join(reportsDirectory(stateDir), "reply-check.json");
}

function lastReplyCheck(stateDir: string): number | null {
	try {
		const value = JSON.parse(readFileSync(replyCheckMarker(stateDir), "utf8")) as { at?: unknown };
		const at = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
		return Number.isFinite(at) ? at : null;
	} catch {
		// No marker yet: no check has run on this install.
		return null;
	}
}

/**
 * The opt-in reply check: only reports whose reporter ticked it, still open, sent within 90 days; at most once a
 * day per install. Returns one line per report a maintainer answered or closed. Failures are silent and the next
 * day tries again.
 */
export async function runReplyCheck(stateDir: string, deps: FollowUpDeps = {}): Promise<string[]> {
	if (followUpDisabled(deps.env ?? process.env)) return [];
	const now = (deps.now ?? (() => new Date()))();
	let watched: Array<[string, OutboxEntry & { number: number }]>;
	try {
		watched = Object.entries(readOutbox(stateDir)).filter((pair): pair is [string, OutboxEntry & { number: number }] => {
			const entry = pair[1];
			if (!entry.replyCheck || !watchable(entry) || entry.sentAt === null) return false;
			const age = now.getTime() - Date.parse(entry.sentAt);
			return age >= 0 && age < REPLY_CHECK_MAX_AGE_MS;
		});
	} catch {
		// A damaged outbox is reported by the commands that read it on purpose, not by a background check.
		return [];
	}
	if (watched.length === 0) return [];
	const last = lastReplyCheck(stateDir);
	if (last !== null && now.getTime() - last >= 0 && now.getTime() - last < REPLY_CHECK_INTERVAL_MS) return [];
	const gh = findGhFor(deps);
	if (gh === null) return [];
	safeResourceWrite(replyCheckMarker(stateDir), `${JSON.stringify({ at: now.toISOString() })}\n`, { mode: 0o600 });
	const lines: string[] = [];
	for (const [id, entry] of watched) {
		const status = await readIssueStatus(gh, entry.number, deps);
		if (status === null) continue;
		const since = Date.parse(entry.lastSeen?.at ?? entry.sentAt ?? "");
		const replied = status.maintainerCommentTimes.some((at) => !(Date.parse(at) <= since));
		if (status.state === "CLOSED")
			lines.push(`Your report #${entry.number} was closed${replied ? " with a reply" : ""}. /report status`);
		else if (replied) lines.push(`The maintainers replied on your report #${entry.number}. /report status`);
		remember(stateDir, id, entry, status, now);
	}
	return lines;
}

type Triple = [number, number, number];

function versionTriple(version: string): Triple | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareTriples(a: Triple, b: Triple): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function citesIssue(line: string, number: number): boolean {
	return new RegExp(
		`(?:(?:^|[^\\w#/]|${REPORT_REPOSITORY})#${number}|github\\.com/${REPORT_REPOSITORY}/(?:issues|pull)/${number})(?!\\d)`,
		"u",
	).test(line);
}

/** Each changelog section as its heading's version and its lines. */
function changelogSections(changelog: string): Array<{ version: string; triple: Triple; lines: string[] }> {
	const sections: Array<{ version: string; triple: Triple; lines: string[] }> = [];
	for (const line of changelog.split("\n")) {
		const heading = /^##\s+v?(\d+\.\d+\.\d+[^\s]*)/u.exec(line);
		const triple = heading ? versionTriple(heading[1] ?? "") : null;
		if (heading && triple) sections.push({ version: heading[1] ?? "", triple, lines: [] });
		else sections.at(-1)?.lines.push(line);
	}
	return sections;
}

export interface FixedReport {
	id: string;
	number: number;
	version: string;
}

/**
 * Reports the upgrade from `transition.from` to `transition.to` fixes, read from the packaged changelog's sections
 * between the two versions. Entries already thanked, withdrawn or never filed are skipped; dev builds get nothing.
 */
export function fixedReports(
	transition: { from: string; to: string },
	outbox: Readonly<Record<string, OutboxEntry>>,
	changelog: string,
): FixedReport[] {
	if (transition.to.includes("-dev")) return [];
	const from = versionTriple(transition.from);
	const to = versionTriple(transition.to);
	if (from === null || to === null) return [];
	const sections = changelogSections(changelog).filter(
		(section) => compareTriples(section.triple, from) > 0 && compareTriples(section.triple, to) <= 0,
	);
	const hits: FixedReport[] = [];
	for (const [id, entry] of Object.entries(outbox)) {
		if (entry.thanked || !filed(entry)) continue;
		if (sections.some((section) => section.lines.some((line) => citesIssue(line, entry.number))))
			hits.push({ id, number: entry.number, version: transition.to });
	}
	return hits;
}

export function readPackagedChangelog(): string | null {
	try {
		return readFileSync(join(resolvePackageRoot(), "CHANGELOG.md"), "utf8");
	} catch {
		// An install without its changelog cannot say a fix is in it.
		return null;
	}
}

/** The once-only thank-you lines for an upgrade; each report is marked thanked so it is never shown again. */
export function takeFixedReportNotices(
	stateDir: string,
	transition: { from: string; to: string },
	options: { changelog?: string | null; env?: NodeJS.ProcessEnv } = {},
): string[] {
	if ((options.env ?? process.env).CI) return [];
	const changelog = options.changelog !== undefined ? options.changelog : readPackagedChangelog();
	if (changelog === null) return [];
	try {
		const outbox = readOutbox(stateDir);
		return fixedReports(transition, outbox, changelog).map((hit) => {
			const entry = outbox[hit.id] as OutboxEntry;
			updateOutbox(stateDir, hit.id, { kind: entry.kind, title: entry.title, thanked: true });
			return `${hit.version} fixes #${hit.number}, which you reported. Thank you.`;
		});
	} catch {
		// A damaged outbox thanks nobody; `report status` names the damage.
		return [];
	}
}

/** Doctor's reports row: "2 sent, 1 fixed (#452 in 0.7.2)", or null when nothing was sent. */
export function reportsDoctorDetail(stateDir: string, changelog: string | null): string | null {
	const sent = Object.values(readOutbox(stateDir)).filter(filed);
	if (sent.length === 0) return null;
	const fixed: string[] = [];
	if (changelog !== null) {
		const sections = changelogSections(changelog);
		for (const entry of sent) {
			// The oldest citing section is the release that shipped the fix.
			const section = [...sections]
				.reverse()
				.find((candidate) => candidate.lines.some((line) => citesIssue(line, entry.number)));
			if (section !== undefined) fixed.push(`#${entry.number} in ${section.version}`);
		}
	}
	return `${sent.length} sent, ${fixed.length} fixed${fixed.length > 0 ? ` (${fixed.join(", ")})` : ""}`;
}
