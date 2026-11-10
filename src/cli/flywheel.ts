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

export const FLYWHEEL_HELP = `clio-coder dev flywheel [--json] [--limit N]
clio-coder dev flywheel --pull <shareId|all> [--key <pem>] [--out <dir>]

Prints the maintainers' ranked backlog, data/flywheel/backlog.csv on the data
branch of iowarp/clio-metrics, read through your gh: failure clusters,
regressions, feature requests, latent demand and friction, each with the
evidence that ranks it. --limit keeps the first N rows (default 20); --json
prints every kept row as JSON. The repository is private to the maintainers.

--pull is for maintainers: it finds the share pointers in iowarp/clio-coder's
has-bundle issues and recent discussions, fetches each named gist, opens it with
the intake key (--key, else CLIO_INTAKE_KEY_FILE, else
~/.config/clio-intake/intake-x25519.pem) and checks it is the share its pointer
names. A telemetry share is imported as telemetry import does; a report bundle
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
type BacklogRow = Record<(typeof BACKLOG_COLUMNS)[number], string>;
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
	return rows.map(
		(cells) =>
			Object.fromEntries(BACKLOG_COLUMNS.map((column, at) => [column, cells[index[at] as number] ?? ""])) as BacklogRow,
	);
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

async function printBacklog(gh: Gh, json: boolean, limit: number, out: (text: string) => void): Promise<number> {
	const result = await gh.run([
		"-H",
		"Accept: application/vnd.github.raw+json",
		`repos/${METRICS_REPOSITORY}/contents/data/flywheel/backlog.csv?ref=data`,
	]);
	if (result.exitCode !== 0) {
		const reason = firstLine(result);
		throw new Error(
			/HTTP 40[34]/u.test(reason)
				? `cannot read the flywheel backlog: ${METRICS_REPOSITORY} is private to the Clio maintainers, or it has no backlog yet (gh: ${reason})`
				: `cannot read the flywheel backlog: ${reason}`,
		);
	}
	const rows = backlogRows(result.stdout).slice(0, limit);
	if (json) {
		const typed = rows.map((row) => ({ ...row, rank: Number(row.rank), score: Number(row.score) }));
		out(`${JSON.stringify(typed, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		out("the flywheel backlog is empty\n");
		return 0;
	}
	out(`${"rank".padEnd(5)}${"kind".padEnd(11)}${"score".padEnd(8)}${clip("title", 60)}  issue  evidence\n`);
	for (const row of rows)
		out(
			`${row.rank.padEnd(5)}${row.kind.padEnd(11)}${row.score.padEnd(8)}${clip(row.title, 60)}  ${(row.issue || "-").padEnd(5)}  ${row.evidence}\n`,
		);
	return 0;
}

/** Every share pointer in the coder repository's has-bundle issues and its latest discussions. */
async function sharePointers(gh: Gh): Promise<Map<string, string>> {
	const issues = await gh.run([
		"--paginate",
		`repos/${CODER_REPOSITORY}/issues?state=all&labels=has-bundle&per_page=100`,
		"--jq",
		".[].body // empty",
	]);
	if (issues.exitCode !== 0) throw new Error(`gh could not list the has-bundle issues: ${firstLine(issues)}`);
	const [owner, name] = CODER_REPOSITORY.split("/");
	const discussions = await gh.run([
		"graphql",
		"-f",
		`owner=${owner}`,
		"-f",
		`name=${name}`,
		"-f",
		"query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussions(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { body } } } }",
		"--jq",
		".data.repository.discussions.nodes[].body",
	]);
	if (discussions.exitCode !== 0) throw new Error(`gh could not list the discussions: ${firstLine(discussions)}`);
	const pointers = new Map<string, string>();
	for (const match of `${issues.stdout}\n${discussions.stdout}`.matchAll(POINTER))
		pointers.set(match[2] as string, match[1] as string);
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
		if (!["--limit", "--pull", "--key", "--out"].includes(arg)) {
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
	if (which !== undefined && (json || values.has("--limit"))) {
		fail("--json and --limit apply only to the backlog, not --pull");
		return 2;
	}
	if (which !== undefined && which !== "all" && !SHARE_ID.test(which)) {
		fail(`--pull takes a share id (shr_ and 16 hex digits) or all, not ${which}`);
		return 2;
	}
	const limit = Number(values.get("--limit") ?? "20");
	if (!Number.isInteger(limit) || limit < 1) {
		fail("--limit takes a positive whole number");
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
		if (which === undefined) return await printBacklog(ghFor(gh, deps), json, limit, out);
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
