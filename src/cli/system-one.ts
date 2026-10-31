import { dirname, resolve, sep } from "node:path";
import { canonicalizePath } from "../core/path-canonical.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { clioStateDir } from "../core/xdg.js";
import { describeBindings, exportToFile, isDay, summarizeDataset } from "../domains/system-one/recorder/index.js";
import type { SiteId } from "../domains/system-one/types.js";
import { SITE_IDS } from "../domains/system-one/types.js";
import { systemOneRecordingLabel } from "../domains/telemetry/consent.js";
import { telemetryRoot } from "../domains/telemetry/index.js";
import { formatColumns, printError, printNote } from "./shared.js";

const HELP = `clio-coder systemone status
clio-coder systemone export --out <file> [--since <YYYY-MM-DD>] [--site <site>]

System One is experimental. Its decision engines answer typed questions about the
operator's request, tool calls, tool results and finished turns; sites, keys and
cuts may change between releases. In research telemetry mode with
telemetry.research.systemOneDataset and content consent for the workspace, every
call and what followed it is kept in the session's telemetry journal as redacted
research content, which telemetry retention expires like any other.

status   whether recording is on, what the dataset holds, and where each site is bound
export   write one JSON line per decision to a local file, joined with the full text
         of its questions and every outcome recorded for it

Flags:
  --out <file>        destination of the export (required, replaced atomically)
  --since <day>       skip samples recorded before this UTC day
  --site <site>       only this site: ${SITE_IDS.join(", ")}
`;

interface ParsedArgs {
	command?: string;
	out?: string;
	since?: string;
	site?: SiteId;
	help: boolean;
}

function flagValue(argv: ReadonlyArray<string>, index: number, flag: string, what: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires ${what}`);
	return value;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (out.command === undefined && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--out":
				out.out = flagValue(argv, i, arg, "a file path");
				i += 1;
				break;
			case "--since": {
				const day = flagValue(argv, i, arg, "a day as YYYY-MM-DD");
				if (!isDay(day)) throw new Error(`--since expects a day as YYYY-MM-DD, got ${day}`);
				out.since = day;
				i += 1;
				break;
			}
			case "--site": {
				const site = flagValue(argv, i, arg, `one of ${SITE_IDS.join(", ")}`);
				if (!(SITE_IDS as ReadonlyArray<string>).includes(site)) {
					throw new Error(`--site expects one of ${SITE_IDS.join(", ")}, got ${site}`);
				}
				out.site = site as SiteId;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

async function runStatus(): Promise<number> {
	const settings = readLayeredSettings(process.cwd()).settings;
	const { systemOne, targets } = settings;
	const summary = await summarizeDataset(clioStateDir());
	const rows: string[][] = [
		["record", systemOneRecordingLabel(settings, process.cwd()).replace(/^record /, "")],
		[
			"samples",
			summary.decisions + summary.outcomes === 0
				? "none"
				: `decision ${summary.decisions}, outcome ${summary.outcomes} across ${summary.sessions} session${summary.sessions === 1 ? "" : "s"} (${summary.oldest} to ${summary.newest})`,
		],
	];
	process.stdout.write(formatColumns(rows));
	process.stdout.write("\nsites\n");
	const sites = describeBindings(settings).map((binding) => {
		if (binding.engine === null) return [binding.site, "off"];
		if (binding.problem !== undefined) return [binding.site, `${binding.engine}: ${binding.problem}`];
		const deadline = binding.deadlineMs === undefined ? "" : `, deadline ${binding.deadlineMs} ms`;
		return [
			binding.site,
			`${binding.engine} (${binding.kind}) → ${binding.target}/${binding.model ?? "target default"}${deadline}`,
		];
	});
	process.stdout.write(formatColumns(sites.map((row) => ["", ...row])));
	if (targets.length === 0 && Object.keys(systemOne.sites).length > 0) {
		printNote("systemOne.sites names engines but no target is configured; run clio-coder targets add.");
	}
	return 0;
}

async function runExport(parsed: ParsedArgs): Promise<number> {
	if (parsed.out === undefined) {
		printError("export requires --out <file>");
		process.stderr.write(HELP);
		return 2;
	}
	const destination = resolve(parsed.out);
	const parent = canonicalizePath(dirname(destination));
	const telemetry = canonicalizePath(telemetryRoot(clioStateDir())) ?? telemetryRoot(clioStateDir());
	if (parent === null) {
		printError("--out could not be checked against the telemetry directory");
		return 2;
	}
	if (parent === telemetry || parent.startsWith(`${telemetry}${sep}`)) {
		printError("--out must not point into the telemetry directory");
		return 2;
	}
	// The file holds redacted state, but redaction is best effort and the operator's own requests are in it.
	// Rows are streamed to the temp file, so a large dataset is never one string.
	const result = await exportToFile(destination, {
		stateDir: clioStateDir(),
		...(parsed.since !== undefined ? { since: parsed.since } : {}),
		...(parsed.site !== undefined ? { site: parsed.site } : {}),
	});
	process.stdout.write(
		`exported ${result.decisions} decision${result.decisions === 1 ? "" : "s"} from ${result.sessions} session${result.sessions === 1 ? "" : "s"} to ${destination}\n`,
	);
	if (result.decisions === 0) printNote("no decisions matched; the file is empty.");
	if (result.missingSpecs > 0) {
		printNote(`${result.missingSpecs} question spec${result.missingSpecs === 1 ? "" : "s"} missing from their samples.`);
	}
	if (result.unreadableRows > 0)
		printNote(`${result.unreadableRows} unreadable sample${result.unreadableRows === 1 ? "" : "s"} skipped.`);
	return 0;
}

export async function runSystemOneCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.command !== "status" && parsed.command !== "export") {
		if (parsed.command !== undefined) printError(`unknown systemone command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}
	try {
		return parsed.command === "status" ? await runStatus() : await runExport(parsed);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
