import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { clioStateDir } from "../core/xdg.js";
import {
	ghEnvironment,
	openShare,
	type ReportCommandRunner,
	readShareGist,
	runReportCommand,
	SHARE_ID,
} from "../domains/report/index.js";
import { importShareArchive } from "../domains/telemetry/share.js";
import { printError } from "./shared.js";

export const FLYWHEEL_HELP = `clio-coder dev flywheel [--json] [--kind <kind>[,<kind>]] [--top N]
clio-coder dev flywheel --pull <shareId|all> [--key <pem>] [--out <dir>]

Prints a Usage block for Clio Coder from data/summary.json (npm downloads,
install-script requests, GitHub views and clones over 7 days, stars, forks,
open reports, shares on file, the latest release and its share of downloads,
stale data sources, the latest weekly digest issue), then the maintainers'
ranked backlog, data/flywheel/backlog.csv, both on the data branch of
iowarp/clio-metrics and read through your gh: failure clusters, regressions,
feature requests, latent demand and friction, each with the evidence that
ranks it. --kind keeps the rows of those kinds (failure, regression,
friction, feature, demand, file-me and any kind clio-metrics adds); --top N
(or --limit N) keeps the first N of them (default 20). A why column, when the
backlog has one, prints under its row. file-me rows are issues clio-metrics
suggests filing: they print last, each with its title ready to paste. --json
prints {usage, backlog}, every column kept, for agents and scripts. The
repository is private to the maintainers.

--pull is for maintainers: it finds the share pointers in iowarp/clio-coder's
latest 1000 has-bundle issues and latest 1000 discussions, fetches each named
gist, opens it with the intake key (--key, else CLIO_INTAKE_KEY_FILE, else
~/.config/clio-intake/intake-x25519.pem) and checks it is the share its
pointer names. A telemetry share is imported as telemetry import does; a report bundle
is saved as <shareId>.tar.gz in --out (default the current directory). A gist
its sender deleted is skipped.
`;

const METRICS_REPOSITORY = "iowarp/clio-metrics";
const CODER_REPOSITORY = "iowarp/clio-coder";
const BACKLOG_COLUMNS = [
	"rank",
	"kind",
	"key",
	"title",
	"score",
	"evidence",
	"issue",
	"firstSeen",
	"lastSeen",
	"versions",
] as const;
/** The required columns, plus any column a newer clio-metrics adds (such as why), kept as text. */
type BacklogRow = Record<(typeof BACKLOG_COLUMNS)[number], string> & Record<string, string>;
const POINTER = /gist:([0-9a-f]{20,40})#(shr_[0-9a-f]{16})/gu;

