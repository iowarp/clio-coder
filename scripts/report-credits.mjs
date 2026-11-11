#!/usr/bin/env node
// R-22: opt-in reporter credit. Read-only against GitHub (`gh issue list`), or a saved fixture with --fixture.
//
//   node scripts/report-credits.mjs --since v0.7.0 --until v0.8.0 [--fixture issues.json]
//     prints { handles: ["@a", "@b"], issues: { "@a": [452] } }
//   node scripts/report-credits.mjs --since ... --until ... --champions
//     also rewrites CHAMPIONS.md (stable releases), honouring champions-removed.txt
//
// The handle comes from the author of the block, never from text in it, so a block cannot credit someone else.
// No counts, ranks, dates or tiers appear in anything this writes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = "iowarp/clio-coder";
const BLOCK_TAG = "clio-coder-report";
export const CHAMPIONS_HEADER =
	"# Champions\n\nThank you to everyone who reported a problem and asked to be credited. Every report made Clio Coder better.\n\n";

/** The first report block's `credit:` value, or null without a block. */
export function blockCredit(body) {
	const lines = String(body ?? "").split(/\r?\n/u);
	const start = lines.findIndex((line) => line.trim() === `\`\`\`${BLOCK_TAG}`);
	if (start < 0) return null;
	for (const line of lines.slice(start + 1)) {
		if (line.trim().startsWith("```")) break;
		const match = /^\s*credit:\s*(\S+)\s*$/iu.exec(line);
		if (match) return match[1].toLowerCase() === "yes";
	}
	return null;
}

const login = (author) => (author && typeof author.login === "string" && author.login !== "" ? author.login : null);

/**
 * Who asked to be credited on one issue: its author by their block, a commenter by their own block, and a reporter
 * a maintainer recorded with `credit: @handle` after the reporter agreed in the thread.
 */
export function issueCredits(issue, maintainers = new Set()) {
	const wanted = new Map();
	const author = login(issue.author);
	const vote = (who, yes) => {
		if (who !== null && yes !== null) wanted.set(who, yes);
	};
	vote(author, blockCredit(issue.body));
	for (const comment of issue.comments ?? []) {
		const who = login(comment.author);
		vote(who, blockCredit(comment.body));
		if (who !== null && maintainers.has(who))
			for (const match of String(comment.body ?? "").matchAll(/^\s*credit:\s*@([A-Za-z0-9-]+)\s*$/gmu))
				if (match[1] === author || (issue.comments ?? []).some((other) => login(other.author) === match[1]))
					if (!wanted.has(match[1])) wanted.set(match[1], true);
	}
	return [...wanted].filter(([, yes]) => yes).map(([who]) => who);
}

/** Issue numbers cited (`#N`) in the changelog sections released after `since`, up to and including `until`. */
export function changelogCitations(changelog, since, until) {
	const bare = (tag) => String(tag ?? "").replace(/^v/u, "");
	const sections = String(changelog).split(/^## /mu).slice(1);
	const cited = new Set();
	let inside = until === undefined;
	for (const section of sections) {
		const heading = section.slice(0, section.indexOf("\n"));
		if (until !== undefined && heading.includes(bare(until))) inside = true;
		if (since !== undefined && heading.includes(bare(since))) break;
		if (inside) for (const match of section.matchAll(/#(\d+)\b/gu)) cited.add(Number(match[1]));
	}
	return cited;
}

/**
 * Credited handles for issues closed as completed whose fix is in the range: closed between the two dates, or
 * cited in the range's changelog. Handles sorted alphabetically, case-insensitively.
 */
export function collectCredits(issues, { from = null, to = null, cited = new Set(), maintainers = new Set() } = {}) {
	const credited = new Map();
	for (const issue of issues) {
		const completed = String(issue.stateReason ?? "").toUpperCase() === "COMPLETED";
		if (String(issue.state ?? "").toUpperCase() !== "CLOSED" || !completed) continue;
		const closed = issue.closedAt ? Date.parse(issue.closedAt) : Number.NaN;
		const dated = from !== null && to !== null && closed > from && closed <= to;
		if (!dated && !cited.has(issue.number) && (from !== null || cited.size > 0)) continue;
		for (const who of issueCredits(issue, maintainers)) {
			const handle = `@${who}`;
			credited.set(
				handle,
				[...(credited.get(handle) ?? []), issue.number].sort((a, b) => a - b),
			);
		}
	}
	const handles = [...credited.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return { handles, issues: Object.fromEntries(handles.map((handle) => [handle, credited.get(handle)])) };
}

/** The release notes' section, or "" when nobody asked to be credited. */
export function creditsSection(credits) {
	if (!credits?.handles?.length) return "";
	return `\n### Thanks\n\nReported by: ${credits.handles.join(", ")}. Thank you.\n`;
}

/** CHAMPIONS.md: every handle ever credited, alphabetical, one per line; a removal request wins. */
export function championsFile(existing, handles, removed = []) {
	const gone = new Set(removed.map((line) => line.trim().replace(/^@/u, "").toLowerCase()).filter(Boolean));
	const all = new Set();
	for (const line of String(existing ?? "").split(/\r?\n/u))
		if (/^@[A-Za-z0-9-]+$/u.test(line.trim())) all.add(line.trim());
	for (const handle of handles) all.add(handle);
	const kept = [...all]
		.filter((handle) => !gone.has(handle.slice(1).toLowerCase()))
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return `${CHAMPIONS_HEADER}${kept.map((handle) => `${handle}\n`).join("")}`;
}

function tagDate(tag) {
	return Date.parse(
		execFileSync("git", ["log", "-1", "--format=%cI", tag], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim(),
	);
}

function fetchIssues() {
	return JSON.parse(
		execFileSync(
			"gh",
			[
				"issue",
				"list",
				"--repo",
				REPOSITORY,
				"--state",
				"closed",
				"--limit",
				"1000",
				"--json",
				"number,author,body,comments,state,stateReason,closedAt",
			],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 },
		),
	);
}

function main() {
	const { values } = parseArgs({
		options: {
			since: { type: "string" },
			until: { type: "string" },
			fixture: { type: "string" },
			maintainer: { type: "string", multiple: true },
			champions: { type: "boolean" },
		},
	});
	const raw = values.fixture ? JSON.parse(readFileSync(values.fixture, "utf8")) : fetchIssues();
	const issues = Array.isArray(raw) ? raw : (raw.issues ?? []);
	const range =
		values.since && values.until && !values.fixture ? { from: tagDate(values.since), to: tagDate(values.until) } : {};
	const changelogPath = join(root, "CHANGELOG.md");
	const cited =
		values.since || values.until
			? changelogCitations(
					existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "",
					values.since,
					values.until,
				)
			: new Set();
	const credits = collectCredits(issues, {
		...range,
		cited: values.fixture && !values.since ? new Set() : cited,
		maintainers: new Set(values.maintainer ?? ["akougkas"]),
	});
	if (values.champions) {
		const path = join(root, "CHAMPIONS.md");
		const removedPath = join(root, "champions-removed.txt");
		const removed = existsSync(removedPath) ? readFileSync(removedPath, "utf8").split(/\r?\n/u) : [];
		writeFileSync(path, championsFile(existsSync(path) ? readFileSync(path, "utf8") : "", credits.handles, removed));
	}
	console.log(JSON.stringify(credits, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