export interface FlywheelDeps {
	run?: ReportCommandRunner;
	findGh?: () => string | null;
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	cwd?: string;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

/** RFC 4180 rows: quoted fields may hold commas, quotes doubled, and newlines. */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (field !== "" || row.length > 0) rows.push([...row, field]);
	return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

function backlogRows(text: string): BacklogRow[] {
	const [header, ...rows] = parseCsv(text);
	const index = BACKLOG_COLUMNS.map((column) => header?.indexOf(column) ?? -1);
	const missing = BACKLOG_COLUMNS.filter((_, at) => index[at] === -1);
	if (missing.length > 0) throw new Error(`the backlog has no ${missing.join(", ")} column`);
	const columns = header ?? [];
	return rows.map((cells) => Object.fromEntries(columns.map((column, at) => [column, cells[at] ?? ""])) as BacklogRow);
}

function clip(text: string, width: number): string {
	return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

interface Gh {
	run: (args: string[], timeoutMs?: number) => ReturnType<ReportCommandRunner>;
}

function ghFor(gh: string, deps: FlywheelDeps): Gh {
	const run = deps.run ?? runReportCommand;
	const env = ghEnvironment(deps.env ?? process.env);
	return {
		run: (args, timeoutMs = 60_000) => run(gh, ["api", "--hostname", "github.com", ...args], { timeoutMs, env }),
	};
}

function firstLine(result: { stdout: string; stderr: string; timedOut: boolean }): string {
	return result.timedOut ? "timed out" : ((result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "");
}

interface ChangeCount {
	current: number | null;
	changePct: number | null;
}

/** The headline numbers for Clio Coder from summary.json; a field the summary lacks is null. */
interface FlywheelUsage {
	asOf: string | null;
	npmDownloads7d: ChangeCount | null;
	installScriptRequests7d: number | null;
	githubViews7d: ChangeCount | null;
	githubClones7d: ChangeCount | null;
	stars: number | null;
	forks: number | null;
	openReports: number | null;
	sharesOnFile: number | null;
	latestRelease: {
		version: string;
		date: string | null;
		adoption: { share: number; window: string } | null;
	} | null;
	staleSources: string[];
	digest: { number: number; title: string; url: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
	let here = value;
	for (const key of path) here = isRecord(here) ? here[key] : undefined;
	return here;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function change(trend: unknown): ChangeCount | null {
	const current = num(at(trend, "current"));
	return current === null ? null : { current, changePct: num(at(trend, "changePct")) };
}

/** The latest release's share of the release downloads in the shortest window that has any, else all time. */
function adoptionOf(entries: unknown, version: string): { share: number; window: string } | null {
	if (!Array.isArray(entries)) return null;
	const rows = entries.filter(isRecord);
	const mine = rows.find((row) => row.version === version);
	if (mine === undefined) return null;
	const given = num(mine.share) ?? num(mine.adoptionShare);
	if (given !== null) return { share: given > 1 ? given / 100 : given, window: str(mine.window) ?? "30d" };
	for (const [field, window] of [
		["downloads7d", "7d"],
		["downloads30d", "30d"],
		["downloads90d", "90d"],
		["downloadsTotal", "all time"],
	] as const) {
		const total = rows.reduce((sum, row) => sum + (num(row[field]) ?? 0), 0);
		const own = num(mine[field]);
		if (total > 0 && own !== null) return { share: own / total, window };
	}
	return null;
}

/** Sources `health` marks stale or gapped; without `health`, every source whose last run failed. */
function staleSources(summary: unknown): string[] {
	const health = at(summary, "health");
	if (isRecord(health)) {
		const entries = Object.entries(health).filter(([, source]) => isRecord(source));
		const stale = entries
			.filter(([, source]) => at(source, "stale") === true)
			.map(([name, source]) => `${name} (newest ${str(at(source, "newestDate")) ?? "never"})`);
		const gapped = entries.flatMap(([name, source]) => {
			const gaps = num(at(source, "gaps")) ?? 0;
			return gaps > 0 ? [`${name} (${gaps} gaps)`] : [];
		});
		return [...stale, ...gapped];
	}
	const sources = at(summary, "sources");
	if (!isRecord(sources)) return [];
	return Object.entries(sources)
		.filter(([, source]) => ["error", "partial"].includes(String(at(source, "status"))))
		.map(([name, source]) => `${name} (${String(at(source, "status"))})`);
}

function usageFrom(summary: unknown): FlywheelUsage {
	const project = at(summary, "projects", "coder");
	const repo = at(project, "repos", CODER_REPOSITORY);
	const week = at(project, "trends", "7d");
	const version = str(at(repo, "latestRelease"));
	return {
		asOf: str(at(summary, "asOf")),
		npmDownloads7d: change(at(week, "npmDownloads")),
		installScriptRequests7d: num(at(week, "installScriptRequests", "current")),
		githubViews7d: change(at(week, "githubViews")),
		githubClones7d: change(at(week, "githubClones")),
		stars: num(at(repo, "stars")) ?? num(at(project, "totals", "stars")),
		forks: num(at(repo, "forks")) ?? num(at(project, "totals", "forks")),
		openReports: num(at(project, "reports", "open")),
		sharesOnFile: num(at(project, "shares", "total")),
		latestRelease:
			version === null
				? null
				: {
						version,
						date: str(at(repo, "latestReleaseDate")),
						adoption: adoptionOf(at(project, "releaseAdoption"), version) ?? adoptionOf(at(repo, "releaseAdoption"), version),
					},
		staleSources: staleSources(summary),
		digest: null,
	};
}

function signed(pct: number | null): string {
	return pct === null ? "" : ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

function count(value: number | null): string {
	return value === null ? "-" : String(value);
}

function formatUsage(usage: FlywheelUsage): string {
	const line = (label: string, value: string) => `  ${label.padEnd(18)}${value}\n`;
	const trend = (value: ChangeCount | null) => (value === null ? "-" : `${value.current}${signed(value.changePct)}`);
	let text = `Usage, Clio Coder${usage.asOf !== null ? ` (7 days to ${usage.asOf})` : ""}\n`;
	text += line("npm downloads", trend(usage.npmDownloads7d));
	text += line("install script", count(usage.installScriptRequests7d));
	text += line("GitHub", `${trend(usage.githubViews7d)} views, ${trend(usage.githubClones7d)} clones`);
	text += line("stars / forks", `${count(usage.stars)} / ${count(usage.forks)}`);
	text += line("open reports", `${count(usage.openReports)}, shares on file ${count(usage.sharesOnFile)}`);
	const release = usage.latestRelease;
	if (release !== null)
		text += line(
			"latest release",
			`${release.version}${release.date !== null ? ` (${release.date})` : ""}${
				release.adoption !== null
					? `, ${Math.round(release.adoption.share * 100)}% of release downloads (${release.adoption.window})`
					: ""
			}`,
		);
	if (usage.staleSources.length > 0) text += line("stale sources", usage.staleSources.join(", "));
	if (usage.digest !== null)
		text += line("weekly digest", `#${usage.digest.number} ${usage.digest.title} ${usage.digest.url}`);
	return text;
}

async function readUsage(gh: Gh): Promise<FlywheelUsage | null> {
	const result = await gh.run([
		"-H",
		"Accept: application/vnd.github.raw+json",
		`repos/${METRICS_REPOSITORY}/contents/data/summary.json?ref=data`,
	]);
	if (result.exitCode !== 0) return null;
	let usage: FlywheelUsage;
	try {
		usage = usageFrom(JSON.parse(result.stdout));
	} catch {
		return null;
	}
	const digest = await gh.run([
		`repos/${METRICS_REPOSITORY}/issues?labels=digest&state=all&per_page=1`,
		"--jq",
		".[0] | [.number, .title, .html_url] | @tsv",
	]);
	const [number, title, url] = digest.exitCode === 0 ? digest.stdout.trim().split("\t") : [];
	if (number !== undefined && /^[0-9]+$/u.test(number) && title !== undefined && url !== undefined)
		usage.digest = { number: Number(number), title, url };
	return usage;
}

interface BacklogView {
	json: boolean;
	limit: number;
	kinds: ReadonlyArray<string> | null;
}

/** A `file-me` row is an issue clio-metrics suggests filing; its title is the one to paste. */
const FILE_ME = "file-me";

function formatBacklog(rows: ReadonlyArray<BacklogRow>): string {
	const table = rows.filter((row) => row.kind !== FILE_ME);
	const fileMe = rows.filter((row) => row.kind === FILE_ME);
	const kindWidth = Math.max(10, ...table.map((row) => row.kind.length)) + 1;
	let text = "";
	if (table.length > 0) {
		text += `${"rank".padEnd(5)}${"kind".padEnd(kindWidth)}${"score".padEnd(8)}${clip("title", 60)}  issue  evidence\n`;
		for (const row of table) {
			text += `${row.rank.padEnd(5)}${row.kind.padEnd(kindWidth)}${row.score.padEnd(8)}${clip(row.title, 60)}  ${(row.issue || "-").padEnd(5)}  ${row.evidence}\n`;
			if (row.why) text += `${" ".repeat(5)}why: ${row.why}\n`;
		}
	}
	if (fileMe.length > 0) {
		text += `${table.length > 0 ? "\n" : ""}To file (ask before filing; each title is ready to paste):\n`;
		for (const row of fileMe) {
			text += `${row.rank.padEnd(5)}${row.title}\n`;
			if (row.why) text += `${" ".repeat(5)}why: ${row.why}\n`;
			text += `${" ".repeat(5)}evidence: ${row.evidence}${row.issue ? ` (${row.issue})` : ""}\n`;
		}
	}
	return text;
}

async function printBacklog(gh: Gh, view: BacklogView, out: (text: string) => void): Promise<number> {
	const result = await gh.run([
		"-H",
		"Accept: application/vnd.github.raw+json",
		`repos/${METRICS_REPOSITORY}/contents/data/flywheel/backlog.csv?ref=data`,
	]);
	if (result.exitCode !== 0) {
		const reason = firstLine(result);
		throw new Error(
			/HTTP 40[34]/u.test(reason)
				? `dev flywheel is for the Clio maintainers: ${METRICS_REPOSITORY} is private to the Clio maintainers, or it has no backlog yet (gh: ${reason})`
				: `cannot read the flywheel backlog: ${reason}`,
		);
	}
	const kinds = view.kinds;
	const rows = backlogRows(result.stdout)
		.filter((row) => kinds === null || kinds.includes(row.kind))
		.slice(0, view.limit);
	const usage = await readUsage(gh);
	if (view.json) {
		const backlog = rows.map((row) => ({ ...row, rank: Number(row.rank), score: Number(row.score) }));
		out(`${JSON.stringify({ usage, backlog }, null, 2)}\n`);
		return 0;
	}
	out(usage !== null ? `${formatUsage(usage)}\n` : `Usage: ${METRICS_REPOSITORY} has no readable summary.json\n\n`);
	if (rows.length === 0) {
		out(kinds === null ? "the flywheel backlog is empty\n" : `the flywheel backlog has no ${kinds.join(" or ")} items\n`);
		return 0;
	}
	out(formatBacklog(rows));
	return 0;
}

/** Pointers are read from at most this many issues and this many discussions, newest first. */
const POINTER_SCAN_LIMIT = 1000;
const PAGE_SIZE = 100;

/** Every share pointer in the coder repository's latest has-bundle issues and discussions, up to the scan limit each. */
async function sharePointers(gh: Gh): Promise<Map<string, string>> {
	const bodies: string[] = [];
	for (let page = 1; page <= POINTER_SCAN_LIMIT / PAGE_SIZE; page += 1) {
		const issues = await gh.run([
			`repos/${CODER_REPOSITORY}/issues?state=all&labels=has-bundle&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
		]);
		if (issues.exitCode !== 0) throw new Error(`gh could not list the has-bundle issues: ${firstLine(issues)}`);
		const items = JSON.parse(issues.stdout) as Array<{ body?: string | null }>;
		for (const item of items) bodies.push(item.body ?? "");
		if (items.length < PAGE_SIZE) break;
	}
	const [owner, name] = CODER_REPOSITORY.split("/");
	let after: string | null = null;
	for (let page = 1; page <= POINTER_SCAN_LIMIT / PAGE_SIZE; page += 1) {
		const discussions = await gh.run([
			"graphql",
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
			...(after !== null ? ["-f", `after=${after}`] : []),
			"-f",
			`query=query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { discussions(first: ${PAGE_SIZE}, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) { pageInfo { hasNextPage endCursor } nodes { body } } } }`,
		]);
		if (discussions.exitCode !== 0) throw new Error(`gh could not list the discussions: ${firstLine(discussions)}`);
		const found = at(JSON.parse(discussions.stdout), "data", "repository", "discussions");
		const nodes = at(found, "nodes");
		if (Array.isArray(nodes)) for (const node of nodes) bodies.push(str(at(node, "body")) ?? "");
		after = at(found, "pageInfo", "hasNextPage") === true ? str(at(found, "pageInfo", "endCursor")) : null;
		if (after === null) break;
	}
	const pointers = new Map<string, string>();
	for (const match of bodies.join("\n").matchAll(POINTER)) pointers.set(match[2] as string, match[1] as string);
	return pointers;
}

async function pull(
	gh: string,
	which: string,
	keyPath: string,
	outDir: string,
	deps: FlywheelDeps,
	out: (text: string) => void,
	fail: (message: string) => void,
): Promise<number> {
	if (!existsSync(keyPath)) {
		fail(`no intake key at ${keyPath}: pass --key <pem> or set CLIO_INTAKE_KEY_FILE`);
		return 1;
	}
	const pem = readFileSync(keyPath, "utf8");
	const pointers = await sharePointers(ghFor(gh, deps));
	const wanted = which === "all" ? [...pointers.keys()] : [which];
	if (which !== "all" && !pointers.has(which)) {
		fail(`no public pointer names ${which}`);
		return 1;
	}
	let failures = 0;
	for (const shareId of wanted) {
		const gistId = pointers.get(shareId) as string;
		try {
			const text = await readShareGist(gistId, shareId, {
				gh,
				...(deps.run !== undefined ? { run: deps.run } : {}),
				...(deps.env !== undefined ? { env: deps.env } : {}),
			});
			if (text === null) {
				out(`${shareId}: gist ${gistId} is gone; its sender forgot it\n`);
				continue;
			}
			const envelope: unknown = JSON.parse(text);
			const plain = openShare(envelope, pem);
			if (plain.shareId !== shareId) throw new Error(`the gist holds ${plain.shareId}, not ${shareId}`);
			const archive = Buffer.from(plain.archive, "base64");
			if (plain.kind === "telemetry-share") {
				const imported = await importShareArchive(deps.stateDir ?? clioStateDir(), archive);
				out(
					`${shareId}: telemetry share (${plain.consent.join(",")}, Clio ${plain.clio}) imported; read it with --imported ${imported.installId}\n`,
				);
			} else {
				const path = join(outDir, `${shareId}.tar.gz`);
				if (existsSync(path)) out(`${shareId}: report bundle already at ${path}\n`);
				else {
					safeResourceWrite(path, archive, { mode: 0o600 });
					out(`${shareId}: report bundle (${plain.consent.join(",")}, Clio ${plain.clio}) saved to ${path}\n`);
				}
			}
		} catch (error) {
			failures += 1;
			fail(`${shareId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (wanted.length === 0) out("no share pointers found\n");
	return failures === 0 ? 0 : 1;
}

/** `dev flywheel`: exit 0 printed or pulled, 1 on no access or a failed share, 2 on usage errors. */
export async function runFlywheelCommand(argv: ReadonlyArray<string>, deps: FlywheelDeps = {}): Promise<number> {
	const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
	const stderr = deps.stderr;
	const fail =
		stderr === undefined ? (message: string) => printError(message) : (message: string) => stderr(`error: ${message}\n`);
	if (argv.includes("--help") || argv.includes("-h")) {
		out(FLYWHEEL_HELP);
		return 0;
	}
	let json = false;
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--json") {
			json = true;
			continue;
		}
		const value = argv[index + 1];
		if (!["--limit", "--top", "--kind", "--pull", "--key", "--out"].includes(arg)) {
			fail(`unknown argument: ${arg}`);
			(stderr ?? ((text: string) => process.stderr.write(text)))(FLYWHEEL_HELP);
			return 2;
		}
		if (value === undefined || value.startsWith("--")) {
			fail(`${arg} needs a value`);
			return 2;
		}
		values.set(arg, value);
		index += 1;
	}
	const which = values.get("--pull");
	if (which === undefined && (values.has("--key") || values.has("--out"))) {
		fail("--key and --out apply only with --pull");
		return 2;
	}
	if (which !== undefined && (json || values.has("--limit") || values.has("--top") || values.has("--kind"))) {
		fail("--json, --kind, --top and --limit apply only to the backlog, not --pull");
		return 2;
	}
	if (values.has("--limit") && values.has("--top")) {
		fail("--top and --limit are the same; pass one");
		return 2;
	}
	if (which !== undefined && which !== "all" && !SHARE_ID.test(which)) {
		fail(`--pull takes a share id (shr_ and 16 hex digits) or all, not ${which}`);
		return 2;
	}
	const limit = Number(values.get("--top") ?? values.get("--limit") ?? "20");
	if (!Number.isInteger(limit) || limit < 1) {
		fail(`${values.has("--top") ? "--top" : "--limit"} takes a positive whole number`);
		return 2;
	}
	let gh: string | null;
	if (deps.findGh !== undefined) gh = deps.findGh();
	else {
		const { resolveToolBinary } = await import("../domains/toolchain/index.js");
		gh = resolveToolBinary("gh").binaryPath;
	}
	if (gh === null) {
		fail("dev flywheel reads GitHub through gh, which is not on PATH");
		return 1;
	}
	try {
		if (which === undefined) {
			const kind = values.get("--kind");
			const kinds =
				kind === undefined
					? null
					: kind
							.split(",")
							.map((name) => name.trim())
							.filter(Boolean);
			return await printBacklog(ghFor(gh, deps), { json, limit, kinds }, out);
		}
		const env = deps.env ?? process.env;
		const keyPath = resolve(
			values.get("--key") ?? (env.CLIO_INTAKE_KEY_FILE || join(homedir(), ".config", "clio-intake", "intake-x25519.pem")),
		);
		return await pull(
			gh,
			which,
			keyPath,
			resolve(deps.cwd ?? process.cwd(), values.get("--out") ?? "."),
			deps,
			out,
			fail,
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
